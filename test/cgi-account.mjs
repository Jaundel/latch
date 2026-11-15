import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let browser;
before(async () => { browser = await chromium.launch({ channel: 'chrome' }); });
after(async () => { await browser?.close(); });

const clientUrl = 'https://clients.njoyn.com/xweb/xweb.asp?clid=21001&page=jobdetails&jobid=J1026-0000';
const candidateUrl = clientUrl.replace('clients.njoyn.com', 'cgi.njoyn.com');
const logoutHref = 'xweb.asp?NTKN=c&clid=21001&page=logoff';
const publicNav = '<nav><a href="?page=profile">My Profile</a><a href="?page=search">Job search</a></nav>';

async function inspect(html, url = candidateUrl) {
  const page = await browser.newPage();
  try {
    // All requests are fulfilled locally; no portal, credential or live Chrome access.
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
    await page.goto(url);
    await page.addScriptTag({ path: fileURLToPath(new URL('../extension/page.js', import.meta.url)) });
    return await page.evaluate(() => __latch.inspect());
  } finally { await page.close(); }
}

test('visible CGI Log off is explicit session evidence after redirect', async () => {
  for (const label of ['Log off', 'Logoff', 'Log\u00a0off']) {
    const snap = await inspect(`${publicNav}<a href="${logoutHref}">${label}</a><h1>Job details</h1>`);
    assert.equal(snap.host, 'cgi.njoyn.com');
    assert.equal(snap.flags.signedIn, true, label);
    assert.equal(snap.fields.length, 0);
  }
});

test('public navigation and a logout URL without an auth label do not prove a session', async () => {
  const snap = await inspect(`${publicNav}<a href="${logoutHref}">Help</a><h1>Job details</h1>`);
  assert.equal(snap.flags.signedIn, false);
});

test('hidden logout controls and descriptive text do not prove a session', async () => {
  const snap = await inspect(`${publicNav}<a hidden href="${logoutHref}">Log off</a>
    <p>Log off</p><a href="?page=help">How to Log off</a>`);
  assert.equal(snap.flags.signedIn, false);
});

test('existing exact Sign out and Log out controls retain their meaning', async () => {
  for (const label of ['Sign out', 'Signout', 'Log out', 'Logout']) {
    const snap = await inspect(`<button>${label}</button>`);
    assert.equal(snap.flags.signedIn, true, label);
  }
});

const background = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const settlingCode = background.slice(background.indexOf('const signature ='), background.indexOf('// ---------- credentials'));
assert.ok(settlingCode.includes('async function settlePage('));

async function settleRedirect(initial, redirected) {
  let clock = 0;
  const makeSettler = new Function('now', 'sleep', 'stopped', 'activeJob', 'Stopped', 'chrome', 'snapshot', `${settlingCode}
    return { signature, settlePage };`);
  const { signature, settlePage } = makeSettler(() => clock, async ms => { clock += ms; },
    () => false, {}, Error, { tabs: { get: async () => ({ url: redirected.url }) } }, async () => [redirected]);
  const result = await settlePage(1, signature([initial]), 40000);
  return { result, elapsed: clock };
}

test('real private settling recognizes redirected Log off without the forty-second timeout', async () => {
  const initial = await inspect(`${publicNav}<h1>Job details</h1>`, clientUrl);
  const redirected = await inspect(`${publicNav}<a href="${logoutHref}">Log off</a><h1>Job details</h1>`);
  const { result, elapsed } = await settleRedirect(initial, redirected);
  assert.ok(elapsed < 2000, `explicit session evidence waited ${elapsed}ms`);
  assert.equal(result[0].flags.signedIn, true);
});

test('a public redirected details page stays unconfirmed through the full existing wait', async () => {
  const initial = await inspect(`${publicNav}<h1>Job details</h1>`, clientUrl);
  const redirected = await inspect(`${publicNav}<h1>Job details</h1>`);
  const { result, elapsed } = await settleRedirect(initial, redirected);
  assert.equal(result[0].flags.signedIn, false);
  assert.ok(elapsed >= 40000, `public navigation prematurely settled at ${elapsed}ms`);
});
