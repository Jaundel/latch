// Latch service worker. Holds the vault and runs sign-in, sign-up, verification,
// 2FA and password reset flows in a tab. Flows start from the on-page bar (any
// browser AI or the user presses it), the popup, or the optional local MCP server.
// Results carry statuses only, never credentials, codes or keys.

import { fingerprint, BRIDGE_PROTOCOL } from './build.js';
import { baseDomain, isAtsHost, isCandidatePortal, recoverySite, resetLinkAllowed, sharedHost, siteFor } from './domains.js';
import { classifySignInError } from './auth-result.js';
import { mainPasswordRisk } from './guard.js';
import { freshCode, parseKey, parseOtpauth, secondsLeft, totp } from './totp.js';
import jsQR from './vendor/jsqr.js';

const PORT = 47801;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => Date.now();

// Chrome restarts an idle worker from the code it loaded at install or reload, even after the
// files change, so the build is fingerprinted once per load and kept for later restarts.
const loadReason = new Promise(resolve => {
  chrome.runtime.onInstalled.addListener(() => resolve('installed'));
  chrome.runtime.onStartup.addListener(() => resolve('startup'));
  setTimeout(() => resolve('other'), 5000);
});
const loadedBuild = (async () => {
  const { build } = await chrome.storage.session.get('build');
  if (build) return build;
  // A browser restart or re-enable runs the code from the last install or reload.
  let loaded = await loadReason !== 'installed' && (await chrome.storage.local.get('build')).build;
  if (!loaded) {
    loaded = await fingerprint(name => fetch(chrome.runtime.getURL(name)).then(response => response.text()));
    await chrome.storage.local.set({ build: loaded });
  }
  await chrome.storage.session.set({ build: loaded });
  return loaded;
})();

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

// confirmNewSites: the first time the main password would go to a site Latch has never
// signed in to, the user approves it in a Latch window that page scripts and browser AIs
// cannot reach. Installs from before this setting existed keep running unattended.
const DEFAULT_SETTINGS = { paused: false, newPasswords: 'unique', confirmNewSites: true, bar: true, approvedSites: [] };

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
// Calls queued or running, by id, each tied to the socket it came on.
const jobs = new Map();

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
  ws.onmessage = e => onBridgeMessage(ws, e.data);
  ws.onerror = () => {};
  ws.onclose = () => {
    // The server that asked is gone, so nobody is waiting for its calls any more.
    for (const job of jobs.values()) if (job.ws === ws) { job.cancelled = true; cancelApplication(job); cancelRecovery(job); }
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

// An answer goes back only on the socket its request came on, never to a server that connected later.
function reply(ws, msg) {
  return ws === bridge.ws && send(msg);
}

function ask(type, request, timeoutMs) {
  return new Promise(resolve => {
    const id = `x${++bridge.seq}`;
    const timer = setTimeout(() => { bridge.replies.delete(id); resolve({ error: 'timeout' }); }, timeoutMs);
    bridge.replies.set(id, r => { clearTimeout(timer); bridge.replies.delete(id); resolve(r); });
    if (!send({ type, id, request })) bridge.replies.get(id)({ error: 'offline' });
  });
}

async function onBridgeMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (msg.type === 'hello') {
    bridge.clients = (msg.clients || []).map(c => String(c).slice(0, 60)).slice(0, 8);
    notifyPopup();
    reply(ws, { type: 'ready', build: await loadedBuild, protocol: BRIDGE_PROTOCOL });
  } else if (msg.type === 'reply') {
    bridge.replies.get(msg.id)?.(msg.result || {});
  } else if (msg.type === 'locate') {
    reply(ws, { type: 'located', id: msg.id, ...await locateTab(msg.args || {}) });
  } else if (msg.type === 'call') {
    const job = { id: msg.id, ws, deadline: Number(msg.deadline) || Infinity, cancelled: false, acted: false };
    // A name is only a label for the activity list; the bridge can never claim to be the user.
    let client = String(msg.client || '').slice(0, 60);
    if (['you', 'page'].includes(client)) client = 'local';
    jobs.set(msg.id, job);
    const result = await enqueue(() => (stopped(job) ? skipped(msg.tool, client) : runTool(msg.tool, msg.args || {}, client, job)));
    jobs.delete(msg.id);
    reply(ws, { type: 'result', id: msg.id, result });
  } else if (msg.type === 'reload') {
    // The bridge has newer files on disk than this worker runs. Reload only when idle, so no call is cut short.
    // Only an unpacked copy runs those files; a store copy updates through the store and ignores this.
    const unpacked = !chrome.runtime.getManifest().update_url;
    if (unpacked && !jobs.size && !activeJob && typeof msg.build === 'string' && msg.build !== await loadedBuild) chrome.runtime.reload();
  } else if (msg.type === 'cancel') {
    const job = jobs.get(msg.id);
    if (job?.ws === ws) { job.cancelled = true; cancelApplication(job); cancelRecovery(job); }
  }
}

// The server gave up on the call at its deadline, or the server went away.
const stopped = job => !!job && (job.cancelled || now() > job.deadline);

function cancelApplication(job) {
  if (!Number.isInteger(job.applicationTab)) return;
  chrome.scripting.executeScript({ target: { tabId: job.applicationTab, frameIds: [0] },
    func: id => {
      const cancelled = globalThis.__jobApplyCancelled ||= new Set();
      if (cancelled.size >= 1000) cancelled.delete(cancelled.values().next().value);
      cancelled.add(id);
      globalThis.__jobApply?.cancel?.(id);
    }, args: [job.id] }).catch(() => {});
}

function cancelRecovery(job) {
  if (!Number.isInteger(job.recoveryTab) || !Number.isInteger(job.recoveryFrame)) return;
  chrome.scripting.executeScript({ target: { tabId: job.recoveryTab, frameIds: [job.recoveryFrame] },
    func: id => {
      const cancelled = globalThis.__latchRecoveryCancelled ||= new Set();
      if (cancelled.size >= 1000) cancelled.delete(cancelled.values().next().value);
      cancelled.add(id);
    }, args: [job.id] }).catch(() => {});
}

