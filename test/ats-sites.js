// Practice copies of real applicant-tracking sign-in patterns, modelled on what
// test/real-sites.mjs found on live sites. Mounted by startSites in fixture.js.
//
//   oracle.localhost       Oracle Recruiting: email, then an emailed 6-digit code; no password.
//                          The page never says "sign in"; only its address does. Has a honeypot.
//   taleo.localhost        Taleo: signs in by User Name; plain input buttons driven by script.
//   login.icims.localhost  iCIMS universal login: identifier page, then password page, beside
//                          seven social "Continue with" buttons; buttons carry value="default".
export function atsSites({ state, key, body, page, send, json, redirect, startSession, session, origin, mailbox, token, code6, cookies }) {
  const post = (site, path) => state.posts.push({ site, path });
  return {
    'oracle.localhost': async (req, res, url) => {
      const site = 'oracle.localhost';
      if (url.pathname === '/sites/CX/my-profile/sign-in') {
        return send(res, page('Manage Your Profile - Careers', `<h1>Manage Your Profile</h1>
          <p>Enter the email address or phone number you used to create your profile. Once your identity is confirmed, you will be able to manage your profile.</p>
          <div id="app"><form id="f"><label for="em">Email Address</label><input id="em" type="email" autocomplete="email">
          <label for="hp">honeypot</label><input id="hp" type="text" name="honey-pot">
          <button type="button">CANCEL</button> <button type="submit">NEXT</button></form></div>
          <script>
            const post = (p, b) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());
            document.getElementById('f').addEventListener('submit', async e => {
              e.preventDefault();
              await post('/api/send-code', { email: document.getElementById('em').value, honeypot: document.getElementById('hp').value });
              const app = document.getElementById('app');
              app.innerHTML = '<p>Enter the code we sent to your email address.</p><div class="digits">' + [1,2,3,4,5,6].map(i => '<input maxlength="1" inputmode="numeric" aria-label="Digit ' + i + '">').join('') + '</div><button id="v" type="button">VERIFY</button><div role="alert" id="err"></div>';
              document.getElementById('v').onclick = async () => {
                const code = [...app.querySelectorAll('.digits input')].map(i => i.value).join('');
                const r = await post('/api/verify', { code });
                if (r.ok) location.href = '/sites/CX/my-profile'; else document.getElementById('err').textContent = 'That code is not valid.';
              };
            });
          </script>`));
      }
      if (url.pathname === '/api/send-code') {
        const b = await body(req);
        post(site, '/api/send-code');
        if (b.honeypot) state.oracleHoneypot = true;
        const acct = state.accounts.get(key(site, b.email)) || { verified: true };
        state.accounts.set(key(site, b.email), acct);
        acct.otp = code6();
        state.secrets.add(acct.otp);
        state.oracleEmail = b.email;
        mailbox.add({ from: 'Careers <no-reply@oracle.localhost>', to: b.email, subject: 'Your one-time passcode', text: `Your one-time passcode is ${acct.otp}. It expires in 10 minutes.` });
        return json(res, { ok: true });
      }
      if (url.pathname === '/api/verify') {
        const b = await body(req);
        const acct = state.accounts.get(key(site, state.oracleEmail));
        if (!acct || b.code !== acct.otp) return json(res, { ok: false });
        return json(res, { ok: true }, { 'Set-Cookie': startSession(site, state.oracleEmail) });
      }
      if (url.pathname === '/sites/CX/my-profile') {
        return session(req) ? send(res, page('My Profile', '<h1>My Profile</h1><button type="button">Sign Out</button>')) : redirect(res, '/sites/CX/my-profile/sign-in');
      }
    },

    'taleo.localhost': async (req, res, url) => {
      const site = 'taleo.localhost';
      const shell = (title, inner) => page(title, `<p>Welcome. You are not signed in.</p><h2>${title}</h2>${inner}`);
      if (url.pathname === '/careersection/iam/accessmanagement/login.jsf') {
        return send(res, shell('Applicant Login', `<form id="f" method="post" action="/careersection/login">
          <label for="u">User Name</label><input id="u" name="username" type="text" autocomplete="off">
          <label for="p">Password</label><input id="p" name="password" type="password" autocomplete="off">
          <input type="button" value="Login" onclick="document.getElementById('f').submit()">
          <input type="button" value="Create a New Account" onclick="location.href='/careersection/register'">
          </form>${cookies(req).error ? '<div class="error" role="alert">The user name or password is incorrect.</div>' : ''}`));
      }
      if (url.pathname === '/careersection/login') {
        const b = await body(req);
        post(site, '/login');
        const acct = [...state.accounts.entries()].find(([k, a]) => k.startsWith(`${site}|`) && a.username === b.username)?.[1];
        if (!acct || acct.password !== b.password) return redirect(res, '/careersection/iam/accessmanagement/login.jsf', { 'Set-Cookie': 'error=1; Path=/' });
        return redirect(res, '/careersection/myaccount', { 'Set-Cookie': startSession(site, acct.email) });
      }
      if (url.pathname === '/careersection/register' && req.method === 'GET') {
        return send(res, shell('New User Registration', `<form id="f" method="post" action="/careersection/register">
          <label for="u">User Name</label><input id="u" name="username" type="text" maxlength="100" required>
          <label for="p">Password</label><input id="p" name="password" type="password" required>
          <label for="p2">Re-enter Password</label><input id="p2" name="password2" type="password" required>
          <label for="e">Email Address</label><input id="e" name="email" type="text" required>
          <label for="e2">Re-enter Email Address</label><input id="e2" name="email2" type="text" required>
          <label><input id="privacy" type="checkbox" required> I have read and accept the privacy agreement</label>
          <input type="button" value="Register" onclick="const f = document.getElementById('f'); if (f.reportValidity()) f.submit()">
          </form>`));
      }
      if (url.pathname === '/careersection/register') {
        const b = await body(req);
        post(site, '/register');
        if (b.password !== b.password2 || b.email !== b.email2 || !b.username) return send(res, shell('New User Registration', '<div class="error" role="alert">Please correct the highlighted fields.</div>'), 400);
        state.accounts.set(key(site, b.email), { email: b.email, username: b.username, password: b.password, verified: true });
        state.passwords.set(site, b.password);
        return redirect(res, '/careersection/myaccount', { 'Set-Cookie': startSession(site, b.email) });
      }
      if (url.pathname === '/careersection/myaccount') {
        return session(req) ? send(res, page('My Account', '<h2>My Account</h2><a href="/careersection/logout">Sign Out</a>')) : redirect(res, '/careersection/iam/accessmanagement/login.jsf');
      }
      if (url.pathname === '/careersection/logout') return redirect(res, '/careersection/iam/accessmanagement/login.jsf', { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' });
    },

    'login.icims.localhost': async (req, res, url) => {
      const site = 'login.icims.localhost';
      const socials = ['Indeed', 'Facebook', 'Microsoft', 'Linkedin', 'Google', 'Corporate Login', 'Apple']
        .map(s => `<button type="submit" name="connection" value="${s.toLowerCase()}">Continue with ${s}</button>`).join('');
      if (url.pathname === '/u/login/identifier' && req.method === 'GET') {
        return send(res, page('Log in to Acme', `<h1>Welcome</h1><p>Log in to Acme to continue.</p>
          <form method="post" action="/u/login/identifier"><label for="username">Username or email address *</label>
          <input id="username" name="username" type="text" autocomplete="email" required>
          <button type="submit" name="action" value="default">Continue</button>${socials}</form>
          <p>Don't have an account? <a href="/u/signup">Sign up</a></p>`));
      }
      if (url.pathname === '/u/login/identifier') {
        const b = await body(req);
        if (b.connection) { state.socialClicks = (state.socialClicks || 0) + 1; return send(res, page('Redirecting', '<p>Redirecting to provider</p>')); }
        // Identifier first: known emails get the password page, new ones the sign-up page.
        const next = state.accounts.has(key(site, b.username)) ? '/u/login/password' : '/u/signup/password';
        return redirect(res, next, { 'Set-Cookie': `who=${encodeURIComponent(b.username)}; HttpOnly; Path=/` });
      }
      if (url.pathname === '/u/login/password' && req.method === 'GET') {
        return send(res, page('Enter your password', `<h1>Enter Your Password</h1>${cookies(req).bad ? '<div class="error" role="alert">Wrong email or password</div>' : ''}
          <form method="post" action="/u/login/password"><label for="password">Password *</label>
          <input id="password" name="password" type="password" autocomplete="current-password" required>
          <button type="submit" name="action" value="default">Continue</button></form><a href="/u/reset-password">Forgot password?</a>`));
      }
      if (url.pathname === '/u/login/password') {
        const b = await body(req);
        post(site, '/u/login/password');
        state.secrets.add(b.password || '');
        const email = cookies(req).who;
        const acct = state.accounts.get(key(site, email));
        if (!acct || acct.password !== b.password) return redirect(res, '/u/login/password', { 'Set-Cookie': 'bad=1; Path=/' });
        return redirect(res, '/portal', { 'Set-Cookie': startSession(site, email) });
      }
      if (url.pathname === '/u/signup/password' && req.method === 'GET') {
        return send(res, page('Create your account', `<h1>Create Your Account</h1><p>Set your password for Acme.</p>
          <form method="post" action="/u/signup"><input type="hidden" name="email" value="">
          <label for="password">Password *</label><input id="password" name="password" type="password" autocomplete="new-password" required>
          <button type="submit" name="action" value="default">Continue</button></form>`));
      }
      if (url.pathname === '/u/signup' && req.method === 'GET') {
        return send(res, page('Sign up | Acme', `<h1>Create Your Account</h1>
          <form method="post" action="/u/signup"><label for="email">Email address *</label><input id="email" name="email" type="text" autocomplete="email" required>
          <label for="password">Password *</label><input id="password" name="password" type="password" autocomplete="new-password" required>
          <button type="submit" name="action" value="default">Continue</button>${socials}</form>`));
      }
      if (url.pathname === '/u/signup') {
        const b = await body(req);
        if (b.connection) { state.socialClicks = (state.socialClicks || 0) + 1; return send(res, page('Redirecting', '<p>Redirecting to provider</p>')); }
        b.email ||= cookies(req).who;
        post(site, '/u/signup');
        const t = token();
        state.accounts.set(key(site, b.email), { password: b.password, verified: false, token: t });
        state.passwords.set(site, b.password);
        state.secrets.add(t);
        mailbox.add({ from: 'iCIMS <no-reply@login.icims.localhost>', to: b.email, subject: 'Verify your email',
          html: `<p>Confirm your email to finish creating your account.</p><a href="${origin(site)}/u/email-verification?ticket=${t}">Verify Your Account</a>`, text: 'Open the HTML version to verify.' });
        return redirect(res, '/u/signup/verify-notice', { 'Set-Cookie': startSession(site, b.email) });
      }
      if (url.pathname === '/u/signup/verify-notice') {
        return send(res, page('Verify your email', '<h1>Verify your email</h1><p>We sent you a link to confirm your account. Check your email.</p>'));
      }
      if (url.pathname === '/u/email-verification') {
        for (const [k, a] of state.accounts) if (k.startsWith(`${site}|`) && a.token === url.searchParams.get('ticket')) { a.verified = true; return send(res, page('Verified', '<h1>Email verified</h1>')); }
        return send(res, page('Expired', '<h1>Link expired</h1>'), 400);
      }
      if (url.pathname === '/portal') return session(req) ? send(res, page('Candidate Portal', '<h1>Candidate Portal</h1><a href="/u/logout">Log out</a>')) : redirect(res, '/u/login/identifier');
      if (url.pathname === '/u/logout') return redirect(res, '/u/login/identifier', { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' });
    },
  };
}
