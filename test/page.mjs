import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

let browser;
before(async () => { browser = await chromium.launch({ channel: 'chromium' }); });
after(async () => { await browser?.close(); });

async function withPage(html, fn) {
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    await page.addScriptTag({ path: fileURLToPath(new URL('../extension/page.js', import.meta.url)) });
    await fn(page);
  } finally { await page.close(); }
}

test('authentication never fills or submits an application, even with a Sign In header', async () => {
  for (const purpose of ['login', 'signup']) {
    await withPage(`<title>Job Application</title><header><button>Sign In</button></header>
      <h1>Apply for this job</h1><form><label>Email<input type="email"></label>
      <button type="submit">Submit application</button></form>
      <script>window.clicks = 0; document.addEventListener('click', () => window.clicks++);
      document.querySelector('form').onsubmit = e => e.preventDefault();</script>`, async page => {
      const result = await page.evaluate(purpose => {
        const snap = __latch.inspect();
        const ref = snap.fields[0].ref;
        const result = __latch.fillAndSubmit({ fills: [{ ref, value: 'private@example.test' }], submitRef: ref, purpose });
        return { result, clicks, filled: !!document.querySelector('input').value };
      }, purpose);
      assert.equal(result.result.noForm, true);
      assert.equal(result.clicks, 0);
      assert.equal(result.filled, false);
    });
  }
});

test('email-first authentication is distinguished from newsletter and application fields', async () => {
  await withPage(`<h1>Sign In</h1><form><label>Email<input type="email"></label><button>Continue</button></form>`, async page => {
    const auth = await page.evaluate(() => __latch.inspect().auth);
    assert.equal(auth?.login, true);
    assert.equal(auth?.signup, false);
  });
  await withPage(`<h1>Create a Shop account</h1><form><label>Email<input type="email"></label><button>Continue</button></form>`, async page => {
    assert.equal((await page.evaluate(() => __latch.inspect().auth))?.signup, true);
  });
  await withPage(`<header><button>Sign In</button></header><form><label>Email<input type="email"></label><button>Subscribe</button></form>`, async page => {
    assert.equal((await page.evaluate(() => __latch.inspect().auth))?.login, false);
  });
});

test('Workday account menu is positive session evidence only while visible', async () => {
  await withPage(`<button id="accountSettingsButton">Candidate account</button><h1>Autofill with Resume</h1>`, async page => {
    assert.equal(await page.evaluate(() => __latch.inspect().flags.signedIn), true);
    await page.locator('#accountSettingsButton').evaluate(el => el.style.display = 'none');
    assert.equal(await page.evaluate(() => __latch.inspect().flags.signedIn), false);
  });
});

test('available authentication paths reflect visible choices without their URLs or values', async () => {
  await withPage(`<h1>Sign In</h1><form><input type="email"><input type="password"><button>Sign In</button></form>
    <button>Continue with Google</button><a href="/signup?token=private">Create Account</a>
    <button>Continue as guest</button><button hidden>Continue with LinkedIn</button>`, async page => {
    const paths = await page.evaluate(() => __latch.inspect().paths);
    assert.equal(paths?.email, true);
    assert.equal(paths?.password, true);
    assert.equal(paths?.google, true);
    assert.equal(paths?.linkedin, false);
    assert.equal(paths?.create_account, true);
    assert.equal(paths?.guest, true);
    assert.ok(Object.values(paths).every(value => typeof value === 'boolean'));
  });
});