async function skipped(tool, client) {
  const result = { status: 'expired', message: 'Latch skipped this call because its time ran out before it could start. Nothing was filled; call it again if it is still needed.' };
  await recordActivity(tool, result, client).catch(() => {});
  return result;
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
let activeJob = null;   // the bridge call the running tool serves, if any
const authBackoff = new Map();

// Thrown at the next fill, submit or link once the caller has stopped waiting.
class Stopped extends Error {}
function beforeAction() {
  if (stopped(activeJob)) throw new Stopped();
  if (activeJob) activeJob.acted = true;
}

async function measured(phase, action) {
  const started = now();
  try { return await action(); }
  finally { if (observation) observation[phase] += now() - started; }
}

// `observe: false` keeps a popup's look at a page out of a running tool call's evidence.
async function snapshot(tabId, { observe = true } = {}) {
  const started = now();
  const target = { tabId, allFrames: true };
  await chrome.scripting.executeScript({ target, files: ['page.js'], injectImmediately: true }).catch(() => {});
  const results = await chrome.scripting.executeScript({ target, func: () => globalThis.__latch?.inspect() ?? null, injectImmediately: true }).catch(() => []);
  const snap = results.filter(r => r?.result).map(r => ({ frameId: r.frameId, ...r.result }));
  if (observation && observe) { observation.snap = snap; observation.detection_ms += now() - started; }
  return snap;
}

async function inFrame(tabId, frameId, op, arg) {
  if (['fillAndSubmit', 'fillCode', 'fillOne', 'requestRecovery', 'fillResetAndSubmit'].includes(op)) {
    beforeAction();
    // Private authentication does not pass through applicationTool. Set up the
    // current document before acting, including after an authentication redirect.
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] },
      world: 'MAIN', func: keepFrames, args: [true] }).catch(() => {});
    beforeAction(); // cancellation or the deadline may have arrived during setup
  }
  const started = now();
  const [res] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    injectImmediately: true,
    func: (op, arg) => globalThis.__latch?.[op]?.(arg) ?? { ok: false },
    args: [op, arg ?? null],
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
  let stableSince = 0;
  let snap = [];
  await sleep(300);
  while (now() < end) {
    // A cancelled flow ends here rather than drawing conclusions from a page that has not settled.
    if (stopped(activeJob)) throw new Stopped();
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
      if (sig !== last) { last = sig; stableSince = now(); }
      else if (frame?.error || flagged(snap, 'signedIn') || flagged(snap, 'checkEmail') ||
               !['identifier', 'password'].includes(stateOf(frame)) || now() - stableSince >= 4000) return snap;
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

// use: 'site' or 'main' picks one source; by default a saved site password wins. `source` is a tag, never the secret.
async function credentialFor(ctx, host, formActionHost = '', { use } = {}) {
  const site = siteFor(ctx.vault, host);
  const main = ctx.vault.identity;
  if (use !== 'main' && site?.password) return { username: site.username || main.email, password: site.password, host: site.host, source: 'site' };
  if (use === 'site') return { missing: true };
  // Nobody approves sign-ins, so the main password only goes where the page is what it claims to be.
  const risk = mainPasswordRisk({ host, formActionHost, knownHosts: Object.keys(ctx.vault.sites), email: main.email });
  if (risk) {
    return {
      blocked: {
        status: 'blocked', reason: 'suspicious_site', site: host, retryable: false, next_action: 'open_official_sign_in',
        message: `Latch did not fill the user's password because ${risk}. Do not enter credentials on this page; open the site's official sign-in page and call sign_in there.`,
      },
    };
  }
  const refused = await approveMain(ctx, host);
  if (refused) return { blocked: refused };
  // Tagged with the host signed in to: a sibling's entry says nothing about this account.
  return { username: site?.username || main.email, password: main.password, host, source: 'main' };
}

// ---------- approving the main password for a new site

// Latch has an entry for this site, whatever made it. Used for display only, never to trust a site.
const knownSite = (vault, host) => Object.keys(vault.sites).some(h => h === host || baseDomain(h) === baseDomain(host));

// Where the main password may go without asking: a site the user allowed or saved themselves, or
// one where the main password already signed in. Entries Latch makes on its own (a reset request,
// a 2FA key, a generated password) say nothing about whether the site deserves the main password.
function trustedForMain(vault, settings, host) {
  const base = baseDomain(host);
  if ((settings.approvedSites || []).includes(base)) return true;
  return Object.entries(vault.sites).some(([h, s]) => baseDomain(h) === base && (s.mainTrusted || s.source === 'you'));
}

const DENIAL_MS = 10 * 60e3;

// null when the main password may be used here, otherwise the result to return.
async function approveMain(ctx, host) {
  if (ctx.byUser || !ctx.meta?.settings?.confirmNewSites || trustedForMain(ctx.vault, ctx.meta.settings, host)) return null;
  // A "Don't allow" holds for a while, so a page cannot keep the approval window popping up.
  const key = `denied:${baseDomain(host)}`;
  const deniedAt = (await chrome.storage.session.get(key))[key];
  const answer = deniedAt && now() - deniedAt < DENIAL_MS ? 'deny' : await askApproval(host, ctx.tabId);
  if (answer === 'allow') return null;
  if (answer === 'deny' && !deniedAt) await chrome.storage.session.set({ [key]: now() });
  const denied = answer === 'deny';
  return {
    status: 'needs_user', reason: denied ? 'approval_denied' : 'approval_missing', site: host, retryable: !denied, next_action: 'ask_user',
    message: denied
      ? `The user chose not to let Latch use their password on ${host}. Do not try again on this site; ask the user how to proceed.`
      : `Latch asked the user to allow signing in to ${host} and got no answer. Ask the user to approve it in the Latch window, then try again.`,
  };
}

const approvals = new Map(); // id -> { host, tabId, resolve }

async function askApproval(host, tabId) {
  beforeAction();
  const id = crypto.randomUUID();
  const answer = new Promise(resolve => approvals.set(id, { host, tabId, resolve }));
  barProgress(tabId, `Waiting for you to allow Latch on ${baseDomain(host)} in the Latch window.`);
  const win = await chrome.windows.create({ url: chrome.runtime.getURL(`approve.html#${id}`), type: 'popup', width: 440, height: 560, focused: true }).catch(() => null);
  if (!win) { approvals.delete(id); return 'unavailable'; }
  const settle = value => approvals.get(id)?.resolve(value);
  const closed = windowId => { if (windowId === win.id) settle('closed'); };
  chrome.windows.onRemoved.addListener(closed);
  const timer = setTimeout(() => settle('timeout'), 180000);
  const watch = setInterval(() => { if (stopped(activeJob)) settle('cancelled'); }, 500);
  const result = await answer;
  approvals.delete(id);
  clearTimeout(timer);
  clearInterval(watch);
  chrome.windows.onRemoved.removeListener(closed);
  chrome.windows.remove(win.id).catch(() => {});
  if (result === 'allow') {
    const { settings } = await getMeta();
    const approvedSites = [...new Set([baseDomain(host), ...(settings.approvedSites || [])])].slice(0, 500);
    await chrome.storage.local.set({ settings: { ...settings, approvedSites } });
    barProgress(tabId, 'Allowed. Signing in…');
  }
  return result;
}

// The other credential to try once after a rejection, or null. Passwords are compared only here.
async function alternativeFor(ctx, host, formActionHost, tried) {
  const site = siteFor(ctx.vault, host);
  if (!site?.password || site.password === ctx.vault.identity.password) return null;
  const cred = await credentialFor(ctx, host, formActionHost, { use: tried === 'site' ? 'main' : 'site' });
  return cred.blocked || cred.missing ? null : cred;
}

const migrated = () => ({ password: null, source: 'main', pendingMain: false, recovery: null, migratedAt: now(), status: 'active', lastUsed: now() });

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

// purpose 'reset' asks only for a password-reset link, which goes to the popup's tab, never to the AI.
async function fetchMail(ctx, host, expect, purpose = 'verify', since) {
  const { usedMail } = await getMeta();
  return ask('mail', {
    imap: ctx.vault.mailbox,
    site: { host },
    since: since ?? (await startedAt(host)) - 60e3,
    expect,
    purpose,
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
  if (recoverySite(ctx.vault, host)) return resetWaiting(host);
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

// Verification never opens a password reset link, whatever the server returns: it would spend the reset token.
const resetLinkish = link => /reset|forgot|recover|(?:change|new|set).?password/i.test(String(link || ''));

async function openPrivately(ctx, url) {
  beforeAction();
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
  const key = totpFor(ctx.vault, host);
  if ((f.appCode && !f.emailCode) || (key && !f.emailCode && !f.phoneCode)) {
    if (!key) {
      return needsUser('authenticator_code', host, 'The site wants a code from an authenticator app, and Latch has no 2FA key for this site. Ask the user for the code, or ask them to add the site\'s 2FA key in Latch.');
    }
    const code = await freshCode(key);
    const refs = frame.digits.length >= 4 ? frame.digits : [frame.fields.find(x => x.kind === 'code').ref];
    await inFrame(ctx.tabId, frame.frameId, 'fillCode', { refs, code });
    ctx.twoFactor = true;
    return null;
  }
  if (f.phoneCode && !f.emailCode) {
    return needsUser('phone_code', host, 'The site sent a code to the user\'s phone. Ask the user to enter it in the tab, then continue.');
  }
  if (!ctx.vault.mailbox) return mailProblem(ctx, {}, host, 'code');
  const mail = await fetchMail(ctx, host, 'code');
  if (!mail.found || (!mail.code && resetLinkish(mail.link))) return mailProblem(ctx, mail.found ? {} : mail, host, 'code');
  if (mail.code) {
    const refs = frame.digits.length >= 4 ? frame.digits : [frame.fields.find(x => x.kind === 'code').ref];
    await inFrame(ctx.tabId, frame.frameId, 'fillCode', { refs, code: mail.code });
  } else {
    if (recoverySite(ctx.vault, host)) return resetWaiting(host);
    await openPrivately(ctx, mail.link);
  }
  await markUsed(mail.key);
  ctx.verified = true;
  return null;
}

const confirmByLink = (ctx, host) => measured('verification_ms', () => confirmByLinkStep(ctx, host));
async function confirmByLinkStep(ctx, host) {
  if (recoverySite(ctx.vault, host)) return { result: resetWaiting(host) };
  if (!ctx.vault.mailbox) return { result: await mailProblem(ctx, {}, host, 'link') };
  const mail = await fetchMail(ctx, host, 'link');
  if (!mail.found || !mail.link || resetLinkish(mail.link)) return { result: await mailProblem(ctx, mail.found ? {} : mail, host, 'link') };
  await openPrivately(ctx, mail.link);
  await markUsed(mail.key);
  ctx.verified = true;
  return { ok: true };
}

// ---------- results

function needsUser(reason, site, message) {
  return { status: 'needs_user', reason, site, message };
}

// While a recovery email is on its way the newest site email may be it, however it is worded,
// so no link is opened and the AI is not sent to the inbox.
function resetWaiting(host) {
  return { ...needsUser('recovery_pending', host, 'A password reset email is on its way for this site, so Latch will not open emailed links here. Open the reset link from the newest email from this site in the user\'s inbox, then call set_new_password on the reset page. Call verify_email again after that if it is still needed.'),
    next_action: 'open_reset_link' };
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
  for (const s of Object.values(vault.sites)) { add(s.password); add(s.username); add(s.previousPassword); add(s.totp?.secret); }
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

async function recordActivity(tool, result, client = '') {
  const { activity } = await getMeta();
  activity.unshift({ at: now(), tool, site: result.site || '', status: result.status, reason: result.reason || '', client });
  await chrome.storage.local.set({ activity: activity.slice(0, 50) });
  notifyPopup();
}

// ---------- flows

// A password reset page is the user's to finish from the popup; Latch fills nothing on it here.
function resetPage(snap, host) {
  const f = snap.find(x => x.reset);
  if (!f) return null;
  return { status: 'reset_form', site: f.host || host, next_action: 'set_new_password',
    message: 'This is a password reset page. Call set_new_password here; Latch chooses, enters and saves the new password.' };
}

// A set-password step can read as a reset form. Once signIn has called it a sign-up,
// createAccount may fill that exact tab and URL; any other reset form stays the user's.
const signupKey = tabId => `signup:${tabId}`;
const rememberSignup = (tabId, url) => chrome.storage.session.set({ [signupKey(tabId)]: url });

async function resetUnlessSignup(tabId, snap, host) {
  const reset = resetPage(snap, host);
  if (!reset) return null;
  const key = signupKey(tabId);
  const url = (await chrome.storage.session.get(key))[key];
  return url === snap.find(x => x.reset).url ? null : reset;
}

const passwordField = frame => frame.fields.find(x => x.kind === 'password' && !x.confirm) || frame.fields.find(x => x.kind === 'password');

async function submitPassword(ctx, frame, pw, cred) {
  const ident = frame.fields.filter(x => (x.kind === 'email' || x.kind === 'username') && (!pw.form || x.form === pw.form));
  const fills = [...ident.map(x => ({ ref: x.ref, value: cred.username })), { ref: pw.ref, value: cred.password }];
  return inFrame(ctx.tabId, frame.frameId, 'fillAndSubmit', { fills, submitRef: pw.ref, purpose: 'login' });
}

async function waitForState(tabId, want, ms) {
  const end = now() + ms;
  let snap = [];
  while (now() < end) {
    if (stopped(activeJob)) throw new Stopped();
    snap = await snapshot(tabId);
    if (stateOf(pickFrame(snap)) === want) break;
    await sleep(350);
  }
  return snap;
}

const retryLeft = (frame, pass) => !pass.altTried && pass.submissions < 2 && !!pass.source &&
  !['locked', 'no_account'].includes(classifySignInError(frame.error || pass.error, frame.flags?.locked));

// After a rejected password, submit the other saved credential once.
// Returns null when there is nothing to try, { result } to stop, or { snap, frame } once submitted.
async function retryPassword(ctx, frame, pass) {
  if (!retryLeft(frame, pass)) return null;
  let snap = null;
  let target = frame;
  if (stateOf(target) !== 'password') {
    // Some sites show the error first and bring the form back a moment later.
    snap = await waitForState(ctx.tabId, 'password', 3000);
    target = pickFrame(snap);
    if (stateOf(target) !== 'password' || target.host !== frame.host || !target.auth?.login) return null;
  }
  // A sign-in form may label its one password new (CGI); a second field means sign-up or reset.
  const passwords = target.fields.filter(x => x.kind === 'password');
  const [pw] = passwords;
  if (target.reset || passwords.length !== 1 || pw.confirm || (pw.isNew && !target.auth?.login)) return null;
  const cred = await alternativeFor(ctx, target.host, target.actions?.[pw.form], pass.source);
  if (!cred) return null;
  if (insecure(target.url)) return { result: blocked(target.host) };
  const r = await submitPassword(ctx, target, pw, cred);
  if (!r?.ok) return { result: changedUnderneath(target.host, 'sign_in') };
  Object.assign(pass, { source: cred.source, credHost: cred.host, altTried: true, submissions: pass.submissions + 1 });
  return { snap, frame: target };
}

async function signIn(ctx) {
  const { tabId } = ctx;
  let snap = await waitForFields(tabId);
  let frame = pickFrame(snap);
  let state = stateOf(frame);
  const tabHost = hostOf(ctx.tab.url);
  const reset = resetPage(snap, tabHost);
  if (reset) return reset;
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
  // Which credential went in last, kept across code and identifier steps. Holds tags and the site's
  // own error text, never values. `returned`: the site came back to its email step after a password.
  const pass = { source: null, credHost: null, altTried: false, pendingMain: false, submissions: 0, error: '', returned: false };
  const failed = f => loginFailed(ctx, f.error ? f : { ...f, error: pass.error }, pass);
  for (let step = 0; step < 7; step++) {
    const host = frame?.host || tabHost;
    if (state !== 'none' && insecure(frame.url)) return blocked(host);
    let before = signature(snap);
    let wait = 40000;
    if (state === 'captcha') {
      return needsUser('captcha', host, 'The site is showing a CAPTCHA. Ask the user to solve it in the tab, then call sign_in again.');
    } else if (state === 'code') {
      if (last?.action === 'code') return codeRejected(ctx, host);
      const stop = await enterCode(ctx, frame);
      if (stop) return stop;
      last = { action: 'code', host };
    } else if (state === 'password') {
      if (last?.action === 'password' && last.host === host) {
        const retry = await retryPassword(ctx, frame, pass);
        if (!retry) return failed(frame);
        if (retry.result) return retry.result;
        wait = 15000; // a second rejection often repeats the first error word for word
      } else {
        // Right after Latch's own email or code step this is a sign-up's password step:
        // a real reset page is reached from an email link.
        const reset = ['identifier', 'code'].includes(last?.action) ? null : resetPage(snap, host);
        if (reset) { await clearAll(tabId); return reset; }
        if (frame.fields.some(x => x.kind === 'password' && (x.isNew || x.confirm)) && !frame.auth?.login) {
          await clearAll(tabId);
          await rememberSignup(tabId, frame.url);
          return { status: 'no_account', site: host, message: 'The site has no account for the user\'s email and is offering to create one. Call create_account on this page.' };
        }
        if (pass.submissions) {
          // Asked again after a password went in: the same credential is never submitted twice.
          const retry = await retryPassword(ctx, frame, pass);
          if (!retry) return failed(frame);
          if (retry.result) return retry.result;
          wait = 15000;
        } else {
          const pw = passwordField(frame);
          const site = siteFor(ctx.vault, host);
          const action = frame.actions?.[pw.form];
          let cred = await credentialFor(ctx, host, action, { use: site?.pendingMain ? 'main' : undefined });
          if (cred.blocked && site?.pendingMain && site.password) cred = await credentialFor(ctx, host, action, { use: 'site' });
          if (cred.blocked) { await clearAll(tabId); return cred.blocked; }
          const r = await submitPassword(ctx, frame, pw, cred);
          if (!r?.ok) return changedUnderneath(host, 'sign_in');
          Object.assign(pass, { source: cred.source, credHost: cred.host, pendingMain: !!site?.pendingMain && cred.source === 'main', submissions: pass.submissions + 1 });
        }
      }
      last = { action: 'password', host };
    } else if (state === 'identifier') {
      if (last && last.action !== 'identifier' && frame.flags.signedIn && !frame.auth?.login) return signedIn(ctx, host, pass);
      if (last?.action === 'identifier' && last.host === host) return failed(frame);
      if (last?.action === 'password' && last.host === host && (frame.error || frame.auth?.login)) {
        // Back at the email step after a password: a rejection, and only the other credential may follow it.
        pass.returned = true;
        if (!retryLeft(frame, pass) || !await alternativeFor(ctx, host, '', pass.source)) return failed(frame);
      }
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
        return signedIn(ctx, host, pass);
      }
      if (flagged(snap, 'signedIn')) return signedIn(ctx, host, pass);
      if (frame?.error) {
        const retry = last?.action === 'password' ? await retryPassword(ctx, frame, pass) : null;
        if (!retry) return failed(frame);
        if (retry.result) return retry.result;
        before = signature(retry.snap || snap);
        wait = 15000;
        last = { action: 'password', host: retry.frame.host };
      } else {
        await clearAll(tabId);
        return { status: 'unconfirmed', site: host, message: 'The sign-in form disappeared, but Latch found no authenticated account control. Inspect the tab before continuing; do not assume sign-in succeeded.' };
      }
    }
    snap = await settle(tabId, before, wait);
    frame = pickFrame(snap);
    if (pass.source && frame?.error) pass.error = frame.error;
    state = flagged(snap, 'signedIn') || flagged(snap, 'checkEmail') ? 'none' : stateOf(frame);
  }
  await clearAll(tabId);
  return { status: 'error', site: tabHost, message: 'Sign-in took more steps than Latch supports. Ask the user to finish signing in.' };
}

async function signedIn(ctx, host, pass) {
  await clearAll(ctx.tabId);
  const siteHost = pass?.credHost || host;
  const entry = ctx.vault.sites[siteHost];
  let patch = { lastUsed: now(), status: 'active' };
  if (entry?.recovery && siteHost === host) patch.recovery = null;
  // The main password worked where a site password was saved, so the site moves to the main password.
  // A shared host keeps it: the saved password may belong to another employer's account there.
  if (pass?.source === 'main' && (entry?.password || entry?.pendingMain)) patch = sharedHost(siteHost) ? { ...patch, pendingMain: false } : migrated();
  else if (pass?.source === 'site' && entry?.pendingMain) patch.pendingMain = false;
  else if (pass?.source === 'main' && !entry) {
    const sibling = siteFor(ctx.vault, host);
    if (sibling?.username) patch.username = sibling.username;
  }
  // The main password went in here with the user's approval (or before approvals existed).
  if (pass?.source === 'main') patch.mainTrusted = true;
  await rememberSite(siteHost, patch);
  const verified = ctx.verified ? { verified: true } : {};
  if (pass?.source === 'main' && (pass.altTried || pass.pendingMain)) {
    return { status: 'signed_in', reason: 'main_password', site: host, ...verified,
      message: 'Signed in with the user\'s main password. Latch now uses the main password for this site. Continue your task in this tab.' };
  }
  return { status: 'signed_in', site: host, ...verified, message: 'Signed in. Continue your task in this tab.' };
}

async function loginFailed(ctx, frame, pass) {
  await clearAll(ctx.tabId);
  const host = frame.host;
  const status = pass?.returned && !frame.error ? 'credentials_or_account_problem' : classifySignInError(frame.error, frame.flags.locked);
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
  if (!frame.error) return { status: 'unconfirmed', site: host, next_action: 'inspect_page', message: 'The sign-in outcome is not confirmed. Inspect the tab before retrying.' };
  return { status: 'sign_in_failed', site: host, message: `The site did not accept the sign-in.${siteSaid(frame.error)}` };
}

async function codeRejected(ctx, host) {
  await clearAll(ctx.tabId);
  if (ctx.twoFactor) {
    return { status: 'verification_failed', reason: 'authenticator_code', site: host, message: 'The site did not accept the 2FA code from Latch\'s saved key. The key may be out of date; ask the user to check the site\'s two-factor settings.' };
  }
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
  const reset = await resetUnlessSignup(tabId, snap, hostOf(ctx.tab.url));
  if (reset) return reset;
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
      const firstPw = frame.fields.find(x => x.kind === 'password');
      const cred = await credentialFor(ctx, host, firstPw && frame.actions?.[firstPw.form]);
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
      const wantsNew = frame.fields.some(x => x.kind === 'password' && (x.isNew || x.confirm));
      if (last?.action === 'identifier' && !wantsNew && frame.auth?.login && !frame.auth?.signup) {
        await clearAll(tabId);
        return accountExists(host, fresh);
      }
      if (last?.action === 'signup' && last.url === frame.url) {
        await clearAll(tabId);
        if (frame.flags.exists) return accountExists(host, fresh);
        // No box Latch can read, but the page began saying a code went out only after this submit.
        if (frame.flags.emailCode && !last.emailCode && !frame.error) return mailProblem(ctx, {}, here, 'code');
        return frame.error ? { status: 'sign_up_failed', site: here, message: `The site did not accept the sign-up.${siteSaid(frame.error)}` } : { status: 'unconfirmed', site: here, next_action: 'inspect_page', message: 'The sign-up outcome is not confirmed. Inspect the tab before retrying.' };
      }
      const reset = await resetUnlessSignup(tabId, snap, here);
      if (reset) {
        await clearAll(tabId);
        if (fresh) await updateVault(v => { delete v.sites[host]; });
        return reset;
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
      last = { action: 'signup', url: frame.url, emailCode: frame.flags.emailCode };
    } else if (state === 'identifier') {
      if (last && last.action !== 'identifier' && (frame.flags.signedIn || !(frame.flags.signupish || frame.flags.loginish))) {
        return accountCreated(ctx, host);
      }
      if (last?.action === 'signup') return accountCreated(ctx, host, 'The site now asks the user to sign in; call sign_in.');
      if (last?.action === 'identifier' && last.url === frame.url) {
        await clearAll(tabId);
        if (frame.flags.exists) return accountExists(host, fresh);
        return frame.error ? { status: 'sign_up_failed', site: here, message: `The site did not accept the email.${siteSaid(frame.error)}` } : { status: 'unconfirmed', site: here, next_action: 'inspect_page', message: 'The email step outcome is not confirmed. Inspect the tab before retrying.' };
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
    state = flagged(snap, 'signedIn') || flagged(snap, 'checkEmail') ? 'none' : stateOf(frame);
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
    if (ctx.twoFactor) return { status: 'verified', reason: 'authenticator_code', site: host, message: 'Entered the 2FA code. Continue your task in this tab.' };
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

async function requestPasswordRecovery(ctx) {
  const { tab, tabId } = ctx;
  const host = hostOf(tab.url);
  if (insecure(tab.url) || new URL(tab.url).protocol !== 'https:') return blocked(host);
  const site = ctx.vault.sites[host];
  const isEmail = s => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
  // A saved account with a user name that is not an email cannot be recovered by email here.
  // Employee systems (a company's own Workday, say) sign in with a work identity, not this one.
  const employeeSystem = isAtsHost(host) && !isCandidatePortal(tab.url);
  const email = site?.status === 'active' && site.username ? (isEmail(site.username) ? site.username : null)
    : !employeeSystem && isEmail(ctx.vault.identity.email) ? ctx.vault.identity.email : null;
  if (!email)
    return { status: 'needs_user', reason: 'identity_uncertain', site: host, next_action: 'inspect_account', message: 'Latch cannot establish an active account with an email username saved for this exact host. Inspect the account before requesting recovery.' };
  const snap = await snapshot(tabId);
  if (flagged(snap, 'recoverySent')) return { status: 'unconfirmed', site: host, next_action: 'inspect_page', message: 'The page already indicates a recovery request. Inspect it before requesting another.' };
  const frames = snap.filter(f => f.top && f.url === tab.url && f.recovery);
  if (frames.length !== 1) return { status: 'no_form', site: host, message: 'Open the site\'s explicit password recovery form, then request recovery again.' };
  activeJob.recoveryTab = tabId;
  activeJob.recoveryFrame = frames[0].frameId;
  activeJob.recoveryDeadline = Math.min(activeJob.deadline - 3000, now() + 20000);
  if (stopped(activeJob)) throw new Stopped();
  await markStart(host);
  const sent = await inFrame(tabId, frames[0].frameId, 'requestRecovery', { email, expectedUrl: tab.url,
    runId: activeJob.id, deadline: activeJob.recoveryDeadline });
  if (sent?.stopped) return { status: sent.acted ? 'outcome_unknown' : 'expired', reason: now() >= activeJob.recoveryDeadline ? 'timed_out' : 'cancelled', site: host, next_action: 'inspect_page', message: 'The recovery request stopped. Inspect the page before retrying.' };
  if (!sent?.ok) return { status: sent?.acted ? 'outcome_unknown' : 'unconfirmed', site: host, next_action: 'inspect_page', message: 'The recovery form changed or was incomplete. Inspect the page before trying anything else.' };
  // Sent, so the newest site email may be this one whether or not the page ever confirms it.
  await rememberSite(host, { recovery: { requestedAt: now() } });
  const until = Math.min(now() + 8000, activeJob.recoveryDeadline);
  while (now() < until) {
    if (stopped(activeJob)) throw new Stopped();
    await sleep(400);
    const current = await chrome.tabs.get(tabId).catch(() => null);
    if (!current || hostOf(current.url) !== host || insecure(current.url)) break;
    const after = await snapshot(tabId);
    if (flagged(after, 'recoverySent')) {
      return { status: 'needs_user', reason: 'recovery_requested', site: host, next_action: 'open_reset_link',
        message: 'Reset email requested. Open the newest email from this site in the user\'s inbox and open its reset link, then call set_new_password on the reset page. Do not request another one.' };
    }
    if (after.some(f => f.error)) break;
  }
  return { status: now() >= activeJob.recoveryDeadline ? 'outcome_unknown' : 'unconfirmed', site: host, next_action: 'inspect_page', message: 'The recovery request was sent, but the site did not confirm its outcome. Inspect the page before retrying.' };
}

// ---------- two-factor codes

// The key for this host, or for the one site on the same domain that has a key.
function totpFor(vault, host) {
  if (vault.sites[host]?.totp) return vault.sites[host].totp;
  const base = baseDomain(host);
  const hits = Object.entries(vault.sites).filter(([h, s]) => s.totp && baseDomain(h) === base);
  return hits.length === 1 ? hits[0][1].totp : null;
}

// Which saved site a 2FA key or new password on `host` belongs to.
function ownerOf(vault, host) {
  if (vault.sites[host]) return host;
  return recoverySite(vault, host)?.host || siteFor(vault, host)?.host || host;
}

// Reads an otpauth:// QR code off the screen when the page shows no key as text.
async function readQrKey(ctx) {
  let tab = await chrome.tabs.get(ctx.tabId).catch(() => null);
  if (!tab) return null;
  // A screenshot shows the window's front tab, so this tab has to be the one in front.
  if (!tab.active) {
    beforeAction();
    tab = await chrome.tabs.update(tab.id, { active: true }).catch(() => null);
    if (!tab?.active) return null;
    await sleep(400);
  }
  const [res] = await chrome.scripting.executeScript({ target: { tabId: ctx.tabId, frameIds: [0] }, func: () => globalThis.__latch?.qrRect() ?? null }).catch(() => []);
  const rect = res?.result;
  if (!rect) return null;
  await sleep(350);
  // The screenshot shows whatever is in front, so it counts only if this tab, at the same
  // address, was in front both before and after it was taken.
  const inFront = async () => { const t = await chrome.tabs.get(tab.id).catch(() => null); return !!t?.active && t.url === tab.url; };
  if (!await inFront()) return null;
  const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }).catch(() => null);
  if (!shot || !await inFront()) return null;
  const image = await createImageBitmap(await (await fetch(shot)).blob());
  const scale = rect.dpr || 1;
  const pad = 12;
  const sx = Math.max(0, Math.floor((rect.x - pad) * scale));
  const sy = Math.max(0, Math.floor((rect.y - pad) * scale));
  const sw = Math.min(image.width - sx, Math.ceil((rect.w + pad * 2) * scale));
  const sh = Math.min(image.height - sy, Math.ceil((rect.h + pad * 2) * scale));
  if (sw < 40 || sh < 40) return null;
  const canvas = new OffscreenCanvas(sw, sh);
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
  const found = jsQR(g.getImageData(0, 0, sw, sh).data, sw, sh, { inversionAttempts: 'attemptBoth' });
  return found?.data ? parseOtpauth(found.data) : null;
}

// After a code goes in: the page has moved past the code step, or shows an error on it.
// A confirmation page has no fields at all, so this does not wait for one like settle() does.
async function stepAnswered(tabId, before, asking, ms = 15000) {
  const end = now() + ms;
  let snap = [];
  await sleep(500);
  while (now() < end) {
    if (stopped(activeJob)) throw new Stopped();
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return [];
    if (tab.status === 'complete') {
      snap = await snapshot(tabId);
      const step = asking(snap);
      if (snap.length && signature(snap) !== before && (!step || step.error || pickFrame(snap)?.error)) return snap;
    }
    await sleep(350);
  }
  return snap;
}
const codeAnswered = (tabId, before) => stepAnswered(tabId, before, snap => snap.find(f => stateOf(f) === 'code'));

async function setupTwoFactor(ctx) {
  const { tabId } = ctx;
  const snap = await waitForFields(tabId, 3000);
  const frame = snap.find(f => f.totpSetup);
  if (!frame) {
    return { status: 'no_form', site: hostOf(ctx.tab.url), message: 'No authenticator app setup found on this page. Open the site\'s two-factor settings, choose the authenticator app option, then try again.' };
  }
  if (insecure(frame.url)) return blocked(frame.host);
  beforeAction();
  const read = await inFrame(tabId, frame.frameId, 'readTotpSetup');
  let key = read?.uri ? parseOtpauth(read.uri) : read?.secret ? parseKey(read.secret) : null;
  if (!key && frame.totpSetup.qr) key = await readQrKey(ctx);
  if (!key) {
    return needsUser('totp_key_unreadable', frame.host, 'Latch could not read the setup key. Press the page\'s "Can\'t scan it?" or "enter the key manually" link so the key shows as text, then try again.');
  }
  const host = ownerOf(ctx.vault, frame.host);
  const saved = { secret: key.secret, digits: key.digits, period: key.period, algorithm: key.algorithm, issuer: key.issuer || '', addedAt: now(), verified: false };
  await updateVault(v => {
    v.sites[host] ||= { username: v.identity.email, password: null, source: 'main', createdAt: now(), status: 'active' };
    v.sites[host].totp = saved;
  });
  // Most sites ask for one code to confirm the key before turning 2FA on.
  const current = (await snapshot(tabId)).find(f => f.frameId === frame.frameId) || frame;
  const refs = current.digits.length >= 4 ? current.digits : current.fields.filter(x => x.kind === 'code').map(x => x.ref).slice(0, 1);
  if (!refs.length) {
    return { status: 'two_factor_saved', site: host, verified: false,
      message: 'Saved the 2FA key. When the site asks for a code to confirm it, call verify_email.' };
  }
  const before = signature([current]);
  await inFrame(tabId, current.frameId, 'fillCode', { refs, code: await freshCode(saved) });
  const after = await codeAnswered(tabId, before);
  const still = after.find(f => stateOf(f) === 'code');
  if (still?.error) {
    await updateVault(v => { if (v.sites[host]) delete v.sites[host].totp; });
    return { status: 'verification_failed', reason: 'authenticator_code', site: host,
      message: `The site did not accept the code from the key Latch read, so Latch dropped that key. Ask the user to check the setup page.${siteSaid(still.error)}` };
  }
  if (still) {
    return { status: 'unconfirmed', site: host, verified: false, next_action: 'inspect_page',
      message: 'Saved the 2FA key and entered a code, but the site has not confirmed 2FA is on. Inspect the page before continuing.' };
  }
  await updateVault(v => { if (v.sites[host]?.totp) v.sites[host].totp.verified = true; });
  return { status: 'two_factor_saved', site: host, verified: true,
    message: 'Saved the 2FA key and confirmed it with a code. Latch enters this site\'s 2FA codes from now on. If the site shows backup codes, ask the user to keep them somewhere safe.' };
}

// ---------- forgotten passwords: choosing the new one

async function setNewPassword(ctx) {
  const { tabId } = ctx;
  const snap = await waitForFields(tabId, 3000);
  const frames = snap.filter(f => f.reset);
  if (frames.length !== 1) {
    return { status: 'no_form', site: hostOf(ctx.tab.url), message: 'No new-password form found in this tab. Open the reset link from the site\'s email first, then try again.' };
  }
  const [frame] = frames;
  if (insecure(frame.url)) return blocked(frame.host);
  if (!frame.top && baseDomain(frame.host) !== baseDomain(hostOf(ctx.tab.url))) {
    return { status: 'no_form', site: hostOf(ctx.tab.url), message: 'The new-password form here belongs to another site, so Latch left it alone.' };
  }
  const fields = frame.fields.filter(x => frame.reset.pw.includes(x.ref));
  const owner = ownerOf(ctx.vault, frame.host);
  let password = null;
  let source = 'latch';
  if (ctx.meta.settings.newPasswords === 'mine') {
    const cred = await credentialFor(ctx, frame.host, frame.actions?.[fields[0]?.form] || '', { use: 'main' });
    if (cred.blocked) return cred.blocked;
    if (fits(cred.password, fields)) { password = cred.password; source = 'main'; }
  }
  if (!password) {
    password = generatePassword(fields);
    if (!fits(password, fields)) password = generatePassword(fields, true);
  }
  const previous = ctx.vault.sites[owner] ? structuredClone(ctx.vault.sites[owner]) : null;
  // Saved before it goes into the page, so an interruption never loses the new password.
  await updateVault(v => {
    const s = v.sites[owner] || { username: v.identity.email, createdAt: now() };
    v.sites[owner] = { ...s, password: source === 'latch' ? password : null, source, pendingMain: source === 'main',
      previousPassword: s.password || null, status: 'active', recovery: null, resetAt: now(), lastUsed: now() };
  });
  const before = signature(snap);
  const r = await inFrame(tabId, frame.frameId, 'fillResetAndSubmit', { refs: frame.reset.pw, value: password, expectedUrl: frame.url });
  const restore = () => updateVault(v => { if (previous) v.sites[owner] = previous; else delete v.sites[owner]; });
  if (!r?.ok) {
    if (!r?.filled) await restore();
    await clearAll(tabId);
    return changedUnderneath(frame.host, 'set_new_password');
  }
  const after = await stepAnswered(tabId, before, snap => snap.find(f => f.reset), 20000);
  const again = after.find(f => f.reset);
  const shown = pickFrame(after);
  if (again && (again.error || shown?.error) && !flagged(after, 'resetDone')) {
    // The form is still there with an error: the site kept the old password.
    await restore();
    await clearAll(tabId);
    return { status: 'reset_failed', site: frame.host, message: `The site did not accept the new password.${siteSaid(again.error || shown.error)}` };
  }
  await clearAll(tabId);
  return { status: 'password_reset', site: owner,
    message: 'Set a new password and saved it in Latch. If the site asks you to sign in, call sign_in.' };
}

const FLOWS = { sign_in: signIn, create_account: createAccount, verify_email: verifyEmail, fill_email: fillEmail, request_password_recovery: requestPasswordRecovery,
  setup_two_factor: setupTwoFactor, set_new_password: setNewPassword };

// Tools that drive Chrome over DevTools know a tab by its address, not by its extension tab ID.
async function resolveTab({ tabId, url } = {}) {
  if (Number.isInteger(tabId)) return chrome.tabs.get(tabId).catch(() => null);
  if (typeof url === 'string' && url) {
    const tabs = await chrome.tabs.query({});
    const bare = u => String(u || '').split('#')[0];
    const exact = t => t.url === url || t.pendingUrl === url;
    return tabs.find(t => exact(t) && t.active) || tabs.find(exact) || tabs.find(t => bare(t.url) === bare(url)) || null;
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

// The server asks this when several browsers are connected, to send the call to the right one.
async function locateTab(args) {
  const tab = args.application
    ? (Number.isInteger(args.tabId) ? await chrome.tabs.get(args.tabId).catch(() => null)
      : (await chrome.tabs.query({})).find(t => t.url === args.url || t.pendingUrl === args.url))
    : await resolveTab(args).catch(() => null);
  if (!tab || (args.exactUrl && tab.url !== args.url)) return { found: false, focused: false };
  const win = await chrome.windows.get(tab.windowId).catch(() => null);
  return { found: true, focused: !!win?.focused };
}

// Workday re-enables Save and Continue only from an animation frame, and Chrome runs none in a background tab.
function keepFrames(workdayOnly = false) {
  if (workdayOnly && !/(^|\.)myworkdayjobs\.com$/i.test(location.hostname)) return;
  if (window.__latchFrames) return;
  window.__latchFrames = true;
  const request = window.requestAnimationFrame.bind(window);
  const cancel = window.cancelAnimationFrame.bind(window);
  const waiting = new Map();
  window.requestAnimationFrame = callback => {
    const run = time => {
      if (!waiting.has(handle)) return;
      clearTimeout(waiting.get(handle));
      waiting.delete(handle);
      callback(time);
    };
    const handle = request(run);
    waiting.set(handle, setTimeout(() => run(performance.now()), 100));
    return handle;
  };
  window.cancelAnimationFrame = handle => {
    clearTimeout(waiting.get(handle));
    waiting.delete(handle);
    cancel(handle);
  };
}

class Unanswered extends Error {}

// One script step, bounded so that a timeout unwinds through the caller's normal cleanup.
function answered(work, ms) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Unanswered()), ms); });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

async function applicationTool(args, job) {
  const meta = await getMeta();
  if (meta.settings.paused) return { status: 'paused', message: 'Latch is paused.' };
  const expectedOrigin = new URL(args.url).origin;
  let tab;
  if (args.operation === 'open') {
    const tabs = await chrome.tabs.query({});
    tab = Number.isInteger(args.tabId) ? await chrome.tabs.get(args.tabId).catch(() => null) :
      tabs.find(t => t.url === args.url || t.pendingUrl === args.url);
    if (tab && tab.url !== args.url && tab.pendingUrl !== args.url)
      return { status: 'tab_not_found', message: 'The specified tab does not show the exact URL.' };
    if (!tab) { beforeAction(); tab = await chrome.tabs.create({ url: args.url, active: false }); }
    await tabReady(tab.id);
  } else {
    if (!Number.isInteger(args.tabId)) return { status: 'tab_not_found', message: 'A tab ID is required for this operation.' };
    tab = await chrome.tabs.get(args.tabId).catch(() => null);
  }
  if (!tab) return { status: 'tab_not_found', message: 'The specified tab was not found.' };
  // Its address holds a reset token, so this tool neither works on the tab nor reports the address.
  if (await resetTabSite(tab.id)) return { status: 'blocked', reason: 'reset_tab', tabId: tab.id, message: 'The user is finishing a password reset in this tab. Leave it alone.' };
  const current = await chrome.tabs.get(tab.id).catch(() => null);
  let origin;
  try { origin = new URL(current?.url || '').origin; } catch {}
  if (origin !== expectedOrigin) return { status: 'blocked', tabId: tab.id, message: 'The tab origin does not match the requested origin.' };
  if (args.operation === 'organize') {
    if (!chrome.tabGroups) return { status: 'unavailable', tabId: tab.id, message: 'This build of Latch does not organize tabs.' };
    beforeAction();
    // Finished applications wait together for the user; everything else is work in progress.
    const [title, color] = args.ready ? ['Ready to submit', 'green'] : ['Applications', 'grey'];
    const groups = await chrome.tabGroups.query({ title, windowId: current.windowId });
    const groupId = await chrome.tabs.group(groups.length ? { tabIds: tab.id, groupId: groups[0].id } : { tabIds: tab.id });
    if (!groups.length) await chrome.tabGroups.update(groupId, { title, color });
    return { status: 'ok', tabId: tab.id, url: current.url };
  }
  if (args.operation === 'close') {
    beforeAction();
    await chrome.tabs.remove(tab.id);
    return { status: 'ok', tabId: tab.id, url: current.url };
  }
  if (args.operation === 'open') return { status: 'ok', tabId: tab.id, url: current.url };
  if (stopped(job)) throw new Stopped();
  const target = { tabId: tab.id, frameIds: [0] };
  job.applicationTab = tab.id;
  // Chrome freezes idle background tabs, and a script sent to one waits forever, holding up every later call.
  const sleeping = { status: 'blocked', reason: 'tab_asleep', tabId: tab.id, url: current.url, message: 'Chrome has put this tab to sleep, so nothing was done in it.' };
  if (current.frozen || current.discarded) return sleeping;
  try {
    await answered(chrome.scripting.executeScript({ target, world: 'MAIN', func: keepFrames }).catch(() => {}), 10000);
    await answered(chrome.scripting.executeScript({ target, files: ['application-scan.js', 'application.js'] }), 10000);
  } catch (err) {
    if (err instanceof Unanswered) return sleeping;
    throw err;
  }
  if (stopped(job)) throw new Stopped();
  if (args.operation !== 'scan') beforeAction();
  const deadline = Math.min(job.deadline - 3000, now() + 42000);
  // The page refuses to start, and stops working, at its deadline, so a late answer cannot act.
  const [response] = await answered(chrome.scripting.executeScript({ target, func: input => globalThis.__jobApply.run(input),
    args: [{ operation: args.operation, expectedOrigin, fills: args.fills, entries: args.entries,
      runId: job.id, deadline }] }), deadline - now() + 3000);
  const after = await chrome.tabs.get(tab.id).catch(() => null);
  return { ...(response?.result || { status: 'error', message: 'Application engine returned no result.' }), tabId: tab.id, url: after?.url || current.url };
}

// byUser: the user started this themselves in the popup, so no approval window is needed.
// It is passed in code, never taken from a caller's message.
async function runTool(tool, args, client = '', job = null, { byUser = false } = {}) {
  if (tool === 'application_page') {
    activeJob = job;
    try { return await applicationTool(args, job); }
    catch (err) { return { status: job?.acted ? 'outcome_unknown' : 'error', message: 'Application operation did not complete. Inspect the tab before repeating an action.' }; }
    finally { activeJob = null; }
  }
  const started = now();
  observation = { snap: [], actions: [], detection_ms: 0, fill_submit_ms: 0, page_wait_ms: 0, verification_ms: 0 };
  activeJob = job;
  let vault;
  let result;
  let tab = null;
  try {
    vault = await readVault();
    const meta = await getMeta();
    if (!vault.identity) {
      result = { status: 'not_set_up', message: 'Latch is not set up yet. Ask the user to click the Latch icon in Chrome and add their email and password.' };
    } else if (meta.settings.paused) {
      result = { status: 'paused', message: 'The user has paused Latch. Ask them to sign in themselves or turn Latch back on.' };
    } else if (typeof tool !== 'string' || !Object.hasOwn(FLOWS, tool)) {
      result = { status: 'error', message: 'Unknown Latch tool.' };
    } else {
      tab = await resolveTab(args);
      if (tool === 'request_password_recovery' && tab && tab.url !== args.url) tab = null;
      // A frozen tab never answers a script, and the call would hold up everything queued behind it.
      const asleep = tab?.frozen || tab?.discarded;
      if (asleep) tab = null;
      // A press is for the page it was made on; if the tab has moved on since, nothing runs.
      let originNow = '';
      try { originNow = new URL(tab?.url || '').origin; } catch {}
      const moved = !!tab && typeof args.expectOrigin === 'string' && originNow !== args.expectOrigin;
      result = moved ? { status: 'error', message: 'The page changed before Latch could start. Look at the page again before pressing.' }
        : tab
        ? await FLOWS[tool]({ tab, tabId: tab.id, vault, meta, verified: false, client, byUser })
        : { status: 'error', message: asleep ? 'Chrome has put that tab to sleep, so nothing was done in it. Open the page again.' : !Number.isInteger(args.tabId) && args.url
          ? 'No open tab shows that address. Pass the tab\'s current URL or its tabId.'
          : 'That tab does not exist. Pass the tabId from your browser tools.' };
      if (tab && tool !== 'fill_email' && !(tool === 'request_password_recovery' && (stopped(job) || now() >= (job.recoveryDeadline || Infinity) || ['outcome_unknown', 'expired'].includes(result.status)))) await clearAll(tab.id);
    }
  } catch (err) {
    // Nothing more is filled or submitted; values Latch already put in the page are cleared.
    if (tab && tool !== 'fill_email' && tool !== 'request_password_recovery') await clearAll(tab.id);
    if (err instanceof Stopped) {
      result = job.acted
        ? { status: 'outcome_unknown', reason: 'cancelled', message: 'Latch stopped partway because the caller stopped waiting, so the page may already have changed. Inspect the tab before doing anything else.' }
        : { status: 'expired', message: 'Latch stopped before filling anything because the caller stopped waiting. Call it again if it is still needed.' };
    } else {
      console.warn('latch:', tool, err?.name || 'error');
      result = { status: 'error', message: 'Latch hit a problem on this page. Try again, or ask the user to sign in themselves.' };
    }
  }
  activeJob = null;
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
    wrong_password: 'stop_retries', sign_in_failed: 'inspect_page', unconfirmed: 'inspect_page', no_form: 'inspect_page',
    outcome_unknown: 'inspect_page', two_factor_saved: 'continue', password_reset: 'sign_in', reset_failed: 'inspect_page' })[result.status];
  result.timings = { scope: 'tool_call', total_ms: now() - started, detection_ms: observation.detection_ms, fill_submit_ms: observation.fill_submit_ms,
    page_wait_ms: observation.page_wait_ms, verification_ms: observation.verification_ms };
  observation = null;
  // The flow may have saved new secrets (a generated or reset password, a 2FA key), so scrub
  // against the vault as it is now as well as as it was.
  result = redact(redact(result, vault || emptyVault()), await readVault().catch(() => emptyVault()));
  await recordActivity(tool, result, client).catch(() => {});
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

// The site a reset tab opened by Latch belongs to, if this is one.
async function resetTabSite(tabId) {
  const key = `resetTab:${tabId}`;
  return (await chrome.storage.session.get(key))[key] || null;
}

// Fills the user's main password into both fields of the reset form in front of them. The user presses the page's button.
async function fillResetHere() {
  if ((await getMeta()).settings.paused) return { ok: false, reason: 'paused', message: 'Latch is paused.' };
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !/^https:/.test(tab.url || '')) return { ok: false, reason: 'not_https', message: 'Latch only fills passwords on secure (https) pages.' };
  const vault = await readVault();
  if (!vault.identity?.password) return { ok: false, reason: 'not_set_up', message: 'Add your email and password to Latch first.' };
  const frames = (await snapshot(tab.id, { observe: false })).filter(f => f.reset);
  if (frames.length !== 1) return { ok: false, reason: 'no_form', message: 'Latch could not find exactly one password reset form on this page.' };
  const [frame] = frames;
  if (!/^https:/.test(frame.url || '')) return { ok: false, reason: 'not_https', message: 'Latch only fills passwords on secure (https) pages.' };
  if (!frame.top && baseDomain(frame.host) !== baseDomain(hostOf(tab.url))) return { ok: false, reason: 'no_form', message: 'Latch could not find exactly one password reset form on this page.' };
  // The reset belongs to the site that asked for it, which may be another subdomain than this page.
  const opened = await resetTabSite(tab.id);
  const owner = opened && baseDomain(opened) === baseDomain(frame.host) ? opened
    : vault.sites[frame.host] ? frame.host : recoverySite(vault, frame.host)?.host;
  if (!owner) return { ok: false, reason: 'unknown_site', message: 'Latch has no account or recovery request for this site, so it did not fill your password.' };
  const fields = frame.fields.filter(x => frame.reset.pw.includes(x.ref));
  if (fields.length !== 2) return { ok: false, reason: 'no_form', message: 'Latch could not find exactly one password reset form on this page.' };
  const risk = mainPasswordRisk({ host: frame.host, formActionHost: frame.actions?.[fields[0].form] || '', knownHosts: Object.keys(vault.sites), email: vault.identity.email });
  if (risk) return { ok: false, reason: 'suspicious_site', message: `Latch did not fill your password because ${risk}.` };
  if (!fits(vault.identity.password, fields)) return { ok: false, reason: 'password_policy', message: 'This site\'s password rules do not accept your main password.' };
  const r = await inFrame(tab.id, frame.frameId, 'fillReset', { refs: frame.reset.pw, value: vault.identity.password, expectedUrl: frame.url });
  if (!r?.ok) return { ok: false, reason: 'changed', message: 'The page changed before Latch could fill it. Try again.' };
  await rememberSite(owner, { pendingMain: true, resetAt: now() });
  return { ok: true, message: 'Filled your main password. Press the page\'s button to save it.' };
}

const resetLookups = new Set(); // hosts with an openResetLink running, so one email is never opened twice

async function openResetLink(host) {
  if (resetLookups.has(host)) return { ok: false, reason: 'busy' };
  resetLookups.add(host);
  try { return await findResetLink(host); }
  finally { resetLookups.delete(host); }
}

// Fetches the newest reset email for `host` and opens its link in a tab the user keeps. The AI never sees the link.
async function findResetLink(host) {
  const vault = await readVault();
  if (!vault.mailbox) return { ok: false, reason: 'no_inbox' };
  const requestedAt = vault.sites[host]?.recovery?.requestedAt;
  const mail = await fetchMail({ vault }, host, 'link', 'reset', (requestedAt || now()) - 60e3);
  if (mail.error) return { ok: false, reason: 'mail_error', error: mail.error };
  if (!mail.found) return { ok: false, reason: 'not_found' };
  let url = null;
  try { url = new URL(mail.link); } catch {}
  if (!url || url.protocol !== 'https:' || url.username || url.password || !resetLinkAllowed(url.hostname, host)) return { ok: false, reason: 'link_rejected' };
  const tab = await chrome.tabs.create({ url: url.href, active: true });
  await chrome.storage.session.set({ [`resetTab:${tab.id}`]: host });
  await markUsed(mail.key);
  await updateVault(v => {
    const s = v.sites[host];
    if (s) s.recovery = { requestedAt: s.recovery?.requestedAt || now(), ...s.recovery, openedAt: now() };
  });
  return { ok: true, tabId: tab.id };
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
      .map(([host, s]) => ({ host, source: s.source, createdAt: s.createdAt, lastUsed: s.lastUsed, status: s.status, verified: !!s.verified,
        hasPassword: !!s.password, username: s.username && s.username !== vault.identity?.email ? s.username : '',
        totp: !!s.totp, totpVerified: !!s.totp?.verified, issuer: s.totp?.issuer || '' }))
      .sort((a, b) => (b.lastUsed || b.createdAt || 0) - (a.lastUsed || a.createdAt || 0)),
    resets: Object.entries(vault.sites)
      .filter(([, s]) => s.recovery || s.pendingMain)
      .map(([host, s]) => ({ host, requestedAt: s.recovery?.requestedAt || null, openedAt: s.recovery?.openedAt || null, resetAt: s.resetAt || null, pendingMain: !!s.pendingMain }))
      .sort((a, b) => Math.max(b.requestedAt || 0, b.openedAt || 0, b.resetAt || 0) - Math.max(a.requestedAt || 0, a.openedAt || 0, a.resetAt || 0)),
    connected: connected(),
    clients: bridge.clients,
    version: chrome.runtime.getManifest().version,
  };
}

