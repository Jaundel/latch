// The on-page bar, end to end in Chrome with the real extension: what a browser AI
// sees, what it can press, the first-use approval window, 2FA codes and setup (text
// key and QR code), the forgot-password flow, and pages that try to misuse the bar.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { launchWithExtension } from './launch.mjs';
import { totp } from '../extension/totp.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const MAIN = { email: 'grace.c4n4ry@example.test', password: 'Main-B4r-Canary!9' };
const SETUP_KEY = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const QR_KEY = 'KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU';
const LOGIN_KEY = 'MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U';

let work, context, popup, id;
const posts = [];
const state = { passwords: {}, signedIn: new Set(), twofaOn: new Set(), resetToken: null, resetRequests: 0 };

const page = (title, body, head = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body><main>${body}</main></body></html>`;
const loginForm = (site, error = '') => page(`Sign in to ${site}`, `<h1>Sign in to ${site}</h1>${error ? `<div role="alert" class="error">${error}</div>` : ''}
  <form method="post" action="/login"><label>Email <input type="email" name="email" autocomplete="username"></label>
  <label>Password <input type="password" name="password" autocomplete="current-password"></label><button type="submit">Sign in</button></form>`);
const home = site => page(`${site} home`, `<h1>Welcome back</h1><p>You are signed in to ${site}.</p><button type="button">Sign out</button>`);

async function site(host, path, method, body) {
  const pw = state.passwords[host] ?? MAIN.password;
  if (host === 'hostile.test' && path === '/login' && method === 'GET') {
    return { html: loginForm(host).replace('</head>', `<style>button { background: rgb(255, 0, 0) !important; color: rgb(255, 255, 0) !important; display: inline !important; font-size: 40px !important; }
      #cover { position: fixed; inset: 0; margin: 0; border: 0; padding: 0; width: 100vw; height: 100vh; background: rgba(255,255,255,.01); pointer-events: none; }</style></head>`)
      .replace('</main>', '</main><div id="cover" popover="manual"></div>') };
  }
  if (path === '/login' && method === 'GET') return { html: loginForm(host) };
  if (path === '/login') {
    if (body.email !== MAIN.email || body.password !== pw) return { status: 401, html: loginForm(host, 'Incorrect email or password.') };
    if (host === 'secure.test') return { redirect: '/2fa' };
    state.signedIn.add(host);
    return { redirect: '/home' };
  }
  if (path === '/home') return { html: home(host) };
  if (path === '/about') return { html: page('About', '<h1>About us</h1><p>No forms here.</p>') };
  if (host === 'secure.test' && path === '/2fa') {
    const form = (err = '') => page('Two-step verification', `<h1>Two-step verification</h1>${err ? `<div role="alert">${err}</div>` : ''}
      <p>Enter the 6-digit code from your authenticator app.</p><form method="post" action="/2fa"><label>Code <input name="otp" inputmode="numeric" autocomplete="one-time-code"></label><button type="submit">Verify</button></form>`);
    if (method === 'GET') return { html: form() };
    if (body.otp !== await totp({ secret: LOGIN_KEY })) return { status: 400, html: form('That code is not right.') };
    state.signedIn.add(host);
    return { redirect: '/home' };
  }
  if ((host === 'setup.test' || host === 'qr.test') && path === '/security/2fa') {
    const key = host === 'qr.test' ? QR_KEY : SETUP_KEY;
    if (method === 'POST') {
      if (body.code !== await totp({ secret: key })) return { status: 400, html: page('Error', '<div role="alert">Invalid code</div>') };
      state.twofaOn.add(host);
      return { html: page('2FA on', '<h1>Two-factor authentication is on</h1><p>Save your backup codes.</p>') };
    }
    const qr = await QRCode.toDataURL(`otpauth://totp/${host}:grace?secret=${key}&issuer=${host}`, { margin: 2, width: 220 });
    const manual = host === 'qr.test' ? '' : `<p>Can't scan it? Enter this setup key instead: <code>${key.toLowerCase().match(/.{4}/g).join(' ')}</code></p>`;
    return { html: page('Set up two-factor authentication', `<h1>Set up two-factor authentication</h1>
      <p>Scan this QR code with your authenticator app.</p><img src="${qr}" width="220" height="220" alt="QR code for your authenticator app">${manual}
      <form method="post"><label>Enter the 6-digit code from the app <input name="code" autocomplete="one-time-code" inputmode="numeric"></label><button type="submit">Verify and turn on</button></form>`) };
  }
  if (host === 'reset.test' && path === '/forgot') {
    if (method === 'POST') {
      state.resetRequests++;
      state.resetFor = body.email;
      state.resetToken = 'tok-' + Math.random().toString(36).slice(2);
      return { html: page('Check your email', '<h1>Check your email</h1><p>If an account exists for that email, we sent a password reset link.</p>') };
    }
    return { html: page('Forgot password', `<h1>Forgot your password?</h1><p>Enter your email and we will send you a link to reset your password.</p>
      <form method="post" action="/forgot"><label>Email <input type="email" name="email"></label><button type="submit">Send reset link</button></form>`) };
  }
  if (host === 'reset.test' && path === '/reset') {
    if (method === 'POST') {
      if (!body.password || body.password !== body.confirm) return { status: 400, html: page('Error', '<div role="alert">Passwords do not match</div>') };
      state.passwords[host] = body.password;
      return { html: page('Password changed', '<h1>Your password has been reset</h1><p>Sign in with your new password.</p><a href="/login">Sign in</a>') };
    }
    return { html: page('Choose a new password', `<h1>Reset your password</h1><form method="post" action="/reset">
      <label>New password <input type="password" name="password" autocomplete="new-password"></label>
      <label>Confirm new password <input type="password" name="confirm" autocomplete="new-password"></label><button type="submit">Reset password</button></form>`) };
  }
  if (host === 'hostile.test' && path === '/login' && method === 'GET') {
    return { html: loginForm(host).replace('</head>', `<style>button { background: rgb(255, 0, 0) !important; color: rgb(255, 255, 0) !important; display: inline !important; font-size: 40px !important; }
      #cover { position: fixed; inset: 0; margin: 0; border: 0; padding: 0; width: 100vw; height: 100vh; background: rgba(255,255,255,.01); pointer-events: none; }</style></head>`)
      .replace('</main>', '</main><div id="cover" popover="manual"></div>') };
  }
  return { status: 404, html: page('Not found', '<h1>Not found</h1>') };
}

