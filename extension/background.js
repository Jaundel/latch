// Latch service worker. Holds the vault, talks to the local MCP server, and runs
// sign-in, sign-up and verification flows in the AI's tab. Results sent back to
// the server carry statuses only, never credentials or codes.

import { fingerprint } from './build.js';
import { baseDomain, siteFor } from './domains.js';
import { classifySignInError } from './auth-result.js';

const PORT = 47801;
const loadedBuild = fingerprint(name => fetch(chrome.runtime.getURL(name)).then(response => response.text()));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => Date.now();

// ---------- domains

function insecure(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return false;
    return !(u.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$|\.(test|localhost)$/.test(u.hostname));
  } catch {
    return true;
  }
}

// ---------- vault: AES-GCM with a non-extractable key kept in IndexedDB

const b64 = bytes => btoa(String.fromCharCode(...bytes));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

function keyStore(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('latch', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('keys');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const req = fn(open.result.transaction('keys', mode).objectStore('keys'));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    };
  });
}

let keyPromise = null;
function vaultKey() {
  keyPromise ??= (async () => {
    let key = await keyStore('readonly', s => s.get('vault'));
    if (!key) {
      key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await keyStore('readwrite', s => s.put(key, 'vault'));
    }
    return key;
  })();
  return keyPromise;
}

const emptyVault = () => ({ identity: null, mailbox: null, sites: {} });

async function readVault() {
  const { vault } = await chrome.storage.local.get('vault');
  if (!vault) return emptyVault();
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(vault.iv) }, await vaultKey(), unb64(vault.data));
  return { ...emptyVault(), ...JSON.parse(new TextDecoder().decode(plain)) };
}

async function writeVault(v) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await vaultKey(), new TextEncoder().encode(JSON.stringify(v)));
  await chrome.storage.local.set({ vault: { iv: b64(iv), data: b64(new Uint8Array(data)) } });
}

let vaultChain = Promise.resolve();
function updateVault(fn) {
  const run = vaultChain.then(async () => {
    const v = await readVault();
    const out = await fn(v);
    await writeVault(v);
    return out;
  });
  vaultChain = run.catch(() => {});
  return run;
}

const DEFAULT_SETTINGS = { paused: false, newPasswords: 'unique' };

async function getMeta() {
  const m = await chrome.storage.local.get(['settings', 'activity', 'usedMail']);
  return {
    settings: { ...DEFAULT_SETTINGS, ...m.settings },
    activity: m.activity || [],
    usedMail: m.usedMail || [],
  };
}

// ---------- bridge to the local MCP server

const bridge = { ws: null, clients: [], replies: new Map(), seq: 0, retry: 0 };

function connect() {
  if (bridge.ws && bridge.ws.readyState <= WebSocket.OPEN) return;
  let ws;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  } catch {
    return;
  }
  bridge.ws = ws;
  ws.onopen = () => { bridge.retry = 0; notifyPopup(); };
  ws.onmessage = e => onBridgeMessage(e.data);
  ws.onerror = () => {};
  ws.onclose = () => {
    if (bridge.ws !== ws) return;
    bridge.ws = null;
    bridge.clients = [];
    for (const done of bridge.replies.values()) done({ error: 'offline' });
    bridge.replies.clear();
    notifyPopup();
    const delays = [1000, 3000, 10000];
    if (bridge.retry < delays.length) setTimeout(connect, delays[bridge.retry++]);
  };
}

const connected = () => bridge.ws?.readyState === WebSocket.OPEN;

function send(msg) {
  if (!connected()) return false;
  bridge.ws.send(JSON.stringify(msg));
  return true;
}

function ask(type, request, timeoutMs) {
  return new Promise(resolve => {
    const id = `x${++bridge.seq}`;
    const timer = setTimeout(() => { bridge.replies.delete(id); resolve({ error: 'timeout' }); }, timeoutMs);
    bridge.replies.set(id, r => { clearTimeout(timer); bridge.replies.delete(id); resolve(r); });
    if (!send({ type, id, request })) bridge.replies.get(id)({ error: 'offline' });
  });
}

async function onBridgeMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (msg.type === 'hello') {
    bridge.clients = (msg.clients || []).map(c => String(c).slice(0, 60)).slice(0, 8);
    notifyPopup();
    send({ type: 'ready', build: await loadedBuild });
  } else if (msg.type === 'reply') {
    bridge.replies.get(msg.id)?.(msg.result || {});
  } else if (msg.type === 'call') {
    const result = await enqueue(() => runTool(msg.tool, msg.args || {}));
    send({ type: 'result', id: msg.id, result });
  }
}

setInterval(() => send({ type: 'ping' }), 20000);
chrome.alarms.create('connect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'connect') connect(); });
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();

let queue = Promise.resolve();
function enqueue(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

// ---------- page access

let observation = null; // Tools execute serially; contains metadata only, never field values.
const authBackoff = new Map();

async function measured(phase, action) {
  const started = now();
  try { return await action(); }
  finally { if (observation) observation[phase] += now() - started; }
}

async function snapshot(tabId) {
  const started = now();
  const target = { tabId, allFrames: true };
  await chrome.scripting.executeScript({ target, files: ['page.js'], injectImmediately: true }).catch(() => {});
  const results = await chrome.scripting.executeScript({ target, func: () => globalThis.__latch?.inspect() ?? null, injectImmediately: true }).catch(() => []);
  const snap = results.filter(r => r?.result).map(r => ({ frameId: r.frameId, ...r.result }));
  if (observation) { observation.snap = snap; observation.detection_ms += now() - started; }
  return snap;
}

async function inFrame(tabId, frameId, op, arg) {
  const started = now();
  const [res] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    injectImmediately: true,
    func: (op, arg) => globalThis.__latch?.[op]?.(arg) ?? { ok: false },
    args: [op, arg],
  }).catch(() => []);
  if (observation && ['fillAndSubmit', 'fillCode'].includes(op)) {
    observation.fill_submit_ms += now() - started;
    if (res?.result?.ok) observation.actions.push(op === 'fillCode' ? 'verification_submit' : `${arg.purpose}_submit`);
  }
  return res?.result;
}