// What a tab offers, read without filling anything.
async function describePage(tab, vault) {
  if (!tab || !/^https?:/.test(tab.url || '')) return { kind: 'blank', host: '' };
  const snap = await snapshot(tab.id, { observe: false });
  const resetFrame = snap.find(f => f.reset);
  const setupFrame = snap.find(f => f.totpSetup);
  const frame = resetFrame || setupFrame || pickFrame(snap);
  const st = stateOf(frame);
  const host = frame?.host || hostOf(tab.url);
  const flags = frame?.flags || {};
  const key = !!totpFor(vault, host);
  let kind = 'none';
  if (resetFrame) kind = 'reset';
  else if (setupFrame) kind = 'totp_setup';
  else if (st === 'captcha') kind = 'captcha';
  else if (st === 'code') {
    if ((flags.appCode && !flags.emailCode) || (key && !flags.emailCode && !flags.phoneCode)) kind = 'totp';
    else kind = flags.phoneCode && !flags.emailCode ? 'phone_code' : 'code';
  } else if (frame?.recovery && frame.top && st === 'identifier') kind = 'recovery';
  else if (frame?.auth?.login && st !== 'none') kind = 'sign_in';
  else if (frame?.auth?.signup && st !== 'none') kind = 'sign_up';
  else if (snap.some(f => f.recovery && f.top)) kind = 'recovery';
  else if (flagged(snap, 'checkEmail')) kind = 'check_email';
  else if (flagged(snap, 'signedIn')) kind = 'signed_in';
  return { kind, host, saved: !!siteFor(vault, host)?.password, known: knownSite(vault, host), totp: key, pendingReset: !!recoverySite(vault, host) };
}

