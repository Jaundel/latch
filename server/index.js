#!/usr/bin/env node
// MCP server for Latch. The AI calls these tools; the work happens in the Latch
// Chrome extension, which connects to this process over a loopback WebSocket.
// The first server to start owns the port; later ones relay through it.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import WebSocket, { WebSocketServer } from 'ws';
import { z } from 'zod';
import { EXTENSION_ID } from '../extension/id.js';
import { checkMailbox, findVerification, lookupProvider } from './mail.js';

const VERSION = '0.1.0';
const PORT = Number(process.env.LATCH_PORT || 47801);
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
const log = msg => process.stderr.write(`latch: ${msg}\n`);

const UNAVAILABLE = {
  status: 'unavailable',
  message: 'Latch is not connected to Chrome. Ask the user to open Chrome with the Latch extension turned on, then try again.',
};
const TIMED_OUT = { status: 'error', message: 'Latch did not finish in time. Check the tab, then try again.' };
const DROPPED = { status: 'error', message: 'Latch lost its connection to Chrome. Try again.' };

// Everything returned to the AI passes through this shape; unknown keys are dropped.
const Result = z.object({
  status: z.string().regex(/^[a-z_]{2,40}$/),
  site: z.string().max(253).regex(/^[a-z0-9.-]*$/i).optional(),
  reason: z.string().regex(/^[a-z_]{2,40}$/).optional(),
  message: z.string().max(400).optional(),
  verified: z.boolean().optional(),
  missing: z.array(z.string().max(80)).max(12).optional(),
});

let clientName = 'AI';
let wss = null;          // set when this process owns the port
let extension = null;    // extension socket (owner only)
const peers = new Set(); // relay sockets from other Latch servers (owner only)
let upstream = null;     // socket to the owner (relay only)
const pending = new Map();
const connectWaiters = new Set();
let seq = 0;

const send = (ws, msg) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
const parse = data => { try { return JSON.parse(String(data)); } catch { return {}; } };

function clients() {
  return [clientName, ...[...peers].map(p => p.clientName).filter(Boolean)];
}

function failPending(result) {
  for (const done of pending.values()) done(result);
  pending.clear();
}

function listen() {
  return new Promise((resolve, reject) => {
    const server = new WebSocketServer({
      host: '127.0.0.1',
      port: PORT,
      maxPayload: 1 << 20,
      verifyClient: ({ origin, req }) => origin === EXTENSION_ORIGIN || (!origin && req.url === '/peer'),
    });
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}

function onConnection(ws, req) {
  if (req.url === '/peer') {
    peers.add(ws);
    ws.on('message', data => onPeerMessage(ws, data));
    ws.on('close', () => { peers.delete(ws); send(extension, { type: 'hello', version: VERSION, clients: clients() }); });
    return;
  }
  if (extension && extension !== ws) extension.close();
  extension = ws;
  ws.on('message', data => onExtensionMessage(ws, data));
  ws.on('close', () => {
    if (extension !== ws) return;
    extension = null;
    failPending(DROPPED);
  });
  send(ws, { type: 'hello', version: VERSION, clients: clients() });
  for (const wake of connectWaiters) wake();
  connectWaiters.clear();
  log('extension connected');
}

async function onExtensionMessage(ws, data) {
  const msg = parse(data);
  switch (msg.type) {
    case 'ping':
      send(ws, { type: 'pong' });
      break;
    case 'result':
      pending.get(msg.id)?.(msg.result);
      break;
    case 'mail':
      send(ws, { type: 'reply', id: msg.id, result: await findVerification(msg.request || {}) });
      break;
    case 'mail_check':
      send(ws, { type: 'reply', id: msg.id, result: await checkMailbox(msg.request || {}) });
      break;
    case 'provider':
      send(ws, { type: 'reply', id: msg.id, result: await lookupProvider(msg.request?.domain) });
      break;
  }
}

async function onPeerMessage(ws, data) {
  const msg = parse(data);
  if (msg.type === 'hello') {
    ws.clientName = String(msg.client || '').slice(0, 60);
    send(extension, { type: 'hello', version: VERSION, clients: clients() });
  } else if (msg.type === 'call') {
    const result = await callExtension(msg.tool, msg.args, Math.min(Number(msg.timeoutMs) || 60000, 90000));
    send(ws, { type: 'result', id: msg.id, result });
  }
}

function waitForExtension(ms) {
  if (extension) return Promise.resolve();
  return new Promise(resolve => {
    const wake = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { connectWaiters.delete(wake); resolve(); }, ms);
    connectWaiters.add(wake);
  });
}

async function callExtension(tool, args, timeoutMs) {
  await waitForExtension(30000);
  if (!extension) return UNAVAILABLE;
  const id = ++seq;
  return new Promise(resolve => {
    const timer = setTimeout(() => { pending.delete(id); resolve(TIMED_OUT); }, timeoutMs);
    pending.set(id, result => { clearTimeout(timer); pending.delete(id); resolve(result); });
    send(extension, { type: 'call', id, tool, args });
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
      if (msg.type === 'result') pending.get(msg.id)?.(msg.result);
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
  if (wss) {
    result = await callExtension(tool, args, timeoutMs);
  } else if (upstream) {
    const id = ++seq;
    result = await new Promise(resolve => {
      const timer = setTimeout(() => { pending.delete(id); resolve(TIMED_OUT); }, timeoutMs + 35000);
      pending.set(id, r => { clearTimeout(timer); pending.delete(id); resolve(r); });
      send(upstream, { type: 'call', id, tool, args, timeoutMs });
    });
  } else {
    result = UNAVAILABLE;
  }
  const safe = Result.safeParse(result);
  const out = safe.success ? safe.data : { status: 'error', message: 'Latch returned an unexpected result.' };
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
      'Never ask the user for their password and never type credentials yourself.',
  },
);

const tabArg = {
  tabId: z.number().int().optional().describe('Chrome tab ID from your browser tools. Defaults to the active tab.'),
};

server.registerTool('sign_in', {
  title: 'Sign in',
  description:
    'Sign the user in on the website open in a Chrome tab. Use it whenever a page asks the user to log in or a session has expired. ' +
    'Latch fills the saved email and password privately, submits, enters email verification codes if the site asks, and returns the outcome. ' +
    'You never see the email or password. Afterwards, continue with your normal browser tools.',
  inputSchema: tabArg,
}, args => call('sign_in', args, 58000));

server.registerTool('create_account', {
  title: 'Create account',
  description:
    'Create an account for the user on the sign-up page open in a Chrome tab. Before calling, fill any other fields yourself ' +
    '(name, etc.) and tick required boxes, but leave email and password fields empty. Latch fills the user\'s email and a new ' +
    'strong password, saves it, submits, and completes email verification (codes or links). If the result lists missing fields, ' +
    'fill them and call again; a retry reuses the same saved password.',
  inputSchema: tabArg,
}, args => call('create_account', args, 58000));

server.registerTool('verify_email', {
  title: 'Verify email',
  description:
    'Finish an email verification step, for example when a page says a code or link was sent to the user\'s email. ' +
    'Latch reads only the matching recent message from that site, then enters the code in the tab or opens the link privately. ' +
    'Codes and links are never shown to you.',
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
  send(extension, { type: 'hello', version: VERSION, clients: clients() });
  send(upstream, { type: 'hello', client: clientName });
};

await claimRole().catch(err => log(`could not open the Chrome bridge: ${err.code || err.message}`));
await server.connect(new StdioServerTransport());

const shutdown = () => {
  wss?.close();
  upstream?.close();
  process.exit(0);
};
process.stdin.on('end', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
