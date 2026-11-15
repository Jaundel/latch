// Reads verification and password reset emails over IMAP. Only codes and links
// leave this module, and only back to the extension; nothing here is sent to the AI.
// Verify searches never return reset links. Reset links are looked up only when the
// user clicks Open reset email in the popup, and the extension opens them itself.
import { createHash } from 'node:crypto';
import { Resolver, resolveMx, resolveTxt } from 'node:dns/promises';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { baseDomain, isAtsHost, resetLinkAllowed } from '../extension/domains.js';

export { baseDomain };

const GENERIC_LABELS = new Set(['www', 'login', 'accounts', 'account', 'auth', 'app', 'my', 'secure', 'signin', 'id', 'sso', 'portal', 'careers', 'jobs', 'mail']);

function siteLabels(host) {
  const labels = new Set();
  const base = baseDomain(host);
  labels.add(base.split('.')[0]);
  const first = host.split('.')[0];
  if (first && !GENERIC_LABELS.has(first) && first !== base.split('.')[0]) labels.add(first);
  return [...labels].filter(l => l.length >= 3);
}

const SUBJECT_HINT = /verif|confirm|code|activat|welcome|sign|log ?in|one[- ]time|otp|passcode|security|account/i;
const LINK_GOOD = /verif|confirm|activat|validat|magic|sign.?in|log.?in|complete|get started|finish/i;
const WORDS = "(?:[\\w'’-]+ ){0,3}?";
export const RESET_SUBJECT = new RegExp(`reset ${WORDS}password|password (?:reset|recovery|change|assistance)\\b|account recovery|forgot (?:your )?password|recover ${WORDS}(?:password|account)|change ${WORDS}password|new password`, 'i');
export const RESET_LINK = /reset|forgot|recover|(?:change|new|set).?password/i;
// A message about resetting, not the bare "Forgot your password?" of a footer.
const RESET_BODY = /\b(?:request(?:ed)?|asked|click|tap|use|follow)\b[^.\n]{0,60}\b(?:reset|recover|change|choose|set)\b[^.\n]{0,40}\bpassword\b|\bpassword (?:reset|recovery) (?:link|request)\b/i;
const LINK_BAD = /unsubscribe|privacy|terms|help|support|preferences|manage|facebook\.com|twitter\.com|x\.com\/|instagram|youtube|linkedin\.com\/company|mailto:|tel:|app store|google play|apps\.apple|play\.google/i;

function imapClient(imap) {
  return new ImapFlow({
    host: imap.host,
    port: Number(imap.port) || 993,
    secure: imap.secure !== false,
    auth: { user: imap.user, pass: imap.pass },
    logger: false,
    connectionTimeout: 10000,
    greetingTimeout: 8000,
    socketTimeout: 60000,
    disableAutoIdle: true,
    emitLogs: false,
  });
}

function failure(err) {
  return err?.authenticationFailed || /auth/i.test(err?.responseText || '') ? 'auth' : 'connect';
}

export async function checkMailbox(imap) {
  const client = imapClient(imap);
  client.on('error', () => {});
  try {
    await client.connect();
    await client.logout();
    return { ok: true };
  } catch (err) {
    client.close();
    return { ok: false, reason: failure(err) };
  }
}

// The system resolver is unreliable on some Windows setups, so fall back to public ones.
async function dnsQuery(kind, domain) {
  try {
    return await (kind === 'mx' ? resolveMx(domain) : resolveTxt(domain));
  } catch {
    const resolver = new Resolver({ timeout: 3000, tries: 1 });
    resolver.setServers(['1.1.1.1', '8.8.8.8']);
    return kind === 'mx' ? resolver.resolveMx(domain) : resolver.resolveTxt(domain);
  }
}

export async function lookupProvider(domain) {
  domain = String(domain || '').toLowerCase();
  try {
    const mx = (await dnsQuery('mx', domain).catch(() => [])).map(r => r.exchange.toLowerCase()).join(' ');
    if (/google\.com|googlemail\.com/.test(mx)) return { provider: 'google' };
    if (/outlook\.com|protection\.outlook|office365/.test(mx)) return { provider: 'microsoft' };
    // Filtering gateways hide the provider in MX; the sender policy usually still names it.
    const spf = (await dnsQuery('txt', domain).catch(() => [])).map(t => t.join('')).find(t => t.startsWith('v=spf1')) || '';
    if (/_spf\.google\.com/.test(spf)) return { provider: 'google' };
    if (/spf\.protection\.outlook\.com/.test(spf)) return { provider: 'microsoft' };
    return { provider: mx ? 'other' : 'unknown' };
  } catch {
    return { provider: 'unknown' };
  }
}