// ---------- the on-page bar

const BAR_LABELS = {
  sign_in: 'Sign in with Latch', create_account: 'Create account with Latch', code: 'Enter code with Latch', totp: 'Enter 2FA code with Latch',
  totp_setup: 'Set up 2FA with Latch', reset: 'Set new password with Latch', recovery: 'Send reset email with Latch', setup: 'Set up Latch',
};
const BAR_TOOLS = { sign_in: 'sign_in', create_account: 'create_account', code: 'verify_email', totp: 'verify_email', totp_setup: 'setup_two_factor',
  reset: 'set_new_password', recovery: 'request_password_recovery' };
const BUSY_TEXT = { sign_in: 'Signing in…', create_account: 'Creating the account…', code: 'Entering the code…', totp: 'Entering the 2FA code…',
  totp_setup: 'Saving the 2FA key…', reset: 'Setting a new password…', recovery: 'Asking for a reset email…' };
const TOOL_LABELS = { sign_in: BAR_LABELS.sign_in, create_account: BAR_LABELS.create_account, verify_email: BAR_LABELS.code,
  set_new_password: BAR_LABELS.reset, request_password_recovery: BAR_LABELS.recovery, setup_two_factor: BAR_LABELS.totp_setup };
const AI = 'AI assistants: ';

