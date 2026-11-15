// Accessibility audit with axe-core (WCAG 2.1 A and AA rules) of every Latch screen in light
// and dark, and of the on-page panel in the real extension. Any violation fails the test.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { launchWithExtension } from './launch.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const read = name => readFileSync(join(root, 'extension', name), 'utf8');
const now = Date.now();
const STATE = { setup: true, email: 'you@example.com', connected: true, clients: ['claude-code'], mailbox: null, version: '1.0.0',
  settings: { paused: false, newPasswords: 'unique', confirmNewSites: true, bar: true, approvedSites: ['github.com'] },
  activity: [{ at: now - 60e3, tool: 'sign_in', site: 'github.com', status: 'signed_in', client: 'page' },
    { at: now - 3600e3, tool: 'sign_in', site: 'paypa1.com', status: 'blocked', reason: 'suspicious_site', client: 'page' }],
  sites: [{ host: 'github.com', status: 'active', source: 'main', totp: true, lastUsed: now },
    { host: 'shop.example', status: 'active', source: 'latch', hasPassword: true, lastUsed: now - 3600e3 }], resets: [] };
const REPLIES = `{
  pageState: () => ({ kind: 'sign_in', host: 'github.com', saved: false, totp: true }),
  codes: () => [{ host: 'github.com', issuer: 'GitHub', code: '482915', left: 19, period: 30, verified: true }],
  provider: () => ({ name: 'Gmail', host: 'imap.gmail.com', port: 993, help: 'https://myaccount.google.com/apppasswords' }),
  'approval:get': () => ({ host: 'login.bank.example', base: 'bank.example' }),
}`;

let browser;
before(async () => { browser = await chromium.launch({ channel: 'chrome' }); });
after(async () => { await browser?.close(); });

async function audit(page) {
  await page.addScriptTag({ content: AXE });
  return page.evaluate(async () => {
    const r = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
    return r.violations.map(v => `${v.id}: ${v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(', ')}`);
  });
}

async function openPage(file, { state = STATE, scheme, width, height }) {
  const page = await browser.newPage({ viewport: { width, height }, colorScheme: scheme });
  await page.route('https://ext.test/**', route => {
    const name = new URL(route.request().url()).pathname.replace(/^\/+/, '');
    if (name === 'stub.js') {
      return route.fulfill({ contentType: 'text/javascript', body: `const state = ${JSON.stringify(state)}; const replies = ${REPLIES};
        window.chrome = { runtime: { getURL: p => 'https://ext.test/' + p.replace(/^\\/+/, ''), getManifest: () => ({ version: '1.0.0' }),
          sendMessage: async m => (m.type === 'state' ? structuredClone(state) : replies[m.type] ? replies[m.type](m) : {}),
          onMessage: { addListener() {} }, connect: () => ({ postMessage() {} }) },
          tabs: { create() {} }, action: { getUserSettings: async () => ({ isOnToolbar: false }) } };` });
    }
    if (name.startsWith('_favicon')) return route.fulfill({ status: 404, body: '' });
    let body = read(name);
    if (name.endsWith('.html')) body = body.replace('<head>', '<head><script src="/stub.js"></script>');
    return route.fulfill({ contentType: name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'text/javascript' : 'text/html', body });
  });
  await page.goto(`https://ext.test/${file}`);
  await page.waitForTimeout(700);
  return page;
}

const SCREENS = [
  ['popup.html', 360, 600],
  ['app.html#ready', 1200, 900],
  ['app.html#accounts', 1200, 900],
  ['app.html#codes', 1200, 900],
  ['app.html#activity', 1200, 900],
  ['app.html#connect', 1200, 1100],
  ['app.html#settings', 1200, 1000],
  ['app.html#security', 1200, 1000],
  ['approve.html#abc', 440, 560],
];

for (const scheme of ['light', 'dark']) {
  test(`setup screens have no WCAG A/AA violations (${scheme})`, async () => {
    const welcome = await openPage('app.html#welcome', { state: { ...STATE, setup: false, email: '' }, scheme, width: 1200, height: 800 });
    assert.deepEqual(await audit(welcome), []);
    await welcome.close();
    const popup = await openPage('popup.html', { state: { ...STATE, setup: false, email: '', sites: [] }, scheme, width: 360, height: 600 });
    assert.deepEqual(await audit(popup), []);
    await popup.close();
  });

  for (const [file, width, height] of SCREENS) {
    test(`${file} has no WCAG A/AA violations (${scheme})`, async () => {
      const page = await openPage(file, { scheme, width, height });
      assert.deepEqual(await audit(page), []);
      await page.close();
    });
  }
}

test('the on-page panel has no WCAG A/AA violations, light and dark', async () => {
  const work = mkdtempSync(join(tmpdir(), 'latch-a11y-'));
  const ext = join(work, 'extension');
  cpSync(join(root, 'extension'), ext, { recursive: true });
  const { context, id } = await launchWithExtension(join(work, 'profile'), ext, { viewport: { width: 1200, height: 800 } });
  try {
    await context.route(/^https:\/\/a11y\.test\//, route => route.fulfill({ contentType: 'text/html',
      body: '<!doctype html><html lang="en"><head><title>Sign in</title></head><body><main><h1>Sign in</h1><form method="post"><label>Email <input type="email" name="email"></label><label>Password <input type="password" name="password"></label><button>Sign in</button></form></main></body></html>' }));
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'saveIdentity', email: 'a11y@example.test', password: 'A11y-pass-123' }));
    for (const scheme of ['light', 'dark']) {
      const page = await context.newPage();
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto('https://a11y.test/login');
      await page.getByRole('button', { name: 'Sign in with Latch' }).waitFor({ timeout: 15000 });
      await page.waitForTimeout(500);
      assert.deepEqual(await audit(page), [], scheme);
      await page.close();
    }
  } finally {
    await context.close();
    rmSync(work, { recursive: true, force: true });
  }
});

for (const scheme of ['light', 'dark']) {
  test(`the website and practice site have no WCAG A/AA violations (${scheme})`, async () => {
    // The site's CSP forbids injected scripts (as it should), so the audit context bypasses it.
    const auditContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: scheme, bypassCSP: true });
    const page = await auditContext.newPage();
    await page.route('https://site.test/**', route => {
      let name = new URL(route.request().url()).pathname.replace(/^\/+/, '') || 'index.html';
      if (name.endsWith('/')) name += 'index.html';
      const type = { html: 'text/html', css: 'text/css', js: 'text/javascript', png: 'image/png' }[name.split('.').pop()];
      return route.fulfill({ contentType: type, body: readFileSync(join(root, 'docs', name)) });
    });
    const found = {};
    for (const path of ['', 'privacy.html', 'demo/', 'demo/2fa.html', 'demo/forgot.html', 'demo/reset.html']) {
      await page.goto(`https://site.test/${path}`);
      const violations = await audit(page);
      if (violations.length) found[path || 'index'] = violations;
    }
    await auditContext.close();
    assert.deepEqual(found, {});
  });
}