async function clearAll(tabId) {
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => globalThis.__latch?.clearFilled(true), injectImmediately: true }).catch(() => {});
}

async function tabReady(tabId, ms = 8000) {
  const end = now() + ms;
  while (now() < end) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return false;
    if (tab.status === 'complete') return true;
    await sleep(200);
  }
  return true;
}

async function waitForFields(tabId, ms = 6000) {
  const end = now() + ms;
  let snap = [];
  while (now() < end) {
    snap = await snapshot(tabId);
    if (snap.some(f => f.flags?.signedIn)) return snap;
    if (snap.some(f => f.fields.length || f.digits.length)) {
      // Give auto-solving CAPTCHAs (Turnstile and similar) a moment before treating them as blocking.
      if (!snap.some(f => f.captcha)) return snap;
    }
    await sleep(400);
  }
  return snap;
}

const signature = snap => {
  const f = pickFrame(snap);
  return f ? [
    f.frameId, f.url.split('#')[0], f.fields.map(x => x.kind).join(','), f.digits.length,
    f.error, f.captcha, f.busy, f.flags.checkEmail, f.flags.signedIn,
  ].join('|') : '';
};

// Wait until the page has changed from `before` and stopped changing.
const settle = (tabId, before, ms = 40000) => measured('page_wait_ms', () => settlePage(tabId, before, ms));
async function settlePage(tabId, before, ms) {
  const end = now() + ms;
  let last = null;
  let snap = [];
  await sleep(300);
  while (now() < end) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return [];
    snap = await snapshot(tabId);
    const sig = signature(snap);
    const frame = pickFrame(snap);
    const busy = frame?.busy;
    // Redirects and client-rendered forms can briefly have no inputs at all.
    // Only settle on a usable next step or explicit terminal evidence.
    const actionable = stateOf(frame) !== 'none' || frame?.error ||
      ['signedIn', 'checkEmail', 'passkey', 'push', 'locked', 'exists'].some(flag => flagged(snap, flag));
    if (snap.length && sig !== before && !busy && actionable) {
      if (sig === last) return snap;
      last = sig;
    }
    await sleep(350);
  }
  return snap.length ? snap : await snapshot(tabId);
}

const RANK = { captcha: 5, code: 4, password: 3, identifier: 2, none: 0 };

function stateOf(f) {
  if (!f) return 'none';
  if (f.captcha) return 'captcha';
  if (f.digits.length >= 4 || f.fields.some(x => x.kind === 'code')) return 'code';
  if (f.fields.some(x => x.kind === 'password')) return 'password';
  if (f.fields.some(x => x.kind === 'email' || x.kind === 'username')) return 'identifier';
  return 'none';
}

function pickFrame(snap) {
  let best = null;
  for (const f of snap) {
    const rank = RANK[stateOf(f)];
    if (!best || rank > best.rank || (rank === best.rank && f.top && !best.f.top)) best = { f, rank };
  }
  return best?.f ?? null;
}

const flagged = (snap, name) => snap.some(f => f.flags?.[name]);
const hostOf = url => { try { return new URL(url).hostname; } catch { return ''; } };

// ---------- credentials

const SETS = ['abcdefghijkmnopqrstuvwxyz', 'ABCDEFGHJKLMNPQRSTUVWXYZ', '23456789', '!@#$%*-_+=?'];

function randomIndex(n) {
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf); while (buf[0] >= limit);
  return buf[0] % n;
}

function matchesPattern(pattern, value) {
  for (const flags of ['v', 'u']) {
    try { return new RegExp(`^(?:${pattern})$`, flags).test(value); } catch {}
  }
  return true;
}

