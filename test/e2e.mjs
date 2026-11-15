// End-to-end test: a real MCP client calls the Latch server, which drives the
// real extension in Chromium against local fake sites and a fake IMAP inbox.
// It plays the AI's part (filling non-credential fields, reading the page) and
// checks that nothing private reaches the AI.
import { launchWithExtension } from './launch.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Mailbox, startImap, startSites } from './fixture.js';
import { fingerprint } from '../extension/build.js';

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
const sourceBuild = await fingerprint(name => Promise.resolve(readFileSync(join(ext, name), 'utf8')));
const bgPath = join(ext, 'background.js');
const bgSource = readFileSync(bgPath, 'utf8');
const bgMoved = bgSource.replace('const PORT = 47801;', `const PORT = ${TEST_PORT};`);
if (bgMoved === bgSource) throw new Error('background.js has no "const PORT = 47801;" line, so the test copy could reach the live bridge');
writeFileSync(bgPath, bgMoved);

const mailbox = new Mailbox();
const imapStats = { logins: 0, failedLogins: 0, bodiesRead: 0 };
const imap = await startImap({ user: MAIN.email, pass: APP_PASSWORD, mailbox, stats: imapStats });
const sites = await startSites({ main: MAIN, mailbox });
const url = (host, path) => `http://${host}:${sites.port}${path}`;
mailbox.add({ from: 'Jobs Board <no-reply@jobs.localhost>', to: MAIN.email, subject: 'Verify your email', text: 'Your verification code is 111111.', at: new Date(Date.now() - 2 * 3600e3) });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, 'server', 'index.js')],
  env: { ...process.env, LATCH_PORT: String(TEST_PORT), LATCH_EXTENSION_DIR: ext },
  stderr: 'pipe',
});
let serverLog = '';
transport.stderr?.on('data', d => { serverLog += d; });
const mcp = new Client({ name: 'latch-e2e', version: '1.0.0' });
await mcp.connect(transport);

const { tools } = await mcp.listTools();
check('MCP server lists the nine tools', tools.map(t => t.name).sort().join() === 'application_page,create_account,fill_email,inspect_connection,request_password_recovery,set_new_password,setup_two_factor,sign_in,verify_email', tools.map(t => t.name).join(' '));

const { context, sw } = await launchWithExtension(join(work, 'profile'), ext, {
  viewport: { width: 1100, height: 800 },
  args: ['--host-resolver-rules=MAP plain.example 127.0.0.1, MAP collector.example 127.0.0.1'],
});
check('extension loads with its pinned ID', new URL(sw.url()).host === EXTENSION_ID);

const popup = await context.newPage();
await popup.setViewportSize({ width: 360, height: 640 });
await popup.goto(`chrome-extension://${EXTENSION_ID}/popup.html`);
const latchState = () => popup.evaluate(() => chrome.runtime.sendMessage({ type: 'state' }));

for (let i = 0; i < 60 && !(await latchState()).connected; i++) await sleep(250);
check('extension connects to the local MCP server', (await latchState()).connected);
await popup.screenshot({ path: join(out, 'popup-setup.png') });

// ---------- setup in the Latch page, as the user would: one step
const app = await context.newPage();
await app.goto(`chrome-extension://${EXTENSION_ID}/app.html#welcome`);
await app.fill('#email', MAIN.email);
await app.fill('#password', MAIN.password);
await app.click('form button[type=submit]');
await app.waitForSelector('h1:has-text("ready")', { timeout: 15000 });
await app.screenshot({ path: join(out, 'app-ready.png') });
check('setup takes one step: email and password', (await latchState()).setup);
// This run plays an unattended AI, so the first-use approval is off; test/bar.mjs covers approval.
await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'settings', patch: { confirmNewSites: false } }));