// Results are written for tool callers; on the page the tools are buttons.
function forPage(text) {
  const tools = Object.keys(TOOL_LABELS).join('|');
  return String(text || '')
    .replace(/ The site says: ".*"$/, '')
    .replace(/use fill_email to fill its email field without submitting it/g, 'fill its email field directly')
    .replace(new RegExp(`\\b(?:call|use) (${tools})\\b`, 'g'), (_, t) => `press "${TOOL_LABELS[t]}"`)
    .replace(new RegExp(`\\b(${tools})\\b`, 'g'), (_, t) => `"${TOOL_LABELS[t]}"`);
}

const GOOD = new Set(['signed_in', 'account_created', 'verified', 'filled', 'two_factor_saved', 'password_reset']);
const WAITING = new Set(['needs_user', 'check_inbox', 'verification_pending', 'unconfirmed', 'retry_blocked', 'expired', 'outcome_unknown',
  'no_form', 'account_exists', 'no_account', 'form_incomplete', 'paused']);
const toneOf = r => (GOOD.has(r.status) ? 'good' : WAITING.has(r.status) ? 'wait' : 'bad');

const offer = (action, host, note, agent) => ({ host, action, label: BAR_LABELS[action], note, agent });
const press = action => `press "${BAR_LABELS[action]}"`;