before(async () => {
  work = mkdtempSync(join(tmpdir(), 'latch-bar-'));
  const ext = join(work, 'extension');
  // LATCH_TEST_EXTENSION runs these against another build, such as the unpacked store package.
  cpSync(process.env.LATCH_TEST_EXTENSION || join(root, 'extension'), ext, { recursive: true });
  let sw;
  ({ context, id, sw } = await launchWithExtension(join(work, 'profile'), ext, { viewport: { width: 1200, height: 860 } }));
  if (process.env.LATCH_DEBUG) {
    sw.on('console', m => console.error('SW', m.type(), m.text()));
    context.on('weberror', e => console.error('WEBERROR', e.error().message));
    context.on('page', pg => pg.on('console', m => { if (/latch|error/i.test(m.text())) console.error('PAGE', pg.url(), m.text()); }));
  }
  // The published practice site, served from docs/demo exactly as it is on the web.
  await context.route(/^https:\/\/practice\.test\//, route => {
    const name = new URL(route.request().url()).pathname.split('/').pop() || 'index.html';
    const type = { html: 'text/html', js: 'text/javascript', css: 'text/css', png: 'image/png' }[name.split('.').pop()];
    return route.fulfill({ contentType: type, body: readFileSync(join(root, 'docs', 'demo', name)) });
  });
  await context.route(/^https:\/\/[a-z]+\.test\//, async route => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.hostname === 'practice.test') return route.fallback();
    const body = req.method() === 'POST' ? Object.fromEntries(new URLSearchParams(req.postData() || '')) : {};
    if (req.method() === 'POST') posts.push({ host: u.hostname, path: u.pathname, body });
    const r = await site(u.hostname, u.pathname, req.method(), body);
    // A fulfilled 302 is followed outside the route, so redirects are a refresh instead.
    if (r.redirect) return route.fulfill({ status: 200, contentType: 'text/html', body: `<meta http-equiv="refresh" content="0;url=${new URL(r.redirect, u).href}">` });
    return route.fulfill({ status: r.status || 200, contentType: 'text/html; charset=utf-8', body: r.html });
  });
  popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
});

