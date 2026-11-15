#!/usr/bin/env node
// MCP server for Latch. The AI calls these tools; the work happens in the Latch
// Chrome extension, which connects to this process over a loopback WebSocket.
// The first server to start owns the port; later ones relay through it.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { z } from 'zod';
import { EXTENSION_ID, STORE_ID } from '../extension/id.js';
import { fingerprint, BRIDGE_PROTOCOL } from '../extension/build.js';
import { checkMailbox, findVerification, lookupProvider } from './mail.js';

const VERSION = '1.0.0';
const PORT = Number(process.env.LATCH_PORT || 47801);
// The unpacked copy and the Chrome Web Store copy have different IDs. LATCH_EXTENSION_IDS adds others.
const EXTRA_IDS = String(process.env.LATCH_EXTENSION_IDS || '').split(',').map(s => s.trim()).filter(id => /^[a-p]{32}$/.test(id));
const EXTENSION_ORIGINS = new Set([EXTENSION_ID, STORE_ID, ...EXTRA_IDS].filter(Boolean).map(id => `chrome-extension://${id}`));
// Only the unpacked copy runs files from this checkout, so only it is compared against them.
// Store copies update through the store and need only a matching bridge protocol.
const DEV_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
const log = msg => process.stderr.write(`latch: ${msg}\n`);

const UNAVAILABLE = {
  status: 'unavailable',
  message: 'Latch is not connected to Chrome. Ask the user to open Chrome with the Latch extension turned on, then try again.',
};
// Once a call has reached Chrome, a missing result does not mean nothing happened there.
const TIMED_OUT = { status: 'outcome_unknown', reason: 'timed_out', next_action: 'inspect_page',
  message: 'Latch did not report back in time, so the step may have run. Inspect the tab before doing anything else; do not repeat the step blindly.' };
const DROPPED = { status: 'outcome_unknown', reason: 'connection_lost', next_action: 'inspect_page',
  message: 'Latch lost its connection to Chrome after the step was sent, so it may have run. Inspect the tab before doing anything else; do not repeat the step blindly.' };
const CHECK_FAILED = { status: 'error', message: 'Latch could not finish the connection check. Try again.' };
const FAILED = { status: 'error', message: 'Latch hit a problem before sending anything to Chrome. Try again.' };
const RELOAD_REQUIRED = { status: 'reload_required', message: 'Latch has been updated. Reload the Latch extension on chrome://extensions, then try again.' };
const TAB_NOT_FOUND = { status: 'tab_not_found', message: 'No connected browser confirmed the requested tab. Pass its current URL or tab ID; no credential action was sent.' };

// Everything returned to the AI passes through this shape; unknown keys are dropped.
const Result = z.object({
  status: z.string().regex(/^[a-z_]{2,40}$/),
  site: z.string().max(253).regex(/^[a-z0-9.-]*$/i).optional(),
  reason: z.string().regex(/^[a-z_]{2,40}$/).optional(),
  message: z.string().max(600).optional(),
  inbox: z.string().url().max(200).optional(),
  verified: z.boolean().optional(),
  retryable: z.boolean().optional(),
  next_action: z.string().regex(/^[a-z_]{2,60}$/).optional(),
  paths: z.object(Object.fromEntries(['email', 'password', 'google', 'linkedin', 'microsoft', 'apple', 'facebook', 'sso', 'create_account', 'guest'].map(key => [key, z.boolean().optional()]))).optional(),
  evidence: z.object({
    actions: z.array(z.enum(['login_submit', 'signup_submit', 'code_submit', 'verification_submit'])).max(4),
    signals: z.array(z.enum(['account_control', 'email_verification_text', 'email_code_text', 'lock_text', 'existing_account_text'])).max(5),
    captcha: z.boolean(), error_observed: z.boolean(),
  }).optional(),
  account: z.object({ creation: z.enum(['created', 'existing', 'unknown']), email_verification: z.enum(['pending', 'verified', 'unknown']), session: z.enum(['signed_in', 'unknown']) }).optional(),
  timings: z.object({ scope: z.literal('tool_call'), total_ms: z.number().nonnegative(), detection_ms: z.number().nonnegative(), fill_submit_ms: z.number().nonnegative(),
    page_wait_ms: z.number().nonnegative(), verification_ms: z.number().nonnegative() }).optional(),
  missing: z.array(z.string().max(80)).max(12).optional(),
  connections: z.object(Object.fromEntries(['connected', 'ready', 'current', 'lookup_replies', 'matched']
    .map(key => [key, z.number().int().nonnegative()]))).optional(),
});