async function barModel(tab) {
  const vault = await readVault().catch(() => emptyVault());
  if (!vault.identity) {
    return offer('setup', hostOf(tab.url), 'Latch can sign in on pages like this once you add your email and password.',
      `${AI}Latch is installed but not set up. Ask the user to press "Set up Latch"; it takes under a minute.`);
  }
  const page = await describePage(tab, vault);
  const h = page.host;
  const inbox = !!vault.mailbox && connected();
  const webmail = !inbox && ['code', 'check_email'].includes(page.kind) ? await webmailFor(vault.identity.email).catch(() => '') : '';
  switch (page.kind) {
    case 'sign_in':
      return offer('sign_in', h, 'Latch signs in with your saved details.',
        `${AI}${press('sign_in')} instead of typing an email or password. Latch fills them privately and reports the result here.`);
    case 'sign_up':
      return offer('create_account', h, 'Latch creates the account with your email and a new strong password.',
        `${AI}fill in the other fields first and leave email and password empty, then ${press('create_account')}.`);
    case 'totp':
      // Offered whether or not a key is saved, so the page cannot tell which.
      return offer('totp', h, 'Latch can enter the code from your authenticator app if it has the key for this site.',
        `${AI}${press('totp')}. If Latch has no key for this site, ask the user for the code.`);
    case 'phone_code':
      return { host: h, note: `${h} sent a code to your phone.`, agent: `${AI}ask the user for the code sent to their phone.` };
    case 'code':
      return inbox
        ? offer('code', h, 'Latch reads the emailed code from your inbox and enters it.', `${AI}${press('code')}.`)
        : { host: h, note: `${h} emailed a code.`, linkUrl: webmail, linkLabel: 'Open inbox',
          agent: `${AI}open the user's inbox, read the newest email from ${h}, and type its code here. Latch is not connected to the inbox.` };
    case 'check_email':
      return { host: h, note: `${h} emailed a link.`, linkUrl: webmail, linkLabel: 'Open inbox',
        agent: `${AI}open the user's inbox and open the link in the newest email from ${h}.` };
    case 'totp_setup':
      return offer('totp_setup', h, 'Latch can keep this site\'s 2FA key and enter its codes for you.', `${AI}${press('totp_setup')} to save the key and confirm it with a code.`);
    case 'reset':
      return offer('reset', h, 'Latch chooses a strong new password, enters it and saves it.', `${AI}${press('reset')}. Do not type a password yourself.`);
    case 'recovery':
      return offer('recovery', h, 'Latch enters your email address and asks for a reset link.',
        `${AI}${press('recovery')}, then open the reset link from the newest email in the user's inbox.`);
    case 'captcha':
      return { host: h, note: 'This page shows a CAPTCHA.', agent: `${AI}ask the user to solve the CAPTCHA, then continue.` };
    default:
      return null;
  }
}

