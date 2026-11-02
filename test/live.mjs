// Live check with your real details in your own Chrome.
//
// Starts the practice sites on *.localhost and the Latch MCP server on its normal
// port, so the installed extension connects. A browser agent opens the practice
// pages and calls the tools through http://127.0.0.1:47950. The practice sites are
// the only thing that receives your details. Leak checks compare against what they
// received and report counts only; nothing private is printed or returned.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Mailbox, startSites } from './fixture.js';

const SITES_PORT = 47900;
const CONTROL_PORT = 47950;
const root = fileURLToPath(new URL('..', import.meta.url));

const sites = await startSites({ mailbox: new Mailbox(), live: true, port: SITES_PORT });
let serverLog = '';
let extensionConnected = false;
const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'server', 'index.js')], stderr: 'pipe' });
transport.stderr?.on('data', d => {
  serverLog += d;
  if (/extension connected/.test(String(d))) extensionConnected = true;
});
const mcp = new Client({ name: 'latch-live-check', version: '1.0.0' });
await mcp.connect(transport);

const sha = s => createHash('sha256').update(s.toLowerCase()).digest('hex');
const secrets = () => [...sites.secrets].filter(s => s && s.length >= 4);
const leakCount = text => secrets().filter(s => String(text).toLowerCase().includes(s.toLowerCase())).length;
const calls = [];

async function readJson(req) {
  let data = '';
  for await (const chunk of req) data += chunk;
  try { return JSON.parse(data || '{}'); } catch { return {}; }
}

const control = createServer(async (req, res) => {
  const reply = obj => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  try {
    if (req.method === 'POST' && req.url === '/call') {
      const { tool, tabId } = await readJson(req);
      const result = await mcp.callTool({ name: tool, arguments: Number.isInteger(tabId) ? { tabId } : {} }, undefined, { timeout: 120000 });
      const text = result.content?.[0]?.text || '';
      const leaks = leakCount(text);
      calls.push({ tool, leaks });
      return reply(leaks ? { status: 'leak_detected', leaks } : { ...JSON.parse(text), leakCheck: 'clean' });
    }
    if (req.method === 'POST' && req.url === '/check') {
      const { hashes = [] } = await readJson(req);
      const known = new Set(secrets().map(sha));
      return reply({ checked: hashes.length, matches: hashes.filter(h => known.has(h)).length });
    }
    if (req.url === '/status') {
      const accounts = {};
      for (const [key, acct] of sites.accounts) {
        const site = key.split('|')[0];
        accounts[site] = { count: (accounts[site]?.count || 0) + 1, verified: acct.verified };
      }
      return reply({
        extensionConnected,
        accounts,
        posts: sites.posts.length,
        privateValuesSeenBySites: secrets().length,
        toolCalls: calls.length,
        leaksInToolResults: calls.reduce((n, c) => n + c.leaks, 0),
        leaksInServerLog: leakCount(serverLog),
        bridgeLog: serverLog.split('\n').filter(line => /^latch: (listening|relaying|extension (connected|ready)|(?:sign_in|create_account|verify_email|fill_email) ->)/.test(line)).slice(-15),
      });
    }
    if (req.url === '/stop') {
      reply({ stopping: true });
      setTimeout(shutdown, 100);
      return;
    }
    res.writeHead(404);
    res.end();
  } catch (err) {
    reply({ status: 'harness_error', message: String(err.message).slice(0, 200) });
  }
});
await new Promise(resolve => control.listen(CONTROL_PORT, '127.0.0.1', resolve));

async function shutdown() {
  control.close();
  sites.server.close();
  await mcp.close().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);

console.log(`practice sites: http://<name>.localhost:${SITES_PORT}  (jobs, later, steps, wrong, captcha, phone, frame, shop)`);
console.log(`control:        http://127.0.0.1:${CONTROL_PORT}  (POST /call, POST /check, GET /status, GET /stop)`);
setTimeout(shutdown, 60 * 60e3);