const TOOLS = new Set(['application_page', 'create_account', 'fill_email', 'inspect_connection', 'request_password_recovery', 'set_new_password', 'setup_two_factor', 'sign_in', 'verify_email']);

function checkedResult(tool, result) {
  const safe = (tool === 'application_page' ? ApplicationResult : Result).safeParse(result);
  return safe.success ? safe.data : { status: 'error', message: 'Latch returned an unexpected result.' };
}

const EXTENSION_DIR = process.env.LATCH_EXTENSION_DIR || fileURLToPath(new URL('../extension/', import.meta.url));

// File timestamps can change without a code update (checkout, sync or editor). A file that cannot
// be read mid-checkout matches no browser, so every browser counts as stale until it is back.
const extensionBuild = () => fingerprint(name => readFile(join(EXTENSION_DIR, name), 'utf8')).catch(() => null);

let clientName = 'AI';
let wss = null;          // set when this process owns the port
// One socket per Chrome running Latch (owner only): the user's own browser and, say, a
// separate automation profile stay connected side by side.
const extensions = new Map(); // socket -> { ready, build, since }
const peers = new Set(); // relay sockets from other Latch servers (owner only)
let upstream = null;     // socket to the owner (relay only)
const pending = new Map(); // id -> done, with done.ws (socket asked) and done.kind
const connectWaiters = new Set();
let seq = 0;
let listeningSince = 0;
// Every server process numbers from 1, so ids carry a per-process prefix: a browser's late answer
// to an earlier owner must not match a call from the next one.
const INSTANCE = randomBytes(6).toString('hex');
const nextId = () => `${INSTANCE}.${++seq}`;
// Browsers reconnect on a 30-second alarm, so a new owner may not have heard from all of them yet.
const SETTLE_MS = 32000;

const send = (ws, msg) => {
  if (ws?.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(msg));
  return true;
};
const parse = data => {
  try {
    const msg = JSON.parse(String(data));
    return msg && typeof msg === 'object' ? msg : {};
  } catch {
    return {};
  }
};
const targeted = args => Number.isInteger(args?.tabId) || !!args?.url;

function clients() {
  return [clientName, ...[...peers].map(p => p.clientName).filter(Boolean)];
}

function failPending(result, ws) {
  for (const [id, done] of pending) {
    if (ws && done.ws !== ws) continue;
    pending.delete(id);
    done(done.lost || result);
  }
}

function greetExtensions() {
  for (const ws of extensions.keys()) send(ws, { type: 'hello', version: VERSION, clients: clients() });
}