const bars = new Map();       // tabId -> { frames: Map(frameId -> probe), timer, model, busy, busyModel, presses }
const barResults = new Map(); // tabId -> the last result of a flow the bar ran, shown for a while
const RESULT_MS = 30000;
let barSeq = 0;

function barEntry(tabId) {
  let entry = bars.get(tabId);
  if (!entry) bars.set(tabId, entry = { frames: new Map(), timer: null, model: null, busy: false, busyModel: null, presses: [] });
  return entry;
}

chrome.tabs.onRemoved.addListener(tabId => { bars.delete(tabId); barResults.delete(tabId); });
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' && bars.has(tabId)) bars.get(tabId).frames.clear();
});

function scheduleBar(tabId, ms = 250) {
  const entry = barEntry(tabId);
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => evaluateBar(tabId).catch(() => {}), ms);
}

function onProbe(sender, sig) {
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId) || !Number.isInteger(sender.frameId)) return;
  const entry = barEntry(tabId);
  entry.frames.set(sender.frameId, typeof sig === 'string' ? sig.slice(0, 40) : '');
  if (entry.frames.size > 200) entry.frames.delete(entry.frames.keys().next().value);
  scheduleBar(tabId);
}

function pushBar(tab, model) {
  let origin = '';
  try { origin = new URL(tab.url).origin; } catch {}
  chrome.tabs.sendMessage(tab.id, { type: 'bar:state', model, origin }, { frameId: 0 }).catch(() => {});
}

async function evaluateBar(tabId) {
  const entry = bars.get(tabId);
  const tab = entry && await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !/^https?:/.test(tab.url || '')) return;
  if (entry.busy) return pushBar(tab, entry.busyModel);
  const { settings } = await getMeta();
  let model = null;
  if (!settings.paused && settings.bar !== false && [...entry.frames.values()].some(Boolean)) model = await barModel(tab).catch(() => null);
  const done = barResults.get(tabId);
  if (done && now() - done.at < RESULT_MS && baseDomain(done.host) === baseDomain(hostOf(tab.url))) {
    model = { host: hostOf(tab.url), ...(model || {}), status: done.text, tone: done.tone };
    if (!model.action && !model.linkUrl && done.linkUrl) Object.assign(model, { linkUrl: done.linkUrl, linkLabel: 'Open inbox' });
  }
  entry.model = model;
  pushBar(tab, model);
}