function generatePassword(fields = [], simple = false) {
  const maxLen = Math.min(64, ...fields.map(f => f.maxLength).filter(Boolean));
  const minLen = Math.max(12, ...fields.map(f => f.minLength));
  const len = Math.max(Math.min(simple ? 16 : 20, maxLen), Math.min(minLen, maxLen));
  const patterns = fields.map(f => f.pattern).filter(Boolean);
  let pw = '';
  for (let attempt = 0; attempt < 30; attempt++) {
    const sets = simple || attempt >= 20 ? SETS.slice(0, 3) : SETS;
    const all = sets.join('');
    const chars = sets.map(s => s[randomIndex(s.length)]);
    while (chars.length < len) chars.push(all[randomIndex(all.length)]);
    for (let i = chars.length - 1; i > 0; i--) {
      const j = randomIndex(i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    pw = chars.join('');
    if (patterns.every(p => matchesPattern(p, pw))) break;
  }
  return pw;
}

function fits(password, fields) {
  return fields.every(f => (!f.maxLength || password.length <= f.maxLength)
    && password.length >= (f.minLength || 0)
    && (!f.pattern || matchesPattern(f.pattern, password)));
}

async function credentialFor(ctx, host) {
  const site = siteFor(ctx.vault, host);
  const main = ctx.vault.identity;
  if (site?.password) return { username: site.username || main.email, password: site.password, host: site.host };
  return { username: main.email, password: main.password, host };
}

async function rememberSite(host, patch) {
  await updateVault(v => {
    const site = v.sites[host] || { username: v.identity.email, password: null, source: 'main', createdAt: now() };
    v.sites[host] = { ...site, ...patch };
  });
}

async function markStart(host) {
  await chrome.storage.session.set({ [`start:${baseDomain(host)}`]: now() });
}

async function startedAt(host) {
  const key = `start:${baseDomain(host)}`;
  return (await chrome.storage.session.get(key))[key] ?? now() - 15 * 60e3;
}

// ---------- email verification

async function fetchMail(ctx, host, expect) {
  const { usedMail } = await getMeta();
  return ask('mail', {
    imap: ctx.vault.mailbox,
    site: { host },
    since: (await startedAt(host)) - 60e3,
    expect,
    exclude: usedMail,
    waitMs: 28000,
  }, 40000);
}

async function markUsed(key) {
  if (!key) return;
  const { usedMail } = await getMeta();
  await chrome.storage.local.set({ usedMail: [key, ...usedMail].slice(0, 100) });
}

async function mailProblem(ctx, mail, host, kind) {
  if (!ctx.vault.mailbox || mail.error === 'auth') return inboxFallback(ctx, host, kind);
  if (mail.error) return { status: 'error', site: host, message: 'Latch could not reach the user\'s inbox. Try verify_email again shortly.' };
  return { status: 'verification_pending', site: host, message: 'The verification email has not arrived yet. Wait a little, then call verify_email.' };
}

// Without an inbox connection the AI can still fetch the email itself in the
// user's webmail. It will see that message; the password stays private.
async function inboxFallback(ctx, host, kind) {
  const inbox = await webmailFor(ctx.vault.identity.email);
  const where = inbox ? `open ${inbox} in a new tab (the user is already signed in there)` : 'open the user\'s webmail in a new tab';
  const step = kind === 'link'
    ? 'open the confirmation link in it'
    : `read the code and type it into the code field in tab ${ctx.tabId}, then submit`;
  return {
    status: 'check_inbox',
    reason: kind === 'link' ? 'email_link' : 'email_code',
    site: host,
    ...(inbox ? { inbox } : {}),
    message: `${host} emailed the user ${kind === 'link' ? 'a confirmation link' : 'a verification code'}, and Latch is not connected to their inbox, ` +
      `so fetch only its newest matching verification message using a connected mail tool if available; otherwise ${where}. ` +
      `Then ${step}. Carry on in tab ${ctx.tabId}; the user does not need to fetch the email.`,
  };
}

async function openPrivately(ctx, url) {
  const tab = await chrome.tabs.create({ url, active: false, windowId: ctx.tab.windowId });
  await sleep(500);
  await tabReady(tab.id, 20000);
  await sleep(1500);
  await chrome.tabs.remove(tab.id).catch(() => {});
}

// Fill a code the site asked for. Returns a final result if it cannot continue, otherwise null.
const enterCode = (ctx, frame) => measured('verification_ms', () => enterCodeStep(ctx, frame));
async function enterCodeStep(ctx, frame) {
  const host = frame.host;
  const f = frame.flags;
  if (f.phoneCode && !f.emailCode) {
    return needsUser('phone_code', host, 'The site sent a code to the user\'s phone. Ask the user to enter it in the tab, then continue.');
  }
  if (f.appCode && !f.emailCode) {
    return needsUser('authenticator_code', host, 'The site wants a code from an authenticator app. Ask the user to enter it in the tab, then continue.');
  }
  if (!ctx.vault.mailbox) return mailProblem(ctx, {}, host, 'code');
  const mail = await fetchMail(ctx, host, 'code');
  if (!mail.found) return mailProblem(ctx, mail, host, 'code');
  if (mail.code) {
    const refs = frame.digits.length >= 4 ? frame.digits : [frame.fields.find(x => x.kind === 'code').ref];
    await inFrame(ctx.tabId, frame.frameId, 'fillCode', { refs, code: mail.code });
  } else {
    await openPrivately(ctx, mail.link);
  }
  await markUsed(mail.key);
  ctx.verified = true;
  return null;
}

const confirmByLink = (ctx, host) => measured('verification_ms', () => confirmByLinkStep(ctx, host));
async function confirmByLinkStep(ctx, host) {
  if (!ctx.vault.mailbox) return { result: await mailProblem(ctx, {}, host, 'link') };
  const mail = await fetchMail(ctx, host, 'link');
  if (!mail.found || !mail.link) return { result: await mailProblem(ctx, mail, host, 'link') };
  await openPrivately(ctx, mail.link);
  await markUsed(mail.key);
  ctx.verified = true;
  return { ok: true };
}

// ---------- results

function needsUser(reason, site, message) {
  return { status: 'needs_user', reason, site, message };
}

const siteSaid = text => (text ? ` The site says: "${text.slice(0, 120)}"` : '');

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Last line of defence: scrub anything from the vault out of text going to the AI.
function redact(result, vault) {
  const secrets = new Set();
  const add = s => { if (s && String(s).length >= 4) secrets.add(String(s)); };
  add(vault.identity?.email);
  add(vault.identity?.email?.split('@')[0]);
  add(vault.identity?.password);
  add(vault.mailbox?.user);
  add(vault.mailbox?.pass);
  for (const s of Object.values(vault.sites)) { add(s.password); add(s.username); }
  const scrub = text => {
    let out = String(text);
    for (const s of [...secrets].sort((a, b) => b.length - a.length)) out = out.replace(new RegExp(escapeRe(s), 'gi'), '[hidden]');
    return out;
  };
  const out = { ...result };
  if (out.message) out.message = scrub(out.message);
  if (out.missing) out.missing = out.missing.map(scrub);
  return out;
}

async function recordActivity(tool, result) {
  const { activity } = await getMeta();
  activity.unshift({ at: now(), tool, site: result.site || '', status: result.status });
  await chrome.storage.local.set({ activity: activity.slice(0, 50) });
  notifyPopup();
}

// ---------- flows

async function signIn(ctx) {
  const { tabId } = ctx;
  let snap = await waitForFields(tabId);
  let frame = pickFrame(snap);
  let state = stateOf(frame);
  const tabHost = hostOf(ctx.tab.url);
  if (flagged(snap, 'signedIn') && !frame?.auth?.login) {
    return { status: 'signed_in', site: tabHost, message: 'This tab already looks signed in.' };
  }
  const retryAt = authBackoff.get(frame?.host) || 0;
  if (retryAt > now()) return { status: 'retry_blocked', site: frame.host, retryable: false, next_action: 'inspect_alternative_paths',
    message: 'A recent credential rejection may indicate an account problem. Latch blocks another automatic attempt for 60 seconds; inspect the available sign-in routes instead.' };
  if (['identifier', 'password'].includes(state) && !frame.auth?.login) {
    return { status: 'no_form', site: tabHost, message: 'No sign-in form found. This may be an application form; use fill_email to fill its email field without submitting it.' };
  }
  if (state === 'none') {
    if (flagged(snap, 'signedIn')) return { status: 'signed_in', site: tabHost, message: 'This tab already looks signed in.' };
    return { status: 'no_form', site: tabHost, message: 'No sign-in form found in this tab. Open the site\'s sign-in page, then call sign_in again.' };
  }
  await markStart(frame.host);
  let last = null;
  for (let step = 0; step < 7; step++) {
    const host = frame?.host || tabHost;
    if (state !== 'none' && insecure(frame.url)) return blocked(host);
    const before = signature(snap);
    if (state === 'captcha') {
      return needsUser('captcha', host, 'The site is showing a CAPTCHA. Ask the user to solve it in the tab, then call sign_in again.');
    } else if (state === 'code') {
      if (last?.action === 'code') return codeRejected(ctx, host);
      const stop = await enterCode(ctx, frame);
      if (stop) return stop;
      last = { action: 'code', host };
    } else if (state === 'password') {
      if (last?.action === 'password' && last.host === host) return loginFailed(ctx, frame);
      if (frame.fields.some(x => x.kind === 'password' && (x.isNew || x.confirm)) && !frame.auth?.login) {
        await clearAll(tabId);
        return { status: 'no_account', site: host, message: 'The site has no account for the user\'s email and is offering to create one. Call create_account on this page.' };
      }
      const cred = await credentialFor(ctx, host);
      const pw = frame.fields.find(x => x.kind === 'password' && !x.confirm) || frame.fields.find(x => x.kind === 'password');
      const ident = frame.fields.filter(x => (x.kind === 'email' || x.kind === 'username') && (!pw.form || x.form === pw.form));
      const fills = [...ident.map(x => ({ ref: x.ref, value: cred.username })), { ref: pw.ref, value: cred.password }];
      const r = await inFrame(tabId, frame.frameId, 'fillAndSubmit', { fills, submitRef: pw.ref, purpose: 'login' });
      if (!r?.ok) return changedUnderneath(host, 'sign_in');
      last = { action: 'password', host, credHost: cred.host };
    } else if (state === 'identifier') {
      if (last && last.action !== 'identifier' && frame.flags.signedIn && !frame.auth?.login) return signedIn(ctx, host, last);
      if (last?.action === 'identifier' && last.host === host) return loginFailed(ctx, frame);
      const site = siteFor(ctx.vault, host);
      const field = frame.fields.find(x => x.kind === 'email') || frame.fields.find(x => x.kind === 'username');
      const r = await inFrame(tabId, frame.frameId, 'fillAndSubmit', {
        fills: [{ ref: field.ref, value: site?.username || ctx.vault.identity.email }], submitRef: field.ref, purpose: 'login',
      });
      if (!r?.ok) return changedUnderneath(host, 'sign_in');
      last = { action: 'identifier', host };
    } else {
      if (!snap.length) return unreadable(tabHost, 'sign_in');
      if (flagged(snap, 'passkey')) return needsUser('passkey', host, 'The site wants a passkey or security key. Ask the user to finish signing in.');
      if (flagged(snap, 'push')) return needsUser('push_approval', host, 'The site sent a sign-in approval to the user\'s device. Ask the user to approve it, then continue.');
      if (flagged(snap, 'locked')) return needsUser('locked', host, 'The site says the account is locked or rate-limited. Ask the user to check it.');
      if (flagged(snap, 'checkEmail') && !last?.action?.startsWith('password')) {
        const link = await confirmByLink(ctx, host);
        if (link.result) return link.result;
        return signedIn(ctx, host, last);
      }
      if (flagged(snap, 'signedIn')) return signedIn(ctx, host, last);
      if (frame?.error) return loginFailed(ctx, frame);
      await clearAll(tabId);
      return { status: 'unconfirmed', site: host, message: 'The sign-in form disappeared, but Latch found no authenticated account control. Inspect the tab before continuing; do not assume sign-in succeeded.' };
    }
    snap = await settle(tabId, before);
    frame = pickFrame(snap);
    state = stateOf(frame);
  }
  await clearAll(tabId);
  return { status: 'error', site: tabHost, message: 'Sign-in took more steps than Latch supports. Ask the user to finish signing in.' };
}

async function signedIn(ctx, host, last) {
  await clearAll(ctx.tabId);
  const siteHost = last?.credHost || host;
  await rememberSite(siteHost, { lastUsed: now(), status: 'active' });
  return { status: 'signed_in', site: host, ...(ctx.verified ? { verified: true } : {}), message: 'Signed in. Continue your task in this tab.' };
}

async function loginFailed(ctx, frame) {
  await clearAll(ctx.tabId);
  const host = frame.host;
  const status = classifySignInError(frame.error, frame.flags.locked);
  if (['credentials_or_account_problem', 'wrong_password', 'locked'].includes(status)) {
    authBackoff.set(host, now() + 60000);
    if (authBackoff.size > 100) authBackoff.delete(authBackoff.keys().next().value);
  }
  if (status === 'locked') return { ...needsUser('locked', host, 'The site says the account is locked or rate-limited. Stop sign-in attempts.'), retryable: false };
  if (status === 'credentials_or_account_problem') {
    return { status, site: host, retryable: false, next_action: 'inspect_alternative_paths',
      message: `The site could not authenticate this account; it did not establish whether the email, password, or account state caused the failure. Do not retry automatically.${siteSaid(frame.error)}` };
  }
  if (status === 'no_account') {
    return { status: 'no_account', site: host, message: 'The site says there is no account for the user\'s email. Use create_account on its sign-up page if you mean to make one.' };
  }
  if (status === 'wrong_password') {
    return { status, site: host, retryable: false, message: `The site explicitly rejected the password. Do not retry the same credential automatically.${siteSaid(frame.error)}` };
  }
  return { status: 'sign_in_failed', site: host, message: `The site did not accept the sign-in.${siteSaid(frame.error)}` };
}

async function codeRejected(ctx, host) {
  await clearAll(ctx.tabId);
  return { status: 'verification_failed', site: host, message: 'The site did not accept the emailed code. Call verify_email to try a newer one, or ask the user.' };
}

function blocked(host) {
  return { status: 'blocked', site: host, message: 'Latch only fills credentials on secure (https) pages. Ask the user how they want to proceed.' };
}

function changedUnderneath(host, verb) {
  return { status: 'error', site: host, message: `The form changed while Latch was filling it. Call ${verb} again.` };
}

function unreadable(host, verb) {
  return { status: 'error', site: host, message: `Latch could not read the page after submitting. Check the tab, then call ${verb} again if needed.` };
}

async function createAccount(ctx) {
  const { tabId } = ctx;
  let snap = await waitForFields(tabId);
  let frame = pickFrame(snap);
  let state = stateOf(frame);
  if (state === 'none') {
    return { status: 'no_form', site: hostOf(ctx.tab.url), message: 'No sign-up form found in this tab. Open the site\'s sign-up page, then call create_account again.' };
  }
  const host = frame.host;
  // Email-first sites (iCIMS) ask for the email before deciding between sign-in and sign-up.
  const emailFirst = state === 'identifier' && frame.auth?.login;
  if (['identifier', 'password'].includes(state) && !frame.auth?.signup && !emailFirst) {
    return { status: 'no_form', site: host, message: 'No sign-up form found. This may be an application form; use fill_email to fill its email field without submitting it.' };
  }
  if (insecure(frame.url)) return blocked(host);
  if (state === 'captcha') return needsUser('captcha', host, 'The site is showing a CAPTCHA. Ask the user to solve it in the tab, then call create_account again.');
  await markStart(host);

  // Reuse whatever is saved for this exact site so retries never create a second password.
  const email = ctx.vault.identity.email;
  const saved = ctx.vault.sites[host];
  let password = saved?.password || null;
  let fresh = false;
  if (!password) {
    if (ctx.meta.settings.newPasswords === 'mine' || saved) {
      password = (await credentialFor(ctx, host)).password;
    } else {
      password = generatePassword(frame.fields.filter(x => x.kind === 'password'));
      fresh = true;
      await updateVault(v => { v.sites[host] = { username: email, password, source: 'latch', createdAt: now(), status: 'pending' }; });
    }
  }

  let last = null;
  let regenerated = false;
  for (let step = 0; step < 8; step++) {
    const here = frame?.host || host;
    const before = signature(snap);
    if (state === 'captcha') {
      await clearAll(tabId);
      return needsUser('captcha', here, 'The site is showing a CAPTCHA. Ask the user to solve it in the tab, then call create_account again.');
    } else if (state === 'code') {
      if (last?.action === 'code') return codeRejected(ctx, here);
      const stop = await enterCode(ctx, frame);
      if (stop) return stop;
      last = { action: 'code' };
    } else if (state === 'password') {
      const wantsNew = frame.fields.some(x => x.kind === 'password' && (x.isNew || x.confirm));
      if (last?.action === 'identifier' && !wantsNew && frame.auth?.login && !frame.auth?.signup) {
        await clearAll(tabId);
        return accountExists(host, fresh);
      }
      if (last?.action === 'signup' && last.url === frame.url) {
        await clearAll(tabId);
        if (frame.flags.exists) return accountExists(host, fresh);
        return { status: 'sign_up_failed', site: here, message: `The site did not accept the sign-up.${siteSaid(frame.error)}` };
      }
      const pwFields = frame.fields.filter(x => x.kind === 'password');
      if (fresh && !fits(password, pwFields)) {
        password = generatePassword(pwFields);
        if (!fits(password, pwFields)) password = generatePassword(pwFields, true);
        await updateVault(v => { v.sites[host].password = password; });
      }
      const form = pwFields[0].form;
      const inForm = x => !form || !x.form || x.form === form;
      // Sites that sign in by user name (Taleo) get the email as the user name, so
      // sign_in can fill the same value later. Fall back to the part before the @.
      const userFields = frame.fields.filter(x => x.kind === 'username' && inForm(x) && x.empty);
      let username = saved?.username || email;
      if (userFields.some(f => (f.maxLength && username.length > f.maxLength) || (f.pattern && !matchesPattern(f.pattern, username)))) {
        username = email.split('@')[0].replace(/[^A-Za-z0-9._-]/g, '').slice(0, Math.min(64, ...userFields.map(f => f.maxLength || 64)));
      }
      if (userFields.length) {
        await updateVault(v => {
          v.sites[host] ||= { password: null, source: 'latch', createdAt: now(), status: 'pending' };
          v.sites[host].username = username;
        });
      }
      const fills = [
        ...frame.fields.filter(x => x.kind === 'email' && inForm(x)).map(x => ({ ref: x.ref, value: email })),
        ...userFields.map(x => ({ ref: x.ref, value: username })),
        ...pwFields.map(x => ({ ref: x.ref, value: password })),
      ];
      const r = await inFrame(tabId, frame.frameId, 'fillAndSubmit', {
        fills, submitRef: pwFields[pwFields.length - 1].ref, purpose: 'signup', validate: true,
      });
      if (!r?.ok) {
        if (r?.ownInvalid && fresh && !regenerated) {
          regenerated = true;
          password = generatePassword(pwFields, true);
          await updateVault(v => { v.sites[host].password = password; });
          snap = await snapshot(tabId);
          frame = pickFrame(snap);
          state = stateOf(frame);
          continue;
        }
        if (r?.missing?.length) {
          return { status: 'form_incomplete', site: here, missing: r.missing, message: 'Fill these fields (leave email and password empty), then call create_account again.' };
        }
        return changedUnderneath(here, 'create_account');
      }
      last = { action: 'signup', url: frame.url };
    } else if (state === 'identifier') {
      if (last && last.action !== 'identifier' && (frame.flags.signedIn || !(frame.flags.signupish || frame.flags.loginish))) {
        return accountCreated(ctx, host);
      }
      if (last?.action === 'signup') return accountCreated(ctx, host, 'The site now asks the user to sign in; call sign_in.');
      if (last?.action === 'identifier' && last.url === frame.url) {
        await clearAll(tabId);
        if (frame.flags.exists) return accountExists(host, fresh);
        return { status: 'sign_up_failed', site: here, message: `The site did not accept the email.${siteSaid(frame.error)}` };
      }
      const field = frame.fields.find(x => x.kind === 'email') || frame.fields.find(x => x.kind === 'username');
      const purpose = frame.auth?.signup ? 'signup' : 'login';
      const r = await inFrame(tabId, frame.frameId, 'fillAndSubmit', { fills: [{ ref: field.ref, value: email }], submitRef: field.ref, purpose });
      if (!r?.ok) return changedUnderneath(here, 'create_account');
      last = { action: 'identifier', url: frame.url };
    } else {
      if (!snap.length) return unreadable(here, 'create_account');
      if (flagged(snap, 'exists')) return accountExists(host, fresh);
      if (flagged(snap, 'checkEmail') && !ctx.verified) {
        const link = await confirmByLink(ctx, host);
        if (link.result) {
          await rememberSite(host, { status: 'active', verified: false });
          return { ...link.result, account: { creation: 'created', email_verification: 'pending', session: 'unknown' }, message: `Account created. ${link.result.message}` };
        }
      }
      return accountCreated(ctx, host);
    }
    snap = await settle(tabId, before);
    frame = pickFrame(snap);
    state = stateOf(frame);
  }
  await clearAll(tabId);
  return { status: 'error', site: host, message: 'Sign-up took more steps than Latch supports. Ask the user to finish it.' };
}

async function accountCreated(ctx, host, note = '') {
  await clearAll(ctx.tabId);
  const verified = !!ctx.verified;
  await rememberSite(host, { status: 'active', verified, lastUsed: now() });
  const base = verified ? 'Account created and email verified.' : 'Account created.';
  return { status: 'account_created', site: host, verified, message: `${base} ${note || 'Continue your task in this tab.'}` };
}

async function accountExists(host, fresh) {
  if (fresh) await updateVault(v => { delete v.sites[host]; });
  return { status: 'account_exists', site: host, message: 'The site says an account with the user\'s email already exists. Call sign_in instead.' };
}

async function verifyEmail(ctx) {
  const { tabId } = ctx;
  let snap = await waitForFields(tabId, 3000);
  const frame = pickFrame(snap);
  const state = stateOf(frame);
  const host = frame?.host || hostOf(ctx.tab.url);
  if (state === 'captcha') return needsUser('captcha', host, 'The site is showing a CAPTCHA. Ask the user to solve it, then call verify_email again.');
  if (state === 'code') {
    if (insecure(frame.url)) return blocked(host);
    const before = signature(snap);
    const stop = await enterCode(ctx, frame);
    if (stop) return stop;
    snap = await settle(tabId, before);
    if (stateOf(pickFrame(snap)) === 'code') return codeRejected(ctx, host);
    await clearAll(tabId);
    await markVerified(host);
    return { status: 'verified', site: host, message: 'Email verified. Continue your task in this tab.' };
  }
  const link = await confirmByLink(ctx, host);
  if (link.result) return link.result;
  await markVerified(host);
  return { status: 'verified', site: host, message: 'Opened the confirmation link privately. Reload the tab if it has not updated.' };
}

async function markVerified(host) {
  await updateVault(v => {
    const site = siteFor(v, host);
    if (site) v.sites[site.host].verified = true;
  });
}

async function fillEmail(ctx) {
  const snap = await waitForFields(ctx.tabId, 3000);
  for (const f of [...snap].sort((a, b) => (b.focused ? 1 : 0) - (a.focused ? 1 : 0))) {
    const ref = f.focused || f.fields.find(x => x.kind === 'email' && x.empty)?.ref;
    if (!ref) continue;
    if (insecure(f.url)) return blocked(f.host);
    await inFrame(ctx.tabId, f.frameId, 'fillOne', { ref, value: ctx.vault.identity.email });
    return { status: 'filled', site: f.host, message: 'Filled in the user\'s email address.' };
  }
  return { status: 'no_form', site: hostOf(ctx.tab.url), message: 'No empty email field found. Click the field you want filled, then call fill_email again.' };
}

const FLOWS = { sign_in: signIn, create_account: createAccount, verify_email: verifyEmail, fill_email: fillEmail };

async function resolveTab(tabId) {
  if (Number.isInteger(tabId)) return chrome.tabs.get(tabId).catch(() => null);
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

async function runTool(tool, args) {
  const started = now();
  observation = { snap: [], actions: [], detection_ms: 0, fill_submit_ms: 0, page_wait_ms: 0, verification_ms: 0 };
  let vault;
  let result;
  try {
    vault = await readVault();
    const meta = await getMeta();
    if (!vault.identity) {
      result = { status: 'not_set_up', message: 'Latch is not set up yet. Ask the user to click the Latch icon in Chrome and add their email and password.' };
    } else if (meta.settings.paused) {
      result = { status: 'paused', message: 'The user has paused Latch. Ask them to sign in themselves or turn Latch back on.' };
    } else if (!FLOWS[tool]) {
      result = { status: 'error', message: 'Unknown Latch tool.' };
    } else {
      const tab = await resolveTab(args.tabId);
      result = tab
        ? await FLOWS[tool]({ tab, tabId: tab.id, vault, meta, verified: false })
        : { status: 'error', message: 'That tab does not exist. Pass the tabId from your browser tools.' };
      if (tab && tool !== 'fill_email') await clearAll(tab.id);
    }
  } catch (err) {
    console.warn('latch:', tool, err?.name || 'error');
    result = { status: 'error', message: 'Latch hit a problem on this page. Try again, or ask the user to sign in themselves.' };
  }
  const snap = observation.snap;
  result.paths = Object.assign({}, ...snap.map(f => f.paths));
  // Merge across frames without letting a later false hide a visible alternative.
  for (const key of Object.keys(result.paths)) result.paths[key] = snap.some(f => f.paths?.[key]);
  result.evidence = {
    actions: [...new Set(observation.actions)],
    signals: Object.entries({ signedIn: 'account_control', checkEmail: 'email_verification_text', emailCode: 'email_code_text', locked: 'lock_text', exists: 'existing_account_text' })
      .filter(([flag]) => flagged(snap, flag)).map(([, signal]) => signal),
    captcha: snap.some(f => f.captcha),
    error_observed: snap.some(f => !!f.error),
  };
  result.account ||= {
    creation: result.status === 'account_created' ? 'created' : result.status === 'account_exists' ? 'existing' : 'unknown',
    email_verification: result.verified === true || result.status === 'verified' ? 'verified' :
      ['check_inbox', 'verification_pending'].includes(result.status) ? 'pending' : 'unknown',
    session: result.status === 'signed_in' || (result.status === 'account_created' && flagged(snap, 'signedIn')) ? 'signed_in' : 'unknown',
  };
  result.next_action ||= ({ signed_in: 'continue', no_account: 'open_signup', account_exists: 'sign_in',
    account_created: 'inspect_page', check_inbox: 'verify_email', verification_pending: 'verify_email',
    needs_user: 'inspect_required_step', form_incomplete: 'complete_noncredential_fields',
    wrong_password: 'stop_retries', sign_in_failed: 'inspect_page', unconfirmed: 'inspect_page', no_form: 'inspect_page' })[result.status];
  result.timings = { scope: 'tool_call', total_ms: now() - started, detection_ms: observation.detection_ms, fill_submit_ms: observation.fill_submit_ms,
    page_wait_ms: observation.page_wait_ms, verification_ms: observation.verification_ms };
  observation = null;
  result = redact(result, vault || emptyVault());
  await recordActivity(tool, result).catch(() => {});
  return result;
}

// ---------- popup API (accepted only from this extension's own pages)

const PROVIDERS = {
  gmail: { webmail: 'https://mail.google.com', name: 'Gmail', host: 'imap.gmail.com', help: 'https://myaccount.google.com/apppasswords', note: 'Needs 2-Step Verification on your Google account.' },
  workspace: { webmail: 'https://mail.google.com', name: 'Google Workspace', host: 'imap.gmail.com', help: 'https://myaccount.google.com/apppasswords', note: 'Many schools turn app passwords off. If yours has, skip this step.' },
  outlook: { webmail: 'https://outlook.live.com/mail', name: 'Outlook', host: 'outlook.office365.com', unsupported: 'Microsoft no longer accepts app passwords for mail. Skip this; your AI will read codes in your inbox tab instead.' },
  yahoo: { webmail: 'https://mail.yahoo.com', name: 'Yahoo Mail', host: 'imap.mail.yahoo.com', help: 'https://login.yahoo.com/myaccount/security/app-password' },
  icloud: { webmail: 'https://www.icloud.com/mail', name: 'iCloud Mail', host: 'imap.mail.me.com', help: 'https://account.apple.com/account/manage', note: 'Use an app-specific password.' },
  aol: { webmail: 'https://mail.aol.com', name: 'AOL Mail', host: 'imap.aol.com', help: 'https://login.aol.com/account/security' },
  fastmail: { webmail: 'https://app.fastmail.com', name: 'Fastmail', host: 'imap.fastmail.com', help: 'https://app.fastmail.com/settings/security/apppasswords' },
  zoho: { webmail: 'https://mail.zoho.com', name: 'Zoho Mail', host: 'imap.zoho.com' },
  gmx: { webmail: 'https://www.gmx.com', name: 'GMX', host: 'imap.gmx.com' },
};
const PROVIDER_DOMAINS = {
  'gmail.com': 'gmail', 'googlemail.com': 'gmail', 'outlook.com': 'outlook', 'hotmail.com': 'outlook', 'live.com': 'outlook',
  'msn.com': 'outlook', 'yahoo.com': 'yahoo', 'ymail.com': 'yahoo', 'icloud.com': 'icloud', 'me.com': 'icloud', 'mac.com': 'icloud',
  'aol.com': 'aol', 'fastmail.com': 'fastmail', 'zoho.com': 'zoho', 'gmx.com': 'gmx',
};

async function detectProvider(email) {
  const domain = String(email).split('@')[1]?.toLowerCase() || '';
  if (PROVIDER_DOMAINS[domain]) return { ...PROVIDERS[PROVIDER_DOMAINS[domain]], port: 993, secure: true };
  if (connected()) {
    const r = await ask('provider', { domain }, 6000);
    if (r.provider === 'google') return { ...PROVIDERS.workspace, port: 993, secure: true };
    if (r.provider === 'microsoft') return { ...PROVIDERS.outlook, name: 'Microsoft 365', webmail: 'https://outlook.office.com/mail', port: 993, secure: true };
  }
  return { name: domain, host: domain ? `imap.${domain}` : '', port: 993, secure: true };
}

async function webmailFor(email) {
  const domain = String(email).split('@')[1]?.toLowerCase() || '';
  const key = `webmail:${domain}`;
  const cached = (await chrome.storage.local.get(key))[key];
  if (cached) return cached;
  const { webmail = '' } = await detectProvider(email);
  if (webmail) await chrome.storage.local.set({ [key]: webmail });
  return webmail;
}

async function popupState() {
  const [vault, meta] = await Promise.all([readVault().catch(() => emptyVault()), getMeta()]);
  return {
    setup: !!vault.identity,
    email: vault.identity?.email || '',
    mailbox: vault.mailbox ? { user: vault.mailbox.user, host: vault.mailbox.host, port: vault.mailbox.port, secure: vault.mailbox.secure } : null,
    settings: meta.settings,
    activity: meta.activity.slice(0, 20),
    sites: Object.entries(vault.sites)
      .map(([host, s]) => ({ host, source: s.source, createdAt: s.createdAt, lastUsed: s.lastUsed, status: s.status, verified: !!s.verified, hasPassword: !!s.password }))
      .sort((a, b) => (b.lastUsed || b.createdAt || 0) - (a.lastUsed || a.createdAt || 0)),
    connected: connected(),
    clients: bridge.clients,
  };
}

const popupHandlers = {
  state: () => popupState(),
  // The user runs a flow on the tab in front of them, exactly as the AI would.
  runHere: async ({ tool }) => {
    if (!['sign_in', 'create_account', 'verify_email'].includes(tool)) return { status: 'error', message: 'Unknown action.' };
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || !/^https?:/.test(tab.url || '')) return { status: 'error', message: 'Open the site\'s page first.' };
    return enqueue(() => runTool(tool, { tabId: tab.id }));
  },
  connect: () => { connect(); return {}; },
  provider: ({ email }) => detectProvider(email),
  saveIdentity: async ({ email, password }) => {
    await updateVault(v => {
      v.identity = { email: email.trim(), password: password || v.identity?.password || '' };
    });
    return { ok: true };
  },
  saveMailbox: async ({ mailbox }) => {
    const host = mailbox.host.trim();
    // Google shows app passwords in groups of four; the spaces are not part of it.
    const pass = host === 'imap.gmail.com' ? mailbox.pass.replace(/\s+/g, '') : mailbox.pass;
    const imap = { user: mailbox.user.trim(), pass, host, port: Number(mailbox.port) || 993, secure: mailbox.secure !== false };
    let tested = false;
    if (connected()) {
      const r = await ask('mail_check', imap, 25000);
      if (r.ok === false) return { ok: false, reason: r.reason || 'connect' };
      tested = r.ok === true;
    }
    await updateVault(v => { v.mailbox = imap; });
    return { ok: true, tested };
  },
  removeMailbox: async () => { await updateVault(v => { v.mailbox = null; }); return { ok: true }; },
  settings: async ({ patch }) => {
    const { settings } = await getMeta();
    await chrome.storage.local.set({ settings: { ...settings, ...patch } });
    return { ok: true };
  },
  reveal: async ({ host }) => ({ password: (await readVault()).sites[host]?.password || '' }),
  forget: async ({ host }) => { await updateVault(v => { delete v.sites[host]; }); return { ok: true }; },
  erase: async () => {
    await chrome.storage.local.clear();
    await keyStore('readwrite', s => s.clear());
    keyPromise = null;
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const fromPopup = sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''));
  const handler = fromPopup && popupHandlers[msg?.type];
  if (!handler) return false;
  Promise.resolve(handler(msg)).then(reply, () => reply({ ok: false, error: true }));
  return true;
});

function notifyPopup() {
  chrome.runtime.sendMessage({ type: 'changed' }).catch(() => {});
}

