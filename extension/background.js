// Latch service worker. Holds the vault, talks to the local MCP server, and runs
// sign-in, sign-up and verification flows in the AI's tab. Results sent back to
// the server carry statuses only, never credentials or codes.

const PORT = 47801;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => Date.now();

// ---------- domains

const TWO_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'co.in',
  'com.br', 'com.mx', 'co.za', 'com.sg', 'com.hk', 'com.tr', 'com.cn', 'co.kr', 'com.ar', 'on.ca',
]);

function baseDomain(host) {
  host = String(host || '').toLowerCase();
  if (/^[\d.]+$/.test(host) || host.includes(':')) return host;
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  return parts.slice(TWO_PART_TLDS.has(parts.slice(-2).join('.')) ? -3 : -2).join('.');
}

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

const DEFAULT_SETTINGS = { paused: false, askNewSites: false, newPasswords: 'unique' };

async function getMeta() {
  const m = await chrome.storage.local.get(['settings', 'allowed', 'pending', 'activity', 'usedMail']);
  return {
    settings: { ...DEFAULT_SETTINGS, ...m.settings },
    allowed: m.allowed || [],
    pending: m.pending || [],
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

async function snapshot(tabId) {
  const target = { tabId, allFrames: true };
  await chrome.scripting.executeScript({ target, files: ['page.js'] }).catch(() => {});
  const results = await chrome.scripting.executeScript({ target, func: () => globalThis.__latch?.inspect() ?? null }).catch(() => []);
  return results.filter(r => r?.result).map(r => ({ frameId: r.frameId, ...r.result }));
}

async function inFrame(tabId, frameId, op, arg) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: (op, arg) => globalThis.__latch?.[op]?.(arg) ?? { ok: false },
    args: [op, arg],
  }).catch(() => []);
  return res?.result;
}

async function clearAll(tabId) {
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => globalThis.__latch?.clearFilled(true) }).catch(() => {});
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
  await tabReady(tabId);
  let snap = [];
  while (now() < end) {
    snap = await snapshot(tabId);
    if (snap.some(f => f.fields.length || f.digits.length)) {
      // Give auto-solving CAPTCHAs (Turnstile and similar) a moment before treating them as blocking.
      if (!snap.some(f => f.captcha)) return snap;
    }
    await sleep(400);
  }
  return snap;
}

const signature = snap => snap.map(f => [
  f.frameId, f.url.split('#')[0], f.fields.map(x => x.kind).join(','), f.digits.length,
  f.error, f.captcha, f.busy, f.flags.checkEmail, f.flags.signedIn,
].join('|')).join('||');