// Progress for a flow the bar started, shown while it runs.
function barProgress(tabId, text) {
  const entry = bars.get(tabId);
  if (!entry?.busy) return;
  entry.busyModel = { ...entry.busyModel, status: text, tone: 'wait' };
  chrome.tabs.get(tabId).then(tab => pushBar(tab, entry.busyModel)).catch(() => {});
}

// A press on the bar's button. The content script has already checked that it was a
// trusted input event on an unobscured, untampered bar; this checks it against what
// Latch is offering on that tab right now.
async function barAct(sender, action) {
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId) || sender.frameId !== 0) return { ok: false };
  const entry = barEntry(tabId);
  if (!entry.model && !entry.busy) {
    // Chrome stops an idle worker and its memory goes with it, so after a long look at the
    // page this works out again what the page offers before trusting the press.
    const [tab, { settings }] = await Promise.all([chrome.tabs.get(tabId).catch(() => null), getMeta()]);
    entry.frames.set(0, entry.frames.get(0) || 'press');
    if (tab && !settings.paused && settings.bar !== false) entry.model = await barModel(tab).catch(() => null);
  }
  if (!entry.model?.action || entry.model.action !== action) return { ok: false, message: 'Latch no longer offers that on this page. Wait a moment, then look at the page again.' };
  if (entry.busy) return { ok: false, message: 'Latch is already working on this page.' };
  entry.presses = entry.presses.filter(t => now() - t < 60000);
  if (entry.presses.length >= 6) return { ok: false, message: 'Latch was pressed many times in a row here, so it is waiting a minute before trying again.' };
  entry.presses.push(now());
  if (action === 'setup') {
    await chrome.tabs.create({ url: chrome.runtime.getURL('app.html#welcome'), index: (sender.tab.index ?? 0) + 1 });
    return { ok: true };
  }
  const tool = BAR_TOOLS[action];
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tool || !tab || hostOf(tab.url) !== hostOf(sender.url || '')) return { ok: false, message: 'The page changed. Press again.' };
  entry.busy = true;
  entry.busyModel = { ...entry.model, busy: true, status: BUSY_TEXT[action], tone: 'wait' };
  barResults.delete(tabId);
  pushBar(tab, entry.busyModel);
  const job = { id: `page-${++barSeq}`, ws: null, deadline: now() + 240000, cancelled: false, acted: false };
  enqueue(() => runTool(tool, { tabId, url: tab.url, expectOrigin: new URL(tab.url).origin }, 'page', job)).then(result => {
    entry.busy = false;
    barResults.set(tabId, { at: now(), host: result.site || hostOf(tab.url), text: forPage(result.message), tone: toneOf(result), linkUrl: result.inbox || '' });
    scheduleBar(tabId, 700);
    setTimeout(() => scheduleBar(tabId, 0), RESULT_MS + 500);
  }, () => { entry.busy = false; scheduleBar(tabId, 0); });
  return { ok: true };
}

// ---------- extension pages (popup, Latch app, approval window)

const normalizeHost = input => {
  const text = String(input || '').trim().toLowerCase();
  try { return new URL(/^[a-z]+:\/\//.test(text) ? text : `https://${text}`).hostname; } catch { return ''; }
};

const popupHandlers = {
  state: () => popupState(),
  pageState: async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return describePage(tab, await readVault().catch(() => emptyVault()));
  },
  // Password resets are the user's action: these run only from the popup, never from a bridge call.
  fillReset: () => fillResetHere(),
  openResetLink: ({ host }) => openResetLink(String(host || '')),
  dismissReset: async ({ host }) => {
    await updateVault(v => {
      const s = v.sites[String(host || '')];
      if (s) { s.recovery = null; s.pendingMain = false; }
    });
    return { ok: true };
  },
  // The user runs a flow on the tab in front of them, exactly as the AI would.
  runHere: async ({ tool }) => {
    if (!['sign_in', 'create_account', 'verify_email', 'set_new_password', 'setup_two_factor', 'request_password_recovery'].includes(tool)) {
      return { status: 'error', message: 'Unknown action.' };
    }
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || !/^https?:/.test(tab.url || '')) return { status: 'error', message: 'Open the site\'s page first.' };
    const job = { id: `you-${++barSeq}`, ws: null, deadline: now() + 120000, cancelled: false, acted: false };
    const result = await enqueue(() => runTool(tool, { tabId: tab.id, url: tab.url }, 'you', job, { byUser: true }));
    return { ...result, message: forPage(result.message) };
  },
  codes: async () => {
    const vault = await readVault();
    const out = [];
    for (const [host, s] of Object.entries(vault.sites)) {
      if (!s.totp) continue;
      out.push({ host, issuer: s.totp.issuer || '', verified: !!s.totp.verified, code: await totp(s.totp), left: secondsLeft(s.totp), period: s.totp.period || 30 });
    }
    return out.sort((a, b) => a.host.localeCompare(b.host));
  },
  addTotp: async ({ host, key }) => {
    const site = normalizeHost(host);
    const parsed = parseKey(key);
    if (!site || !site.includes('.')) return { ok: false, reason: 'host' };
    if (!parsed) return { ok: false, reason: 'key' };
    await updateVault(v => {
      if (!v.identity) throw new Error('not set up');
      v.sites[site] ||= { username: v.identity.email, password: null, source: 'main', createdAt: now(), status: 'active' };
      v.sites[site].totp = { secret: parsed.secret, digits: parsed.digits, period: parsed.period, algorithm: parsed.algorithm, issuer: parsed.issuer, addedAt: now(), verified: false };
      // The user named this site themselves, so it may receive the main password without asking.
      v.sites[site].mainTrusted = true;
    });
    return { ok: true, host: site };
  },
  removeTotp: async ({ host }) => {
    await updateVault(v => { if (v.sites[String(host || '')]) delete v.sites[String(host)].totp; });
    return { ok: true };
  },
  saveSite: async ({ host, username, password }) => {
    const site = normalizeHost(host);
    if (!site || !site.includes('.') || typeof password !== 'string' || !password) return { ok: false };
    await updateVault(v => {
      if (!v.identity) throw new Error('not set up');
      const s = v.sites[site] || { createdAt: now() };
      v.sites[site] = { ...s, username: String(username || '').trim() || v.identity.email, password, source: 'you', status: 'active', pendingMain: false };
    });
    return { ok: true, host: site };
  },
  'approval:get': ({ id }) => {
    const a = approvals.get(String(id || ''));
    return a ? { host: a.host, base: baseDomain(a.host) } : { gone: true };
  },
  'approval:answer': ({ id, answer }) => {
    approvals.get(String(id || ''))?.resolve(answer === 'allow' ? 'allow' : 'deny');
    return { ok: true };
  },
  'approval:ping': () => ({ ok: true }),
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
    const allowed = ['paused', 'newPasswords', 'confirmNewSites', 'bar', 'approvedSites'];
    const clean = Object.fromEntries(Object.entries(patch || {}).filter(([k]) => allowed.includes(k)));
    await chrome.storage.local.set({ settings: { ...settings, ...clean } });
    refreshBars();
    return { ok: true };
  },
  reveal: async ({ host }) => ({ password: (await readVault()).sites[host]?.password || '' }),
  forget: async ({ host }) => { await updateVault(v => { delete v.sites[host]; }); return { ok: true }; },
  erase: async () => {
    // The build of the loaded code is not user data, and a later browser restart still needs it.
    const { build } = await chrome.storage.local.get('build');
    await chrome.storage.local.clear();
    if (build) await chrome.storage.local.set({ build });
    await keyStore('readwrite', s => s.clear());
    keyPromise = null;
    return { ok: true };
  },
};

// After these, what the bar offers on open pages may have changed.
const CHANGES_BARS = new Set(['saveIdentity', 'addTotp', 'removeTotp', 'saveSite', 'forget', 'erase', 'saveMailbox', 'removeMailbox']);
const refreshBars = () => { for (const tabId of bars.keys()) scheduleBar(tabId, 0); };

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || typeof msg?.type !== 'string') return false;
  if (sender.url?.startsWith(chrome.runtime.getURL(''))) {
    const handler = Object.hasOwn(popupHandlers, msg.type) && popupHandlers[msg.type];
    if (!handler) return false;
    Promise.resolve(handler(msg)).then(r => { if (CHANGES_BARS.has(msg.type)) refreshBars(); reply(r); }, () => reply({ ok: false, error: true }));
    return true;
  }
  // Content scripts: the bar's probe and its button.
  if (!sender.tab) return false;
  if (msg.type === 'bar:probe') { onProbe(sender, msg.sig); return false; }
  if (msg.type === 'bar:act') {
    barAct(sender, String(msg.action || '')).then(reply, () => reply({ ok: false }));
    return true;
  }
  return false;
});

function notifyPopup() {
  chrome.runtime.sendMessage({ type: 'changed' }).catch(() => {});
}

// The approval window keeps the worker awake while the user decides.
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'approval' || !port.sender?.url?.startsWith(chrome.runtime.getURL(''))) return;
  port.onMessage.addListener(() => {});
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const vault = await readVault().catch(() => emptyVault());
  if (reason === 'install' && !vault.identity) chrome.tabs.create({ url: chrome.runtime.getURL('app.html#welcome') }).catch(() => {});
  if (reason === 'update') {
    // Earlier versions never asked before using the main password; keep that for existing setups.
    const { settings = {} } = await chrome.storage.local.get('settings');
    if (vault.identity && !('confirmNewSites' in settings)) await chrome.storage.local.set({ settings: { ...settings, confirmNewSites: false } });
  }
  // Pages that were already open get the bar without a reload.
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }).catch(() => []);
  for (const tab of tabs) {
    if (!tab.discarded && !tab.frozen) chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['bar.js'] }).catch(() => {});
  }
});
