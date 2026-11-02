// End-to-end test: a real MCP client calls the Latch server, which drives the
// real extension in Chromium against local fake sites and a fake IMAP inbox.
// It plays the AI's part (filling non-credential fields, reading the page) and
// checks that nothing private reaches the AI.
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Mailbox, startImap, startSites } from './fixture.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = join(root, 'test', 'output');
mkdirSync(out, { recursive: true });
const TEST_PORT = 47811;
const MAIN = { email: 'ada.c4n4ry@mail.localhost', password: 'Main-C4n4ry-pass!7' };
const APP_PASSWORD = 'imap-c4n4ry-app';
const EXTENSION_ID = /'([a-p]{32})'/.exec(readFileSync(join(root, 'extension', 'id.js'), 'utf8'))[1];
const sleep = ms => new Promise(r => setTimeout(r, ms));

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  (${detail})` : ''}`);
}
const note = (name, detail) => { checks.push({ name, ok: null, detail: String(detail) }); console.log(`INFO  ${name}  (${detail})`); };

// The extension under test is a copy pointed at a test port, so a real install keeps working.
const work = mkdtempSync(join(tmpdir(), 'latch-e2e-'));
const ext = join(work, 'extension');
cpSync(join(root, 'extension'), ext, { recursive: true });
const bgPath = join(ext, 'background.js');
writeFileSync(bgPath, readFileSync(bgPath, 'utf8').replace('const PORT = 47801;', `const PORT = ${TEST_PORT};`));

const mailbox = new Mailbox();
const imapStats = { logins: 0, failedLogins: 0, bodiesRead: 0 };
const imap = await startImap({ user: MAIN.email, pass: APP_PASSWORD, mailbox, stats: imapStats });
const sites = await startSites({ main: MAIN, mailbox });
const url = (host, path) => `http://${host}:${sites.port}${path}`;
mailbox.add({ from: 'Jobs Board <no-reply@jobs.localhost>', to: MAIN.email, subject: 'Verify your email', text: 'Your verification code is 111111.', at: new Date(Date.now() - 2 * 3600e3) });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, 'server', 'index.js')],
  env: { ...process.env, LATCH_PORT: String(TEST_PORT) },
  stderr: 'pipe',
});
let serverLog = '';
transport.stderr?.on('data', d => { serverLog += d; });
const mcp = new Client({ name: 'latch-e2e', version: '1.0.0' });
await mcp.connect(transport);

const { tools } = await mcp.listTools();
check('MCP server lists the four tools', tools.map(t => t.name).sort().join() === 'create_account,fill_email,sign_in,verify_email', tools.map(t => t.name).join(' '));

