import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const SHELL = '<div id="conn"><span class="conn-text"></span></div><main id="view"></main><p id="announce" role="status" aria-live="polite"></p>';

test('account emblems stay loaded across popup renders without a load loop', async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage();
  try {
    await page.route('https://popup.test/**', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="8" fill="blue"/></svg>' }));
    await page.setContent(SHELL);
    await page.evaluate(() => {
      const state = { setup: true, email: 'fixture@example.test', connected: true, clients: [], mailbox: null,
        settings: { paused: false, newPasswords: 'unique' }, activity: [],
        sites: ['example.com', 'two.com', 'three.com', 'four.com', 'five.com'].map(host => ({ host, status: 'active', lastUsed: Date.now() })) };
      window.chrome = { runtime: { getURL: path => 'https://popup.test' + path,
        sendMessage: async ({ type }) => type === 'state' ? structuredClone(state) : type === 'pageState' ? { kind: 'none', host: 'example.com' } : {},
        onMessage: { addListener() {} } } };
      window.iconChanges = 0;
      new MutationObserver(changes => {
        window.iconChanges += changes.filter(change => change.target.matches?.('.fav')).length;
      }).observe(document.getElementById('view'), { subtree: true, childList: true });
    });
    await page.addScriptTag({ type: 'module', content: readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8') });
    await page.waitForFunction(() => document.querySelectorAll('.fav img').length === 5);
    const before = await page.evaluate(() => { window.originalIcon = document.querySelector('.list .fav'); return iconChanges; });
    await page.waitForTimeout(250);
    const changes = await page.evaluate(before => iconChanges - before, before);
    assert.equal(changes, 0, 'loaded images must not keep replacing themselves');
    await page.getByRole('button', { name: 'Show all 5', exact: true }).click();
    assert.equal(await page.evaluate(() => document.querySelector('.list .fav') === window.originalIcon), true,
      'rerendering must retain the loaded account emblem instead of flashing a fallback letter');
    assert.equal(await page.locator('.page .fav img').count(), 1, 'a page and account with the same host each keep their own emblem');
    await page.waitForFunction(() => document.querySelectorAll('.list .fav img').length === 5, null, { timeout: 5000 });
    assert.equal(await page.getByRole('heading', { name: 'Password resets' }).count(), 0, 'no resets section without resets');
  } finally { await browser.close(); }
});

test('reset page fill and the password resets list send popup-only messages', async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage();
  try {
    await page.setContent(SHELL);
    await page.evaluate(() => {
      const state = { setup: true, email: 'fixture@example.test', connected: true, clients: [], mailbox: { user: 'fixture@example.test', host: 'imap.example.test' },
        settings: { paused: false, newPasswords: 'mine' }, activity: [], sites: [],
        resets: [{ host: 'jobs.test', requestedAt: Date.now() - 5 * 60e3, openedAt: null, resetAt: null, pendingMain: false }] };
      window.sent = [];
      const replies = {
        state: () => structuredClone(state),
        pageState: () => ({ kind: 'reset', host: 'portal.test', saved: false, pendingReset: false }),
        fillReset: () => {
          state.resets.unshift({ host: 'portal.test', requestedAt: null, openedAt: null, resetAt: Date.now(), pendingMain: true });
          return { ok: true, message: "Filled your main password. Press the page's button to save it." };
        },
        openResetLink: () => ({ ok: false, reason: 'not_found' }),
        dismissReset: ({ host }) => { state.resets = state.resets.filter(r => r.host !== host); return { ok: true }; },
      };
      window.chrome = { runtime: { getURL: path => 'https://popup.test' + path,
        sendMessage: async msg => {
          if (!['state', 'pageState', 'connect'].includes(msg.type)) sent.push(msg);
          return replies[msg.type]?.(msg) ?? {};
        },
        onMessage: { addListener() {} } } };
    });
    await page.addScriptTag({ type: 'module', content: readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8') });
    await page.getByText('Password reset page for portal.test', { exact: true }).waitFor();

    const rows = page.locator('ul[aria-label="Password resets"] > li');
    assert.equal(await rows.count(), 1);
    assert.match(await rows.first().innerText(), /jobs\.test[\s\S]*Requested 5m ago/);
    assert.doesNotMatch(await rows.first().innerText(), /Saved\?/);

    await page.getByRole('button', { name: 'Use my main password', exact: true }).click();
    await page.locator('.page .notice').filter({ hasText: "Press the page's button to save it." }).waitFor();
    assert.deepEqual(await page.evaluate(() => sent), [{ type: 'fillReset' }]);
    assert.equal(await page.locator('#announce').innerText(), "Filled your main password. Press the page's button to save it.");
    assert.equal(await page.locator('.page .notice').getAttribute('aria-live'), null, 'only the persistent region speaks');

    assert.equal(await rows.count(), 2);
    const portal = rows.filter({ hasText: 'portal.test' });
    assert.match(await portal.innerText(), /Saved\? Latch will use your main password next sign-in/);
    assert.match(await portal.innerText(), /Filled just now/);

    await page.getByRole('button', { name: 'Open reset email for jobs.test', exact: true }).click();
    await page.getByText('Latch did not find an unused reset email with a link to jobs.test. If it has arrived, open it from your webmail.').first().waitFor();
    assert.deepEqual(await page.evaluate(() => sent.at(-1)), { type: 'openResetLink', host: 'jobs.test' });

    await page.getByRole('button', { name: 'Dismiss reset for jobs.test', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('ul[aria-label="Password resets"] > li').length === 1);
    assert.deepEqual(await page.evaluate(() => sent.at(-1)), { type: 'dismissReset', host: 'jobs.test' });

    await page.getByRole('button', { name: 'Dismiss reset for portal.test', exact: true }).click();
    await page.getByRole('heading', { name: 'Password resets' }).waitFor({ state: 'detached' });

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByText('Same as mine is recommended. New accounts use your main password, and sign-in tries it when a saved site password stops working.', { exact: true }).waitFor();
  } finally { await browser.close(); }
});

test('reset rows keep their own pending state and results reach one persistent live region', async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage();
  try {
    await page.setContent(SHELL);
    await page.evaluate(() => {
      const state = { setup: true, email: 'fixture@example.test', connected: true, clients: [], mailbox: { user: 'fixture@example.test', host: 'imap.example.test' },
        settings: { paused: false, newPasswords: 'mine' }, activity: [], sites: [],
        resets: ['a.test', 'b.test'].map(host => ({ host, requestedAt: Date.now() - 60e3, openedAt: null, resetAt: null, pendingMain: false })) };
      window.opens = [];
      window.release = {};
      window.live = document.getElementById('announce');
      const replies = {
        state: () => structuredClone(state),
        pageState: () => ({ kind: 'none', host: '' }),
        openResetLink: ({ host }) => { opens.push(host); return new Promise(resolve => { release[host] = resolve; }); },
        dismissReset: ({ host }) => { state.resets = state.resets.filter(r => r.host !== host); return { ok: true }; },
      };
      window.chrome = { runtime: { getURL: path => 'https://popup.test' + path, sendMessage: async msg => replies[msg.type]?.(msg) ?? {}, onMessage: { addListener() {} } } };
    });
    await page.addScriptTag({ type: 'module', content: readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8') });
    const open = host => page.getByRole('button', { name: `Open reset email for ${host}`, exact: true });
    const announced = () => page.locator('#announce').innerText();
    await open('a.test').click();
    assert.equal(await announced(), 'Looking for the reset email from a.test…');
    await open('b.test').click();
    assert.equal(await open('a.test').isDisabled(), true, 'one row working does not free another');
    await page.evaluate(() => release['b.test']({ ok: false, reason: 'link_rejected' }));
    await page.getByText("The reset email's link does not go to b.test", { exact: false }).first().waitFor();
    assert.equal(await open('a.test').isDisabled(), true, 'a.test is still waiting');
    assert.equal(await open('a.test').innerText(), 'Working…');
    assert.equal(await open('b.test').isDisabled(), false);
    await page.evaluate(() => release['a.test']({ ok: true, tabId: 8 }));
    await page.waitForFunction(() => document.getElementById('announce').textContent.startsWith('Opened the reset link for a.test'));
    assert.equal(await open('a.test').isDisabled(), false);
    assert.deepEqual(await page.evaluate(() => opens), ['a.test', 'b.test']);
    assert.equal(await page.evaluate(() => live === document.getElementById('announce')), true, 'the live region survives renders');
    assert.equal(await page.locator('#view [aria-live]').count(), 0, 'notices are not live regions of their own');

    const cases = [
      [{ ok: false, reason: 'mail_error', error: 'offline' }, 'Latch reads your inbox while your AI is connected. Connect it, or open the reset email from your webmail.'],
      [{ ok: false, reason: 'mail_error', error: 'auth' }, 'Your inbox app password was not accepted. Update it in Settings.'],
      [{ ok: false, reason: 'mail_error', error: 'connect' }, 'Could not reach your inbox. Try again shortly.'],
      [{ ok: false, reason: 'mail_error', error: 'timeout' }, 'Could not reach your inbox. Try again shortly.'],
      [{ ok: false, reason: 'not_found' }, 'Latch did not find an unused reset email with a link to a.test. If it has arrived, open it from your webmail.'],
    ];
    for (const [reply, text] of cases) {
      await open('a.test').click();
      await page.evaluate(reply => release['a.test'](reply), reply);
      await page.waitForFunction(text => document.getElementById('announce').textContent === text, text);
      await page.locator('#view .notice').filter({ hasText: text }).waitFor();
    }
  } finally { await browser.close(); }
});