after(async () => {
  await context?.close().catch(() => {});
  rmSync(work, { recursive: true, force: true });
});

const send = msg => popup.evaluate(m => chrome.runtime.sendMessage(m), msg);
const bar = p => p.locator('latch-bar');
const statusOf = p => p.locator('latch-bar [slot=status]');
async function open(url) {
  const p = await context.newPage();
  await p.goto(url);
  await p.bringToFront();
  return p;
}
async function waitForStatus(p, re, timeout = 45000) {
  try {
    await p.waitForFunction(source => new RegExp(source, 'i').test(document.querySelector('latch-bar [slot=status]')?.textContent || ''), re.source, { timeout });
  } catch (err) {
    const said = await p.locator('latch-bar').innerText().catch(() => '(no bar)');
    const recent = (await send({ type: 'state' })).activity.slice(0, 3).map(a => `${a.tool}:${a.status}:${a.reason}`).join(', ');
    throw new Error(`bar never matched ${re}; recent: ${recent}; it says: ${said.replace(/\s+/g, ' ')}`);
  }
  return statusOf(p).textContent();
}
// Like an AI that reads the page before acting: the button has been on screen a moment.
async function press(p, name) {
  const button = p.getByRole('button', { name, exact: true });
  await button.waitFor({ timeout: 15000 }).catch(async err => {
    const said = await p.locator('latch-bar').innerText().catch(() => '(no bar)');
    throw new Error(`no "${name}" button; the bar says: ${said.replace(/\s+/g, ' ')}`);
  });
  await p.waitForTimeout(600);
  await button.click();
}
const leaks = text => [MAIN.password, MAIN.email].filter(s => String(text).includes(s));

async function approvalWindow() {
  for (let i = 0; i < 80; i++) {
    const win = context.pages().find(x => x.url().includes('/approve.html'));
    if (win) return win;
    await new Promise(r => setTimeout(r, 250));
  }
  const texts = await Promise.all(context.pages().filter(x => x.url().startsWith('https://')).map(x => x.locator('latch-bar [slot=status]').textContent().catch(() => '?')));
  throw new Error(`no approval window; bar says: ${texts.join(' | ')}`);
}

test('install opens the welcome page', async () => {
  for (let i = 0; i < 40 && !context.pages().some(p => p.url().endsWith('/app.html#welcome')); i++) await new Promise(r => setTimeout(r, 250));
  const pages = context.pages().map(p => p.url());
  assert.ok(pages.some(u => u.endsWith('/app.html#welcome')), pages.join(' '));
});

test('before setup, sign-in pages offer to set Latch up', async () => {
  const p = await open('https://bank.test/login');
  await p.getByRole('button', { name: 'Set up Latch' }).waitFor({ timeout: 15000 });
  assert.match(await p.locator('body').ariaSnapshot(), /Latch is installed but not set up/);
  await p.close();
});