function listen() {
  return new Promise((resolve, reject) => {
    const server = new WebSocketServer({
      host: '127.0.0.1',
      port: PORT,
      maxPayload: 1 << 20,
      verifyClient: ({ origin, req }) => EXTENSION_ORIGINS.has(origin) || (!origin && req.url === '/peer'),
    });
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}

function onConnection(ws, req) {
  if (req.url === '/peer') {
    peers.add(ws);
    ws.on('message', data => onPeerMessage(ws, data).catch(err => log(`relay message failed: ${err.code || err.name}`)));
    ws.on('close', () => {
      peers.delete(ws);
      // Nobody is waiting for these any more, so Chrome should stop working on them.
      for (const [id, done] of pending) {
        if (done.peer !== ws) continue;
        send(done.ws, { type: 'cancel', id });
        done(DROPPED);
      }
      greetExtensions();
    });
    return;
  }
  // A reloaded extension's old socket closes with its worker, so connections are not replaced here.
  extensions.set(ws, { ready: false, build: '', since: ++seq, origin: String(req.headers.origin || '') });
  ws.on('message', data => onExtensionMessage(ws, data).catch(err => log(`extension message failed: ${err.code || err.name}`)));
  ws.on('close', () => {
    extensions.delete(ws);
    failPending(DROPPED, ws);
  });
  send(ws, { type: 'hello', version: VERSION, clients: clients() });
  log(`extension connected (${extensions.size} open)`);
}

async function onExtensionMessage(ws, data) {
  const msg = parse(data);
  switch (msg.type) {
    case 'ready': {
      const ext = extensions.get(ws);
      if (!ext) break;
      ext.ready = true;
      ext.build = typeof msg.build === 'string' ? msg.build : '';
      ext.protocol = msg.protocol;
      for (const wake of connectWaiters) wake();
      connectWaiters.clear();
      break;
    }
    case 'ping':
      send(ws, { type: 'pong' });
      break;
    case 'result':
    case 'located': {
      // Only the browser a request went to may answer it.
      const done = pending.get(msg.id);
      if (done?.ws === ws && done.kind === (msg.type === 'result' ? 'call' : 'locate')) done(msg.type === 'result' ? msg.result : msg);
      break;
    }
    case 'mail':
    case 'mail_check':
    case 'provider': {
      let result;
      try {
        result = msg.type === 'mail' ? await findVerification(msg.request || {}) :
          msg.type === 'mail_check' ? await checkMailbox(msg.request || {}) : await lookupProvider(msg.request?.domain);
      } catch (err) {
        log(`${msg.type} failed: ${err.code || err.name}`);
        result = { error: 'failed' };
      }
      send(ws, { type: 'reply', id: msg.id, result });
      break;
    }
  }
}

async function onPeerMessage(ws, data) {
  const msg = parse(data);
  if (msg.type === 'hello') {
    ws.clientName = String(msg.client || '').slice(0, 60);
    greetExtensions();
  } else if (msg.type === 'call') {
    // Anything local can reach this socket, so it gets the same tools and result shape as an MCP client.
    if (!TOOLS.has(msg.tool)) return send(ws, { type: 'result', id: msg.id, result: { status: 'error', message: 'Unknown Latch tool.' } });
    let result;
    try {
      result = msg.tool === 'inspect_connection' ? await inspectConnection(msg.args) :
        await callExtension(msg.tool, msg.args, Math.min(Number(msg.timeoutMs) || 60000, 90000), ws.clientName, ws);
    } catch (err) {
      log(`relayed ${String(msg.tool).slice(0, 40)} failed: ${err.code || err.name}`);
      result = msg.tool === 'inspect_connection' ? CHECK_FAILED : FAILED;
    }
    send(ws, { type: 'result', id: msg.id, result: checkedResult(msg.tool, result) });
  }
}

function nextReady(ms) {
  return new Promise(resolve => {
    const wake = () => { clearTimeout(timer); connectWaiters.delete(wake); resolve(); };
    const timer = setTimeout(wake, ms);
    connectWaiters.add(wake);
  });
}

// Ask one browser whether it has the tab a call is about, and whether that window is in front.
function locate(ws, args) {
  const id = nextId();
  return new Promise(resolve => {
    const done = r => { clearTimeout(timer); pending.delete(id); resolve({ found: r?.found === true, focused: r?.focused === true, replied: r?.type === 'located' }); };
    const timer = setTimeout(() => done({}), 2000);
    Object.assign(done, { ws, kind: 'locate' });
    pending.set(id, done);
    if (!send(ws, { type: 'locate', id, args: { tabId: args?.tabId, url: args?.url, application: args?.application, exactUrl: args?.exactUrl } })) done({});
  });
}

// Which browsers are ready and current and, for a request naming a tab, which of them have it.
// Stale browsers are asked as well: if one of them may hold the tab, the fix is a reload.
async function look(args) {
  const build = await extensionBuild();
  const fresh = e => e.origin !== DEV_ORIGIN || e.build === build;
  const isCurrent = e => fresh(e) && e.protocol === BRIDGE_PROTOCOL;
  const ready = [...extensions].filter(([, e]) => e.ready);
  const current = ready.filter(([, e]) => isCurrent(e));
  const staleReason = e => (fresh(e) ? 'unsupported_worker' : 'stale_worker');
  const answers = targeted(args) && current.length ? await Promise.all(ready.map(async ([ws, e]) =>
    ({ ws, since: e.since, current: isCurrent(e), stale: staleReason(e), ...await locate(ws, args) }))) : [];
  const connections = { connected: extensions.size, ready: ready.length, current: current.length,
    lookup_replies: answers.filter(a => a.replied).length, matched: answers.filter(a => a.found).length };
  const target = answers.filter(a => a.current && a.found);
  const holder = answers.find(a => !a.current && a.found);
  const silent = answers.some(a => !a.current && !a.replied);
  let status = 'ready';
  let reason = 'connection_verified';
  if (!ready.length) [status, reason] = ['unavailable', 'no_ready_browser'];
  else if (!current.length) [status, reason] = ['reload_required', ready.some(([, e]) => fresh(e)) ? 'unsupported_worker' : 'stale_worker'];
  else if (targeted(args) && !target.length && (holder || silent)) [status, reason] = ['reload_required', holder ? holder.stale : 'stale_browser_may_hold_target'];
  else if (targeted(args) && !target.length) {
    [status, reason] = ['tab_not_found', answers.some(a => a.current && a.replied) ? 'target_not_in_connected_browser' : 'no_target_lookup_reply'];
  }
  return { status, reason, connections, current, target };
}

// Waits up to 30 s for a browser when none is ready. While this owner is new it also keeps
// waiting for a browser that has not connected yet before reporting the tab missing.
async function survey(args, { reload = false } = {}) {
  const started = Date.now();
  for (;;) {
    const found = await look(args);
    if (found.status === 'ready') return found;
    let until = Math.min(started + 30000, found.connections.ready ? listeningSince + SETTLE_MS : Infinity);
    if (reload && found.status === 'reload_required' && await askStaleReload()) until = Math.max(until, Math.min(started + 30000, Date.now() + 15000));
    if (Date.now() >= until) return found;
    await nextReady(until - Date.now());
  }
}

// An extension running files older than the ones on disk is asked to reload itself, so an update
// does not wait for someone to press Reload on chrome://extensions. The extension refuses while busy.
const reloadAsked = new Map(); // build -> time of the last request
async function askStaleReload() {
  const build = await extensionBuild();
  if (!wss || !build) return false;
  const since = Date.now() - (reloadAsked.get(build) || 0);
  if (since < 60000) return since < 20000;
  let asked = false;
  for (const [ws, e] of extensions) if (e.ready && e.origin === DEV_ORIGIN && e.build !== build && send(ws, { type: 'reload', build })) asked = true;
  if (asked) { reloadAsked.set(build, Date.now()); log('asked an out-of-date extension to reload'); }
  return asked;
}

// Read-only bridge/target inspection. Never asks an extension to run an authentication flow.
async function inspectConnection(args = {}) {
  const { status, reason, connections } = await survey(args);
  return { status, reason, connections, message: 'Read-only connection check. No authentication action was sent; ready does not verify account setup or sign-in.' };
}

// Up-to-date connections win over stale ones. Among several browsers the call goes to the one that
// has the tab, then the one in front, then the most recent connection.
async function pickExtension(args, { current, target }) {
  const score = a => (a.found ? 2 : 0) + (a.focused ? 1 : 0);
  const byScore = answers => answers.sort((a, b) => score(b) - score(a) || b.since - a.since)[0]?.ws ?? null;
  if (targeted(args)) return byScore(target);
  if (current.length < 2) return current[0]?.[0] ?? null;
  return byScore(await Promise.all(current.map(async ([ws, e]) => ({ ws, since: e.since, ...await locate(ws, args) }))));
}

async function callExtension(tool, args, timeoutMs, client = clientName, peer = null) {
  const app = tool === 'application_page';
  const recovery = tool === 'request_password_recovery';
  const found = await survey(app || recovery ? { ...args, application: true, exactUrl: recovery } : args, { reload: true });
  if (app && args.operation === 'open' && found.status === 'tab_not_found' && !Number.isInteger(args.tabId) &&
      found.connections.connected === 1 && found.connections.ready === 1 && found.connections.current === 1 && found.connections.lookup_replies === 1) {
    found.status = 'ready';
    found.target = [{ ws: found.current[0][0], found: true }];
  }
  if ((app || recovery) && found.target.length > 1) return { status: 'blocked', message: 'The target is present in multiple connected browsers; routing is ambiguous.' };
  const refused = { unavailable: UNAVAILABLE, reload_required: RELOAD_REQUIRED, tab_not_found: TAB_NOT_FOUND }[found.status];
  if (refused) return { ...refused, reason: found.reason };
  const ws = await pickExtension(args, found);
  if (!ws) return UNAVAILABLE;
  const id = nextId();
  return new Promise(resolve => {
    const done = result => { clearTimeout(timer); pending.delete(id); resolve(result); };
    // Chrome skips the call if it is still queued at the deadline, and stops before its next
    // fill or submit once cancelled.
    const timer = setTimeout(() => { send(ws, { type: 'cancel', id }); done(TIMED_OUT); }, timeoutMs);
    Object.assign(done, { ws, kind: 'call', peer });
    pending.set(id, done);
    if (!send(ws, { type: 'call', id, tool, args, client, deadline: Date.now() + timeoutMs })) done(UNAVAILABLE);
  });
}

function connectUpstream() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/peer`);
    ws.once('open', () => {
      upstream = ws;
      send(ws, { type: 'hello', client: clientName });
      resolve();
    });
    ws.once('error', reject);
    ws.on('message', data => {
      const msg = parse(data);
      const done = pending.get(msg.id);
      if (msg.type === 'result' && done?.kind === 'relay') done(msg.result);
    });
    ws.on('close', () => {
      if (upstream !== ws) return;
      upstream = null;
      failPending(DROPPED);
      setTimeout(() => claimRole().catch(() => {}), 300);
    });
  });
}

async function claimRole() {
  try {
    wss = await listen();
    listeningSince = Date.now();
    wss.on('connection', onConnection);
    wss.on('error', err => log(`server error: ${err.code || err.message}`));
    log(`listening on 127.0.0.1:${PORT}`);
  } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err;
    await connectUpstream();
    log('relaying through the running Latch server');
  }
}

async function call(tool, args, timeoutMs) {
  if (!wss && !upstream) await claimRole().catch(() => {});
  let result;
  const lost = tool === 'inspect_connection' ? CHECK_FAILED : null;
  try {
    if (wss) {
      result = tool === 'inspect_connection' ? await inspectConnection(args) : await callExtension(tool, args, timeoutMs);
    } else if (upstream) {
      const id = nextId();
      // The owner may wait up to about 34 s for a browser before it sends the call on.
      result = await new Promise(resolve => {
        const done = r => { clearTimeout(timer); pending.delete(id); resolve(r); };
        const timer = setTimeout(() => done(lost || TIMED_OUT), timeoutMs + 40000);
        Object.assign(done, { kind: 'relay', lost });
        pending.set(id, done);
        if (!send(upstream, { type: 'call', id, tool, args, timeoutMs })) done(UNAVAILABLE);
      });
    } else {
      result = UNAVAILABLE;
    }
  } catch (err) {
    log(`${tool} failed: ${err.code || err.name}`);
    result = lost || FAILED;
  }
  const out = checkedResult(tool, result);
  log(`${tool} -> ${out.status}`);
  return { content: [{ type: 'text', text: JSON.stringify(out) }] };
}

const server = new McpServer(
  { name: 'latch', version: VERSION },
  {
    instructions:
      'Latch signs the user in and creates accounts in their Chrome tabs without revealing their email, ' +
      'password or verification codes to you. Browse with your normal Chrome tools and call Latch only ' +
      'when a page needs the user to sign in, create an account, verify their email, or enter their email address. ' +
      'Never ask the user for their password and never type credentials yourself. ' +
      'If a result has status check_inbox, use an available connected mail tool to read only the newest matching verification email ' +
      'from that site; otherwise use the user\'s webmail tab. Enter its code or open its confirmation link yourself, then continue. ' +
      'This is an automated agent step, not a request for the user to fetch the email.',
  },
);

const tabArg = {
  tabId: z.number().int().optional().describe('Chrome tab ID from your browser tools. Defaults to the active tab.'),
  // Single sign-on redirects can carry long state, so the cap only has to stay under the bridge's 1 MiB messages.
  url: z.string().url().max(65536).optional().describe('The tab\'s current address, for browser tools that do not expose Chrome tab IDs (Playwright, DevTools). Used when tabId is not given.'),
};

const ApplicationResult = z.object({
  status: z.string().regex(/^[a-z_]{2,40}$/), message: z.string().max(600).optional(),
  reason: z.string().max(80).optional(), next_action: z.string().max(80).optional(),
  tabId: z.number().int().optional(), url: z.string().max(65536).optional(),
  page: z.unknown().optional(), snapshot: z.unknown().optional(), results: z.unknown().optional(),
});
const appValue = z.union([z.string().max(20000), z.number(), z.boolean(), z.array(z.string().max(20000)).max(100), z.null()]);
const appFill = z.object({
  id: z.string().max(500), label: z.string().max(1000), kind: z.string().max(80), action: z.string().max(80),
  value: appValue, parts: z.array(z.string().max(100)).max(20).optional(),
  document: z.object({ name: z.string().max(255), mime: z.string().max(120), base64: z.string().max(700000).regex(/^[A-Za-z0-9+/]*={0,2}$/), sha256: z.string().regex(/^[a-f0-9]{64}$/i) }).strict().optional(),
}).strict();
const appEntries = z.object(Object.fromEntries(['work', 'education', 'websites', 'languages', 'projects'].map(key =>
  [key, z.union([z.number().int().min(0).max(100), z.array(z.unknown()).max(100)]).optional()]))).strict();
server.registerTool('application_page', {
  title: 'Work on an application page',
  description: 'Open, scan, fill, advance, organize or close a specific application tab using typed application data.',
  inputSchema: {
    operation: z.enum(['open', 'scan', 'fill', 'next', 'organize', 'close']),
    url: z.string().url().max(65536).refine(value => { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; } }),
    tabId: z.number().int().nonnegative().optional(), fills: z.array(appFill).max(200).optional(),
    entries: appEntries.optional(), ready: z.boolean().optional(),
  },
}, args => {
  if ((args.operation !== 'open' && !Number.isInteger(args.tabId)) || (args.operation === 'organize' && typeof args.ready !== 'boolean')) return { content: [{ type: 'text', text: JSON.stringify({ status: 'blocked', message: 'This operation requires a tab ID and organize requires ready.' }) }] };
  if (Buffer.byteLength(JSON.stringify(args), 'utf8') > 850000) return { content: [{ type: 'text', text: JSON.stringify({ status: 'blocked', message: 'Application data exceeds the bridge size limit.' }) }] };
  return call('application_page', args, 58000);
});

server.registerTool('inspect_connection', {
  title: 'Check browser connection',
  description: 'Read-only check of connected extension builds and whether a browser can locate the requested tab. Never signs in, fills fields, creates an account or reads credentials. Ready verifies routing only, not account setup.',
  inputSchema: tabArg,
}, args => call('inspect_connection', args, 10000));

server.registerTool('request_password_recovery', {
  title: 'Request password recovery',
  description: 'Use when the user has forgotten a password. On the exact HTTPS tab already showing a "forgot password" form, privately enters the user\'s email (or the user name saved for that site) and asks the site for a reset email. Then open the reset link from the newest email from that site in the user\'s inbox and call set_new_password on the page it opens. Do not request again. If interrupted or timed out, inspect the page before any retry because the request may have been sent.',
  inputSchema: {
    url: z.string().url().max(65536).refine(value => { try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; } }),
    tabId: z.number().int().nonnegative().optional(),
  },
}, args => call('request_password_recovery', args, 30000));

server.registerTool('sign_in', {
  title: 'Sign in',
  description:
    'Sign the user in on the website open in a Chrome tab. Use it whenever a page asks the user to log in or a session has expired. ' +
    'Latch fills the saved email and password privately, submits, enters email verification codes and authenticator (2FA) codes if the site asks, and returns the outcome. ' +
    'You never see the email, password or codes. Afterwards, continue with your normal browser tools.',
  inputSchema: tabArg,
}, args => call('sign_in', args, 58000));

server.registerTool('set_new_password', {
  title: 'Set a new password',
  description:
    'On a password reset page (reached from a reset email link), Latch chooses a strong new password, enters it in both fields, submits, ' +
    'and saves it for that site so later sign-ins use it. You never see the password. Use after request_password_recovery, or whenever a site makes the user choose a new password.',
  inputSchema: tabArg,
}, args => call('set_new_password', args, 58000));

server.registerTool('setup_two_factor', {
  title: 'Set up two-factor authentication',
  description:
    'On a site\'s authenticator-app 2FA setup page (the one showing a QR code or setup key), Latch reads and saves the key privately, ' +
    'enters the confirmation code, and from then on fills that site\'s 2FA codes during sign_in and verify_email. ' +
    'If the key is only in a QR code, keep the tab in front so Latch can read it. Ask the user to store any backup codes the site shows.',
  inputSchema: tabArg,
}, args => call('setup_two_factor', args, 58000));

server.registerTool('create_account', {
  title: 'Create account',
  description:
    'Create an account for the user on the sign-up page open in a Chrome tab. Before calling, fill any other fields yourself ' +
    '(name, etc.) and tick required boxes, but leave email and password fields empty. Latch fills the user\'s email and uses ' +
    'the saved New account passwords setting (Same as mine or Unique), then saves, submits and verifies email. If the result lists missing fields, ' +
    'fill them and call again; a retry reuses the same saved password.',
  inputSchema: tabArg,
}, args => call('create_account', args, 58000));

server.registerTool('verify_email', {
  title: 'Verify email',
  description:
    'Finish an email verification step, for example when a page says a code or link was sent to the user\'s email. ' +
    'Latch reads only the matching recent message from that site, then enters the code in the tab or opens the link privately. ' +
    'Codes and links are not shown to you, unless the user has not connected their inbox; then the result is check_inbox ' +
    'and tells you how to fetch the email yourself.',
  inputSchema: tabArg,
}, args => call('verify_email', args, 55000));

server.registerTool('fill_email', {
  title: 'Fill email',
  description:
    'Type the user\'s email address into an email field (for example on a job application) without revealing it to you. ' +
    'Fills the focused field if it is a text field, otherwise the first empty email field. Does not submit.',
  inputSchema: tabArg,
}, args => call('fill_email', args, 20000));

server.server.oninitialized = () => {
  const info = server.server.getClientVersion();
  if (info?.name) clientName = String(info.name).slice(0, 60);
  greetExtensions();
  send(upstream, { type: 'hello', client: clientName });
};

await claimRole().catch(err => log(`could not open the Chrome bridge: ${err.code || err.message}`));
// Optional persistent owner for repeated local jobctl runs; ordinary MCP clients still use stdio.
const bridgeOnly = process.argv.includes('--bridge-only');
if (!bridgeOnly) await server.connect(new StdioServerTransport());

const shutdown = () => {
  wss?.close();
  upstream?.close();
  process.exit(0);
};
if (!bridgeOnly) process.stdin.on('end', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
