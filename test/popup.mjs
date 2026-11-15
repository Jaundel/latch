// The toolbar popup and the Latch page, rendered in Chrome against a stand-in for the extension API.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const read = name => readFileSync(new URL(`../extension/${name}`, import.meta.url), 'utf8');
let browser;
before(async () => { browser = await chromium.launch({ channel: 'chrome' }); });
after(async () => { await browser?.close(); });

// Serves the extension's pages from a fake origin, with chrome.runtime answered by `replies`.
async function open(file, { state, replies = {}, viewport = { width: 360, height: 600 } }) {
  const page = await browser.newPage({ viewport });
  await page.route('https://ext.test/**', route => {
    const name = new URL(route.request().url()).pathname.slice(1).split('?')[0];
    if (name.startsWith('_favicon')) return route.fulfill({ status: 404, body: '' });
    const type = name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'text/javascript' : 'text/html';
    let body = read(name);
    // The stand-in API has to exist before the page's own module runs.
    if (name.endsWith('.html')) body = body.replace('<head>', '<head><script src="/stub.js"></script>');
    return route.fulfill({ contentType: type, body });
  });
  await page.route('https://ext.test/stub.js', route => route.fulfill({ contentType: 'text/javascript', body: `
    window.sent = [];
    const state = ${JSON.stringify(state)};
    const replies = { state: () => structuredClone(state), ${Object.entries(replies).map(([k, v]) => `${JSON.stringify(k)}: ${v}`).join(',')} };
    window.chrome = {
      runtime: { getURL: p => 'https://ext.test/' + p.replace(/^\\//, ''), getManifest: () => ({ version: '1.0.0' }),
        sendMessage: async msg => { window.sent.push(msg); return replies[msg.type] ? replies[msg.type](msg) : {}; },
        onMessage: { addListener() {} }, connect: () => ({ postMessage() {} }) },
      tabs: { create: o => { window.opened = o.url; } },
      action: { getUserSettings: async () => ({ isOnToolbar: false }) },
    };
    window.close = () => { window.closed = true; };` }));
  await page.goto(`https://ext.test/${file}`);
  return page;
}

const SETUP = { setup: true, email: 'fixture@example.test', connected: false, clients: [], mailbox: null, version: '1.0.0',
  settings: { paused: false, newPasswords: 'unique', confirmNewSites: true, bar: true, approvedSites: ['bank.test'] }, activity: [],
  sites: [{ host: 'github.com', status: 'active', source: 'main', totp: true, totpVerified: true, lastUsed: Date.now() }], resets: [] };

test('before setup the popup offers one button that opens setup', async () => {
  const page = await open('popup.html', { state: { ...SETUP, setup: false, email: '', sites: [] } });
  await page.getByRole('heading', { name: 'Let your AI sign in for you' }).waitFor();
  await page.getByRole('button', { name: 'Set up Latch' }).click();
  assert.match(await page.evaluate(() => window.opened), /app\.html#welcome$/);
  await page.close();
});

test('the popup reads the page in front and runs Latch there', async () => {
  const page = await open('popup.html', { state: SETUP, replies: {
    pageState: '() => ({ kind: "sign_in", host: "github.com", saved: false, totp: true })',
    codes: '() => [{ host: "github.com", issuer: "GitHub", code: "123456", left: 12, period: 30, verified: true }]',
    runHere: '() => ({ status: "signed_in", site: "github.com", message: "Signed in. Continue your task in this tab." })',
  } });
  await page.locator('.page-title', { hasText: 'Sign-in page' }).waitFor();
  assert.equal(await page.locator('.twofa .code').textContent(), '123 456', '2FA code for the site is shown');
  await page.getByRole('button', { name: 'Sign in with Latch' }).click();
  await page.locator('.page .notice', { hasText: 'Signed in. Continue your task in this tab.' }).waitFor();
  assert.ok((await page.evaluate(() => window.sent)).some(m => m.type === 'runHere' && m.tool === 'sign_in'));
  await page.close();
});

test('welcome is one step: email and password', async () => {
  const state = { ...SETUP, setup: false, email: '', sites: [] };
  const page = await open('app.html#welcome', { state, viewport: { width: 1200, height: 800 }, replies: {
    saveIdentity: '() => { state.setup = true; state.email = "new@example.test"; return { ok: true }; }',
  } });
  await page.getByRole('heading', { name: 'Let your AI sign in for you.' }).waitFor();
  await page.getByRole('button', { name: 'Start using Latch' }).click();
  await page.getByText('Enter the email address you sign in with.').waitFor();
  await page.getByLabel('Email').fill('new@example.test');
  await page.getByLabel('Password', { exact: true }).fill('Secret-pass-1');
  await page.getByRole('button', { name: 'Start using Latch' }).click();
  await page.getByRole('heading', { name: 'You\'re ready.' }).waitFor();
  const saved = (await page.evaluate(() => window.sent)).find(m => m.type === 'saveIdentity');
  assert.deepEqual(saved, { type: 'saveIdentity', email: 'new@example.test', password: 'Secret-pass-1' });
  assert.equal(await page.getByLabel('Password', { exact: true }).count(), 0, 'the password field is gone once saved');
  await page.getByText('Pin Latch to your toolbar.').waitFor();
  await page.close();
});

test('settings show approved sites and the safety switch', async () => {
  const page = await open('app.html#settings', { state: SETUP, viewport: { width: 1200, height: 800 } });
  await page.getByText('Ask before using my password on a new site').waitFor();
  assert.equal(await page.getByRole('checkbox', { name: 'Ask before using my password on a new site' }).isChecked(), true);
  await page.getByRole('button', { name: 'Remove bank.test' }).click();
  const patch = (await page.evaluate(() => window.sent)).find(m => m.type === 'settings');
  assert.deepEqual(patch.patch, { approvedSites: [] });
  await page.close();
});

test('2FA keys can be added by hand, and bad keys are explained', async () => {
  const page = await open('app.html#codes', { state: SETUP, viewport: { width: 1200, height: 800 }, replies: {
    codes: '() => [{ host: "github.com", issuer: "GitHub", code: "654321", left: 20, period: 30, verified: true }]',
    addTotp: 'm => (m.key.includes("not") ? { ok: false, reason: "key" } : { ok: true, host: "example.com" })',
  } });
  await page.getByText('654 321').waitFor();
  await page.getByLabel('Site').fill('example.com');
  await page.getByLabel('Setup key').fill('not a key');
  await page.getByRole('button', { name: 'Save 2FA key' }).click();
  await page.getByText(/does not look like a setup key/).waitFor();
  await page.close();
});

test('the approval window names the site and starts on "Don\'t allow"', async () => {
  const page = await open('approve.html#abc', { state: SETUP, viewport: { width: 440, height: 560 }, replies: {
    'approval:get': '() => ({ host: "login.bank.test", base: "bank.test" })',
    'approval:answer': '() => ({ ok: true })',
  } });
  await page.getByText('Sign in to this site with your password?').waitFor();
  assert.equal(await page.locator('.site b').textContent(), 'bank.test');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Don\'t allow');
  assert.equal(await page.getByRole('button', { name: 'Allow', exact: true }).isDisabled(), true, 'Allow is briefly disabled');
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Allow', exact: true }).click();
  const answer = (await page.evaluate(() => window.sent)).find(m => m.type === 'approval:answer');
  assert.deepEqual(answer, { type: 'approval:answer', id: 'abc', answer: 'allow' });
  await page.close();
});