// Wait until the page has changed from `before` and stopped changing.
async function settle(tabId, before, ms = 12000) {
  const end = now() + ms;
  let last = null;
  let snap = [];
  await sleep(300);
  while (now() < end) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return [];
    if (tab.status === 'complete') {
      snap = await snapshot(tabId);
      const sig = signature(snap);
      const busy = snap.some(f => f.busy);
      if (snap.length && sig !== before && !busy) {
        if (sig === last) return snap;
        last = sig;
      }
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

// ---------- credentials and approvals

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

function siteFor(vault, host) {
  if (vault.sites[host]) return { host, ...vault.sites[host] };
  const base = baseDomain(host);
  const same = Object.entries(vault.sites).filter(([h, s]) => baseDomain(h) === base && s.password);
  return same.length === 1 ? { host: same[0][0], ...same[0][1] } : null;
}

const approvalWaiters = new Map();

async function updateBadge() {
  const { pending = [] } = await chrome.storage.local.get('pending');
  await chrome.action.setBadgeBackgroundColor({ color: '#B45309' });
  await chrome.action.setBadgeText({ text: pending.length ? String(pending.length) : '' });
}

async function requestApproval(host, ms = 40000) {
  const { pending = [] } = await chrome.storage.local.get('pending');
  if (!pending.includes(host)) await chrome.storage.local.set({ pending: [...pending, host] });
  await updateBadge();
  notifyPopup();
  chrome.notifications.create(`approve|${host}`, {
    type: 'basic',
    iconUrl: 'icons/128.png',
    title: `Use your password on ${host}?`,
    message: 'Your AI is signing in to this site. Latch will fill your password; the AI will not see it.',
    buttons: [{ title: 'Allow' }, { title: 'Not now' }],
    requireInteraction: true,
    priority: 2,
  }, () => void chrome.runtime.lastError);
  return new Promise(resolve => {
    const waiters = approvalWaiters.get(host) || new Set();
    approvalWaiters.set(host, waiters);
    const done = allow => { clearTimeout(timer); waiters.delete(done); resolve(allow); };
    const timer = setTimeout(() => done(false), ms);
    waiters.add(done);
  });
}

async function decide(host, allow) {
  const { pending = [], allowed = [] } = await chrome.storage.local.get(['pending', 'allowed']);
  await chrome.storage.local.set({
    pending: pending.filter(h => h !== host),
    allowed: allow ? [...new Set([...allowed, host])] : allowed,
  });
  for (const done of approvalWaiters.get(host) || []) done(allow);
  approvalWaiters.delete(host);
  chrome.notifications.clear(`approve|${host}`, () => void chrome.runtime.lastError);
  await updateBadge();
  notifyPopup();
}

chrome.notifications.onButtonClicked.addListener((id, index) => {
  if (id.startsWith('approve|')) decide(id.slice(8), index === 0);
});
chrome.notifications.onClicked.addListener(() => chrome.action.openPopup?.().catch(() => {}));

async function credentialFor(ctx, host, verb) {
  const site = siteFor(ctx.vault, host);
  const main = ctx.vault.identity;
  if (site?.password) return { username: site.username || main.email, password: site.password, host: site.host };
  const { allowed } = await getMeta();
  if (ctx.meta.settings.askNewSites && !allowed.includes(host)) {
    if (!(await requestApproval(host, ctx.meta.settings.approvalWaitMs || 40000))) {
      return {
        blocked: needsUser('site_approval', host,
          `Latch needs the user's OK before using their password on ${host}. A request is waiting in the Latch extension; ` +
          `ask the user to allow it, then call ${verb} again.`),
      };
    }
  }
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

function mailProblem(ctx, mail, host) {
  if (!ctx.vault.mailbox) {
    return needsUser('mailbox', host, 'The site sent something to the user\'s email, but Latch is not connected to their inbox. Ask the user to connect it in Latch or finish this step themselves.');
  }
  if (mail.error === 'auth') {
    return needsUser('mailbox', host, 'Latch could not sign in to the user\'s inbox. Ask the user to reconnect it in Latch.');
  }
  if (mail.error) return { status: 'error', site: host, message: 'Latch could not reach the user\'s inbox. Try verify_email again shortly.' };
  return { status: 'verification_pending', site: host, message: 'The verification email has not arrived yet. Wait a little, then call verify_email.' };
}

async function openPrivately(ctx, url) {
  const tab = await chrome.tabs.create({ url, active: false, windowId: ctx.tab.windowId });
  await sleep(500);
  await tabReady(tab.id, 20000);
  await sleep(1500);
  await chrome.tabs.remove(tab.id).catch(() => {});
}

// Fill a code the site asked for. Returns a final result if it cannot continue, otherwise null.
async function enterCode(ctx, frame) {
  const host = frame.host;
  const f = frame.flags;
  if (f.phoneCode && !f.emailCode) {
    return needsUser('phone_code', host, 'The site sent a code to the user\'s phone. Ask the user to enter it in the tab, then continue.');
  }
  if (f.appCode && !f.emailCode) {
    return needsUser('authenticator_code', host, 'The site wants a code from an authenticator app. Ask the user to enter it in the tab, then continue.');
  }
  if (!ctx.vault.mailbox) return mailProblem(ctx, {}, host);
  const mail = await fetchMail(ctx, host, 'code');
  if (!mail.found) return mailProblem(ctx, mail, host);
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

async function confirmByLink(ctx, host) {
  if (!ctx.vault.mailbox) return { result: mailProblem(ctx, {}, host) };
  const mail = await fetchMail(ctx, host, 'link');
  if (!mail.found || !mail.link) return { result: mailProblem(ctx, mail, host) };
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
      const cred = await credentialFor(ctx, host, 'sign_in');
      if (cred.blocked) return cred.blocked;
      const pw = frame.fields.find(x => x.kind === 'password' && !x.confirm) || frame.fields.find(x => x.kind === 'password');
      const ident = frame.fields.filter(x => (x.kind === 'email' || x.kind === 'username') && (!pw.form || x.form === pw.form));
      const fills = [...ident.map(x => ({ ref: x.ref, value: cred.username })), { ref: pw.ref, value: cred.password }];
      const r = await inFrame(tabId, frame.frameId, 'fillAndSubmit', { fills, submitRef: pw.ref, purpose: 'login' });
      if (!r?.ok) return changedUnderneath(host, 'sign_in');
      last = { action: 'password', host, credHost: cred.host };
    } else if (state === 'identifier') {
      if (last && last.action !== 'identifier' && (frame.flags.signedIn || !frame.flags.loginish)) return signedIn(ctx, host, last);
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
      return signedIn(ctx, host, last);
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
  return { status: 'signed_in', site: host, message: 'Signed in. Continue your task in this tab.' };
}

async function loginFailed(ctx, frame) {
  await clearAll(ctx.tabId);
  const host = frame.host;
  const err = (frame.error || '').toLowerCase();
  if (frame.flags.locked) return needsUser('locked', host, 'The site says the account is locked or rate-limited. Ask the user to check it.');
  if (/no account|not found|does ?n.?t exist|could ?n.?t find|not registered|no user/.test(err)) {
    return { status: 'no_account', site: host, message: 'The site says there is no account for the user\'s email. Use create_account on its sign-up page if you mean to make one.' };
  }
  if (/incorrect|invalid|wrong|did ?n.?t match|does ?n.?t match|not recogni[sz]ed/.test(err)) {
    return { status: 'wrong_password', site: host, message: 'The site rejected the saved password. Ask the user to update it in Latch or sign in themselves.' };
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
      const cred = await credentialFor(ctx, host, 'create_account');
      if (cred.blocked) return cred.blocked;
      password = cred.password;
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
      const fills = [
        ...frame.fields.filter(x => x.kind === 'email' && inForm(x)).map(x => ({ ref: x.ref, value: email })),
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
      const r = await inFrame(tabId, frame.frameId, 'fillAndSubmit', { fills: [{ ref: field.ref, value: email }], submitRef: field.ref, purpose: 'signup' });
      if (!r?.ok) return changedUnderneath(here, 'create_account');
      last = { action: 'identifier', url: frame.url };
    } else {
      if (!snap.length) return unreadable(here, 'create_account');
      if (flagged(snap, 'exists')) return accountExists(host, fresh);
      if (flagged(snap, 'checkEmail') && !ctx.verified) {
        const link = await confirmByLink(ctx, host);
        if (link.result) {
          await rememberSite(host, { status: 'active', verified: false });
          return { ...link.result, message: `Account created. ${link.result.message}` };
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
  result = redact(result, vault || emptyVault());
  await recordActivity(tool, result).catch(() => {});
  return result;
}

// ---------- popup API (accepted only from this extension's own pages)

const PROVIDERS = {
  gmail: { name: 'Gmail', host: 'imap.gmail.com', help: 'https://myaccount.google.com/apppasswords', note: 'Needs 2-Step Verification on your Google account.' },
  workspace: { name: 'Google Workspace', host: 'imap.gmail.com', help: 'https://myaccount.google.com/apppasswords', note: 'Many schools turn app passwords off. If yours has, skip this step.' },
  outlook: { name: 'Outlook', host: 'outlook.office365.com', unsupported: 'Microsoft no longer accepts app passwords for mail. Skip this for now; your AI will ask you when a site sends a code.' },
  yahoo: { name: 'Yahoo Mail', host: 'imap.mail.yahoo.com', help: 'https://login.yahoo.com/myaccount/security/app-password' },
  icloud: { name: 'iCloud Mail', host: 'imap.mail.me.com', help: 'https://account.apple.com/account/manage', note: 'Use an app-specific password.' },
  aol: { name: 'AOL Mail', host: 'imap.aol.com', help: 'https://login.aol.com/account/security' },
  fastmail: { name: 'Fastmail', host: 'imap.fastmail.com', help: 'https://app.fastmail.com/settings/security/apppasswords' },
  zoho: { name: 'Zoho Mail', host: 'imap.zoho.com' },
  gmx: { name: 'GMX', host: 'imap.gmx.com' },
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
    if (r.provider === 'microsoft') return { ...PROVIDERS.outlook, name: 'Microsoft 365', port: 993, secure: true };
  }
  return { name: domain, host: domain ? `imap.${domain}` : '', port: 993, secure: true };
}

async function popupState() {
  const [vault, meta] = await Promise.all([readVault().catch(() => emptyVault()), getMeta()]);
  return {
    setup: !!vault.identity,
    email: vault.identity?.email || '',
    mailbox: vault.mailbox ? { user: vault.mailbox.user, host: vault.mailbox.host, port: vault.mailbox.port, secure: vault.mailbox.secure } : null,
    settings: meta.settings,
    allowed: meta.allowed,
    pending: meta.pending,
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
  decide: async ({ host, allow }) => { await decide(host, allow); return { ok: true }; },
  revoke: async ({ host }) => {
    const { allowed } = await getMeta();
    await chrome.storage.local.set({ allowed: allowed.filter(h => h !== host) });
    return { ok: true };
  },
  reveal: async ({ host }) => ({ password: (await readVault()).sites[host]?.password || '' }),
  forget: async ({ host }) => { await updateVault(v => { delete v.sites[host]; }); return { ok: true }; },
  erase: async () => {
    await chrome.storage.local.clear();
    await keyStore('readwrite', s => s.clear());
    keyPromise = null;
    await updateBadge();
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

updateBadge().catch(() => {});
