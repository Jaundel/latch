import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchWithExtension } from './launch.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'latch-loading-'));
const ext = join(work, 'extension');
cpSync(join(root, 'extension'), ext, { recursive: true });
const bg = join(ext, 'background.js');
const bgSource = readFileSync(bg, 'utf8');
const bgMoved = bgSource.replace('const PORT = 47801;', 'const PORT = 47821;');
if (bgMoved === bgSource) throw new Error('background.js has no "const PORT = 47801;" line, so the test copy could reach the live bridge');
writeFileSync(bg, bgMoved);
const timers = new Set();
let posts = 0;
const site = createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  if (req.url === '/slow') {
    res.write('<html><body>Still loading');
    const timer = setTimeout(() => { timers.delete(timer); res.end('</body></html>'); }, 20000);
    timers.add(timer);
    return;
  }
  if (req.method === 'POST') {
    posts++;
    req.resume();
    res.writeHead(303, { location: req.url === '/identifier' ? '/password' : '/home' });
    return res.end();
  }
  if (req.url === '/home') return res.end('<h1>Signed in</h1><button>Sign out</button>');
  if (req.url === '/identifier') return res.end('<h1>Sign In</h1><form method="post"><label>Email<input type="email" name="email"></label><button>Continue</button></form>');
  if (req.url === '/password') return res.end('<h1>Enter Your Password</h1><form method="post"><label>Password<input type="password" name="password"></label><button>Log In</button></form><iframe src="/slow"></iframe>');
  if (req.url === '/delayed-signup') return res.end(`<h1>Create Account</h1><form><input type="email" aria-label="Email"><input type="password" autocomplete="new-password" aria-label="Password"><button>Create Account</button></form>
    <script>document.querySelector('form').onsubmit = event => {
      event.preventDefault(); fetch('/signup-start', {method:'POST'});
      setTimeout(() => { const frame = document.createElement('iframe'); frame.src = '/unrelated'; document.body.append(frame); }, 50);
      setTimeout(() => { document.body.innerHTML = '<h1>Welcome</h1><button>Sign out</button>'; }, 2200);
    };</script>`);
  if (req.url === '/slow-login') return res.end(`<h1>Sign In</h1><form><input type="email" aria-label="Email"><input type="password" aria-label="Password"><button>Sign In</button></form>
    <script>document.querySelector('form').onsubmit = event => {
      event.preventDefault(); fetch('/login-start', {method:'POST'});
      setTimeout(() => { document.body.innerHTML = '<h1>Candidate Home</h1><button>Sign out</button>'; }, 13500);
    };</script>`);
  if (req.url === '/hydrating-login') return res.end(`<title>Sign In</title><h1>Sign In</h1><form><input type="email" aria-label="Email"><button>Continue</button></form>
    <script>document.querySelector('form').onsubmit = event => {
      event.preventDefault(); fetch('/identify-start', {method:'POST'});
      document.body.innerHTML = '<h1>Enter your password</h1>';
      setTimeout(() => {
        document.body.innerHTML = '<h1>Enter your password</h1><form method="post"><input type="password" name="password" aria-label="Password"><button>Log In</button></form>';
      }, 1800);
    };</script>`);
  if (req.url === '/hydrating-error') return res.end(`<h1>Sign In</h1><form><input type="email" aria-label="Email"><button>Continue</button></form>
    <script>document.querySelector('form').onsubmit = event => {
      event.preventDefault(); fetch('/identify-start', {method:'POST'});
      document.body.innerHTML = '<h1>Checking your account</h1>';
      setTimeout(() => { document.body.innerHTML = '<div role="alert">No account found</div>'; }, 1800);
    };</script>`);
  res.end(`<title>Sign In</title><h1>Sign In</h1><form method="post">
    <label>Email<input type="email" name="email"></label><label>Password<input type="password" name="password"></label>
    <button>Sign In</button></form><iframe src="/slow"></iframe>`);
});
await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
const mcp = new Client({ name: 'latch-loading-test', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'server/index.js')], env: { ...process.env, LATCH_PORT: '47821', LATCH_EXTENSION_DIR: ext }, stderr: 'pipe' });
let context;
try {
  await mcp.connect(transport);
  let sw;
  ({ context, sw } = await launchWithExtension(join(work, 'profile'), ext, { headless: true }));
  context.on('weberror', error => console.error('browser error:', error.error().message));
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html`);
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'saveIdentity', email: 'loading-canary@example.test', password: 'Loading-Canary!7' }));
  // An unattended AI: no approval window for the new site.
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'settings', patch: { confirmNewSites: false } }));
  const page = await context.newPage();
  await page.goto(`http://jobs.localhost:${site.address().port}/login`, { waitUntil: 'domcontentloaded' });
  const tabId = await popup.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, page.url());
  const started = Date.now();
  const result = await mcp.callTool({ name: 'sign_in', arguments: { tabId } }, undefined, { timeout: 70000 });
  const status = JSON.parse(result.content[0].text).status;
  const elapsed = Date.now() - started;
  console.log(JSON.stringify({ status, elapsedMs: elapsed, posts, path: new URL(page.url()).pathname }));
  assert.equal(status, 'signed_in', 'a loading third-party frame must not block the ready login form');
  assert.equal(posts, 1);
  assert.ok(elapsed < 6000, 'login must not wait for the unrelated frame to finish loading');
  assert.equal(new URL(page.url()).pathname, '/home');
  const existingStarted = Date.now();
  const existing = JSON.parse((await mcp.callTool({ name: 'sign_in', arguments: { tabId } })).content[0].text);
  assert.equal(existing.status, 'signed_in');
  assert.ok(Date.now() - existingStarted < 1000, 'an already authenticated page should return immediately');
  await page.goto(`http://jobs.localhost:${site.address().port}/identifier`);
  const nextStarted = Date.now();
  const next = JSON.parse((await mcp.callTool({ name: 'sign_in', arguments: { tabId } }, undefined, { timeout: 70000 })).content[0].text);
  const nextElapsed = Date.now() - nextStarted;
  console.log(JSON.stringify({ scenario: 'email-first with loading password page', status: next.status, elapsedMs: nextElapsed, posts }));
  assert.equal(next.status, 'signed_in');
  assert.equal(posts, 3, 'each of the email and password stages must submit exactly once');
  assert.ok(nextElapsed < 6000, 'the password stage must not wait for unrelated frames');
  await page.goto(`http://jobs.localhost:${site.address().port}/delayed-signup`);
  const signupStarted = Date.now();
  const signup = JSON.parse((await mcp.callTool({ name: 'create_account', arguments: { tabId } }, undefined, { timeout: 70000 })).content[0].text);
  console.log(JSON.stringify({ scenario: 'unrelated frame during pending signup', status: signup.status, elapsedMs: Date.now() - signupStarted }));
  assert.equal(signup.status, 'account_created', 'an unrelated frame change must not be mistaken for a rejected signup');
  assert.equal(posts, 4, 'signup must submit exactly once');
  await page.goto(`http://jobs.localhost:${site.address().port}/slow-login`);
  const slowStarted = Date.now();
  const slow = JSON.parse((await mcp.callTool({ name: 'sign_in', arguments: { tabId } }, undefined, { timeout: 70000 })).content[0].text);
  console.log(JSON.stringify({ scenario: 'slow site response', status: slow.status, elapsedMs: Date.now() - slowStarted }));
  assert.equal(slow.status, 'signed_in', 'a silent pending submission is not a rejected password');
  assert.equal(posts, 5, 'slow sites must not cause duplicate submissions');
  await page.goto(`http://jobs.localhost:${site.address().port}/hydrating-login`);
  const hydrationStarted = Date.now();
  const hydrated = JSON.parse((await mcp.callTool({ name: 'sign_in', arguments: { tabId } }, undefined, { timeout: 70000 })).content[0].text);
  console.log(JSON.stringify({ scenario: 'password form hydrates after redirect shell', status: hydrated.status, elapsedMs: Date.now() - hydrationStarted, path: new URL(page.url()).pathname }));
  assert.equal(hydrated.status, 'signed_in');
  assert.equal(new URL(page.url()).pathname, '/home', 'an intermediate shell must not be reported as signed in');
  assert.equal(posts, 7, 'both stages must submit exactly once before claiming success');
  assert.ok(Date.now() - hydrationStarted < 6000, 'hydration should resume as soon as the password form is ready');
  await page.goto(`http://jobs.localhost:${site.address().port}/hydrating-error`);
  const rejected = JSON.parse((await mcp.callTool({ name: 'sign_in', arguments: { tabId } }, undefined, { timeout: 70000 })).content[0].text);
  console.log(JSON.stringify({ scenario: 'delayed rejection after form disappears', status: rejected.status }));
  assert.equal(rejected.status, 'no_account', 'a form-less transition must wait for the actual rejection');
  assert.equal(posts, 8, 'an unresolved transition must not cause duplicate submissions');
} finally {
  for (const timer of timers) clearTimeout(timer);
  await context?.close();
  await mcp.close();
  site.closeAllConnections();
  await new Promise(resolve => site.close(resolve));
  rmSync(work, { recursive: true, force: true });
}
