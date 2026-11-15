import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

let browser;
before(async () => { browser = await chromium.launch({ channel: 'chrome' }); });
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

const PAGE_JS = fileURLToPath(new URL('../extension/page.js', import.meta.url));

// Serves html at an https URL without a network or certificate.
async function withSite(html, fn, url = 'https://reset.test/account') {
  const page = await browser.newPage();
  try {
    await page.route('https://reset.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto(url);
    await page.addScriptTag({ path: PAGE_JS });
    await fn(page);
  } finally { await page.close(); }
}

const shadowLogin = mode => `<h1>Sign in</h1><template id="tpl"><form><label>Email<input type="email"></label>
  <label>Password<input type="password"></label><button type="submit">Sign in</button></form></template><x-login></x-login>
  <script>window.submits = 0; const closed = new Map();
  window.chrome = window.chrome || {}; window.chrome.dom = { openOrClosedShadowRoot: el => el.shadowRoot || closed.get(el) || null };
  customElements.define('x-login', class extends HTMLElement { connectedCallback() {
    const root = this.attachShadow({ mode: '${mode}' }); closed.set(this, root);
    root.append(document.getElementById('tpl').content.cloneNode(true));
    root.querySelector('form').addEventListener('submit', e => { e.preventDefault(); window.submits++; });
  } });</script>`;

test('a login form inside an open or closed shadow root is found and submitted', async () => {
  for (const mode of ['open', 'closed']) {
    await withPage(shadowLogin(mode), async page => {
      const out = await page.evaluate(() => {
        const snap = __latch.inspect();
        const email = snap.fields.find(f => f.kind === 'email'), pw = snap.fields.find(f => f.kind === 'password');
        const result = __latch.fillAndSubmit({ fills: [{ ref: email.ref, value: 'private@example.test' }, { ref: pw.ref, value: 'not-a-real-secret' }], submitRef: pw.ref, purpose: 'login' });
        return { kinds: snap.fields.map(f => f.kind), auth: snap.auth, paths: snap.paths.password, result, submits };
      });
      assert.deepEqual(out.kinds, ['email', 'password'], mode);
      assert.equal(out.auth.login, true, mode);
      assert.equal(out.paths, true, mode);
      assert.equal(out.result.ok, true, mode);
      assert.equal(out.result.clicked, true, mode);
      assert.equal(out.result.native, false, mode);
      assert.equal(out.submits, 1, mode);
    });
  }
});

test('inputs wrapped in their own shadow roots use the surrounding form button', async () => {
  await withPage(`<form><h1>Sign in</h1><x-input data-type="email"></x-input><x-input data-type="password"></x-input>
    <button type="submit">Sign in</button></form>
    <script>window.submits = 0; document.querySelector('form').addEventListener('submit', e => { e.preventDefault(); submits++; });
    customElements.define('x-input', class extends HTMLElement { connectedCallback() {
      const input = document.createElement('input'); input.type = this.dataset.type; input.setAttribute('aria-label', this.dataset.type);
      this.attachShadow({ mode: 'open' }).append(input);
    } });</script>`, async page => {
    const out = await page.evaluate(() => {
      const snap = __latch.inspect();
      const pw = snap.fields.find(f => f.kind === 'password');
      const result = __latch.fillAndSubmit({ fills: [{ ref: pw.ref, value: 'not-a-real-secret' }], submitRef: pw.ref, purpose: 'login' });
      return { login: snap.auth.login, clicked: result.clicked, submits };
    });
    assert.deepEqual(out, { login: true, clicked: true, submits: 1 });
  });
});

// An ASP.NET portal: one form around a search box, a Returning User sign-in
// whose password is marked new-password, and a New Applicant sign-up.
const cgiLogin = section => `<title>Careers</title><form id="aspnetForm" method="post" action="/Login.aspx">
  <div class="search"><input type="text" aria-label="Keywords"><input type="submit" id="btnSearch" value="Search"></div>
  ${section}
  <div class="new"><h3>New Applicant</h3>
    <div><input type="text" autocomplete="off" placeholder="Email address" id="Inp_New_email"></div>
    <div><select id="country"><option>Canada</option></select></div>
    <div><input type="submit" id="btnCreate" value="Create Profile"></div></div></form>
  <script>window.clicked = []; document.addEventListener('click', e => clicked.push(e.target.id));
  document.forms[0].addEventListener('submit', e => e.preventDefault());</script>`;
const RETURNING_DIV = `<div class="returning"><h3>Returning User</h3>
  <div><input type="text" autocomplete="off" placeholder="Email address" id="Inp_Login_email"></div>
  <div><input type="password" autocomplete="new-password" id="Inp_Login_password"></div>
  <div><input type="submit" id="btnLogin" value="Login"> <a href="#forgot">Forgot your password?</a></div></div>`;
const RETURNING_FIELDSET = `<fieldset><legend>Existing applicant</legend>
  <input type="text" autocomplete="off" placeholder="Email address" id="Inp_Login_email">
  <input type="password" autocomplete="new-password" id="Inp_Login_password">
  <button id="btnLogin">Sign In</button></fieldset>`;

test('a Returning User block sharing one form with New Applicant is a login form with its own button', async () => {
  for (const section of [RETURNING_DIV, RETURNING_FIELDSET]) {
    await withPage(cgiLogin(section), async page => {
      const out = await page.evaluate(() => {
        const snap = __latch.inspect();
        const email = snap.fields.find(f => f.kind === 'email');
        const pw = snap.fields.find(f => f.kind === 'password');
        const others = snap.fields.filter(f => f.kind === 'email' && f.ref !== email.ref);
        const result = __latch.fillAndSubmit({ fills: [email, ...others].map(f => ({ ref: f.ref, value: 'private@example.test' }))
          .concat({ ref: pw.ref, value: 'not-a-real-secret' }), submitRef: pw.ref, purpose: 'login' });
        return { auth: snap.auth, isNew: pw.isNew, confirm: pw.confirm, result, clicked,
          newApplicant: document.getElementById('Inp_New_email').value };
      });
      assert.deepEqual(out.auth, { login: true, signup: false });
      assert.equal(out.isNew, true);
      assert.equal(out.confirm, false);
      assert.equal(out.result.ok, true);
      assert.equal(out.result.clicked, true);
      assert.deepEqual(out.clicked, ['btnLogin']);
      assert.equal(out.newApplicant, '');
    });
  }
});

test('the Create Profile path stays offered on a Returning User page', async () => {
  await withPage(cgiLogin(RETURNING_DIV), async page => {
    const out = await page.evaluate(() => { const snap = __latch.inspect(); return { auth: snap.auth, create: snap.paths.create_account }; });
    assert.deepEqual(out.auth, { login: true, signup: false });
    assert.equal(out.create, true);
  });
});

// Records what fillAndSubmit clicks when the login wording sits outside the login form.
async function loginClick(html) {
  let out;
  await withPage(`${html}<script>window.clicked = []; addEventListener('click', e => { clicked.push(e.target.id || e.target.tagName); e.preventDefault(); }, true);</script>`, async page => {
    out = await page.evaluate(() => {
      const snap = __latch.inspect();
      const id = snap.fields.find(f => ['email', 'username'].includes(f.kind));
      const pw = snap.fields.find(f => f.kind === 'password');
      __latch.fillAndSubmit({ fills: [{ ref: id.ref, value: 'private@example.test' }, { ref: pw.ref, value: 'not-a-real-secret' }], submitRef: pw.ref, purpose: 'login' });
      return clicked;
    });
  });
  return out;
}

test('a sign-in click stays on the form\'s own button, not a header link or search box', async () => {
  const fields = '<input type="email" aria-label="Email"><input type="password" aria-label="Password">';
  assert.deepEqual(await loginClick(`<header><a href="/login">Sign In</a></header><h2>Applicant Login</h2>
    <form action="/in">${fields}<input id="go" type="button" value="Login"></form>`), ['go']);
  assert.deepEqual(await loginClick(`<nav><a href="/login">Sign in</a></nav><h1>Sign in</h1>
    <div><form>${fields}<button id="go" type="button">Continue</button></form></div>`), ['go']);
  assert.deepEqual(await loginClick(`<nav><a href="/login">Log in</a></nav><h1>Log in</h1>
    <div class="box">${fields}<div id="go" role="button">Continue</div></div>`), ['go']);
  assert.deepEqual(await loginClick(`<header><form action="/search"><input type="submit" id="search" value="Search"></form></header>
    <main><h1>Log in</h1><div class="box">${fields}<div id="go" role="button">Log in</div></div></main>`), ['go']);
});

test('on a flat page or one page-wide form a sign-in click takes the button after the password', async () => {
  const fields = '<input type="email" aria-label="Email"><input type="password" aria-label="Password">';
  assert.deepEqual(await loginClick(`<header><a id="head" href="/login">Sign In</a></header><h1>Sign in</h1>${fields}
    <div id="go" role="button">Continue</div>`), ['go']);
  assert.deepEqual(await loginClick(`<form action="/Login.aspx"><a id="head" href="/login">Sign In</a><h1>Sign in</h1>${fields}
    <div id="go" role="button">Continue</div></form>`), ['go']);
  assert.deepEqual(await loginClick(`<form action="/Login.aspx"><input type="submit" id="search" value="Search"><h1>Sign in</h1>${fields}
    <input type="submit" id="go" value="Login"></form>`), ['go']);
  assert.deepEqual(await loginClick(`<form action="/Login.aspx"><input type="submit" id="head" value="Sign In"><h2>Returning User</h2>${fields}
    <div id="go" role="button">Enter</div></form>`), ['go']);
  // Nothing follows the password here, so the button before it is the one.
  assert.deepEqual(await loginClick(`<h1>Log in</h1><form action="/in"><button id="go">Log in</button>${fields}</form>`), ['go']);
});

test('a button inside a shadow root counts as after the password by where its host sits', async () => {
  const fields = '<input type="email" aria-label="Email"><input type="password" aria-label="Password">';
  assert.deepEqual(await loginClick(`<x-button id="head" data-label="Sign In"></x-button><h1>Sign in</h1>${fields}
    <x-button id="go" data-label="Continue"></x-button>
    <script>customElements.define('x-button', class extends HTMLElement { connectedCallback() {
      this.attachShadow({ mode: 'open' }).innerHTML = '<button>' + this.dataset.label + '</button>';
    } });</script>`), ['go']);
});

test('a login section does not swallow a one-password sign-up form', async () => {
  const pages = [
    `<h1>Save your application</h1><p>Choose a password so you can sign in later.</p><form><label>Email<input type="email"></label>
      <label>Choose a password<input type="password"></label><button>Save and continue</button></form>`,
    `<h1>Get started</h1><form><label>Email<input type="email"></label><label>Create a password<input type="password"></label>
      <p>You will sign in with this later.</p><button>Get started</button></form>`,
    `<h1>Welcome</h1><form><label>Email<input type="email"></label><label>Password<input type="password" autocomplete="new-password"></label>
      <p>Already a member? Sign in below.</p><input type="submit" value="Create Account"></form>`,
  ];
  for (const html of pages) {
    await withPage(html, async page => {
      assert.deepEqual(await page.evaluate(() => __latch.inspect().auth), { login: false, signup: true });
    });
  }
});

test('a new-password field is a login only under returning-user wording, not bare sign-in text', async () => {
  const form = rest => `<form><label>Email<input type="email"></label>
    <label>Password<input type="password" autocomplete="new-password"></label>${rest}</form>`;
  for (const html of [
    `<h1>Welcome</h1><p>Sign in to see your applications.</p>${form('<button>Continue</button>')}`,
    `<h1>Log in to apply faster</h1>${form('<button>Continue</button>')}`,
    form('<p>You can log in with this later.</p><button>Continue</button>'),
  ]) {
    await withPage(html, async page => {
      const out = await page.evaluate(() => {
        const snap = __latch.inspect();
        const pw = snap.fields.find(f => f.kind === 'password');
        const result = __latch.fillAndSubmit({ fills: [{ ref: pw.ref, value: 'not-a-real-secret' }], submitRef: pw.ref, purpose: 'login' });
        return { auth: snap.auth, noForm: result.noForm, filled: !!document.querySelector('input[type=password]').value };
      });
      assert.deepEqual(out, { auth: { login: false, signup: true }, noForm: true, filled: false }, html);
    });
  }
  for (const html of [
    `<h1>Returning applicants</h1>${form('<button>Continue</button>')}`,
    `<h1>Existing users</h1>${form('<button>Continue</button>')}`,
    // The form's own button is not section text, and many sign-in forms carry the hint to fend off autofill.
    `<h1>Welcome</h1>${form('<button>Sign in</button>')}`,
  ]) {
    await withPage(html, async page => {
      assert.deepEqual(await page.evaluate(() => __latch.inspect().auth), { login: true, signup: false }, html);
    });
  }
});

test('a username held in a shadow root is filled with the password beside it', async () => {
  await withPage(`<h1>Sign in</h1><x-user></x-user><label>Password<input id="p" type="password"></label><div id="go" role="button">Sign in</div>
    <script>customElements.define('x-user', class extends HTMLElement { connectedCallback() {
      const input = document.createElement('input'); input.id = 'u'; input.name = 'username'; input.setAttribute('aria-label', 'Username');
      this.attachShadow({ mode: 'open' }).append(input);
    } });</script>`, async page => {
    const out = await page.evaluate(() => {
      const snap = __latch.inspect();
      const user = snap.fields.find(f => f.kind === 'username'), pw = snap.fields.find(f => f.kind === 'password');
      __latch.fillAndSubmit({ fills: [{ ref: user.ref, value: 'private@example.test' }, { ref: pw.ref, value: 'not-a-real-secret' }], submitRef: pw.ref, purpose: 'login' });
      return { user: !!document.querySelector('x-user').shadowRoot.getElementById('u').value, pw: !!document.getElementById('p').value };
    });
    assert.deepEqual(out, { user: true, pw: true });
  });
});

test('filling and submitting walks the document for shadow roots once per step, not per lookup', async () => {
  const hosts = '<x-box></x-box>'.repeat(5);
  await withPage(`<main><h1>Sign in</h1>${hosts}<div><input type="email" aria-label="Email"><input type="password" aria-label="Password">
    <div id="go" role="button">Sign in</div></div></main>
    <script>customElements.define('x-box', class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<span>x</span>'; } });</script>`, async page => {
    const walks = await page.evaluate(() => {
      const snap = __latch.inspect();
      const pw = snap.fields.find(f => f.kind === 'password');
      let n = 0;
      const all = Document.prototype.querySelectorAll;
      Document.prototype.querySelectorAll = function (selector) { if (selector === '*') n++; return all.call(this, selector); };
      __latch.fillAndSubmit({ fills: [{ ref: pw.ref, value: 'not-a-real-secret' }], submitRef: pw.ref, purpose: 'login' });
      Document.prototype.querySelectorAll = all;
      return n;
    });
    assert.ok(walks <= 3, `walked the document ${walks} times`);
  });
});

test('genuine sign-up forms still read as sign-up beside a sign-in button', async () => {
  const pages = [
    `<h1>Create Account</h1><form><label for="e">Email Address*</label><input id="e" type="text" autocomplete="email">
      <label for="p">Password*</label><input id="p" type="password" autocomplete="new-password">
      <label for="v">Verify New Password*</label><input id="v" type="password" autocomplete="new-password">
      <button type="submit">Create Account</button></form><button type="submit" form="none">Sign In</button>`,
    `<h1>Create Your Account</h1><form><label for="e">Email address *</label><input id="e" type="text" autocomplete="email">
      <label for="p">Password *</label><input id="p" type="password" autocomplete="new-password">
      <button type="submit">Continue</button><button type="submit">Continue with Google</button>
      <button type="submit">Corporate Login</button></form><p>Already have an account? <a href="/login">Log in</a></p>`,
  ];
  for (const html of pages) {
    await withPage(html, async page => {
      assert.deepEqual(await page.evaluate(() => __latch.inspect().auth), { login: false, signup: true });
    });
  }
});

const RESET_PAGE = `<main><h1>Reset your password</h1><form method="post" action="/reset">
  <label>New password<input type="password" autocomplete="new-password"></label>
  <label>Confirm new password<input type="password" autocomplete="new-password"></label>
  <button type="submit">Reset password</button></form><a href="/login">Back to sign in</a></main>
  <script>window.submits = 0; window.clicks = 0; document.querySelector('form').addEventListener('submit', e => { e.preventDefault(); submits++; });
  document.querySelector('button').addEventListener('click', () => clicks++);</script>`;

test('resetForm finds a new and confirm password form and nothing else', async () => {
  await withSite(RESET_PAGE, async page => {
    const out = await page.evaluate(() => {
      const snap = __latch.inspect();
      return { reset: snap.reset, recovery: snap.recovery, refs: snap.fields.map(f => f.ref) };
    });
    assert.ok(out.reset);
    assert.deepEqual(out.reset.pw, out.refs);
    assert.ok(out.reset.button && out.reset.scope);
    assert.equal(out.recovery, null);
  });
  // A change-password form asks for the current password: out of scope.
  await withSite(RESET_PAGE.replace('<label>New password', '<label>Current password<input type="password" autocomplete="current-password"></label><label>New password'), async page => {
    assert.equal(await page.evaluate(() => __latch.inspect().reset), null);
  });
  // A sign-up form that asks to choose a password is not a reset page.
  await withSite(`<h1>Create your account</h1><form action="/signup"><label>Email<input type="email"></label>
    <p>Choose a password</p><label>Password<input type="password"></label><label>Confirm password<input type="password"></label>
    <button type="submit">Continue</button></form>`, async page => {
    assert.equal(await page.evaluate(() => __latch.inspect().reset), null);
  });
  await withSite(`<form action="/signup"><h1>Create a new account</h1><p>Set your password</p><label>Password<input type="password"></label>
    <label>Confirm password<input type="password"></label><button type="submit">Continue</button></form>`, async page => {
    assert.equal(await page.evaluate(() => __latch.inspect().reset), null);
  });
  // A sign-in page with a reset link is not a reset page either.
  await withSite(`<h1>Sign in</h1><form action="/login"><input type="email"><input type="password">
    <a href="/forgot">Reset your password</a><button type="submit">Sign in</button></form>`, async page => {
    assert.equal(await page.evaluate(() => __latch.inspect().reset), null);
  });
  // A page that is not https is never a reset target.
  await withPage(RESET_PAGE, async page => {
    assert.equal(await page.evaluate(() => __latch.inspect().reset), null);
  });
});

test('resetForm finds a form-less reset panel inside a shadow root', async () => {
  await withSite(`<x-reset></x-reset><script>customElements.define('x-reset', class extends HTMLElement { connectedCallback() {
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = '<h2>Set a new password</h2><label>New password<input type="password"></label><label>Confirm password<input type="password"></label><button>Save</button>';
  } });</script>`, async page => {
    const reset = await page.evaluate(() => __latch.inspect().reset);
    assert.equal(reset?.pw?.length, 2);
  });
});

test('fillReset fills both fields and leaves the button to the user', async () => {
  await withSite(RESET_PAGE, async page => {
    const out = await page.evaluate(() => {
      const value = 'not-a-real-secret-1';
      const { reset } = __latch.inspect();
      const wrongUrl = __latch.fillReset({ refs: reset.pw, value, expectedUrl: location.href + '?other' });
      const wrongRefs = __latch.fillReset({ refs: [reset.pw[1], reset.pw[0]], value, expectedUrl: location.href });
      const emptyAfterRefusals = [...document.querySelectorAll('input')].every(el => !el.value);
      const result = __latch.fillReset({ refs: reset.pw, value, expectedUrl: location.href });
      const same = [...document.querySelectorAll('input')].every(el => el.value === value);
      const secretsLeft = __latch.secretsLeft();
      const cleared = __latch.clearFilled(true).cleared;
      const kept = [...document.querySelectorAll('input')].every(el => el.value === value);
      return { wrongUrl, wrongRefs, emptyAfterRefusals, result, same, secretsLeft, cleared, kept, submits, clicks };
    });
    assert.deepEqual(out, { wrongUrl: { ok: false }, wrongRefs: { ok: false }, emptyAfterRefusals: true, result: { ok: true },
      same: true, secretsLeft: false, cleared: 0, kept: true, submits: 0, clicks: 0 });
  });
});

test('recoveryForm accepts a form-less recovery dialog and requestRecovery sends it', async () => {
  await withSite(`<h1>Careers</h1><div role="dialog"><h2>Forgot your password?</h2><p>Enter your email and we will send a reset link.</p>
    <label>Email<input type="email"></label><button>Send</button><button>Cancel</button></div>
    <script>window.sent = 0; document.querySelector('button').addEventListener('click', () => sent++);</script>`, async page => {
    const out = await page.evaluate(async () => {
      const { recovery } = __latch.inspect();
      const result = await __latch.requestRecovery({ email: 'private@example.test', expectedUrl: location.href, runId: 'r1', deadline: Date.now() + 5000 });
      return { recovery, result, sent, filled: !!document.querySelector('input').value };
    });
    assert.ok(out.recovery?.email && out.recovery.button && out.recovery.scope);
    assert.deepEqual(out.result, { ok: true });
    assert.equal(out.sent, 1);
    assert.equal(out.filled, true);
  }, 'https://reset.test/forgot');
  // An email-first sign-in step with a "Forgot password?" link or button is not a recovery form.
  for (const html of [
    `<main><h1>Sign in</h1><label>Email<input type="email"></label><a href="/forgot">Forgot your password?</a><button>Next</button></main>`,
    `<main><h1>Sign in</h1><label>Email<input type="email"></label><button type="button" onclick="">Forgot your password?</button><button>Continue</button></main>`,
    `<form action="/signin"><h1>Sign in</h1><label>Email<input type="email"></label><button type="button">Forgot your password?</button><button>Next</button></form>`,
    `<main><h1>Sign in</h1><label>Email<input type="email"></label><div role="button">Forgot password?</div><button>Next</button></main>`,
  ]) {
    await withSite(html, async page => {
      assert.equal(await page.evaluate(() => __latch.inspect().recovery), null, html);
    });
  }
  // A real recovery form may still use the same button words.
  await withSite(`<form action="/forgot"><h1>Forgot your password?</h1><label>Email<input type="email"></label><button>Next</button></form>`, async page => {
    assert.ok((await page.evaluate(() => __latch.inspect().recovery))?.email);
  });
});

test('resetDone reports a completed password change', async () => {
  await withPage(`<h1>All set</h1><p>Your password has been successfully changed.</p>`, async page => {
    assert.equal(await page.evaluate(() => __latch.inspect().flags.resetDone), true);
  });
  await withPage(`<h1>Sign in</h1><p>Sign in with your new password.</p>`, async page => {
    assert.equal(await page.evaluate(() => __latch.inspect().flags.resetDone), true);
  });
  await withPage(`<h1>Sign in</h1><form><input type="email"><input type="password"><button>Sign in</button></form>`, async page => {
    assert.equal(await page.evaluate(() => __latch.inspect().flags.resetDone), false);
  });
});

// CGI Njoyn as served: a New Applicant form above a Returning User form of its own,
// whose password is marked new-password and whose submit says Apply.
const NJOYN_NEW = `<form id="newuserform" name="newuserform" method="post" action="/corp/xweb/xweb.asp?page=newuser">
  <input type="text" id="NewEmail" name="NewEmail" placeholder="Email address">
  <select id="country"><option>Canada</option></select>
  <input type="submit" id="btnCreate" value="Create Profile"></form>`;
const NJOYN_FIELDS = `<input type="text" id="Inp_Login_email" name="Inp_Login_email" autocomplete="off" placeholder="Email address">
  <input type="password" id="Inp_Login_password" name="Inp_Login_password" autocomplete="new-password">
  <a href="#forgot">Forgot your password?</a> <input type="submit" id="btnApply" value="Apply">`;
const returnForm = (inner = NJOYN_FIELDS) => `<form id="returnuserform" name="returnuserform" method="post" action="/corp/xweb/xweb.asp?page=login">${inner}</form>`;
const njoyn = body => `<title>Winter 2027 : AI Developer Co-op (8 months)</title><h1>Winter 2027 : AI Developer Co-op (8 months)</h1>${body}
  <script>window.clicked = []; document.addEventListener('click', e => clicked.push(e.target.id));
  document.addEventListener('submit', e => e.preventDefault());</script>`;
const NJOYN_LAYOUTS = {
  'each block in its own wrapper': `<div><h2>New Applicant</h2>${NJOYN_NEW}</div><div><h2>Returning User</h2>${returnForm()}</div>`,
  'both blocks in one wrapper': `<div><h2>New Applicant</h2>${NJOYN_NEW}<h2>Returning User</h2>${returnForm()}</div>`,
  'heading inside the form': `<h2>New Applicant</h2>${NJOYN_NEW}${returnForm(`<h2>Returning User</h2>${NJOYN_FIELDS}`)}`,
  'heading in a plain table cell': `<table><tr><td>New Applicant</td></tr><tr><td>${NJOYN_NEW}</td></tr>
    <tr><td class="title">Returning User</td></tr><tr><td>${returnForm()}</td></tr></table>`,
  'an intro line under the heading': `<div><h2>New Applicant</h2>${NJOYN_NEW}</div><div><h2>Returning User</h2><p>Enter your email and password.</p>${returnForm()}</div>`,
  // The parser lifts a <form> straight inside <table> out of the rows it wraps, so the form holds no children.
  'form wrapped around table rows': `<h2>New Applicant</h2>${NJOYN_NEW}<h2>Returning User</h2><table>${returnForm(`<tr><td>${NJOYN_FIELDS}</td></tr>`)}</table>`,
};

test('a Returning User form of its own is the login form and its Apply submit signs in', async () => {
  for (const [layout, html] of Object.entries(NJOYN_LAYOUTS)) {
    await withPage(njoyn(html), async page => {
      const out = await page.evaluate(() => {
        const snap = __latch.inspect();
        const pw = snap.fields.find(f => f.kind === 'password');
        const emails = snap.fields.filter(f => f.kind === 'email');
        const result = __latch.fillAndSubmit({ fills: emails.map(f => ({ ref: f.ref, value: 'private@example.test' }))
          .concat({ ref: pw.ref, value: 'not-a-real-secret' }), submitRef: pw.ref, purpose: 'login' });
        const value = id => document.getElementById(id).value;
        return { auth: snap.auth, email: snap.paths.email, create: snap.paths.create_account, isNew: pw.isNew, result, clicked,
          login: value('Inp_Login_email'), password: value('Inp_Login_password'), newApplicant: value('NewEmail') };
      });
      assert.deepEqual(out.auth, { login: true, signup: false }, layout);
      assert.equal(out.email, true, layout);
      assert.equal(out.create, true, layout);
      assert.equal(out.isNew, true, layout);
      assert.equal(out.result.ok, true, layout);
      assert.equal(out.result.clicked, true, layout);
      assert.deepEqual(out.clicked, ['btnApply'], layout);
      assert.equal(out.login, 'private@example.test', layout);
      assert.equal(out.password, 'not-a-real-secret', layout);
      assert.equal(out.newApplicant, '', layout);
    });
  }
});

test('a Returning User form with its heading outside signs in whatever its own submit says', async () => {
  const fields = NJOYN_FIELDS.replace('value="Apply"', 'value="Continue"');
  await withPage(njoyn(`<div><h2>New Applicant</h2>${NJOYN_NEW}</div><div><h2>Returning User</h2>${returnForm(fields)}</div>`), async page => {
    assert.deepEqual(await page.evaluate(() => __latch.inspect().auth), { login: true, signup: false });
  });
});

test('Apply signs in nowhere but a Returning User form', async () => {
  const email = '<input type="email" aria-label="Email">';
  const pw = '<input type="password" aria-label="Password">';
  const apply = '<input type="submit" id="btnApply" value="Apply">';
  const pages = {
    'an application with no password': `<h2>Returning User</h2><form>${email}${apply}</form>`,
    'an application with no password or heading': `<h1>Apply for this job</h1><form>${email}${apply}</form>`,
    'an ordinary sign-in page': `<h1>Sign in</h1><form>${email}${pw}${apply}</form>`,
    'a new-applicant form': `<h2>New Applicant</h2><form>${email}${pw}${apply}</form>`,
    'a form under no heading': `<form>${email}${pw}${apply}</form>`,
    'a Returning User heading that is not the nearest': `<h2>Returning User</h2><p>Your details.</p><h2>Apply for this job</h2><form>${email}${pw}${apply}</form>`,
    'a heading far above the form': `<div>Returning User</div>${'<p>Line</p>'.repeat(20)}<form>${email}${pw}${apply}</form>`,
    'a sentence rather than a heading': `<p>Returning users who started an application on our previous careers site must sign in there first.</p><form>${email}${pw}${apply}</form>`,
    'an application asking more than a login': `<h2>Returning User</h2><form><input aria-label="First name">${email}${pw}${apply}</form>`,
    'a second password': `<h2>Returning User</h2><form>${email}${pw}<input type="password" aria-label="Confirm password">${apply}</form>`,
    'a password that asks for a new one': `<h2>Returning User</h2><form>${email}<label>Choose a password<input type="password"></label>${apply}</form>`,
    'a form with no identifier': `<h2>Returning User</h2><form>${pw}${apply}</form>`,
    'a password beside something other than an identifier': `<h2>Returning User</h2><form><input aria-label="First name">${pw}${apply}</form>`,
    'plain new-applicant text nearer than the returning line': `<div>Returning User</div><div>New Applicant</div><form>${email}${pw}${apply}</form>`,
    'another non-auth submit': `<h2>Returning User</h2><form>${email}${pw}<input type="submit" id="btnApply" value="Submit application"></form>`,
    'a wordier Apply': `<h2>Returning User</h2><form>${email}${pw}<input type="submit" id="btnApply" value="Apply to this job"></form>`,
  };
  for (const [name, html] of Object.entries(pages)) {
    await withPage(`${html}<script>window.clicks = 0; document.addEventListener('click', () => clicks++);
      document.addEventListener('submit', e => e.preventDefault());</script>`, async page => {
      const out = await page.evaluate(() => {
        const snap = __latch.inspect();
        const field = snap.fields.find(f => f.kind === 'password') || snap.fields.find(f => f.kind === 'email');
        const result = __latch.fillAndSubmit({ fills: [{ ref: field.ref, value: 'not-a-real-secret' }], submitRef: field.ref, purpose: 'login' });
        return { auth: snap.auth, noForm: result.noForm, clicks, filled: [...document.querySelectorAll('input:not([type=submit])')].some(el => el.value) };
      });
      assert.equal(out.auth.login, false, name);
      assert.equal(out.noForm, true, name);
      assert.equal(out.clicks, 0, name);
      assert.equal(out.filled, false, name);
    });
  }
});

// SAP SuccessFactors: Create Account swaps the form for an emailed-passcode step in the same document.
const successFactors = (passcodeType = 'password') => `<title>Career Opportunities: Create an Account</title>
  <form id="f" method="post" action="/career">
    <div id="create"><h1>Create an Account</h1>
      <label for="fbclc_userName">Email Address</label><input id="fbclc_userName" type="text">
      <label for="fbclc_emailConf">Retype Email Address</label><input id="fbclc_emailConf" type="text">
      <label for="fbclc_pwd">Choose Password</label><input id="fbclc_pwd" type="password">
      <label for="fbclc_pwdConf">Retype Password</label><input id="fbclc_pwdConf" type="password">
      <label for="fbclc_fName">First Name</label><input id="fbclc_fName" type="text" value="Ada">
      <label for="fbclc_lName">Last Name</label><input id="fbclc_lName" type="text" value="Lovelace">
      <div id="feedback" aria-live="polite"></div>
      <button type="button" id="createBtn">Create Account</button></div>
    <div id="otp" hidden>
      <p>We've sent a one-time password to your email address. In case you don't find this email in your primary inbox, please check your spam or bulk email folders.</p>
      <label for="passcode">Passcode</label><input id="passcode" type="${passcodeType}">
      <div id="timer" aria-live="polite"></div>
      <button type="submit" id="againBtn">Request a new passcode</button>
      <button type="button" id="continueBtn">Continue</button></div></form>
  <script>window.clicked = []; document.addEventListener('click', e => clicked.push(e.target.id));
  document.addEventListener('submit', e => e.preventDefault());
  document.getElementById('fbclc_pwd').addEventListener('input', () => { document.getElementById('feedback').textContent = 'Password accepted'; });
  document.getElementById('createBtn').addEventListener('click', () => {
    document.getElementById('create').hidden = true;
    document.getElementById('otp').hidden = false;
    document.getElementById('timer').textContent = 'You can request for a new passcode in 2 minutes.';
  });</script>`;
const signUp = () => {
  const snap = __latch.inspect();
  const fills = snap.fields.filter(f => ['email', 'password'].includes(f.kind)).map(f => ({ ref: f.ref, value: 'not-a-real-secret' }));
  const pw = snap.fields.filter(f => f.kind === 'password').at(-1);
  return { auth: snap.auth, result: __latch.fillAndSubmit({ fills, submitRef: pw.ref, purpose: 'signup', validate: true }) };
};

test('an emailed passcode step reads as a code step whether or not its box is masked', async () => {
  for (const type of ['password', 'text']) {
    await withPage(successFactors(type), async page => {
      const { auth, result } = await page.evaluate(signUp);
      assert.equal(auth.signup, true, type);
      assert.equal(result.ok, true, type);
      const out = await page.evaluate(() => {
        const snap = __latch.inspect();
        return { kinds: snap.fields.map(f => f.kind), error: snap.error, emailCode: snap.flags.emailCode, password: snap.paths.password, auth: snap.auth };
      });
      assert.deepEqual(out.kinds, ['code'], type);
      assert.equal(out.error, '', type);
      assert.equal(out.emailCode, true, type);
      assert.equal(out.password, false, type);
      assert.deepEqual(out.auth, { login: false, signup: false }, type);
    });
  }
});

test('the passcode goes in with Continue, not the button that asks for a new passcode', async () => {
  await withPage(successFactors(), async page => {
    await page.evaluate(signUp);
    const out = await page.evaluate(() => {
      const box = __latch.inspect().fields.find(f => f.kind === 'code');
      clicked.length = 0;
      const result = __latch.fillCode({ refs: [box?.ref], code: '123456' });
      return { result, clicked, typed: document.getElementById('passcode').value };
    });
    assert.equal(out.result.clicked, true);
    assert.deepEqual(out.clicked, ['continueBtn']);
    assert.equal(out.typed, '123456');
  });
});

test('a password field stays a password unless it is labelled a one-time code', async () => {
  for (const html of [
    '<h1>Sign in</h1><form><input type="email" aria-label="Email"><label>Password<input type="password"></label><button>Sign in</button></form>',
    '<h1>Sign in</h1><form><input type="email" aria-label="Email"><label>Temporary password<input type="password"></label><button>Sign in</button></form>',
    '<h1>Create Account</h1><form><input type="email" aria-label="Email"><label>Choose Password<input type="password"></label><button>Create Account</button></form>',
  ]) {
    await withPage(html, async page => {
      assert.deepEqual(await page.evaluate(() => __latch.inspect().fields.map(f => f.kind)), ['email', 'password'], html);
    });
  }
  for (const html of [
    '<form><label>One-time password<input type="password"></label><button>Continue</button></form>',
    '<form><label>OTP<input type="password"></label><button>Continue</button></form>',
    '<form><input type="password" autocomplete="one-time-code" aria-label="Enter it here"><button>Continue</button></form>',
  ]) {
    await withPage(html, async page => {
      assert.deepEqual(await page.evaluate(() => __latch.inspect().fields.map(f => f.kind)), ['code'], html);
    });
  }
});

const inspected = async (html, read) => {
  let value;
  await withPage(html, async page => { value = await page.evaluate(read); });
  return value;
};

test('an emailed one-time password is an email code, one sent elsewhere is not', async () => {
  const emailCode = html => inspected(html, () => __latch.inspect().flags.emailCode);
  assert.equal(await emailCode(`<p>We've sent a one-time password to your email address.</p>`), true);
  assert.equal(await emailCode('<p>A one-time password was emailed to your inbox.</p>'), true);
  assert.equal(await emailCode('<p>We have sent a one-time password to your phone.</p>'), false);
  assert.equal(await emailCode('<p>Your one-time password is valid for this session only.</p>'), false);
});

const errorOf = html => inspected(html, () => __latch.inspect().error);

test('status lines are not errors, in any of the places errors are read from', async () => {
  const lines = ['Password accepted', 'Password accepted.', 'Your password has been accepted', 'Passwords match', 'Password strength: Strong',
    'You can request for a new passcode in 2 minutes.', 'You can request for a new passcode in 01:40 minutes', 'Your passcode expires in 10 minutes.',
    'This code will expire in 9:59', 'Resend code in 30 seconds'];
  const wrappers = [t => `<div aria-live="polite">${t}</div>`, t => `<div role="alert">${t}</div>`, t => `<span class="fieldError">${t}</span>`, t => `<p id="pwd-error">${t}</p>`];
  for (const line of lines) {
    for (const wrap of wrappers) assert.equal(await errorOf(wrap(line)), '', wrap(line));
  }
});

test('real failures are still read, alone, beside a status line, or sharing its text', async () => {
  for (const text of ['Password not accepted', 'Password is too weak', 'Password strength: Weak', 'Passwords do not match', 'Password must be at least 8 characters.',
    'Please complete all required fields and re-submit.', 'Invalid passcode.', 'The passcode has expired. Request a new one.', 'Passcode not recognized.',
    'Incorrect passcode. You can request for a new passcode in 2 minutes.', 'Your passcode has expired. You can request for a new passcode in 2 minutes.',
    'Too many attempts. You can request a new passcode in 15 minutes.', 'Could not send the code. Try again in 5 minutes.', 'Unable to send code. Try again in 5 minutes.',
    'Password accepted, but the email address is already in use.']) {
    assert.equal(await errorOf(`<div role="alert">${text}</div>`), text, text);
  }
  assert.equal(await errorOf('<div aria-live="polite">Password accepted</div><div role="alert">This email address is invalid.</div>'), 'This email address is invalid.');
  assert.equal(await errorOf('<div aria-live="polite">You can request for a new passcode in 2 minutes.</div><div class="error">Invalid passcode.</div>'), 'Invalid passcode.');
});

test('password feedback shown while filling the sign-up form leaves no error to fail on', async () => {
  await withPage(successFactors(), async page => {
    const out = await page.evaluate(() => {
      const pw = __latch.inspect().fields.find(f => f.kind === 'password');
      __latch.fillOne({ ref: pw.ref, value: 'not-a-real-secret' });
      return { shown: document.getElementById('feedback').textContent, error: __latch.inspect().error };
    });
    assert.deepEqual(out, { shown: 'Password accepted', error: '' });
  });
});

test('a sign-up form with hidden regional required fields is still submitted; visible ones still block', async () => {
  const form = (hiddenStyle) => `<form id="reg" novalidate onsubmit="event.preventDefault(); window.sent = true">
    <label>Email <input type="text" name="email" autocomplete="email" required></label>
    <label>Password <input type="password" name="pw" autocomplete="new-password" required></label>
    <label>Confirm password <input type="password" name="pw2" autocomplete="new-password" required></label>
    <div style="${hiddenStyle}"><label>Name (zh) <input name="zh" required></label>
      <label><input type="checkbox" name="kr" required> I agree (KR)</label></div>
    <button type="submit">Create account</button></form>`;
  await withPage(form('display:none'), async page => {
    const { result } = await page.evaluate(signUp);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(await page.evaluate(() => window.sent === true), true);
  });
  await withPage(form(''), async page => {
    const { result } = await page.evaluate(signUp);
    assert.equal(result.ok, false);
    assert.ok(result.missing.length >= 1);
  });
});