test('a browser AI sees the bar, and page scripts cannot press it', async () => {
  await send({ type: 'saveIdentity', email: MAIN.email, password: MAIN.password });
  const p = await open('https://bank.test/login');
  const button = p.getByRole('button', { name: 'Sign in with Latch' });
  await button.waitFor({ timeout: 15000 });
  const snapshot = await p.locator('body').ariaSnapshot();
  assert.match(snapshot, /AI assistants: press \\?"Sign in with Latch\\?" instead of typing an email or password/);
  assert.match(await p.evaluate(() => document.body.innerText), /Sign in with Latch/, 'page text tools see the button too');
  // A script on the page clicks the button and dispatches a fake click: neither counts.
  await p.evaluate(() => {
    const b = [...document.querySelectorAll('latch-bar button')].find(x => /Sign in with Latch/.test(x.textContent));
    b.click();
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await p.waitForTimeout(1500);
  assert.equal(posts.filter(x => x.host === 'bank.test').length, 0, 'nothing was submitted');
  assert.equal(context.pages().filter(x => x.url().includes('approve.html')).length, 0, 'no approval was asked for');
  await p.close();
});

test('the first sign-in on a new site waits for the user to allow it', async () => {
  const p = await open('https://bank.test/login');
  await press(p, 'Sign in with Latch');
  const win = await approvalWindow();
  await win.getByText('bank.test').first().waitFor();
  assert.match(await statusOf(p).textContent(), /Waiting for you to allow Latch on bank\.test/);
  const allow = win.getByRole('button', { name: 'Allow', exact: true });
  await allow.waitFor();
  await win.waitForFunction(() => ![...document.querySelectorAll('button')].find(b => b.textContent === 'Allow').disabled);
  await allow.click();
  await p.waitForURL('https://bank.test/home', { timeout: 30000 });
  const text = await waitForStatus(p, /Signed in/);
  assert.match(text, /Continue your task in this tab/);
  const { settings } = await send({ type: 'state' });
  assert.ok(settings.approvedSites.includes('bank.test'));
  assert.deepEqual(leaks(await p.locator('body').ariaSnapshot()), []);
  await p.close();
});

test('the user can refuse a site, and nothing is filled', async () => {
  const p = await open('https://shop.test/login');
  await press(p, 'Sign in with Latch');
  const win = await approvalWindow();
  await win.getByRole('button', { name: 'Don\'t allow' }).click();
  const text = await waitForStatus(p, /chose not to/);
  assert.match(text, /shop\.test/);
  assert.equal(posts.filter(x => x.host === 'shop.test').length, 0);
  assert.equal(await p.locator('input[type=password]').inputValue(), '');
  await p.close();
});

test('page styles cannot restyle the bar, and a covered bar ignores presses', async () => {
  await send({ type: 'settings', patch: { approvedSites: ['bank.test', 'hostile.test'] } });
  const p = await open('https://hostile.test/login');
  const button = p.getByRole('button', { name: 'Sign in with Latch' });
  await button.waitFor({ timeout: 15000 });
  const look = await button.evaluate(el => { const s = getComputedStyle(el); return { bg: s.backgroundColor, size: s.fontSize, display: s.display }; });
  assert.notEqual(look.bg, 'rgb(255, 0, 0)');
  assert.notEqual(look.size, '40px');
  assert.equal(look.display, 'flex', 'laid out by the bar, not the page');
  // Only another top-layer element can sit over the bar; this one keeps putting itself back on top.
  await p.evaluate(() => {
    const cover = document.getElementById('cover');
    window.coverLoop = setInterval(() => { try { cover.hidePopover(); } catch {} cover.showPopover(); }, 40);
  });
  await p.waitForTimeout(600);
  await button.click({ force: true });
  const text = await waitForStatus(p, /covering|only just appeared/, 5000);
  assert.ok(text);
  assert.equal(posts.filter(x => x.host === 'hostile.test').length, 0);
  // Tampering with the bar's own text resets it, and an immediate press is ignored.
  await p.evaluate(() => { clearInterval(window.coverLoop); document.getElementById('cover').hidePopover(); });
  await p.evaluate(() => { const b = [...document.querySelectorAll('latch-bar button')].find(x => /Latch/.test(x.textContent)); b.textContent = 'Accept cookies'; });
  await p.getByRole('button', { name: 'Sign in with Latch' }).waitFor({ timeout: 5000 });
  assert.equal(await p.getByRole('button', { name: 'Accept cookies' }).count(), 0);
  await p.close();
});

test('sign-in passes authenticator 2FA with a saved key', async () => {
  const added = await send({ type: 'addTotp', host: 'secure.test', key: LOGIN_KEY.toLowerCase().match(/.{4}/g).join(' ') });
  assert.equal(added.ok, true);
  const p = await open('https://secure.test/login');
  await press(p, 'Sign in with Latch');
  await p.waitForURL('https://secure.test/home', { timeout: 45000 });
  assert.ok(state.signedIn.has('secure.test'));
  await waitForStatus(p, /Signed in/);
  await p.close();
});

test('the AI can turn on 2FA: Latch saves the key from the page and confirms it', async () => {
  const p = await open('https://setup.test/security/2fa');
  await press(p, 'Set up 2FA with Latch');
  await waitForStatus(p, /Saved the 2FA key and confirmed it/);
  assert.ok(state.twofaOn.has('setup.test'));
  const codes = await send({ type: 'codes' });
  assert.ok(codes.some(c => c.host === 'setup.test' && c.verified));
  assert.ok(!(await p.locator('body').ariaSnapshot()).includes(SETUP_KEY), 'the key never appears in the bar');
  await p.close();
});

test('a key shown only as a QR code is read from the screen', async () => {
  const p = await open('https://qr.test/security/2fa');
  await press(p, 'Set up 2FA with Latch');
  await waitForStatus(p, /Saved the 2FA key and confirmed it/);
  assert.ok(state.twofaOn.has('qr.test'));
  await p.close();
});

test('forgot password: send the reset email, then set and save a new password', async () => {
  const p = await open('https://reset.test/forgot');
  await press(p, 'Send reset email with Latch');
  await waitForStatus(p, /Reset email requested/);
  assert.equal(state.resetRequests, 1);
  assert.equal(state.resetFor, MAIN.email);
  // The AI opens the link from the user's inbox.
  await p.goto(`https://reset.test/reset?token=${state.resetToken}`);
  await press(p, 'Set new password with Latch');
  await waitForStatus(p, /Set a new password and saved it/);
  const chosen = state.passwords['reset.test'];
  assert.ok(chosen && chosen !== MAIN.password && chosen.length >= 16, 'a fresh strong password went in');
  assert.equal((await send({ type: 'reveal', host: 'reset.test' })).password, chosen, 'and Latch saved it');
  assert.deepEqual(leaks(await p.locator('body').ariaSnapshot()).concat(String(await p.locator('body').ariaSnapshot()).includes(chosen) ? ['new password'] : []), []);
  // The next sign-in uses the new password without asking.
  await p.goto('https://reset.test/login');
  await press(p, 'Sign in with Latch');
  await p.waitForURL('https://reset.test/home', { timeout: 30000 });
  await p.close();
});

test('the published practice site works end to end', async () => {
  const p = await open('https://practice.test/demo/index.html');
  await press(p, 'Sign in with Latch');
  const win = await approvalWindow();
  await win.waitForFunction(() => ![...document.querySelectorAll('button')].find(b => b.textContent === 'Allow').disabled);
  await win.getByRole('button', { name: 'Allow', exact: true }).click();
  await waitForStatus(p, /Signed in/);
  assert.equal(await p.locator('#done').isVisible(), true);
  await p.goto('https://practice.test/demo/2fa.html');
  await press(p, 'Set up 2FA with Latch');
  await waitForStatus(p, /Saved the 2FA key and confirmed it/);
  await p.goto('https://practice.test/demo/forgot.html');
  await press(p, 'Send reset email with Latch');
  await waitForStatus(p, /Reset email requested/);
  await p.goto('https://practice.test/demo/reset.html');
  await press(p, 'Set new password with Latch');
  await waitForStatus(p, /Set a new password and saved it/);
  await p.close();
});

test('pages without sign-in fields get no bar', async () => {
  const p = await open('https://bank.test/about');
  await p.waitForTimeout(1500);
  assert.equal(await bar(p).count(), 0);
  await p.close();
});

test('pausing Latch removes the bar', async () => {
  await send({ type: 'settings', patch: { paused: true } });
  const p = await open('https://bank.test/login');
  await p.waitForTimeout(2000);
  assert.equal(await p.getByRole('button', { name: 'Sign in with Latch' }).count(), 0);
  await send({ type: 'settings', patch: { paused: false } });
  await p.close();
});

test('the activity list records presses without secrets', async () => {
  const { activity } = await send({ type: 'state' });
  assert.ok(activity.some(a => a.client === 'page' && a.status === 'signed_in'));
  const stored = await popup.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
  assert.deepEqual(leaks(stored), [], 'the vault is encrypted at rest');
  assert.ok(!stored.includes(SETUP_KEY) && !stored.includes(QR_KEY));
});
