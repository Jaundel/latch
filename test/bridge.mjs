import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { EXTENSION_ID } from '../extension/id.js';
import { BUILD_FILES } from '../extension/build.js';

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
try {
  await mcp.connect(transport);
  ws = new WebSocket('ws://127.0.0.1:47831', { origin: `chrome-extension://${EXTENSION_ID}` });
  const ready = new Promise(resolve => ws.on('message', raw => {
    const msg = JSON.parse(String(raw));
    if (msg.type === 'hello') {
      ws.send(JSON.stringify({ type: 'ready', loadedAt: Date.now(), build }));
      resolve();
    } else if (msg.type === 'call') {
      calls++;
      ws.send(JSON.stringify({ type: 'result', id: msg.id, result: { status: 'filled' } }));
    }
  }));
  await ready;
  const call = async () => JSON.parse((await mcp.callTool({ name: 'fill_email', arguments: {} })).content[0].text);
  assert.equal((await call()).status, 'filled');
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
  assert.equal((await call()).status, 'reload_required');
  assert.equal(calls, 3, 'stale code must not receive credential operations');
  console.log('PASS bridge: content freshness, immediate dispatch, stale-code guard');
} finally {
  ws?.close();
  await mcp.close();
  rmSync(work, { recursive: true, force: true });
}