async function mailFolders(client) {
  const folders = ['INBOX'];
  try {
    for (const box of await client.list()) {
      if (box.specialUse === '\\Junk' && !folders.includes(box.path)) folders.push(box.path);
    }
  } catch {}
  return folders;
}

export const messageKey = id => createHash('sha256').update(String(id || '')).digest('hex').slice(0, 16);

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&#x2F;/gi, '/').replace(/&#47;/g, '/').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function stripTags(s) {
  return decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function hostOf(href) {
  try { return new URL(href).hostname; } catch { return ''; }
}

function allowedScheme(href) {
  try {
    const u = new URL(href);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname.endsWith('.localhost') || u.hostname.endsWith('.test'));
  } catch {
    return false;
  }
}

const purposeOf = req => (req?.purpose === 'reset' ? 'reset' : 'verify');

function mailLinks({ html, text }) {
  const links = [];
  if (html) {
    for (const m of html.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      links.push({ href: decodeEntities(m[1].trim()), label: stripTags(m[2]) });
    }
  }
  if (text) {
    for (const m of text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) {
      const line = text.slice(Math.max(0, m.index - 80), m.index);
      links.push({ href: m[0], label: line.split('\n').pop() });
    }
  }
  return links;
}

const badLink = link => LINK_BAD.test(link.href) || LINK_BAD.test(link.label);
const resetLink = link => RESET_LINK.test(link.href) || RESET_LINK.test(link.label);

// A reset link must be https on the site's base domain, and on its own tenant for a job
// portal. Without a reset subject the link itself has to say reset; with one, any
// same-site link other than the home page.
function extractResetLink(body, siteHost) {
  const exact = String(siteHost || '').toLowerCase();
  const resetSubject = RESET_SUBJECT.test(body.subject || '');
  let best = null;
  for (const link of mailLinks(body)) {
    let u;
    try { u = new URL(link.href); } catch { continue; }
    if (u.protocol !== 'https:' || u.username || u.password || !resetLinkAllowed(u.hostname, exact) || badLink(link)) continue;
    const named = resetLink(link);
    if (!named && !(resetSubject && u.pathname + u.search !== '/')) continue;
    const score = (named ? 4 : 0) + (u.hostname === exact ? 2 : 0) + (u.search || u.pathname.length > 24 ? 1 : 0);
    if (!best || score > best.score) best = { href: link.href, score };
  }
  return best?.href ?? null;
}

export function extractLink(body, siteHost, purpose = 'verify') {
  if (purpose === 'reset') return extractResetLink(body, siteHost);
  const site = baseDomain(siteHost);
  let best = null;
  for (const link of mailLinks(body)) {
    if (!allowedScheme(link.href) || badLink(link) || resetLink(link)) continue;
    let score = 0;
    if (baseDomain(hostOf(link.href)) === site) score += 3;
    if (LINK_GOOD.test(link.label) || LINK_GOOD.test(new URL(link.href).pathname + new URL(link.href).search)) score += 2;
    if (score >= 2 && (!best || score > best.score)) best = { href: link.href, score };
  }
  return best?.href ?? null;
}

export function extractCode({ subject, text }) {
  const normalize = c => c.replace(/[\s-]/g, '');
  const hay = `${subject || ''}\n${text || ''}`;
  const patterns = [
    /\b(\d{4,8})\b(?=[^\n]{0,30}\b(?:is your|is the|as your)\b)/i,
    /(?:code|otp|passcode|pin|one[- ]time)[^\n\d]{0,60}?\b(\d{3}[ -]\d{3}|\d{4,8})\b/i,
    /(?:code|otp|passcode|pin)[^\n]*\n(?:[ \t]*\n){0,3}[ \t]*(\d{3}[ -]\d{3}|\d{4,8}|(?=[A-Z0-9]*\d)[A-Z0-9]{4,8})[ \t]*(?:\n|$)/i,
    /(?:code|otp|passcode)[^\n]{0,60}?\b((?=[A-Z]*\d)(?=\d*[A-Z])[A-Z0-9]{6,8})\b/,
  ];
  for (const re of patterns) {
    const m = re.exec(hay);
    if (m) return normalize(m[1]);
  }
  const lone = [...(text || '').matchAll(/^[ \t]*(\d{6})[ \t]*$/gm)];
  return lone.length === 1 ? lone[0][1] : null;
}

