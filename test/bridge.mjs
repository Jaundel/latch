import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { EXTENSION_ID } from '../extension/id.js';
import { BUILD_FILES, BRIDGE_PROTOCOL, fingerprint } from '../extension/build.js';
import { PAGES, TAB_URL, page as framePage, startWorker } from './worker.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'latch-bridge-'));
const ext = join(work, 'extension');
cpSync(join(root, 'extension'), ext, { recursive: true });
const files = BUILD_FILES;
const build = createHash('sha256').update(JSON.stringify(files.map(name => {
  try { return readFileSync(join(ext, name), 'utf8'); } catch { return ''; }
}))).digest('hex');
const mcp = new Client({ name: 'latch-bridge-test', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'server/index.js')], env: { ...process.env, LATCH_PORT: '47831', LATCH_EXTENSION_DIR: ext }, stderr: 'pipe' });
let ws;
let calls = 0;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, what, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}
const text = res => JSON.parse(res.content[0].text);
const closed = sock => sock.readyState === WebSocket.CLOSED ? Promise.resolve() : new Promise(resolve => sock.once('close', resolve));

async function startServer(port) {
  const client = new Client({ name: 'latch-bridge-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'server/index.js')],
    env: { ...process.env, LATCH_PORT: String(port), LATCH_EXTENSION_DIR: ext }, stderr: 'pipe' }));
  return client;
}

// One Chrome running Latch: it answers locate from `has` and hands calls to `onCall`.
function browser(port, { reports = build, protocol = BRIDGE_PROTOCOL, has = () => true, locates = true, onCall = () => {} } = {}) {
  const sock = new WebSocket(`ws://127.0.0.1:${port}`, { origin: `chrome-extension://${EXTENSION_ID}` });
  const seen = [];
  const ready = new Promise((resolve, reject) => {
    sock.once('error', reject);
    sock.on('message', raw => {
      const msg = JSON.parse(String(raw));
      seen.push(msg);
      if (msg.type === 'hello') {
        sock.send(JSON.stringify({ type: 'ready', build: reports, protocol }));
        setTimeout(resolve, 100);
      } else if (msg.type === 'locate' && locates) {
        sock.send(JSON.stringify({ type: 'located', id: msg.id, found: has(msg.args), focused: false }));
      } else if (msg.type === 'call') {
        onCall(msg, sock);
      }
    });
  });
  return { sock, seen, ready, calls: () => seen.filter(m => m.type === 'call') };
}

// Another Latch server relaying through the owner.
async function relay(port) {
  const sock = new WebSocket(`ws://127.0.0.1:${port}/peer`);
  await new Promise((resolve, reject) => { sock.once('open', resolve); sock.once('error', reject); });
  const waiting = new Map();
  let n = 0;
  sock.on('message', raw => {
    const msg = JSON.parse(String(raw));
    if (msg.type === 'result') waiting.get(msg.id)?.(msg.result);
  });
  sock.on('close', () => { for (const done of waiting.values()) done({ status: 'relay_closed' }); });
  const call = (tool, args, timeoutMs) => new Promise(resolve => {
    const id = `r${++n}`;
    const timer = setTimeout(() => waiting.get(id)?.({ status: 'no_reply' }), timeoutMs + 40000);
    waiting.set(id, result => { clearTimeout(timer); waiting.delete(id); resolve(result); });
    sock.send(JSON.stringify({ type: 'call', id, tool, args, timeoutMs }));
  });
  return { sock, call };
}

