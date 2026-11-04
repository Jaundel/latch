import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

test('account emblems stay loaded across popup renders without a load loop', async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage();
  try {
    await page.route('https://popup.test/**', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="8" fill="blue"/></svg>' }));
    await page.setContent('<div id="conn"><span class="conn-text"></span></div><main id="view"></main>');
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
    assert.equal(await page.locator('.list .fav img').count(), 5);
  } finally { await browser.close(); }
});