// Header-only score; 0 means the body is never fetched.
export function headerScore(parsed, siteHost, purpose = 'verify') {
  const site = baseDomain(siteHost);
  const from = parsed.from?.value?.[0] || {};
  const fromHost = String(from.address || '').split('@')[1] || '';
  const subject = parsed.subject || '';
  if (purpose !== 'reset' && RESET_SUBJECT.test(subject)) return 0;
  const haystack = `${from.name || ''} ${from.address || ''} ${subject}`.toLowerCase();
  let score = 0;
  const sameSite = baseDomain(fromHost) === site;
  if (sameSite) score += 3;
  // A name in the sender or subject is no proof of who sent it: chase.evil.com would claim the
  // real Chase code. Only job portals, which mail from the vendor's domain in the employer's
  // name, may match that way; every other site's mail must come from its own domain.
  else if (!isAtsHost(siteHost)) return 0;
  if (siteLabels(String(siteHost || '').toLowerCase()).some(l => haystack.includes(l))) score += 2;
  if (SUBJECT_HINT.test(subject)) score += 1;
  if (purpose === 'reset' && RESET_SUBJECT.test(subject)) score += 2;
  return score;
}

// What a fetched message yields: { found: { code } | { link }, bonus } or null.
// Reset searches never return a code.
export function judgeMessage(body, siteHost, { purpose, expect } = {}) {
  const site = baseDomain(siteHost);
  if (purpose === 'reset') {
    const link = extractResetLink(body, siteHost);
    return link ? { found: { link }, bonus: hostOf(link) === String(siteHost || '').toLowerCase() ? 5 : 3 } : null;
  }
  if (RESET_SUBJECT.test(body.subject || '')) return null;
  const link = RESET_BODY.test(body.text || '') ? null : extractLink(body, siteHost);
  const bonus = link && baseDomain(hostOf(link)) === site ? 3 : 0;
  const code = expect === 'link' ? null : extractCode(body);
  const found = code ? { code } : link && expect !== 'code-only' ? { link } : null;
  return found ? { found, bonus } : null;
}

async function scanFolder(client, folder, req) {
  const lock = await client.getMailboxLock(folder, { readOnly: true });
  try {
    const purpose = purposeOf(req);
    const since = Number(req.since) || Date.now() - 15 * 60e3;
    const exclude = new Set(req.exclude || []);
    const uids = await client.search({ since: new Date(since - 24 * 3600e3) }, { uid: true });
    if (!uids?.length) return null;
    const recent = uids.slice(-40);
    const heads = [];
    for await (const msg of client.fetch(recent, { uid: true, internalDate: true, headers: ['from', 'subject', 'message-id', 'date'] }, { uid: true })) {
      const at = new Date(msg.internalDate).getTime();
      if (!(at >= since - 120e3)) continue;
      const parsed = await simpleParser(msg.headers);
      const key = messageKey(parsed.messageId || `${folder}:${msg.uid}:${at}`);
      if (exclude.has(key)) continue;
      const score = headerScore(parsed, req.site.host, purpose);
      if (score >= 1) heads.push({ uid: msg.uid, at, key, score });
    }
    heads.sort((a, b) => b.score - a.score || b.at - a.at);
    let best = null;
    for (const head of heads.slice(0, 6)) {
      const msg = await client.fetchOne(String(head.uid), { source: true }, { uid: true });
      if (!msg?.source) continue;
      const parsed = await simpleParser(msg.source);
      const body = { subject: parsed.subject || '', text: parsed.text || stripTags(parsed.html || ''), html: parsed.html || '' };
      const hit = judgeMessage(body, req.site.host, { purpose, expect: req.expect });
      if (!hit) continue;
      const score = head.score + hit.bonus;
      if (score < 3) continue;
      if (!best || score > best.score || (score === best.score && head.at > best.at)) best = { ...hit.found, key: head.key, score, at: head.at };
    }
    return best;
  } finally {
    lock.release();
  }
}

export async function findVerification(req) {
  const deadline = Date.now() + Math.min(Number(req.waitMs) || 30000, 45000);
  const client = imapClient(req.imap);
  client.on('error', () => {});
  try {
    await client.connect();
    const folders = await mailFolders(client);
    for (;;) {
      for (const folder of folders) {
        const hit = await scanFolder(client, folder, req);
        if (hit && purposeOf(req) === 'reset') return { found: true, link: hit.link, key: hit.key };
        if (hit) return { found: true, code: hit.code, link: hit.link, key: hit.key };
      }
      if (Date.now() + 3000 > deadline) return { found: false };
      await new Promise(r => setTimeout(r, 3000));
      await client.noop().catch(() => {});
    }
  } catch (err) {
    return { found: false, error: failure(err) };
  } finally {
    await client.logout().catch(() => client.close());
  }
}