// The optional inbox connection, on the Connect page.
await app.goto(`chrome-extension://${EXTENSION_ID}/app.html#connect`);
await app.waitForSelector('#app-password', { timeout: 15000 });
await app.fill('#app-password', APP_PASSWORD);
await app.click('#inbox details summary');
const adv = app.locator('#inbox details input');
await adv.nth(0).fill('127.0.0.1');
await adv.nth(1).fill(String(imap.port));
await adv.nth(3).uncheck({ force: true });
await app.click('#inbox button[type=submit]');
await app.waitForSelector('#inbox :text("Inbox connected")', { timeout: 30000 });
check('inbox password is verified live over IMAP', imapStats.logins >= 1, `${imapStats.logins} login`);
await app.waitForSelector('.live.on', { timeout: 15000 });
check('the Connect page shows the live AI connection', await app.locator('.live.on').count() === 1);
await app.screenshot({ path: join(out, 'app-connect.png') });

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
  check('creation, verification and session are reported separately', r.account?.creation === 'created' && r.account?.email_verification === 'verified' && r.account?.session === 'signed_in');
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

  // 5b. Workday-style sign-up: covered submit button, emailed confirmation link.
  const workday = await context.newPage();
  await workday.goto(url('cibc.workday.localhost', '/signup'));
  await workday.check('#agree');
  r = await tool('create_account', workday);
  const wdAcct = sites.accounts.get(`cibc.workday.localhost|${MAIN.email}`);
  check('Workday-style sign-up behind a click overlay, verified by link', r.status === 'account_created' && r.verified === true && wdAcct?.verified, `${r.status} verified=${r.verified}`);
  check('Workday-style password meets every listed rule', wdAcct && [/\d/, /[a-z]/, /[A-Z]/, /[^A-Za-z0-9]/].every(re => re.test(wdAcct.password)) && wdAcct.password.length >= 8);
  await noLeak('after Workday-style sign-up', workday);

  // 5b2. A sign-in form that would post the password to another site gets nothing, with no prompt.
  const phish = await context.newPage();
  await phish.goto(url('phish.localhost', '/login'));
  r = await tool('sign_in', phish);
  check('a form posting to another site is refused automatically', r.status === 'blocked' && r.reason === 'suspicious_site' && posts('collector.example') === 0, `${r.status}/${r.reason}`);
  await noLeak('after refused phishing form', phish);

  // 5c. Oracle-style: email, then an emailed code; no password. Only the address says "sign-in".
  const oracle = await context.newPage();
  await oracle.goto(url('oracle.localhost', '/sites/CX/my-profile/sign-in'));
  r = await tool('sign_in', oracle);
  check('Oracle-style passwordless sign-in with an emailed code', r.status === 'signed_in' && new URL(oracle.url()).pathname === '/sites/CX/my-profile', `${r.status} at ${new URL(oracle.url()).pathname}`);
  check('Oracle-style honeypot is never filled', !sites.oracleHoneypot);
  await noLeak('after Oracle-style sign-in', oracle);

  // 5d. Taleo-style: registration asks for a user name; later sign-in is by user name.
  const taleo = await context.newPage();
  await taleo.goto(url('taleo.localhost', '/careersection/register'));
  await taleo.check('#privacy');
  r = await tool('create_account', taleo);
  const taleoAcct = sites.accounts.get(`taleo.localhost|${MAIN.email}`);
  check('Taleo-style registration fills user name, email and both confirmations', r.status === 'account_created' && taleoAcct?.username === MAIN.email, r.status);
  await taleo.goto(url('taleo.localhost', '/careersection/logout'));
  r = await tool('sign_in', taleo);
  check('Taleo-style sign-in by user name', r.status === 'signed_in' && new URL(taleo.url()).pathname === '/careersection/myaccount' && posts('taleo.localhost', '/login') === 1, r.status);
  await noLeak('after Taleo-style sign-in', taleo);

  // 5e. iCIMS-style universal login: email first, then either a password page or a new-account page.
  const icims = await context.newPage();
  await icims.goto(url('login.icims.localhost', '/u/login/identifier'));
  r = await tool('sign_in', icims);
  check('email-first sign-in with no account stops and says so', r.status === 'no_account' && posts('login.icims.localhost') === 0, r.status);
  await icims.goto(url('login.icims.localhost', '/u/login/identifier'));
  r = await tool('create_account', icims);
  const icimsAcct = sites.accounts.get(`login.icims.localhost|${MAIN.email}`);
  check('iCIMS-style sign-up from the email-first page, verified by link', r.status === 'account_created' && r.verified === true && icimsAcct?.verified, `${r.status} verified=${r.verified}`);
  await icims.goto(url('login.icims.localhost', '/u/logout'));
  r = await tool('sign_in', icims);
  check('iCIMS-style two-page sign-in', r.status === 'signed_in' && new URL(icims.url()).pathname === '/portal', r.status);
  check('no "Continue with Google/Indeed/..." button was ever pressed', !sites.socialClicks);
  await noLeak('after iCIMS-style sign-in', icims);

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

  const ambiguous = await context.newPage();
  await ambiguous.goto(url('ambiguous.localhost', '/login'));
  r = await tool('sign_in', ambiguous);
  check('mixed Workday rejection does not diagnose password or lockout', r.status === 'credentials_or_account_problem' && r.retryable === false, r.status);
  check('ambiguous rejection keeps account existence and verification unknown', r.account?.creation === 'unknown' && r.account?.email_verification === 'unknown' && r.account?.session === 'unknown');
  check('rejection preserves sanitized site wording', r.message.includes('might be locked') && r.message.includes('[hidden]'));
  check('agent receives visible alternative paths and rejection evidence', r.paths?.google === true && r.evidence?.error_observed === true && r.evidence?.actions.includes('login_submit'));
  check('tool timing identifies its own measured scope', r.timings?.total_ms >= r.timings?.fill_submit_ms && r.timings?.detection_ms >= 0);
  r = await tool('sign_in', ambiguous);
  check('immediate repeat is blocked without another credential submission', r.status === 'retry_blocked' && posts('ambiguous.localhost') === 1, r.status);
  // This fixture deliberately echoes the submitted email in its own error.
  // Latch can scrub its result and fields, not the site's rendered error text.
  check('rejection clears credential fields', await ambiguous.inputValue('#e') === '' && await ambiguous.inputValue('#p') === '');

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

  // 14a. Tools that drive Chrome over DevTools name the tab by its address, not a tab ID.
  const byUrl = async (name, address) => {
    const res = await mcp.callTool({ name, arguments: { url: address } }, undefined, { timeout: 120000 });
    const text = res.content?.[0]?.text || '';
    transcript.push({ name, text });
    return JSON.parse(text);
  };
  await apply.reload();
  const front = await context.newPage();
  r = await byUrl('fill_email', apply.url());
  check('a tab named by its address is found while another tab is in front', r.status === 'filled' && await apply.inputValue('#ae') === MAIN.email, r.status);
  r = await byUrl('fill_email', url('jobs.localhost', '/no-such-page'));
  check('an address no tab shows is refused', r.status === 'error' && front.url() === 'about:blank', r.status);
  await front.close();

  for (const name of ['sign_in', 'create_account']) {
    await apply.reload();
    r = await tool(name, apply);
    check(`${name} refuses an application form without filling or submitting`, r.status === 'no_form' && await apply.inputValue('#ae') === '' && posts('jobs.localhost', '/submit-application') === 0, r.status);
    await noLeak(`after application ${name}`, apply);
  }

  // 14b. The user can run the same flow from the popup on the tab in front of them.
  const here = await context.newPage();
  await here.goto(url('oracle.localhost', '/sites/CX/my-profile/sign-in'));
  await here.bringToFront();
  await popup.reload();
  await popup.locator('.page-title', { hasText: 'Sign-in page' }).waitFor({ timeout: 15000 });
  check('the popup reads what the page in front offers', (await popup.locator('.page-host').textContent()) === 'oracle.localhost');
  await popup.screenshot({ path: join(out, 'popup-page.png') });
  await popup.locator('.page button.primary').click();
  await popup.locator('.page .notice').waitFor({ timeout: 90000 });
  check('the popup Sign in button signs in on the tab in front', new URL(here.url()).pathname === '/sites/CX/my-profile', await popup.locator('.page .notice').textContent());
  await noLeak('after popup sign-in', here);

  // 15. Paused from the popup.
  await popup.locator('.foot .switch').click();
  await sleep(300);
  r = await tool('sign_in', wrong);
  check('pausing Latch stops all fills', r.status === 'paused', r.status);
  await popup.locator('.foot .switch').click();

  // 16. No inbox connected: Latch tells the AI to fetch the code from webmail itself.
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'removeMailbox' }));
  sites.accounts.get(`later.localhost|${MAIN.email}`).verified = false;
  await later.goto(url('later.localhost', '/settings/verify'));
  const laterTab = await tabIdOf(later);
  r = await tool('verify_email', later);
  check('without an inbox, the AI is told to read the code in webmail', r.status === 'check_inbox' && r.reason === 'email_code' && r.message.includes(`tab ${laterTab}`), r.status);
  // Play the AI: read the newest message from the site in "webmail" and type the code in.
  const newest = mailbox.messages.filter(m => /later\.localhost/.test(m.raw)).at(-1).raw;
  await later.fill('#o', /code to confirm your email: (\S+)/.exec(newest)[1]);
  await later.click('button[type=submit]');
  check('the AI can finish the step from the inbox itself', sites.accounts.get(`later.localhost|${MAIN.email}`).verified === true);

  await popup.reload();
  await popup.waitForSelector('.page');
  await popup.screenshot({ path: join(out, 'popup-home.png') });
  await popup.emulateMedia({ colorScheme: 'dark' });
  await popup.screenshot({ path: join(out, 'popup-home-dark.png') });
  await popup.emulateMedia({ colorScheme: 'light' });

  // File updates must be reported before any credentials are filled. Reloading a
  // running MV3 worker automatically can disconnect it and close extension pages.
  const reloadPage = await context.newPage();
  await reloadPage.goto(url('jobs.localhost', '/apply'));
  await reloadPage.click('#ae');
  const pagePath = join(ext, 'page.js');
  writeFileSync(pagePath, readFileSync(pagePath, 'utf8') + '\n// update regression\n');
  const reloadResult = await tool('fill_email', reloadPage);
  check('updated extension requires reload before any credential operation', reloadResult.status === 'reload_required' && await reloadPage.inputValue('#ae') === '', reloadResult.status);
  check('update handoff leaves the extension connected', context.serviceWorkers().includes(sw) && !popup.isClosed());
  await reloadPage.close();

  // ---------- global checks
  const results = transcript.map(t => t.text).join('\n');
  check('no tool result contained the email, passwords, codes or tokens', leaksIn(results).length === 0, `${transcript.length} results`);
  check('server log contains nothing private', leaksIn(serverLog).length === 0);
  const stored = await popup.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
  check('saved data is encrypted at rest', leaksIn(stored).length === 0 && stored.includes('"vault"'));
  check('only likely matches are opened in full (at most 2 per inbox search)', imapStats.bodiesRead <= 2 * imapStats.searches, `${imapStats.bodiesRead} bodies over ${imapStats.searches} searches`);
} catch (err) {
  check('test run finished without crashing', false, err.stack?.split('\n').slice(0, 3).join(' | '));
} finally {
  writeFileSync(join(out, 'e2e.json'), JSON.stringify({ at: new Date().toISOString(), sourceBuild, checks, transcript }, null, 2));
  await context.close().catch(() => {});
  await mcp.close().catch(() => {});
  imap.server.close();
  sites.server.close();
  rmSync(work, { recursive: true, force: true });
}

const failed = checks.filter(c => c.ok === false);
console.log(`\n${checks.filter(c => c.ok).length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