const failures = [];
async function section(name, body) {
  try {
    await body();
    console.log(`PASS bridge: ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`FAIL bridge: ${name}
  ${err.message}`);
  }
}

try {
  await mcp.connect(transport);
  const bootInspection = mcp.callTool({ name: 'inspect_connection', arguments: {} });
  // A worker can reconnect on its 30-second Chrome alarm rather than immediately.
  await new Promise(resolve => setTimeout(resolve, 5200));
  ws = new WebSocket('ws://127.0.0.1:47831', { origin: `chrome-extension://${EXTENSION_ID}` });
  const ready = new Promise(resolve => ws.on('message', raw => {
    const msg = JSON.parse(String(raw));
    if (msg.type === 'hello') {
      ws.send(JSON.stringify({ type: 'ready', loadedAt: Date.now(), build, protocol: BRIDGE_PROTOCOL }));
      resolve();
    } else if (msg.type === 'locate') {
      ws.send(JSON.stringify({ type: 'located', id: msg.id, found: !msg.args.url, focused: true }));
    } else if (msg.type === 'call') {
      calls++;
      ws.send(JSON.stringify({ type: 'result', id: msg.id, result: { status: 'filled', site: 'a.test' } }));
    }
  }));
  await ready;
  assert.equal(JSON.parse((await bootInspection).content[0].text).status, 'ready',
    'connection inspection must allow the existing worker reconnect interval');
  const call = async (args = {}) => JSON.parse((await mcp.callTool({ name: 'fill_email', arguments: args })).content[0].text);
  const inspect = async (args = {}) => JSON.parse((await mcp.callTool({ name: 'inspect_connection', arguments: args })).content[0].text);
  assert.equal((await call()).status, 'filled');

  // A second Chrome (an automation profile) connects; neither browser is dropped.
  const appTab = 'https://acme.wd1.myworkdayjobs.com/en-US/careers/login';
  const other = new WebSocket('ws://127.0.0.1:47831', { origin: `chrome-extension://${EXTENSION_ID}` });
  const otherCalls = [];
  const otherReady = new Promise(resolve => other.on('message', raw => {
    const msg = JSON.parse(String(raw));
    if (msg.type === 'hello') {
      other.send(JSON.stringify({ type: 'ready', build, protocol: BRIDGE_PROTOCOL }));
      resolve();
    } else if (msg.type === 'locate') {
      other.send(JSON.stringify({ type: 'located', id: msg.id, found: !msg.args.url || msg.args.url === appTab, focused: false }));
    } else if (msg.type === 'call') {
      otherCalls.push(msg.args);
      other.send(JSON.stringify({ type: 'result', id: msg.id, result: { status: 'filled', site: 'b.test' } }));
    }
  }));
  await otherReady;
  const beforeInspect = calls + otherCalls.length;
  const connection = await inspect({ url: appTab });
  assert.equal(connection.status, 'ready');
  assert.deepEqual(connection.connections, { connected: 2, ready: 2, current: 2, lookup_replies: 2, matched: 1 });
  assert.equal(calls + otherCalls.length, beforeInspect, 'connection inspection must not send any authentication operation');
  assert.equal((await call({ url: appTab })).site, 'b.test', 'a call naming a tab address goes to the browser that has it');
  assert.equal(otherCalls[0].url, appTab);
  assert.equal((await call()).site, 'a.test', 'without a tab, the browser in front gets the call');
  assert.equal(ws.readyState, WebSocket.OPEN, 'the first browser stays connected');
  other.close();
  await new Promise(resolve => other.once('close', resolve));
  const beforeMissing = calls;
  const absent = await inspect({ url: appTab });
  assert.equal(absent.status, 'tab_not_found');
  assert.equal(absent.reason, 'target_not_in_connected_browser');
  assert.equal(absent.connections.matched, 0);
  assert.equal((await call({ url: appTab })).status, 'tab_not_found', 'a named tab missing from the only browser must never fall back to its active tab');
  assert.equal(calls, beforeMissing, 'no credential operation may be sent when the named tab was not found');
  calls -= 1;
  console.log('PASS bridge: two browsers stay connected, calls routed by tab address and focus');

  const page = join(ext, 'page.js');
  const future = new Date(Date.now() + 60000);
  utimesSync(page, future, future);
  const started = Date.now();
  assert.equal((await call()).status, 'filled', 'touching unchanged code must not require a reload');
  assert.ok(Date.now() - started < 1000, 'ready connections should dispatch immediately');
  const popup = join(ext, 'popup.js');
  writeFileSync(popup, readFileSync(popup, 'utf8') + '\n// popup-only update\n');
  assert.equal((await call()).status, 'filled', 'popup edits do not change the running authentication worker');
  writeFileSync(page, readFileSync(page, 'utf8') + '\n// actual update\n');
  assert.equal((await inspect()).status, 'reload_required', 'read-only inspection must expose stale workers without invoking them');
  assert.equal((await call()).status, 'reload_required');
  assert.equal(calls, 3, 'stale code must not receive credential operations');
  console.log('PASS bridge: content freshness, immediate dispatch, stale-code guard');

  ws.close();
  await new Promise(resolve => ws.once('close', resolve));
  writeFileSync(page, readFileSync(join(root, 'extension/page.js'), 'utf8'));
  ws = new WebSocket('ws://127.0.0.1:47831', { origin: `chrome-extension://${EXTENSION_ID}` });
  await new Promise(resolve => ws.on('message', raw => {
    const msg = JSON.parse(String(raw));
    if (msg.type === 'hello') {
      ws.send(JSON.stringify({ type: 'ready', build })); // legacy worker, even with a matching disk fingerprint
      resolve();
    } else if (msg.type === 'call') {
      calls++;
      ws.send(JSON.stringify({ type: 'result', id: msg.id, result: { status: 'filled' } }));
    }
  }));
  const legacy = await inspect();
  assert.equal(legacy.status, 'reload_required');
  assert.equal(legacy.reason, 'unsupported_worker');
  assert.equal((await call()).status, 'reload_required');
  assert.equal(calls, 3, 'a legacy worker must never receive credential actions even if its disk fingerprint matches');
  console.log('PASS bridge: legacy worker protocol is refused without credential dispatch');

  await section('a stale browser that may hold the tab means reload_required, not tab_not_found', async () => {
    ws.close();
    await closed(ws);
    const fresh = browser(47831, { has: () => false });
    const stale = browser(47831, { reports: 'stale-build', has: args => args.url === appTab });
    let silent;
    try {
      await Promise.all([fresh.ready, stale.ready]);
      const held = await inspect({ url: appTab });
      assert.equal(held.status, 'reload_required');
      assert.equal(held.reason, 'stale_worker');
      assert.equal(held.connections.matched, 1);
      assert.equal((await call({ url: appTab })).status, 'reload_required');
      stale.sock.close();
      await closed(stale.sock);
      silent = browser(47831, { protocol: null, locates: false }); // a worker from before locate existed
      await silent.ready;
      const unsure = await inspect({ url: appTab });
      assert.equal(unsure.status, 'reload_required');
      assert.equal(unsure.reason, 'stale_browser_may_hold_target');
      assert.equal(fresh.calls().length + stale.calls().length + silent.calls().length, 0, 'no credential action may be sent');
      silent.sock.close();
      await closed(silent.sock);
      assert.equal((await inspect({ url: appTab })).status, 'tab_not_found', 'with only fresh browsers a missing tab is still tab_not_found');
    } finally {
      for (const b of [fresh, stale, silent]) b?.sock.close();
    }
  });

  await section('an unreadable extension file or a bad peer message does not stop the owner', async () => {
    const fresh = browser(47831, { onCall: (msg, sock) => sock.send(JSON.stringify({ type: 'result', id: msg.id, result: { status: 'filled' } })) });
    const guard = join(ext, 'guard.js');
    const saved = readFileSync(guard, 'utf8');
    let peer;
    try {
      await fresh.ready;
      peer = await relay(47831);
      peer.sock.send('null');
      rmSync(guard);
      assert.equal((await peer.call('fill_email', { url: appTab }, 2000)).status, 'reload_required');
      assert.equal((await inspect()).status, 'reload_required');
      writeFileSync(guard, saved);
      assert.equal((await peer.call('fill_email', { url: appTab }, 2000)).status, 'filled', 'the owner keeps serving relays');
      assert.equal((await call({ url: appTab })).status, 'filled');
    } finally {
      writeFileSync(guard, saved);
      fresh.sock.close();
      peer?.sock.close();
    }
  });

  await section('a relay can reach only the registered tools, and only the result schema comes back', async () => {
    const answers = { status: 'filled', vault: { identity: { password: 'relay-c4n4ry' } } };
    const fresh = browser(47831, { onCall: (msg, sock) => sock.send(JSON.stringify({ type: 'result', id: msg.id, result: msg.tool === 'application_page' ? { ...answers, status: 'ok', url: appTab } : answers })) });
    let peer;
    try {
      await fresh.ready;
      peer = await relay(47831);
      for (const tool of ['constructor', 'toString', '__proto__', 'fillReset', ['sign_in']]) {
        const refused = await peer.call(tool, { url: appTab }, 2000);
        assert.deepEqual(refused, { status: 'error', message: 'Unknown Latch tool.' }, String(tool));
      }
      assert.equal(fresh.calls().length, 0, 'an unknown tool never reaches the browser');
      assert.deepEqual(await peer.call('fill_email', { url: appTab }, 2000), { status: 'filled' }, 'unknown result keys are dropped');
      assert.deepEqual(await peer.call('application_page', { operation: 'organize', ready: true, url: appTab, tabId: 7 }, 2000), { status: 'ok', url: appTab });
    } finally {
      fresh.sock.close();
      peer?.sock.close();
    }
  });

  await section('a long sign-in address is checked rather than rejected as invalid input', async () => {
    const fresh = browser(47831, { has: () => false });
    try {
      await fresh.ready;
      const res = await mcp.callTool({ name: 'inspect_connection', arguments: { url: `https://login.example.com/saml?SAMLRequest=${'a'.repeat(3000)}` } });
      assert.ok(!res.isError, res.content[0].text);
      assert.equal(text(res).status, 'tab_not_found');
    } finally {
      fresh.sock.close();
    }
  });

  const job1 = 'https://job1.example.com/signup';
  const job2 = 'https://job2.example.com/login';
  await section('a result for an earlier owner\'s call never answers a later owner\'s call', async () => {
    const first = await startServer(47832);
    const b1 = browser(47832);
    let later;
    let b2;
    let other;
    try {
      await b1.ready;
      const p = await relay(47832);
      assert.equal((await p.call('create_account', { url: job1 }, 400)).status, 'outcome_unknown');
      const [old] = b1.calls();
      p.sock.close();
      b1.sock.close();
      await first.close();
      later = await startServer(47832);
      let answer = (msg, sock) => {
        sock.send(JSON.stringify({ type: 'result', id: old.id, result: { status: 'account_created', site: 'job1.example.com' } }));
        sock.send(JSON.stringify({ type: 'result', id: msg.id, result: { status: 'signed_in', site: 'job2.example.com' } }));
      };
      b2 = browser(47832, { onCall: (msg, sock) => answer(msg, sock) });
      await b2.ready;
      const signedIn = text(await later.callTool({ name: 'sign_in', arguments: { url: job2 } }));
      assert.equal(signedIn.site, 'job2.example.com', 'the browser\'s late answer to the old owner must be dropped');
      other = browser(47832, { has: () => false });
      await other.ready;
      answer = (msg, sock) => {
        other.sock.send(JSON.stringify({ type: 'result', id: msg.id, result: { status: 'wrong_password', site: 'job2.example.com' } }));
        setTimeout(() => sock.send(JSON.stringify({ type: 'result', id: msg.id, result: { status: 'signed_in', site: 'job2.example.com' } })), 200);
      };
      assert.equal(text(await later.callTool({ name: 'sign_in', arguments: { url: job2 } })).status, 'signed_in',
        'only the browser the call went to can answer it');
    } finally {
      for (const b of [b1, b2, other]) b?.sock.close();
      await later?.close();
    }
  });

  await section('a timed-out or abandoned call is cancelled in the browser and reported as outcome_unknown', async () => {
    const owner = await startServer(47833);
    const b = browser(47833);
    let p;
    try {
      await b.ready;
      p = await relay(47833);
      const before = Date.now();
      assert.equal((await p.call('sign_in', { url: job2 }, 400)).status, 'outcome_unknown');
      const [sent] = b.calls();
      assert.ok(sent.deadline >= before + 400 && sent.deadline <= Date.now() + 400, 'each call carries its deadline');
      await until(() => b.seen.some(m => m.type === 'cancel' && m.id === sent.id), 'a cancel after the timeout');
      p.call('create_account', { url: job2 }, 30000);
      await until(() => b.calls().length === 2, 'the second call');
      p.sock.close();
      await until(() => b.seen.some(m => m.type === 'cancel' && m.id === b.calls()[1].id), 'a cancel once the requester left');
      p = await relay(47833);
      const dropped = p.call('verify_email', { url: job2 }, 30000);
      await until(() => b.calls().length === 3, 'the third call');
      b.sock.close();
      const lost = await dropped;
      assert.equal(lost.status, 'outcome_unknown', 'a call lost with its browser may still have run');
      assert.equal(lost.reason, 'connection_lost');
    } finally {
      b.sock.close();
      p?.sock.close();
      await owner.close();
    }
  });

  await section('a new owner waits for a later browser before reporting the tab missing', async () => {
    const owner = await startServer(47834);
    let everyday;
    let jobChrome;
    try {
      const inspection = owner.callTool({ name: 'inspect_connection', arguments: { url: appTab } });
      await sleep(300);
      everyday = browser(47834, { has: () => false });
      await everyday.ready;
      await sleep(1500);
      jobChrome = browser(47834, { has: args => args.url === appTab });
      await jobChrome.ready;
      const found = text(await inspection);
      assert.equal(found.status, 'ready', found.reason);
      assert.equal(found.connections.matched, 1);
    } finally {
      everyday?.sock.close();
      jobChrome?.sock.close();
      await owner.close();
    }
  });

  // The extension's side of the bridge, run in a worker thread against a stand-in server.
  const code = join(work, 'code');
  const disk = join(work, 'disk');
  for (const dir of [code, disk]) {
    cpSync(join(root, 'extension'), dir, { recursive: true });
    const bg = join(dir, 'background.js');
    const src = readFileSync(bg, 'utf8');
    const moved = src.replace('const PORT = 47801;', 'const PORT = 47835;');
    if (moved === src) throw new Error('background.js has no "const PORT = 47801;" line, so a test worker could reach the live bridge');
    writeFileSync(bg, moved);
  }
  const hub = new WebSocketServer({ host: '127.0.0.1', port: 47835 });
  const conns = [];
  hub.on('connection', sock => {
    const conn = { sock, seen: [] };
    conns.push(conn);
    sock.on('message', raw => conn.seen.push(JSON.parse(String(raw))));
    sock.send(JSON.stringify({ type: 'hello', version: '0.1.0', clients: ['bridge-test'] }));
  });
  const readyOn = conn => conn?.seen.find(m => m.type === 'ready');
  const joined = async from => {
    await until(() => readyOn(conns[from]), 'the worker to connect', 10000);
    return conns[from];
  };
  const diskBuild = () => fingerprint(name => readFileSync(join(disk, name), 'utf8'));
  const resultOf = (conn, id) => conn.seen.find(m => m.type === 'result' && m.id === id)?.result;
  const callOn = (conn, id, tool, deadline, args = { url: TAB_URL }) =>
    conn.sock.send(JSON.stringify({ type: 'call', id, tool, args, client: 'bridge-test', deadline }));
  const identity = { type: 'saveIdentity', email: 'ada.c4n4ry@mail.test', password: 'Main-C4n4ry-pass!7' };
  try {
    await section('a restarted worker reports the build it loaded, not the files now on disk', async () => {
      const storage = { local: {}, session: {} };
      const loaded = await diskBuild();
      let worker = startWorker({ code, disk, storage, event: 'installed', extensionId: EXTENSION_ID });
      try {
        assert.equal(readyOn(await joined(0)).build, loaded);
        writeFileSync(join(disk, 'page.js'), readFileSync(join(disk, 'page.js'), 'utf8') + '\n// edited after load\n');
        const edited = await diskBuild();
        await worker.stop();
        // Chrome stops an idle worker and starts it again later from the code it loaded.
        worker = startWorker({ code, disk, storage, extensionId: EXTENSION_ID });
        assert.equal(readyOn(await joined(1)).build, loaded, 'a restarted worker must not vouch for code it is not running');
        await worker.stop();
        storage.session = {};
        worker = startWorker({ code, disk, storage, event: 'startup', extensionId: EXTENSION_ID });
        assert.equal(readyOn(await joined(2)).build, loaded, 'a browser restart keeps the loaded build');
        await worker.stop();
        storage.session = {};
        worker = startWorker({ code: disk, disk, storage, event: 'installed', extensionId: EXTENSION_ID });
        assert.equal(readyOn(await joined(3)).build, edited, 'a reload reports the new build');
      } finally {
        await worker.stop();
      }
    });

    await section('a call past its deadline is skipped, and a cancelled flow stops before its next fill', async () => {
      const from = conns.length;
      const worker = startWorker({ code: disk, disk, storage: { local: {}, session: {} }, event: 'installed', extensionId: EXTENSION_ID });
      try {
        const conn = await joined(from);
        await worker.popup(identity);
        worker.show(PAGES.identifier);
        callOn(conn, 'late', 'sign_in', Date.now() - 1);
        await until(() => resultOf(conn, 'late'), 'the late call');
        assert.equal(resultOf(conn, 'late').status, 'expired');
        assert.equal(worker.fills.length, 0, 'an expired call fills nothing');
        worker.hold(true);
        callOn(conn, 'first', 'fill_email', Date.now() + 30000);
        callOn(conn, 'queued', 'sign_in', Date.now() + 300);
        await sleep(600);
        worker.hold(false);
        await until(() => resultOf(conn, 'queued'), 'the queued call');
        assert.equal(resultOf(conn, 'first').status, 'filled');
        assert.equal(resultOf(conn, 'queued').status, 'expired', 'a call whose deadline passed in the queue is skipped');
        assert.deepEqual(worker.fills.map(f => f.op), ['fillOne']);
        callOn(conn, 'slow', 'sign_in', Date.now() + 60000);
        await until(() => worker.fills.length === 2, 'the email step');
        conn.sock.send(JSON.stringify({ type: 'cancel', id: 'slow' }));
        await sleep(100);
        worker.show(PAGES.password);
        await until(() => resultOf(conn, 'slow'), 'the cancelled call', 10000);
        assert.equal(resultOf(conn, 'slow').status, 'outcome_unknown', 'a flow stopped after a submit may have changed the page');
        assert.deepEqual(worker.fills.map(f => f.purpose), ['', 'login'], 'no password may be filled after the cancel');
      } finally {
        await worker.stop();
      }
    });

    await section('a result goes back only on the connection its call came from', async () => {
      const from = conns.length;
      const worker = startWorker({ code: disk, disk, storage: { local: {}, session: {} }, event: 'installed', extensionId: EXTENSION_ID });
      try {
        const conn = await joined(from);
        await worker.popup(identity);
        worker.show(PAGES.identifier);
        worker.hold(true);
        callOn(conn, 'orphan', 'sign_in', Date.now() + 60000);
        await sleep(200);
        conn.sock.terminate();
        const next = await joined(from + 1);
        worker.hold(false);
        await sleep(1500);
        worker.show(PAGES.signedIn);
        await sleep(2500);
        assert.equal(next.seen.filter(m => m.type === 'result').length, 0, 'the next server must not get the old call\'s result');
        assert.equal(worker.fills.length, 0, 'a call whose requester went away fills nothing');
      } finally {
        await worker.stop();
      }
    });

    const host = new URL(TAB_URL).hostname;
    const at = (url, frame) => ({ ...frame, url, host: new URL(url).hostname });
    const signupPage = framePage([{ kind: 'email', ref: 'e1', form: 0, empty: true },
      { kind: 'password', ref: 'p1', form: 0, empty: true, isNew: true, minLength: 0 }], { auth: { signup: true } });
    const rejectedPage = framePage([{ kind: 'password', ref: 'f2', form: 0, empty: true }], { error: 'Incorrect password. Try again.' });
    const resetPage = framePage([{ kind: 'password', ref: 'n1', form: 0, empty: true, isNew: true, minLength: 0 },
      { kind: 'password', ref: 'n2', form: 0, empty: true, confirm: true, minLength: 0 }],
    { auth: { signup: true }, reset: { pw: ['n1', 'n2'], button: 'b1', scope: 's1' } });
    const recoveryPage = framePage([{ kind: 'email', ref: 'r1', form: 0, empty: true }], { auth: {}, recovery: { email: 'r1', button: 'b1', scope: 's1' } });
    const recoverySentPage = framePage([], { auth: {}, flags: { recoverySent: true } });
    let seq = 0;
    const finish = async (conn, id, what, ms = 15000) => {
      await until(() => resultOf(conn, id), what, ms);
      const result = resultOf(conn, id);
      const dump = JSON.stringify(result);
      assert.ok(!dump.includes(identity.password) && !dump.includes(identity.email), 'results never carry credentials');
      return result;
    };
    // Runs create_account in Unique mode so the vault holds a generated site password.
    const makeAccount = async (conn, worker, url = TAB_URL) => {
      const id = `signup${++seq}`;
      const from = worker.fills.length;
      worker.tab({ url });
      worker.show(at(url, signupPage));
      callOn(conn, id, 'create_account', Date.now() + 60000, { url });
      await until(() => worker.fills.length > from, 'the sign-up fill');
      worker.show(at(url, PAGES.signedIn));
      assert.equal((await finish(conn, id, 'the sign-up')).status, 'account_created');
    };
    const siteState = async (worker, name = host) => (await worker.popup({ type: 'state' })).sites.find(s => s.host === name);
    const withWorker = async body => {
      const from = conns.length;
      const worker = startWorker({ code: disk, disk, storage: { local: {}, session: {} }, event: 'installed', extensionId: EXTENSION_ID });
      try {
        const conn = await joined(from);
        await worker.popup(identity);
        await body(conn, worker);
      } finally {
        await worker.stop();
      }
    };
    // Answers the worker's mail requests; `box.reply` is what the inbox returns.
    const connectInbox = async (conn, worker) => {
      const box = { asks: [], reply: { found: false } };
      conn.sock.on('message', raw => {
        const msg = JSON.parse(String(raw));
        const answer = result => conn.sock.send(JSON.stringify({ type: 'reply', id: msg.id, result }));
        if (msg.type === 'mail_check') answer({ ok: true });
        else if (msg.type === 'mail') { box.asks.push(msg.request); answer(box.reply); }
      });
      assert.equal((await worker.popup({ type: 'saveMailbox', mailbox: { user: 'ada.c4n4ry@mail.test', pass: 'imap-c4n4ry-app', host: 'imap.mail.test', port: 993 } })).ok, true);
      return box;
    };
    const askRecovery = async (conn, worker, url = TAB_URL) => {
      const id = `recover${++seq}`;
      worker.tab({ url });
      worker.show(at(url, recoveryPage));
      callOn(conn, id, 'request_password_recovery', Date.now() + 60000, { url });
      await until(() => worker.fills.some(f => f.op === 'requestRecovery'), 'the recovery request');
      worker.show(at(url, recoverySentPage));
      assert.equal((await finish(conn, id, 'the recovery result')).reason, 'recovery_requested');
    };
    const checkEmailPage = framePage([], { auth: {}, flags: { checkEmail: true } });
    const codePage = framePage([{ kind: 'code', ref: 'c1', form: 0, empty: true }], { auth: {}, flags: { emailCode: true } });
    const expectHeld = async (conn, id, what) => {
      callOn(conn, id, 'verify_email', Date.now() + 60000);
      const held = await finish(conn, id, what);
      assert.equal(held.status, 'needs_user', what);
      assert.equal(held.reason, 'recovery_pending', what);
      assert.equal(held.next_action, 'open_reset_link', what);
    };

    await section('a rejected site password falls back to the main password once and the site moves to it', async () => {
      const from = conns.length;
      const worker = startWorker({ code: disk, disk, storage: { local: {}, session: {} }, event: 'installed', extensionId: EXTENSION_ID });
      try {
        const conn = await joined(from);
        await worker.popup(identity);
        await makeAccount(conn, worker);
        assert.equal((await siteState(worker)).hasPassword, true);
        const start = worker.fills.length;
        worker.show(PAGES.password);
        callOn(conn, 'fallback', 'sign_in', Date.now() + 60000);
        await until(() => worker.fills.length === start + 1, 'the site password');
        worker.show(rejectedPage);
        await until(() => worker.fills.length === start + 2, 'the main password', 10000);
        worker.show(PAGES.signedIn);
        const result = await finish(conn, 'fallback', 'the fallback sign-in');
        assert.equal(result.status, 'signed_in');
        assert.equal(result.reason, 'main_password');
        assert.deepEqual(worker.fills.slice(start).map(f => f.source), ['site', 'main']);
        const site = await siteState(worker);
        assert.equal(site.hasPassword, false, 'the saved site password is dropped');
        assert.equal(site.source, 'main');
        assert.equal(site.status, 'active');
      } finally {
        await worker.stop();
      }
    });

    await section('sign_in submits a password at most twice when both are rejected', async () => {
      const from = conns.length;
      const worker = startWorker({ code: disk, disk, storage: { local: {}, session: {} }, event: 'installed', extensionId: EXTENSION_ID });
      try {
        const conn = await joined(from);
        await worker.popup(identity);
        await makeAccount(conn, worker);
        const start = worker.fills.length;
        worker.show(PAGES.password);
        callOn(conn, 'twice', 'sign_in', Date.now() + 60000);
        await until(() => worker.fills.length === start + 1, 'the site password');
        worker.show(rejectedPage);
        await until(() => worker.fills.length === start + 2, 'the main password', 10000);
        worker.show(framePage([{ kind: 'password', ref: 'f3', form: 0, empty: true }], { error: 'Incorrect password.' }));
        const result = await finish(conn, 'twice', 'the doubly rejected sign-in', 30000);
        assert.equal(result.status, 'wrong_password');
        assert.deepEqual(worker.fills.slice(start).map(f => f.source), ['site', 'main']);
        assert.equal((await siteState(worker)).hasPassword, true, 'a failed fallback keeps the saved site password');
      } finally {
        await worker.stop();
      }
    });

    await section('a reset page is never filled by a tool, and a popup reset makes sign-in try the main password first', async () => {
      const from = conns.length;
      const worker = startWorker({ code: disk, disk, storage: { local: {}, session: {} }, event: 'installed', extensionId: EXTENSION_ID });
      try {
        const conn = await joined(from);
        await worker.popup(identity);
        await makeAccount(conn, worker);
        const start = worker.fills.length;
        worker.show(resetPage);
        callOn(conn, 'reset-sign-in', 'sign_in', Date.now() + 60000);
        const signIn = await finish(conn, 'reset-sign-in', 'sign_in on a reset page');
        assert.equal(signIn.status, 'reset_form');
        assert.equal(signIn.next_action, 'set_new_password');
        callOn(conn, 'reset-sign-up', 'create_account', Date.now() + 60000);
        assert.equal((await finish(conn, 'reset-sign-up', 'create_account on a reset page')).status, 'reset_form');
        assert.equal(worker.fills.length, start, 'no tool fills a reset page');
        assert.equal((await worker.popup({ type: 'pageState' })).kind, 'reset');
        const filled = await worker.popup({ type: 'fillReset' });
        assert.equal(filled.ok, true, filled.message);
        assert.deepEqual(worker.fills.slice(start).map(f => [f.op, f.source]), [['fillReset', 'main']]);
        const [pending] = (await worker.popup({ type: 'state' })).resets;
        assert.equal(pending.host, host);
        assert.equal(pending.pendingMain, true);
        assert.ok(!JSON.stringify(await worker.popup({ type: 'state' })).includes(identity.password), 'popup state never carries passwords');
        worker.show(PAGES.password);
        callOn(conn, 'after-reset', 'sign_in', Date.now() + 60000);
        await until(() => worker.fills.length === start + 2, 'the password step');
        assert.equal(worker.fills.at(-1).source, 'main', 'a pending reset tries the main password first');
        worker.show(PAGES.signedIn);
        const result = await finish(conn, 'after-reset', 'the sign-in after the reset');
        assert.equal(result.status, 'signed_in');
        assert.equal(result.reason, 'main_password');
        const state = await worker.popup({ type: 'state' });
        assert.equal(state.resets.length, 0);
        assert.equal(state.sites.find(s => s.host === host).hasPassword, false);
      } finally {
        await worker.stop();
      }
    });

    await section('recovery on a job portal with no saved account uses the user\'s email and is remembered for the popup', async () => {
      const from = conns.length;
      const worker = startWorker({ code: disk, disk, storage: { local: {}, session: {} }, event: 'installed', extensionId: EXTENSION_ID });
      try {
        const conn = await joined(from);
        await worker.popup(identity);
        worker.show(recoveryPage);
        callOn(conn, 'recover', 'request_password_recovery', Date.now() + 60000);
        await until(() => worker.fills.some(f => f.op === 'requestRecovery'), 'the recovery request');
        worker.show(recoverySentPage);
        const result = await finish(conn, 'recover', 'the recovery result');
        assert.equal(result.status, 'needs_user');
        assert.equal(result.reason, 'recovery_requested');
        assert.equal(result.next_action, 'open_reset_link');
        const [reset] = (await worker.popup({ type: 'state' })).resets;
        assert.equal(reset.host, host);
        assert.ok(reset.requestedAt > 0);
        assert.equal(reset.pendingMain, false);
        assert.equal((await worker.popup({ type: 'pageState' })).pendingReset, true);
        const fills = worker.fills.length;
        for (const tool of ['fillReset', 'openResetLink', 'dismissReset', 'constructor', 'toString', 'hasOwnProperty', ['sign_in']]) {
          const id = `bridge-${tool}`;
          callOn(conn, id, tool, Date.now() + 60000);
          const refused = await finish(conn, id, `the ${tool} call`);
          assert.equal(refused.status, 'error');
          assert.match(refused.message, /Unknown Latch tool/);
          assert.equal('vault' in refused, false);
        }
        assert.equal(worker.fills.length, fills, 'a bridge call cannot reach the popup-only reset actions');
        assert.equal((await worker.popup({ type: 'state' })).resets.length, 1);
        await worker.popup({ type: 'dismissReset', host });
        assert.equal((await worker.popup({ type: 'state' })).resets.length, 0);
      } finally {
        await worker.stop();
      }
    });
    await section('a reset link opens only from the popup on the site\'s own https domain, and verification never opens one', async () => {
      const from = conns.length;
      const worker = startWorker({ code: disk, disk, storage: { local: {}, session: {} }, event: 'installed', extensionId: EXTENSION_ID });
      try {
        const conn = await joined(from);
        await worker.popup(identity);
        const box = await connectInbox(conn, worker);
        const { asks } = box;
        const tenant = `https://${host}/en-US/careers/passwordreset?token=t0k3n`;
        for (const bad of ['https://evil.example/reset?token=t0k3n', `http://${host}/reset?token=t0k3n`, `https://ada:pw@${host}/reset?token=t0k3n`,
          'https://other.wd1.myworkdayjobs.com/reset?token=t0k3n', 'https://objectstorage.myworkdayjobs.com/reset?token=t0k3n']) {
          box.reply = { found: true, link: bad, key: 'reset-bad' };
          const r = await worker.popup({ type: 'openResetLink', host });
          assert.deepEqual(r, { ok: false, reason: 'link_rejected' }, bad);
        }
        assert.equal(worker.opened.length, 0, 'an off-site, off-tenant, plain http or userinfo link is never opened');
        box.reply = { found: false };
        assert.deepEqual(await worker.popup({ type: 'openResetLink', host }), { ok: false, reason: 'not_found' });
        for (const error of ['auth', 'offline']) {
          box.reply = { found: false, error };
          assert.deepEqual(await worker.popup({ type: 'openResetLink', host }), { ok: false, reason: 'mail_error', error });
        }
        box.reply = { found: true, link: tenant, key: 'reset-good' };
        const opened = await worker.popup({ type: 'openResetLink', host });
        assert.equal(opened.ok, true);
        assert.ok(!JSON.stringify(opened).includes('t0k3n'), 'the popup result does not carry the link');
        assert.deepEqual(worker.opened, [tenant]);
        assert.equal(asks.at(-1).purpose, 'reset');
        assert.equal(asks.at(-1).expect, 'link');
        worker.show(framePage([], { auth: {}, flags: { checkEmail: true } }));
        callOn(conn, 'verify-reset-link', 'verify_email', Date.now() + 60000);
        const verify = await finish(conn, 'verify-reset-link', 'verify_email with a reset link in the inbox');
        assert.equal(asks.at(-1).purpose, 'verify');
        assert.equal(verify.status, 'verification_pending');
        assert.ok(!JSON.stringify(verify).includes('t0k3n'), 'a tool result never carries the link');
        assert.deepEqual(worker.opened, [tenant], 'verify_email never opens a reset link');
      } finally {
        await worker.stop();
      }
    });

    await section('a pending recovery keeps verify_email from opening any link or sending the AI to the inbox', async () => {
      await withWorker(async (conn, worker) => {
        const box = await connectInbox(conn, worker);
        await askRecovery(conn, worker);
        const plain = `https://${host}/a/t/abc123`;
        box.reply = { found: true, link: plain, key: 'plain-link' };
        worker.show(checkEmailPage);
        await expectHeld(conn, 'held-link', 'a link page');
        assert.equal(box.asks.length, 0, 'the inbox is not read for a site waiting on a recovery');
        worker.show(codePage);
        await expectHeld(conn, 'held-code', 'a code page whose email only has a link');
        worker.show(checkEmailPage);
        await worker.popup({ type: 'removeMailbox' });
        await expectHeld(conn, 'held-no-inbox', 'no inbox connected');
        assert.equal(worker.opened.length, 0, 'no emailed link is opened');
        await worker.popup({ type: 'dismissReset', host });
        callOn(conn, 'released', 'verify_email', Date.now() + 60000);
        assert.equal((await finish(conn, 'released', 'verify_email after dismissing')).status, 'check_inbox');
      });
    });

    await section('a pending recovery holds a code page back too, whatever the inbox answers', async () => {
      await withWorker(async (conn, worker) => {
        await askRecovery(conn, worker);
        worker.show(codePage);
        await expectHeld(conn, 'held-code-no-inbox', 'a code page with no inbox connected');
        const box = await connectInbox(conn, worker);
        const replies = { nothing: { found: false }, 'refused-login': { found: false, error: 'auth' }, offline: { found: false, error: 'offline' },
          'reset-link': { found: true, link: `https://${host}/reset?token=t0k3n`, key: 'reset-link' } };
        for (const [what, reply] of Object.entries(replies)) {
          box.reply = reply;
          await expectHeld(conn, `held-${what}`, what);
        }
        assert.equal(worker.opened.length, 0, 'no emailed link is opened');
      });
    });

    await section('a recovery the site never confirms still holds verification back', async () => {
      await withWorker(async (conn, worker) => {
        worker.show(recoveryPage);
        callOn(conn, 'no-confirmation', 'request_password_recovery', Date.now() + 60000);
        await until(() => worker.fills.some(f => f.op === 'requestRecovery'), 'the recovery request');
        worker.show(checkEmailPage);
        assert.equal((await finish(conn, 'no-confirmation', 'the unconfirmed recovery')).status, 'unconfirmed');
        assert.deepEqual((await worker.popup({ type: 'state' })).resets.map(r => r.host), [host]);
        await expectHeld(conn, 'held-unconfirmed', 'a page that only says check your email');
      });
    });

    await section('a signed-in site drops its pending recovery', async () => {
      await withWorker(async (conn, worker) => {
        await askRecovery(conn, worker);
        const from = worker.fills.length;
        worker.show(PAGES.password);
        callOn(conn, 'after-recovery', 'sign_in', Date.now() + 60000);
        await until(() => worker.fills.length > from, 'the password');
        worker.show(PAGES.signedIn);
        assert.equal((await finish(conn, 'after-recovery', 'the sign-in')).status, 'signed_in');
        assert.equal((await worker.popup({ type: 'state' })).resets.length, 0);
      });
    });

    await section('recovery uses the user\'s email on career pages only, not on employee systems', async () => {
      await withWorker(async (conn, worker) => {
        for (const url of ['https://wd5.myworkday.com/acme/login/forgot', 'https://my.adp.com/forgot', 'https://app.rippling.com/forgot']) {
          const id = `employee-${seq++}`;
          worker.tab({ url });
          worker.show(at(url, recoveryPage));
          callOn(conn, id, 'request_password_recovery', Date.now() + 60000, { url });
          assert.equal((await finish(conn, id, url)).reason, 'identity_uncertain', url);
        }
        assert.equal(worker.fills.length, 0);
        assert.equal((await worker.popup({ type: 'state' })).resets.length, 0);
        await askRecovery(conn, worker, 'https://acme.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/forgot');
      });
    });

    await section('a reset tab stays private and its fill lands on the site that asked for it', async () => {
      await withWorker(async (conn, worker) => {
        const box = await connectInbox(conn, worker);
        const signIn = 'https://jobs.example.com/login';
        await makeAccount(conn, worker, signIn);
        await askRecovery(conn, worker, 'https://jobs.example.com/forgot');
        const link = 'https://accounts.example.com/reset?token=t0k3n';
        box.reply = { found: true, link, key: 'reset-sub' };
        const opened = await worker.popup({ type: 'openResetLink', host: 'jobs.example.com' });
        assert.equal(opened.ok, true);
        const organize = (tabId, url) => ({ operation: 'organize', ready: true, url, tabId });
        callOn(conn, 'reset-tab', 'application_page', Date.now() + 60000, organize(opened.tabId, 'https://example.org/'));
        const refused = await finish(conn, 'reset-tab', 'application_page on the reset tab');
        assert.equal(refused.status, 'blocked');
        assert.equal(refused.reason, 'reset_tab');
        assert.equal('url' in refused, false);
        callOn(conn, 'reset-tab-same', 'application_page', Date.now() + 60000, organize(opened.tabId, link));
        const same = await finish(conn, 'reset-tab-same', 'application_page naming the reset tab\'s own origin');
        assert.equal(same.status, 'blocked');
        assert.ok(!JSON.stringify(same).includes('t0k3n'));
        worker.tab({ url: 'https://jobs.example.com/account?session=s3cr3t' });
        callOn(conn, 'other-tab', 'application_page', Date.now() + 60000, organize(7, 'https://example.org/'));
        const mismatch = await finish(conn, 'other-tab', 'application_page with the wrong origin');
        assert.equal(mismatch.status, 'blocked');
        assert.equal('url' in mismatch, false, 'a blocked result never echoes the tab\'s address');
        const before = worker.fills.length;
        worker.tab({ id: opened.tabId, url: link });
        worker.show(at(link, resetPage));
        assert.equal((await worker.popup({ type: 'fillReset' })).ok, true);
        assert.deepEqual(worker.fills.slice(before).map(f => [f.op, f.source]), [['fillReset', 'main']]);
        const state = await worker.popup({ type: 'state' });
        assert.deepEqual(state.resets.map(r => [r.host, r.pendingMain]), [['jobs.example.com', true]], 'one row, on the host that asked');
        assert.equal(state.sites.some(s => s.host === 'accounts.example.com'), false);
      });
    });

    await section('the main password is filled on a reset page only for a known site in the tab\'s own site', async () => {
      await withWorker(async (conn, worker) => {
        const stranger = 'https://stranger.example.net/reset';
        worker.tab({ url: stranger });
        worker.show(at(stranger, resetPage));
        const unknown = await worker.popup({ type: 'fillReset' });
        assert.equal(unknown.ok, false);
        assert.equal(unknown.reason, 'unknown_site');
        await makeAccount(conn, worker, 'https://jobs.example.com/login');
        const before = worker.fills.length;
        worker.tab({ url: 'https://news.example.org/' });
        worker.show({ ...at('https://jobs.example.com/reset', resetPage), top: false });
        const framed = await worker.popup({ type: 'fillReset' });
        assert.equal(framed.ok, false);
        assert.equal(worker.fills.length, before, 'nothing is filled');
      });
    });

    await section('the main password working on a sibling tenant leaves that tenant\'s saved password alone', async () => {
      await withWorker(async (conn, worker) => {
        const beta = 'careers-beta.icims.com';
        const acme = 'https://careers-acme.icims.com/login';
        await makeAccount(conn, worker, `https://${beta}/login`);
        const saved = (await worker.popup({ type: 'reveal', host: beta })).password;
        assert.ok(saved);
        const start = worker.fills.length;
        worker.tab({ url: acme });
        worker.show(at(acme, PAGES.password));
        callOn(conn, 'sibling', 'sign_in', Date.now() + 60000, { url: acme });
        await until(() => worker.fills.length === start + 1, 'the sibling password');
        worker.show(at(acme, rejectedPage));
        await until(() => worker.fills.length === start + 2, 'the main password', 10000);
        worker.show(at(acme, PAGES.signedIn));
        const result = await finish(conn, 'sibling', 'the fallback on a sibling tenant');
        assert.equal(result.reason, 'main_password');
        assert.deepEqual(worker.fills.slice(start).map(f => f.source), ['site', 'main']);
        assert.equal((await worker.popup({ type: 'reveal', host: beta })).password, saved, 'the sibling keeps its password');
        const other = await siteState(worker, beta);
        assert.equal(other.source, 'latch');
        const own = await siteState(worker, 'careers-acme.icims.com');
        assert.equal(own.source, 'main');
        assert.equal(own.hasPassword, false);
        assert.equal(own.status, 'active');
      });
    });

    await section('a host shared by employers keeps its saved password when the main password works', async () => {
      await withWorker(async (conn, worker) => {
        const shared = 'https://wd3.myworkdaysite.com/recruiting/acme/careers/login';
        await makeAccount(conn, worker, shared);
        const start = worker.fills.length;
        worker.show(at(shared, PAGES.password));
        callOn(conn, 'shared', 'sign_in', Date.now() + 60000, { url: shared });
        await until(() => worker.fills.length === start + 1, 'the saved password');
        worker.show(at(shared, rejectedPage));
        await until(() => worker.fills.length === start + 2, 'the main password', 10000);
        worker.show(at(shared, PAGES.signedIn));
        assert.equal((await finish(conn, 'shared', 'the shared-host sign-in')).status, 'signed_in');
        assert.equal((await siteState(worker, 'wd3.myworkdaysite.com')).hasPassword, true);
      });
    });

    await section('a site that returns a rejected password to the email step gets the other credential, never the same one twice', async () => {
      await withWorker(async (conn, worker) => {
        await makeAccount(conn, worker);
        const start = worker.fills.length;
        const step = async (frame, count, what) => {
          worker.show(frame);
          await until(() => worker.fills.length === start + count, what, 12000);
        };
        await step(PAGES.identifier, 0, 'nothing yet');
        callOn(conn, 'email-first', 'sign_in', Date.now() + 60000);
        await until(() => worker.fills.length === start + 1, 'the email');
        await step(PAGES.password, 2, 'the site password');
        await step(framePage([{ kind: 'email', ref: 'f1', form: 0, empty: true }], { error: 'Incorrect password. Try again.' }), 3, 'the email again');
        await step(PAGES.password, 4, 'the main password');
        worker.show(PAGES.signedIn);
        const result = await finish(conn, 'email-first', 'the email-first fallback');
        assert.equal(result.reason, 'main_password');
        assert.deepEqual(worker.fills.slice(start).map(f => f.source), ['', 'site', '', 'main']);
      });
    });

    await section('an email-first rejection with nothing else to try fails once, with the backoff', async () => {
      await withWorker(async (conn, worker) => {
        worker.show(PAGES.identifier);
        callOn(conn, 'one-shot', 'sign_in', Date.now() + 60000);
        await until(() => worker.fills.length === 1, 'the email');
        worker.show(PAGES.password);
        await until(() => worker.fills.length === 2, 'the main password', 12000);
        worker.show(framePage([{ kind: 'email', ref: 'f1', form: 0, empty: true }], { error: 'Incorrect password. Try again.' }));
        assert.equal((await finish(conn, 'one-shot', 'the rejected sign-in')).status, 'wrong_password');
        assert.equal(worker.fills.length, 2, 'the password is not submitted again');
        callOn(conn, 'held-off', 'sign_in', Date.now() + 60000);
        assert.equal((await finish(conn, 'held-off', 'the next attempt')).status, 'retry_blocked');
        assert.equal(worker.fills.length, 2);
      });
    });

    await section('a silent return to the email step is not reported as unconfirmed', async () => {
      await withWorker(async (conn, worker) => {
        await makeAccount(conn, worker);
        const start = worker.fills.length;
        worker.show(PAGES.identifier);
        callOn(conn, 'silent', 'sign_in', Date.now() + 60000);
        for (const [count, frame] of [[1, PAGES.password], [2, PAGES.identifier], [3, PAGES.password], [4, PAGES.identifier]]) {
          await until(() => worker.fills.length === start + count, `fill ${count}`, 12000);
          worker.show(frame);
        }
        const result = await finish(conn, 'silent', 'the silent rejection', 20000);
        assert.equal(result.status, 'credentials_or_account_problem');
        assert.deepEqual(worker.fills.slice(start).map(f => f.source), ['', 'site', '', 'main']);
        callOn(conn, 'silent-again', 'sign_in', Date.now() + 60000);
        assert.equal((await finish(conn, 'silent-again', 'the next attempt')).status, 'retry_blocked');
      });
    });

    await section('the fallback runs on a sign-in form that labels its password new, but never on a sign-up form', async () => {
      await withWorker(async (conn, worker) => {
        await makeAccount(conn, worker);
        const start = worker.fills.length;
        worker.show(PAGES.password);
        callOn(conn, 'cgi', 'sign_in', Date.now() + 60000);
        await until(() => worker.fills.length === start + 1, 'the site password');
        worker.show(framePage([{ kind: 'password', ref: 'f2', form: 0, empty: true, isNew: true }], { error: 'Incorrect password. Try again.' }));
        await until(() => worker.fills.length === start + 2, 'the main password', 10000);
        worker.show(PAGES.signedIn);
        assert.equal((await finish(conn, 'cgi', 'the CGI fallback')).reason, 'main_password');
      });
      await withWorker(async (conn, worker) => {
        await makeAccount(conn, worker);
        const start = worker.fills.length;
        worker.show(PAGES.password);
        callOn(conn, 'two-fields', 'sign_in', Date.now() + 60000);
        await until(() => worker.fills.length === start + 1, 'the site password');
        worker.show(framePage([{ kind: 'password', ref: 'f2', form: 0, empty: true, isNew: true },
          { kind: 'password', ref: 'f3', form: 0, empty: true, confirm: true }], { error: 'Incorrect password. Try again.' }));
        assert.equal((await finish(conn, 'two-fields', 'a two-password form')).status, 'wrong_password');
        assert.equal(worker.fills.length, start + 1, 'nothing goes into a form with a confirm field');
      });
    });

    await section('a fallback password is never submitted on a plain http page', async () => {
      await withWorker(async (conn, worker) => {
        await makeAccount(conn, worker);
        const start = worker.fills.length;
        worker.show(PAGES.password);
        callOn(conn, 'downgrade', 'sign_in', Date.now() + 60000);
        await until(() => worker.fills.length === start + 1, 'the site password');
        // The email notice forces the state to none, which skips the loop's own scheme check.
        worker.show(at(TAB_URL.replace('https:', 'http:'), framePage([{ kind: 'password', ref: 'f2', form: 0, empty: true }],
          { error: 'Incorrect password. Try again.', flags: { checkEmail: true } })));
        const result = await finish(conn, 'downgrade', 'the http retry');
        assert.equal(result.status, 'blocked');
        assert.equal(worker.fills.length, start + 1, 'the alternative credential stays out of the http page');
      });
    });

    await section('a rejection on a page that also mentions an emailed link still gets the other credential', async () => {
      await withWorker(async (conn, worker) => {
        await makeAccount(conn, worker);
        const start = worker.fills.length;
        worker.show(PAGES.password);
        callOn(conn, 'notice', 'sign_in', Date.now() + 60000);
        await until(() => worker.fills.length === start + 1, 'the site password');
        // The form never left the page, so the retry has no newer snapshot of its own.
        worker.show(framePage([{ kind: 'password', ref: 'f2', form: 0, empty: true }],
          { error: 'Incorrect password. Try again.', flags: { checkEmail: true } }));
        await until(() => worker.fills.length === start + 2, 'the main password', 10000);
        worker.show(PAGES.signedIn);
        const result = await finish(conn, 'notice', 'the retry beside an email notice');
        assert.equal(result.status, 'signed_in');
        assert.equal(result.reason, 'main_password');
        assert.deepEqual(worker.fills.slice(start).map(f => f.source), ['site', 'main']);
      });
    });

    await section('an error partway through a flow clears what Latch filled', async () => {
      await withWorker(async (conn, worker) => {
        worker.show(PAGES.password);
        callOn(conn, 'thrown', 'sign_in', Date.now() + 60000);
        await until(() => worker.fills.length === 1, 'the password');
        assert.equal(worker.clears(), 0);
        worker.show({ ...PAGES.password, fields: null }); // reading this frame throws inside the flow
        assert.equal((await finish(conn, 'thrown', 'the thrown sign-in')).status, 'error');
        await until(() => worker.clears() > 0, 'the filled fields to be cleared');
      });
    });

    await section('a password step reached by Latch\'s own email step is sign-up, not a reset', async () => {
      await withWorker(async (conn, worker) => {
        worker.show(PAGES.identifier);
        callOn(conn, 'no-account', 'sign_in', Date.now() + 60000);
        await until(() => worker.fills.length === 1, 'the email');
        worker.show(resetPage);
        assert.equal((await finish(conn, 'no-account', 'sign_in on a set-password step')).status, 'no_account');
        assert.equal(worker.fills.length, 1);
        worker.show(PAGES.identifier);
        callOn(conn, 'continue-signup', 'create_account', Date.now() + 60000);
        await until(() => worker.fills.length === 2, 'the sign-up email');
        worker.show(resetPage);
        await until(() => worker.fills.length === 3, 'the sign-up password', 10000);
        worker.show(PAGES.signedIn);
        assert.equal((await finish(conn, 'continue-signup', 'the sign-up')).status, 'account_created');
        assert.deepEqual(worker.fills.map(f => f.purpose), ['login', 'login', 'signup']);
      });
    });

    await section('create_account carries on where sign_in said to, and only there', async () => {
      await withWorker(async (conn, worker) => {
        worker.show(PAGES.identifier);
        callOn(conn, 'told-to-sign-up', 'sign_in', Date.now() + 60000);
        await until(() => worker.fills.length === 1, 'the email');
        worker.show(resetPage);
        assert.equal((await finish(conn, 'told-to-sign-up', 'sign_in on a set-password step')).status, 'no_account');
        const later = `${TAB_URL}?step=2`;
        worker.tab({ url: later });
        worker.show(at(later, resetPage));
        callOn(conn, 'other-url', 'create_account', Date.now() + 60000, { url: later });
        assert.equal((await finish(conn, 'other-url', 'the same tab at another address')).status, 'reset_form');
        worker.tab({ id: 9, url: TAB_URL });
        worker.show(resetPage);
        callOn(conn, 'other-tab', 'create_account', Date.now() + 60000);
        assert.equal((await finish(conn, 'other-tab', 'the same address in another tab')).status, 'reset_form');
        assert.equal(worker.fills.length, 1, 'neither page is filled');
        worker.tab({ id: 7 });
        callOn(conn, 'same-page', 'create_account', Date.now() + 60000);
        await until(() => worker.fills.length === 2, 'the sign-up password');
        worker.show(PAGES.signedIn);
        assert.equal((await finish(conn, 'same-page', 'the sign-up')).status, 'account_created');
        assert.deepEqual(worker.fills.map(f => f.purpose), ['login', 'signup']);
      });
    });

    await section('a reset form reached after create_account\'s own email step is not filled', async () => {
      await withWorker(async (conn, worker) => {
        worker.show(PAGES.identifier);
        callOn(conn, 'email-then-reset', 'create_account', Date.now() + 60000);
        await until(() => worker.fills.length === 1, 'the email');
        worker.show(resetPage);
        const result = await finish(conn, 'email-then-reset', 'a reset form after the email step');
        assert.equal(result.status, 'reset_form');
        assert.equal(result.next_action, 'set_new_password');
        assert.equal(worker.fills.length, 1, 'nothing goes into the reset form');
        assert.equal(await siteState(worker), undefined, 'a generated password nobody used is not kept');
      });
    });

    // Runs create_account up to its one submit, then the page shows `next`.
    const signUpThen = async (conn, worker, id, next, first = signupPage) => {
      worker.show(first);
      callOn(conn, id, 'create_account', Date.now() + 60000);
      await until(() => worker.fills.length === 1, 'the sign-up fill');
      worker.show(next);
    };
    const signupFields = signupPage.fields;
    const unknownAccount = { creation: 'unknown', email_verification: 'unknown', session: 'unknown' };

    await section('a sign-in form that marks its password new is signed in to, not offered as a sign-up', async () => {
      await withWorker(async (conn, worker) => {
        worker.show(framePage([{ kind: 'email', ref: 'e1', form: 0, empty: true }, { kind: 'password', ref: 'f2', form: 0, empty: true, isNew: true }],
          { auth: { login: true, signup: false } }));
        callOn(conn, 'marked-new', 'sign_in', Date.now() + 60000);
        await until(() => worker.fills.length === 1, 'the sign-in fill');
        worker.show(PAGES.signedIn);
        assert.equal((await finish(conn, 'marked-new', 'the sign-in')).status, 'signed_in');
        assert.deepEqual(worker.fills.map(f => [f.purpose, f.source]), [['login', 'main']]);
      });
    });

    await section('a sign-up that reaches an emailed passcode step reports check_inbox and claims no account', async () => {
      await withWorker(async (conn, worker) => {
        await signUpThen(conn, worker, 'passcode', codePage);
        const result = await finish(conn, 'passcode', 'the passcode step');
        assert.equal(result.status, 'check_inbox');
        assert.equal(result.reason, 'email_code');
        assert.equal(result.next_action, 'verify_email');
        assert.deepEqual(result.account, { creation: 'unknown', email_verification: 'pending', session: 'unknown' });
        assert.ok(result.timings.page_wait_ms < 3000, `waited ${result.timings.page_wait_ms} ms`);
        assert.equal(worker.fills.length, 1, 'the passcode box gets nothing');
      });
    });

    await section('create_account called again on a passcode step never types into its box', async () => {
      await withWorker(async (conn, worker) => {
        worker.show(codePage);
        callOn(conn, 'passcode-again', 'create_account', Date.now() + 60000);
        assert.equal((await finish(conn, 'passcode-again', 'the second call')).status, 'check_inbox');
        assert.equal(worker.fills.length, 0);
      });
    });

    await section('a passcode box Latch cannot read still means check_inbox once the page says the code went out', async () => {
      await withWorker(async (conn, worker) => {
        const box = { kind: 'other', ref: 'o1', form: 0, empty: true };
        await signUpThen(conn, worker, 'unread-box', framePage([...signupFields, box], { auth: { signup: true }, flags: { emailCode: true } }));
        const result = await finish(conn, 'unread-box', 'the unread passcode step', 25000);
        assert.equal(result.status, 'check_inbox');
        assert.equal(result.reason, 'email_code');
        assert.equal(result.account.creation, 'unknown');
      });
    });

    await section('sign-up wording that was already on the form is no evidence a code went out', async () => {
      await withWorker(async (conn, worker) => {
        const flags = { emailCode: true };
        const box = { kind: 'other', ref: 'o1', form: 0, empty: true };
        await signUpThen(conn, worker, 'static-text', framePage([...signupFields, box], { auth: { signup: true }, flags }),
          framePage(signupFields, { auth: { signup: true }, flags }));
        const result = await finish(conn, 'static-text', 'the unchanged notice');
        assert.equal(result.status, 'unconfirmed');
        assert.deepEqual(result.account, unknownAccount);
      });
    });

    await section('a rejection on the sign-up form stays sign_up_failed, with or without a passcode notice', async () => {
      for (const flags of [{}, { emailCode: true }]) {
        await withWorker(async (conn, worker) => {
          const error = 'Please complete all required fields and re-submit.';
          await signUpThen(conn, worker, 'rejected', framePage(signupFields, { auth: { signup: true }, error, flags }));
          const result = await finish(conn, 'rejected', 'the rejected sign-up');
          assert.equal(result.status, 'sign_up_failed');
          assert.match(result.message, /complete all required fields/);
          assert.deepEqual(result.account, unknownAccount);
        });
      }
    });

    await section('a sign-up page that says to verify the email reports check_inbox at once, even with the form still showing', async () => {
      await withWorker(async (conn, worker) => {
        await signUpThen(conn, worker, 'verify-modal', framePage(signupFields, { auth: { signup: true }, flags: { checkEmail: true } }));
        const result = await finish(conn, 'verify-modal', 'the verification prompt');
        assert.equal(result.status, 'check_inbox');
        assert.equal(result.reason, 'email_link');
        assert.ok(result.timings.page_wait_ms < 3000, `waited ${result.timings.page_wait_ms} ms`);
      });
    });

    await section('a sign-up the page never answers stays unconfirmed and claims nothing', async () => {
      await withWorker(async (conn, worker) => {
        await signUpThen(conn, worker, 'silent-signup', signupPage);
        const result = await finish(conn, 'silent-signup', 'the silent sign-up', 50000);
        assert.equal(result.status, 'unconfirmed');
        assert.equal(result.next_action, 'inspect_page');
        assert.deepEqual(result.account, unknownAccount);
        assert.deepEqual(result.evidence.signals, []);
        assert.equal(worker.fills.length, 1, 'it is not submitted twice');
      });
    });
  } finally {
    for (const conn of conns) conn.sock.terminate();
    hub.close();
  }
  if (failures.length) throw new Error(`${failures.length} bridge section(s) failed: ${failures.join('; ')}`);
} finally {
  ws?.close();
  await mcp.close();
  rmSync(work, { recursive: true, force: true });
}