const context = await chromium.launchPersistentContext(join(work, 'profile'), {
  channel: 'chromium',
  headless: process.env.HEADED !== '1',
  viewport: { width: 1100, height: 800 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--host-resolver-rules=MAP plain.example 127.0.0.1'],
});
let [sw] = context.serviceWorkers();
sw ??= await context.waitForEvent('serviceworker');
check('extension loads with its pinned ID', new URL(sw.url()).host === EXTENSION_ID);

const popup = await context.newPage();
await popup.setViewportSize({ width: 360, height: 640 });
await popup.goto(`chrome-extension://${EXTENSION_ID}/popup.html`);
const latchState = () => popup.evaluate(() => chrome.runtime.sendMessage({ type: 'state' }));

for (let i = 0; i < 60 && !(await latchState()).connected; i++) await sleep(250);
check('extension connects to the local MCP server', (await latchState()).connected);
await popup.screenshot({ path: join(out, 'popup-setup.png') });

// ---------- setup through the popup, as the user would
await popup.fill('#email', MAIN.email);
await popup.fill('#password', MAIN.password);
await popup.click('button[type=submit]');
await popup.waitForSelector('#app-password');
await popup.fill('#app-password', APP_PASSWORD);
await popup.click('details.adv summary');
const adv = popup.locator('.adv-grid input');
await adv.nth(0).fill('127.0.0.1');
await adv.nth(1).fill(String(imap.port));
await adv.nth(3).uncheck();
await popup.screenshot({ path: join(out, 'popup-inbox.png') });
await popup.click('form button[type=submit]');
await popup.waitForSelector('.identity', { timeout: 30000 });
check('setup completes in the popup', true);
check('inbox password is verified live over IMAP', imapStats.logins >= 1, `${imapStats.logins} login`);

// ---------- helpers that play the AI's side
const transcript = [];

async function tabIdOf(page) {
  const target = page.url();
  return popup.evaluate(async u => (await chrome.tabs.query({})).find(t => t.url === u)?.id, target);
}

async function tool(name, page) {
  const tabId = page ? await tabIdOf(page) : undefined;
  const res = await mcp.callTool({ name, arguments: tabId ? { tabId } : {} }, undefined, { timeout: 120000 });
  const text = res.content?.[0]?.text || '';
  transcript.push({ name, text });
  return JSON.parse(text);
}

const secrets = () => [MAIN.email, MAIN.email.split('@')[0], MAIN.password, APP_PASSWORD, ...sites.secrets].filter(s => s && s.length >= 4);
const leaksIn = text => secrets().filter(s => String(text).toLowerCase().includes(s.toLowerCase()));

// What a browser agent could read back from the tab: field values, the ARIA tree, and the URL.
async function readableByAI(page) {
  const parts = [page.url()];
  for (const frame of page.frames()) {
    parts.push(await frame.evaluate(() => [...document.querySelectorAll('input, textarea')].map(i => i.value).join('\n')).catch(() => ''));
  }
  parts.push(await page.locator('body').ariaSnapshot().catch(() => ''));
  return parts.join('\n');
}

async function noLeak(label, page) {
  const found = leaksIn(await readableByAI(page));
  check(`${label}: nothing private left readable in the tab`, found.length === 0, found.length ? `${found.length} found` : '');
}

// Samples field values from page scripts while a call runs, like a parallel javascript tool would.
async function watch(page, fn) {
  let running = true;
  let samples = 0;
  let hits = 0;
  const loop = (async () => {
    while (running) {
      const values = await page.evaluate(() => [...document.querySelectorAll('input')].map(i => i.value).join('\n')).catch(() => '');
      samples++;
      if (leaksIn(values).some(s => s !== MAIN.email && s !== MAIN.email.split('@')[0])) hits++;
      await sleep(10);
    }
  })();
  const result = await fn();
  running = false;
  await loop;
  return { result, samples, hits };
}

const posts = (site, path) => sites.posts.filter(p => p.site === site && (!path || p.path === path)).length;

try {
  // 1. Sign-up form with a missing field is reported, not submitted.
  const jobs = await context.newPage();
  await jobs.goto(url('jobs.localhost', '/signup'));
  let r = await tool('create_account', jobs);
  check('incomplete sign-up returns the missing fields', r.status === 'form_incomplete' && r.missing?.some(m => /name/i.test(m)), r.missing?.join(' | '));
  check('incomplete sign-up was not submitted', posts('jobs.localhost') === 0);
  await noLeak('after form_incomplete', jobs);

  // 2. The AI fills its part; Latch fills email + generated password and finishes the emailed code.
  await jobs.fill('#n', 'Ada Tester');
  await jobs.check('input[name=terms]');
  r = await tool('create_account', jobs);
  const jobsAcct = sites.accounts.get(`jobs.localhost|${MAIN.email}`);
  check('create_account with emailed code', r.status === 'account_created' && r.verified === true, `${r.status} verified=${r.verified}`);
  check('site has exactly one verified account', jobsAcct?.verified === true && posts('jobs.localhost', '/signup') === 1);
  check('new account got a unique generated password', jobsAcct && jobsAcct.password !== MAIN.password && jobsAcct.password.length >= 16);
  check('stale and other-site codes were ignored', jobs.url().endsWith('/dashboard'), new URL(jobs.url()).pathname);
  await noLeak('after create_account', jobs);

  // 3. Fresh sign-in with the saved password, while page scripts poll the fields.
  await jobs.goto(url('jobs.localhost', '/logout'));
  const classic = await watch(jobs, () => tool('sign_in', jobs));
  check('sign_in reuses the saved password', classic.result.status === 'signed_in' && jobs.url().endsWith('/dashboard'), classic.result.status);
  check('classic form: password never readable by page scripts during the call', classic.hits === 0, `${classic.samples} samples`);
  await noLeak('after sign_in', jobs);

  // 4. Signing up again is recognised as an existing account and keeps the saved password.
  await jobs.goto(url('jobs.localhost', '/logout'));
  await jobs.goto(url('jobs.localhost', '/signup'));
  await jobs.fill('#n', 'Ada Tester');
  await jobs.check('input[name=terms]');
  r = await tool('create_account', jobs);
  check('existing account is detected, not duplicated', r.status === 'account_exists' && [...sites.accounts.keys()].filter(k => k.startsWith('jobs.localhost|')).length === 1, r.status);
  await noLeak('after account_exists', jobs);

  // 5. Email-first sign-up with a strict password rule and a confirmation link.
  const shop = await context.newPage();
  await shop.goto(url('shop.localhost', '/register'));
  r = await tool('create_account', shop);
  const shopAcct = sites.accounts.get(`shop.localhost|${MAIN.email}`);
  check('email-first sign-up confirmed by link', r.status === 'account_created' && r.verified === true && shopAcct?.verified, `${r.status} verified=${r.verified}`);
  check('generated password follows the site rules', shopAcct && shopAcct.password.length <= 16 && /\d/.test(shopAcct.password) && /[A-Za-z]/.test(shopAcct.password), shopAcct?.password.length);
  check('link opened once, in a tab that was closed', sites.confirmVisits === 1 && !context.pages().some(p => p.url().includes('/confirm')));
  check('the AI\'s tab never held the link token', !shop.url().includes('token'));
  await noLeak('after link confirmation', shop);

  // 6. Two-step single-page login with a controlled input, and a 6-box emailed code.
  const steps = await context.newPage();
  await steps.goto(url('steps.localhost', '/login'));
  const spa = await watch(steps, () => tool('sign_in', steps));
  check('two-step SPA sign-in with emailed digit code', spa.result.status === 'signed_in' && steps.url().endsWith('/home'), spa.result.status);
  note('single-page form: samples where page scripts could read the password mid-request', `${spa.hits} of ${spa.samples}`);
  await noLeak('after SPA sign-in', steps);

  // 7. Wrong password: reported, and the fields are cleared before the AI looks again.
  const wrong = await context.newPage();
  await wrong.goto(url('wrong.localhost', '/login'));
  r = await tool('sign_in', wrong);
  check('wrong password is reported', r.status === 'wrong_password', r.status);
  await noLeak('after wrong password', wrong);

  // 8. CAPTCHA: stop before filling anything.
  const captcha = await context.newPage();
  await captcha.goto(url('captcha.localhost', '/login'));
  r = await tool('sign_in', captcha);
  check('visible CAPTCHA hands off to the user', r.status === 'needs_user' && r.reason === 'captcha', `${r.status}/${r.reason}`);
  check('nothing was submitted to the CAPTCHA site', posts('captcha.localhost') === 0);
  await noLeak('after CAPTCHA', captcha);

  // 9. Phone code: hand off.
  const phone = await context.newPage();
  await phone.goto(url('phone.localhost', '/login'));
  r = await tool('sign_in', phone);
  check('phone verification hands off to the user', r.status === 'needs_user' && r.reason === 'phone_code', `${r.status}/${r.reason}`);

  // 10. Plain http on a public-looking host: refused.
  const plain = await context.newPage();
  await plain.goto(`http://plain.example:${sites.port}/login`);
  r = await tool('sign_in', plain);
  check('insecure page is refused', r.status === 'blocked' && posts('plain.example') === 0, r.status);

  // 11. Login form inside a cross-origin iframe.
  const framed = await context.newPage();
  await framed.goto(url('frame.localhost', '/'));
  r = await tool('sign_in', framed);
  check('sign-in inside an embedded login frame', r.status === 'signed_in' && posts('auth.frame.localhost') === 1, `${r.status} at ${r.site}`);

  // 12. Lookalike host: the password saved for jobs.localhost must not go to jobs.evil.localhost.
  const evil = await context.newPage();
  await evil.goto(url('jobs.evil.localhost', '/login'));
  r = await tool('sign_in', evil);
  check("a lookalike site never receives another site's saved password", !sites.posts.some(p => p.site === 'jobs.evil.localhost' && p.sentJobsPassword), r.status);
  await noLeak('after lookalike', evil);

  // 13. Account first, email verification later through verify_email.
  const later = await context.newPage();
  await later.goto(url('later.localhost', '/signup'));
  r = await tool('create_account', later);
  check('sign-up without an immediate verification step', r.status === 'account_created', r.status);
  await later.goto(url('later.localhost', '/settings/verify'));
  r = await tool('verify_email', later);
  check('verify_email enters an emailed letters-and-digits code', r.status === 'verified' && sites.accounts.get(`later.localhost|${MAIN.email}`)?.verified, r.status);
  await noLeak('after verify_email', later);

  // 14. fill_email on an application form.
  const apply = await context.newPage();
  await apply.goto(url('jobs.localhost', '/apply'));
  await apply.click('#ae');
  r = await tool('fill_email', apply);
  const filled = await apply.inputValue('#ae');
  check('fill_email types the address into the focused field', r.status === 'filled' && filled === MAIN.email, r.status);

  // 15. Paused from the popup.
  await popup.locator('.foot .switch').click();
  await sleep(300);
  r = await tool('sign_in', wrong);
  check('pausing Latch stops all fills', r.status === 'paused', r.status);
  await popup.locator('.foot .switch').click();

  await popup.reload();
  await popup.waitForSelector('.identity');
  await popup.screenshot({ path: join(out, 'popup-home.png') });
  await popup.emulateMedia({ colorScheme: 'dark' });
  await popup.screenshot({ path: join(out, 'popup-home-dark.png') });
  await popup.emulateMedia({ colorScheme: 'light' });

  // ---------- global checks
  const results = transcript.map(t => t.text).join('\n');
  check('no tool result contained the email, passwords, codes or tokens', leaksIn(results).length === 0, `${transcript.length} results`);
  check('server log contains nothing private', leaksIn(serverLog).length === 0);
  const stored = await popup.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
  check('saved data is encrypted at rest', leaksIn(stored).length === 0 && stored.includes('"vault"'));
  check('only matching messages were opened in full', imapStats.bodiesRead <= 12, `${imapStats.bodiesRead} bodies`);
} catch (err) {
  check('test run finished without crashing', false, err.stack?.split('\n').slice(0, 3).join(' | '));
} finally {
  writeFileSync(join(out, 'e2e.json'), JSON.stringify({ at: new Date().toISOString(), checks, transcript }, null, 2));
  await context.close().catch(() => {});
  await mcp.close().catch(() => {});
  imap.server.close();
  sites.server.close();
  rmSync(work, { recursive: true, force: true });
}

const failed = checks.filter(c => c.ok === false);
console.log(`\n${checks.filter(c => c.ok).length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
