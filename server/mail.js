// Reads verification emails over IMAP. Only codes and links leave this module,
// and only back to the extension; nothing here is sent to the AI.
import { createHash } from 'node:crypto';
import { resolveMx } from 'node:dns/promises';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const TWO_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'co.in',
  'com.br', 'com.mx', 'co.za', 'com.sg', 'com.hk', 'com.tr', 'com.cn', 'co.kr', 'com.ar', 'on.ca',
]);

export function baseDomain(host) {
  host = String(host || '').toLowerCase().replace(/\.$/, '');
  if (/^[\d.]+$/.test(host) || host.includes(':')) return host;
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join('.');
  return parts.slice(TWO_PART_TLDS.has(lastTwo) ? -3 : -2).join('.');
}

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

export async function lookupProvider(domain) {
  domain = String(domain || '').toLowerCase();
  try {
    const mx = (await resolveMx(domain)).map(r => r.exchange.toLowerCase()).join(' ');
    if (/google\.com|googlemail\.com/.test(mx)) return { provider: 'google' };
    if (/outlook\.com|protection\.outlook|office365/.test(mx)) return { provider: 'microsoft' };
    return { provider: 'other' };
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

export function extractLink({ html, text }, siteHost) {
  const site = baseDomain(siteHost);
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
  let best = null;
  for (const link of links) {
    if (!allowedScheme(link.href) || LINK_BAD.test(link.href) || LINK_BAD.test(link.label)) continue;
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

function headerScore(parsed, site, labels) {
  const from = parsed.from?.value?.[0] || {};
  const fromHost = String(from.address || '').split('@')[1] || '';
  const subject = parsed.subject || '';
  const haystack = `${from.name || ''} ${from.address || ''} ${subject}`.toLowerCase();
  let score = 0;
  if (baseDomain(fromHost) === site) score += 3;
  if (labels.some(l => haystack.includes(l))) score += 2;
  if (SUBJECT_HINT.test(subject)) score += 1;
  return score;
}

async function scanFolder(client, folder, req) {
  const lock = await client.getMailboxLock(folder, { readOnly: true });
  try {
    const site = baseDomain(req.site.host);
    const labels = siteLabels(req.site.host);
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
      const score = headerScore(parsed, site, labels);
      if (score >= 1) heads.push({ uid: msg.uid, at, key, score });
    }
    heads.sort((a, b) => b.score - a.score || b.at - a.at);
    let best = null;
    for (const head of heads.slice(0, 6)) {
      const msg = await client.fetchOne(String(head.uid), { source: true }, { uid: true });
      if (!msg?.source) continue;
      const parsed = await simpleParser(msg.source);
      const body = { subject: parsed.subject || '', text: parsed.text || stripTags(parsed.html || ''), html: parsed.html || '' };
      const link = extractLink(body, req.site.host);
      let score = head.score;
      if (link && baseDomain(hostOf(link)) === site) score += 3;
      if (score < 3) continue;
      const code = req.expect === 'link' ? null : extractCode(body);
      const found = code ? { code } : link && req.expect !== 'code-only' ? { link } : null;
      if (!found) continue;
      if (!best || score > best.score || (score === best.score && head.at > best.at)) best = { ...found, key: head.key, score, at: head.at };
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
