import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const background = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const keepFrames = /function keepFrames\([^\n]*\) \{[\s\S]*?\r?\n\}/.exec(background)[0];
// Exercise the real private snapshot/inFrame entry points, without running a
// service worker, vault, public application helper or connected browser.
const accessSource = background.slice(background.indexOf('async function snapshot('),
  background.indexOf('async function clearAll('));
const PAGE = fileURLToPath(new URL('../extension/page.js', import.meta.url));
let browser;
before(async () => { browser = await chromium.launch({ channel: 'chrome' }); });
after(async () => { await browser?.close(); });

function privateAccess(page, { cancelAfterMain = false } = {}) {
  let cancelled = false;
  const chrome = { scripting: { async executeScript({ target, world, files, func, args }) {
    assert.equal(target.tabId, 7);
    if (files) {
      assert.deepEqual(files, ['page.js']);
      await page.addScriptTag({ path: PAGE });
      return [];
    }
    const result = await page.evaluate(`(${func.toString()})(...${JSON.stringify(args || [])})`);
    if (world === 'MAIN' && cancelAfterMain) cancelled = true;
    return [{ frameId: 0, result }];
  } } };
  const beforeAction = () => { if (cancelled) throw new Error('fixture cancellation'); };
  return new Function('chrome', 'beforeAction', 'observation', 'now',
    `${keepFrames}\n${accessSource}\nreturn { snapshot, inFrame };`)(chrome, beforeAction, null, Date.now);
}

async function withBackground(kind, fn, host = 'acme.wd1.myworkdayjobs.com') {
  const context = await browser.newContext();
  const page = await context.newPage();
  const url = `https://${host}/auth`;
  const heading = kind === 'recovery' ? 'Forgot Password' : kind === 'signup' ? 'Create Account' : 'Sign In';
  const button = kind === 'recovery' ? 'Reset Password' : heading;
  const passwords = kind === 'recovery' ? '' : `<label>Password<input id="pw" type="password" autocomplete="${kind === 'signup' ? 'new-password' : 'current-password'}"></label>`;
  const html = `<h1>${heading}</h1><form action="/auth" method="post">
    <label>Email<input id="email" type="email" required></label>${passwords}<button type="submit">${button}</button></form>
    <script>
      window.requests = []; window.finished = 0; window.committed = {};
      // Deterministically model the observed unfocused-tab condition: native
      // focus/blur dispatch nothing, and the browser paints no animation frames.
      Object.defineProperty(document, 'hasFocus', { value: () => false });
      HTMLElement.prototype.focus = function() {};
      HTMLElement.prototype.blur = function() {};
      let nextFrame = 0; const parked = new Map();
      window.requestAnimationFrame = cb => { parked.set(++nextFrame, cb); return nextFrame; };
      window.cancelAnimationFrame = id => parked.delete(id);
      for (const input of document.querySelectorAll('input')) {
        input.addEventListener('focusin', () => input.dataset.focused = 'yes');
        input.addEventListener('blur', () => input.dataset.blurred = 'yes');
        input.addEventListener('focusout', () => {
          if (input.dataset.focused && input.dataset.blurred) committed[input.id] = input.value;
        });
      }
      document.querySelector('form').addEventListener('submit', e => {
        e.preventDefault();
        requests.push({ committed: Object.keys(committed).sort() });
        requestAnimationFrame(() => { finished++; });
      });
    </script>`;
  await context.route(`https://${host}/**`, route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(url);
  const foreground = await context.newPage();
  await foreground.bringToFront();
  try { await fn(page, privateAccess(page), url); }
  finally { await context.close(); }
}

async function submitPrivate(page, access, kind, url) {
  const [frame] = await access.snapshot(7);
  if (kind === 'recovery') {
    return access.inFrame(7, 0, 'requestRecovery', {
      email: 'fixture@example.test', expectedUrl: url, runId: 'fixture-recovery', deadline: Date.now() + 5000,
    });
  }
  const fields = frame.fields.filter(f => ['email', 'password'].includes(f.kind));
  const password = fields.find(f => f.kind === 'password');
  return access.inFrame(7, 0, 'fillAndSubmit', {
    fills: fields.map(f => ({ ref: f.ref, value: f.kind === 'email' ? 'fixture@example.test' : 'not-a-real-secret' })),
    submitRef: password.ref, purpose: kind === 'signup' ? 'signup' : 'login', validate: true,
  });
}

for (const kind of ['login', 'signup', 'recovery']) {
  test(`private ${kind} commits an unfocused form before its single request`, async () => {
    await withBackground(kind, async (page, access, url) => {
      const result = await submitPrivate(page, access, kind, url);
      assert.equal(result.ok, true);
      assert.deepEqual(await page.evaluate(() => requests), [
        { committed: kind === 'recovery' ? ['email'] : ['email', 'pw'] },
      ]);
    });
  });
  test(`private ${kind} completes a fresh Workday document without any public scan`, async () => {
    await withBackground(kind, async (page, access, url) => {
      await submitPrivate(page, access, kind, url);
      await new Promise(resolve => setTimeout(resolve, 250));
      assert.equal(await page.evaluate(() => finished), 1);
    });
  });
}

test('private setup wraps once per document and installs again after a redirect', async () => {
  await withBackground('login', async (page, access, url) => {
    await submitPrivate(page, access, 'login', url);
    assert.equal(await page.evaluate(() => !!window.__latchFrames), true);
    await page.evaluate(() => { window.originalWrappedRequest = requestAnimationFrame; });
    await submitPrivate(page, access, 'login', url);
    assert.equal(await page.evaluate(() => requestAnimationFrame === originalWrappedRequest), true);
    await page.goto(url + '/redirected');
    assert.equal(await page.evaluate(() => !!window.__latchFrames), false);
    await submitPrivate(page, access, 'login', url + '/redirected');
    assert.equal(await page.evaluate(() => !!window.__latchFrames), true);
  });
});

test('private frame setup does not patch animation scheduling on other hosts', async () => {
  await withBackground('login', async (page, access, url) => {
    await submitPrivate(page, access, 'login', url);
    assert.equal(await page.evaluate(() => !!window.__latchFrames), false);
  }, 'accounts.example.test');
});

test('cancellation during asynchronous setup prevents the private fill and submit', async () => {
  await withBackground('login', async (page, _, url) => {
    const access = privateAccess(page, { cancelAfterMain: true });
    await assert.rejects(submitPrivate(page, access, 'login', url), /fixture cancellation/);
    assert.deepEqual(await page.evaluate(() => ({ requests: requests.length, empty: [...document.querySelectorAll('input')].every(el => !el.value) })),
      { requests: 0, empty: true });
  });
});

test('an expired recovery deadline stops before any focus, value or request', async () => {
  await withBackground('recovery', async (page, access, url) => {
    await access.snapshot(7);
    const result = await access.inFrame(7, 0, 'requestRecovery', {
      email: 'fixture@example.test', expectedUrl: url, runId: 'expired-fixture', deadline: Date.now() - 1,
    });
    assert.equal(result.stopped, true);
    assert.equal(result.acted, false);
    assert.deepEqual(await page.evaluate(() => ({ requests: requests.length, focused: !!document.querySelector('input').dataset.focused,
      empty: !document.querySelector('input').value })), { requests: 0, focused: false, empty: true });
  });
});
