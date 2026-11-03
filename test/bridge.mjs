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
import { PAGES, TAB_URL, startWorker } from './worker.js';

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
    writeFileSync(bg, readFileSync(bg, 'utf8').replace('const PORT = 47801;', 'const PORT = 47835;'));
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
  const callOn = (conn, id, tool, deadline) =>
    conn.sock.send(JSON.stringify({ type: 'call', id, tool, args: { url: TAB_URL }, client: 'bridge-test', deadline }));
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
