// Fake websites and a fake IMAP mailbox for the end-to-end test.
// Every site is served from one loopback port and routed by Host header.
import { createServer as createHttp } from 'node:http';
import { createServer as createTcp } from 'node:net';
import { randomBytes, randomInt } from 'node:crypto';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const code6 = () => String(randomInt(100000, 999999));
const token = () => randomBytes(16).toString('hex');

// ---------- mailbox

export class Mailbox {
  messages = [];
  nextUid = 1;

  add({ from, to, subject, text, html, at = new Date() }) {
    const boundary = `b${token()}`;
    const head = [
      `From: ${from}`, `To: ${to}`, `Subject: ${subject}`, `Date: ${at.toUTCString()}`,
      `Message-ID: <${token()}@fixture.localhost>`, 'MIME-Version: 1.0',
    ];
    const body = html
      ? [`Content-Type: multipart/alternative; boundary="${boundary}"`, '',
        `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', '', text || '',
        `--${boundary}`, 'Content-Type: text/html; charset=utf-8', '', html, `--${boundary}--`, '']
      : ['Content-Type: text/plain; charset=utf-8', '', text, ''];
    this.messages.push({ uid: this.nextUid++, at, raw: [...head, ...body].join('\r\n') });
  }
}

function imapDate(d) {
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}-${mon}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

function inSet(set, value, max) {
  return set.split(',').some(part => {
    const [a, b] = part.split(':').map(x => (x === '*' ? max : Number(x)));
    return b === undefined ? value === a : value >= Math.min(a, b) && value <= Math.max(a, b);
  });
}

function headerFields(raw, names) {
  const head = raw.split('\r\n\r\n')[0].replace(/\r\n[ \t]+/g, ' ');
  const wanted = new Set(names.map(n => n.toLowerCase()));
  return head.split('\r\n').filter(l => wanted.has(l.split(':')[0].toLowerCase())).join('\r\n') + '\r\n\r\n';
}

function parseStrings(args) {
  const out = [];
  for (const m of args.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]);
  return out;
}

export function startImap({ user, pass, mailbox, stats }) {
  const server = createTcp(socket => {
    let buf = Buffer.alloc(0);
    let waiting = false;
    const write = s => socket.write(s);
    const ok = (tag, text = 'done') => write(`${tag} OK ${text}\r\n`);
    write('* OK [CAPABILITY IMAP4rev1 LITERAL+] fixture ready\r\n');
    socket.on('error', () => {});
    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const end = buf.indexOf('\r\n');
        if (end < 0) return;
        const line = buf.subarray(0, end).toString('utf8');
        const lit = /\{(\d+)(\+?)\}$/.exec(line);
        if (lit) {
          const n = Number(lit[1]);
          if (buf.length < end + 2 + n) {
            if (!lit[2] && !waiting) { write('+ go\r\n'); waiting = true; }
            return;
          }
          waiting = false;
          const data = buf.subarray(end + 2, end + 2 + n).toString('utf8');
          buf = Buffer.concat([Buffer.from(line.replace(/\{\d+\+?\}$/, JSON.stringify(data))), buf.subarray(end + 2 + n)]);
          continue;
        }
        buf = buf.subarray(end + 2);
        handle(line);
      }
    });

    function handle(line) {
      const m = /^(\S+) (\S+)(?: (.*))?$/.exec(line);
      if (!m) return;
      const tag = m[1];
      let cmd = m[2].toUpperCase();
      let args = m[3] || '';
      let uid = false;
      if (cmd === 'UID') {
        uid = true;
        const n = /^(\S+)(?: (.*))?$/.exec(args);
        cmd = n[1].toUpperCase();
        args = n[2] || '';
      }
      const msgs = mailbox.messages;
      switch (cmd) {
        case 'CAPABILITY': write('* CAPABILITY IMAP4rev1 LITERAL+\r\n'); ok(tag); break;
        case 'LOGIN': {
          const [u, p] = parseStrings(args);
          if (u === user && p === pass) { stats.logins++; ok(tag, 'logged in'); }
          else { stats.failedLogins++; write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`); }
          break;
        }
        case 'LIST': case 'LSUB': write('* LIST (\\HasNoChildren) "/" "INBOX"\r\n'); ok(tag); break;
        case 'NAMESPACE': write('* NAMESPACE (("" "/")) NIL NIL\r\n'); ok(tag); break;
        case 'SELECT': case 'EXAMINE':
          write(`* FLAGS (\\Seen)\r\n* ${msgs.length} EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 1] ok\r\n* OK [UIDNEXT ${mailbox.nextUid}] ok\r\n`);
          ok(tag, cmd === 'EXAMINE' ? '[READ-ONLY] done' : '[READ-WRITE] done');
          break;
        case 'NOOP': write(`* ${msgs.length} EXISTS\r\n`); ok(tag); break;
        case 'SEARCH': write(`* SEARCH ${msgs.map((x, i) => (uid ? x.uid : i + 1)).join(' ')}\r\n`); ok(tag); break;
        case 'FETCH': {
          const [, set, items] = /^(\S+) \((.*)\)$/.exec(args) || [, args.split(' ')[0], args];
          const max = uid ? mailbox.nextUid - 1 : msgs.length;
          msgs.forEach((x, i) => {
            if (!inSet(set, uid ? x.uid : i + 1, max)) return;
            const parts = [`UID ${x.uid}`];
            if (/INTERNALDATE/i.test(items)) parts.push(`INTERNALDATE "${imapDate(x.at)}"`);
            if (/FLAGS/i.test(items)) parts.push('FLAGS ()');
            let literal = '';
            const fields = /BODY(?:\.PEEK)?\[HEADER\.FIELDS \(([^)]*)\)\]/i.exec(items);
            if (fields) {
              literal = headerFields(x.raw, fields[1].split(/\s+/));
              parts.push(`BODY[HEADER.FIELDS (${fields[1]})] {${Buffer.byteLength(literal)}}\r\n${literal}`);
            } else if (/BODY(?:\.PEEK)?\[\]/i.test(items)) {
              stats.bodiesRead++;
              parts.push(`BODY[] {${Buffer.byteLength(x.raw)}}\r\n${x.raw}`);
            }
            write(`* ${i + 1} FETCH (${parts.join(' ')})\r\n`);
          });
          ok(tag);
          break;
        }
        case 'ID': write('* ID NIL\r\n'); ok(tag); break;
        case 'LOGOUT': write('* BYE bye\r\n'); ok(tag); socket.end(); break;
        default: ok(tag);
      }
    }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

// ---------- websites

const page = (title, body, extra = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font:15px system-ui;margin:40px auto;max-width:420px}label{display:block;margin:10px 0 4px}input:not([type=checkbox]){width:100%;padding:8px}
button{margin-top:14px;padding:8px 14px}.error{color:#b00;margin:10px 0}.digits input{width:36px;text-align:center;display:inline-block}</style>${extra}</head>
<body>${body}</body></html>`;

function readBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => {
      if ((req.headers['content-type'] || '').includes('json')) { try { resolve(JSON.parse(data)); } catch { resolve({}); } }
      else resolve(Object.fromEntries(new URLSearchParams(data)));
    });
  });
}

const cookies = req => Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean).map(c => c.split('=').map(decodeURIComponent)));

// With `live`, the real credentials are unknown here: the seeded sites accept the
// first email and password they are sent and require the same ones afterwards.
export async function startSites({ main, mailbox, live = false, port = 0 }) {
  const state = {
    port: 0,
    accounts: new Map(),      // `${site}|${email}` -> { password, verified, code, token }
    sessions: new Map(),      // sid -> { site, email }
    posts: [],                // { site, path } for every credential POST
    secrets: new Set(),       // codes, tokens and passwords the sites saw
    passwords: new Map(),     // site -> password used at sign-up
  };
  const key = (site, email) => `${site}|${email}`;
  // Everything a site receives counts as private for the leak checks.
  const body = async req => {
    const b = await readBody(req);
    for (const v of [b.email, b.email?.split('@')[0], b.password, b.confirm]) if (v && v.length >= 4) state.secrets.add(v);
    return b;
  };
  const seeded = new Set(['steps.localhost', 'phone.localhost', 'auth.frame.localhost']);
  if (!live) {
    for (const site of seeded) state.accounts.set(key(site, main.email), { password: main.password, verified: true });
    state.accounts.set(key('wrong.localhost', main.email), { password: 'Different-Pass-999', verified: true });
  }
  const account = (site, email, password) => {
    let acct = state.accounts.get(key(site, email));
    if (!acct && live && seeded.has(site) && email && password) {
      acct = { password, verified: true };
      state.accounts.set(key(site, email), acct);
    }
    return acct;
  };

  const origin = host => `http://${host}:${state.port}`;
  const send = (res, html, status = 200, headers = {}) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers }); res.end(html); };
  const json = (res, obj, headers = {}) => { res.writeHead(200, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
  const redirect = (res, to, headers = {}) => { res.writeHead(303, { Location: to, ...headers }); res.end(); };
  const startSession = (site, email) => { const sid = token(); state.sessions.set(sid, { site, email }); return `sid=${sid}; HttpOnly; Path=/`; };
  const session = req => state.sessions.get(cookies(req).sid);

  const loginForm = (title, error = '', extra = '') => page(title, `<h1>${esc(title)}</h1>${error ? `<div class="error" role="alert">${esc(error)}</div>` : ''}
    <form method="post" action="/login">
      <label for="e">Email</label><input id="e" name="email" type="email" autocomplete="username">
      <label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password">
      ${extra}
      <button type="submit">Sign in</button>
    </form>
    <button type="button">Sign in with Google</button> <a href="/forgot">Forgot password?</a>`);

  const classicLogin = async (site, req, res, after = (email, r) => redirect(r, '/dashboard', { 'Set-Cookie': startSession(site, email) })) => {
    const b = await body(req);
    state.posts.push({ site, path: '/login', sentJobsPassword: !!b.password && b.password === state.passwords.get('jobs.localhost') });
    state.secrets.add(b.password || '');
    const acct = account(site, b.email, b.password);
    if (!acct || acct.password !== b.password) return send(res, loginForm(site, 'Incorrect email or password.'), 401);
    return after(b.email, res);
  };

  const sites = {
    'jobs.localhost': async (req, res, url) => {
      const site = 'jobs.localhost';
      const signupForm = (error = '') => page('Join Jobs Board', `<h1>Create your account</h1>${error ? `<div class="error" role="alert">${esc(error)}</div>` : ''}
        <form method="post" action="/signup">
          <label for="n">Full name</label><input id="n" name="name" required>
          <label for="e">Email</label><input id="e" name="email" type="email" required>
          <label for="p">Password</label><input id="p" name="password" type="password" autocomplete="new-password" minlength="8" required>
          <label for="c">Confirm password</label><input id="c" name="confirm" type="password" autocomplete="new-password" required>
          <label><input type="checkbox" name="terms" required> I agree to the terms</label>
          <button type="submit">Create account</button>
        </form><p>Already have an account? <a href="/login">Sign in</a></p>`);
      if (url.pathname === '/signup' && req.method === 'GET') return send(res, signupForm());
      if (url.pathname === '/signup' && req.method === 'POST') {
        const b = await body(req);
        state.posts.push({ site, path: '/signup' });
        if (!b.name || !b.terms || b.password !== b.confirm) return send(res, signupForm('Please complete every field.'), 400);
        if (state.accounts.has(key(site, b.email))) return send(res, signupForm('An account with this email already exists.'), 409);
        const code = code6();
        state.accounts.set(key(site, b.email), { password: b.password, verified: false, code });
        state.passwords.set(site, b.password);
        state.secrets.add(b.password).add(code);
        mailbox.add({ from: 'Jobs Board <no-reply@jobs.localhost>', to: b.email, subject: 'Verify your email', text: `Hi ${b.name},\n\nYour verification code is ${code}.\n\nIt expires in 10 minutes.` });
        // A newer message from another site must not be picked.
        setTimeout(() => mailbox.add({ from: 'Other <hello@other.localhost>', to: b.email, subject: 'Your code', text: 'Your code is 222222' }), 50);
        return redirect(res, '/verify', { 'Set-Cookie': `pending=${encodeURIComponent(b.email)}; HttpOnly; Path=/` });
      }
      if (url.pathname === '/verify') {
        const email = cookies(req).pending;
        const acct = state.accounts.get(key(site, email));
        const form = (error = '') => page('Verify', `<h1>Check your email</h1><p>We sent a 6-digit code to your email.</p>${error ? `<div class="error" role="alert">${esc(error)}</div>` : ''}
          <form method="post" action="/verify"><label for="c">Verification code</label><input id="c" name="code" autocomplete="one-time-code" inputmode="numeric"><button type="submit">Verify</button></form>`);
        if (req.method === 'GET') return send(res, form());
        const b = await body(req);
        if (!acct || b.code !== acct.code) return send(res, form('That code is incorrect.'), 400);
        acct.verified = true;
        return redirect(res, '/dashboard', { 'Set-Cookie': startSession(site, email) });
      }
      if (url.pathname === '/login') return req.method === 'GET' ? send(res, loginForm('Sign in to Jobs Board')) : classicLogin(site, req, res);
      if (url.pathname === '/dashboard') {
        const s = session(req);
        if (!s) return redirect(res, '/login');
        return send(res, page('Dashboard', `<h1>Dashboard</h1><p>You are signed in.</p><a href="/logout">Log out</a>
          <form><label for="nl">Newsletter</label><input id="nl" type="email" placeholder="Email"><button type="button">Subscribe</button></form>`));
      }
      if (url.pathname === '/logout') return redirect(res, '/login', { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' });
      if (url.pathname === '/apply') {
        return send(res, page('Apply', `<h1>Apply</h1><form><label for="an">Name</label><input id="an" name="name">
          <label for="ae">Email address</label><input id="ae" name="email" type="email"><label for="ap">Phone</label><input id="ap" name="phone" type="tel">
          <button type="button">Submit application</button></form>`));
      }
    },

    'shop.localhost': async (req, res, url) => {
      const site = 'shop.localhost';
      if (url.pathname === '/register' && req.method === 'GET') {
        return send(res, page('Shop', `<h1>Create a Shop account</h1><form method="post" action="/register/email">
          <label for="e">Email address</label><input id="e" name="email" type="email" required><button type="submit">Continue</button></form>`));
      }
      if (url.pathname === '/register/email') {
        const b = await body(req);
        return redirect(res, '/register/password', { 'Set-Cookie': `reg=${encodeURIComponent(b.email)}; HttpOnly; Path=/` });
      }
      if (url.pathname === '/register/password' && req.method === 'GET') {
        return send(res, page('Shop', `<h1>Choose a password</h1><form method="post" action="/register/password">
          <label for="p">Password (8-16 characters, letters and numbers)</label>
          <input id="p" name="password" type="password" autocomplete="new-password" maxlength="16" pattern="(?=.*\\d)(?=.*[A-Za-z]).{8,16}" required>
          <button type="submit">Create account</button></form>`));
      }
      if (url.pathname === '/register/password') {
        const b = await body(req);
        const email = cookies(req).reg;
        state.posts.push({ site, path: '/register/password' });
        const t = token();
        state.accounts.set(key(site, email), { password: b.password, verified: false, token: t });
        state.passwords.set(site, b.password);
        state.secrets.add(b.password).add(t);
        mailbox.add({
          from: 'Shop <accounts@shop.localhost>', to: email, subject: 'Confirm your Shop account', text: 'Confirm your account in the HTML version of this email.',
          html: `<p>Thanks for signing up.</p><p><a href="${origin('shop.localhost')}/confirm?token=${t}">Confirm my account</a></p>
            <p><a href="${origin('shop.localhost')}/unsubscribe?u=1">Unsubscribe</a> &middot; <a href="${origin('shop.localhost')}/privacy">Privacy</a></p>`,
        });
        return redirect(res, '/check-email');
      }
      if (url.pathname === '/check-email') {
        return send(res, page('Shop', '<h1>Check your inbox</h1><p>We sent you a link to confirm your account.</p><a href="/resend">Resend</a>'));
      }
      if (url.pathname === '/confirm') {
        for (const [k, acct] of state.accounts) {
          if (k.startsWith(`${site}|`) && acct.token && acct.token === url.searchParams.get('token')) {
            acct.verified = true;
            state.confirmVisits = (state.confirmVisits || 0) + 1;
            return send(res, page('Shop', `<h1>Confirmed</h1><p>Your email is confirmed.</p>`));
          }
        }
        return send(res, page('Shop', '<h1>Link expired</h1>'), 400);
      }
    },

    'steps.localhost': async (req, res, url) => {
      const site = 'steps.localhost';
      if (url.pathname === '/login') {
        return send(res, page('Steps', `<h1>Sign in to Steps</h1><div id="app"></div><script>
          const state = {};
          const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
          // Mimics a React controlled input: state only changes through a real input event.
          function control(input, name) {
            let tracked = input.value;
            Object.defineProperty(input, 'value', { configurable: true,
              get() { return nativeValue.get.call(this); },
              set(v) { tracked = String(v); nativeValue.set.call(this, v); } });
            input.addEventListener('input', () => { const v = nativeValue.get.call(input); if (v !== tracked) { tracked = v; state[name] = v; } });
          }
          const post = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
          const app = document.getElementById('app');
          function step1() {
            app.innerHTML = '<label for="e">Email</label><input id="e" type="email" autocomplete="username"><div role="button" tabindex="0" id="next" style="margin-top:12px;padding:8px;background:#222;color:#fff;width:90px">Continue</div><div id="err" role="alert"></div>';
            control(document.getElementById('e'), 'email');
            document.getElementById('next').onclick = async () => {
              const r = await post('/api/identify', { email: state.email });
              if (r.exists) step2(); else document.getElementById('err').textContent = "We couldn't find an account with that email.";
            };
          }
          function step2() {
            app.innerHTML = '<label for="p">Password</label><input id="p" type="password" autocomplete="current-password"><button id="go" type="button">Sign in</button><div id="err" role="alert"></div>';
            control(document.getElementById('p'), 'password');
            document.getElementById('go').onclick = async () => {
              const r = await post('/api/login', { email: state.email, password: state.password });
              if (r.otp) step3(); else if (r.ok) location.href = '/home'; else document.getElementById('err').textContent = 'Wrong password. Try again.';
            };
          }
          function step3() {
            app.innerHTML = '<p>Enter the 6-digit code we emailed you.</p><div class="digits">' + [0,1,2,3,4,5].map(i => '<input maxlength="1" inputmode="numeric" aria-label="Digit ' + (i + 1) + '">').join('') + '</div><button id="v" type="button">Verify</button><div id="err" role="alert"></div>';
            const boxes = [...app.querySelectorAll('.digits input')];
            boxes.forEach((b, i) => control(b, 'd' + i));
            document.getElementById('v').onclick = async () => {
              const code = boxes.map((b, i) => state['d' + i] || '').join('');
              const r = await post('/api/otp', { code });
              if (r.ok) location.href = '/home'; else document.getElementById('err').textContent = 'That code did not work.';
            };
          }
          step1();
        </script>`));
      }
      if (url.pathname === '/api/identify') {
        const b = await body(req);
        return json(res, { exists: state.accounts.has(key(site, b.email)) || (live && seeded.has(site)) });
      }
      if (url.pathname === '/api/login') {
        const b = await body(req);
        state.posts.push({ site, path: '/api/login' });
        state.secrets.add(b.password || '');
        await new Promise(r => setTimeout(r, 400));
        const acct = account(site, b.email, b.password);
        if (!acct || acct.password !== b.password) return json(res, { otp: false });
        if (live) return json(res, { ok: true }, { 'Set-Cookie': startSession(site, b.email) });
        acct.otp = code6();
        state.secrets.add(acct.otp);
        state.stepsEmail = b.email;
        mailbox.add({ from: 'Steps Security <security@mail.steps.localhost>', to: b.email, subject: 'Your sign-in code', text: `Your sign-in code is:\n\n   ${acct.otp.slice(0, 3)} ${acct.otp.slice(3)}\n\nIf this wasn't you, ignore this email.` });
        return json(res, { otp: true });
      }
      if (url.pathname === '/api/otp') {
        const b = await body(req);
        const acct = state.accounts.get(key(site, state.stepsEmail));
        if (!acct || b.code !== acct.otp) return json(res, { ok: false });
        return json(res, { ok: true }, { 'Set-Cookie': startSession(site, state.stepsEmail) });
      }
      if (url.pathname === '/home') {
        const s = session(req);
        return s ? send(res, page('Steps', '<h1>Welcome back</h1><button type="button">Sign out</button>')) : redirect(res, '/login');
      }
    },

    'later.localhost': async (req, res, url) => {
      const site = 'later.localhost';
      if (url.pathname === '/signup' && req.method === 'GET') {
        return send(res, page('Later', `<h1>Sign up for Later</h1><form method="post" action="/signup">
          <label for="e">Email</label><input id="e" name="email" type="email" required>
          <label for="p">Create password</label><input id="p" name="password" type="password" required>
          <label for="c">Repeat password</label><input id="c" name="confirm" type="password" required>
          <button type="submit">Sign up</button></form>`));
      }
      if (url.pathname === '/signup') {
        const b = await body(req);
        state.posts.push({ site, path: '/signup' });
        state.accounts.set(key(site, b.email), { password: b.password, verified: false });
        state.passwords.set(site, b.password);
        state.secrets.add(b.password);
        return redirect(res, '/welcome', { 'Set-Cookie': startSession(site, b.email) });
      }
      if (url.pathname === '/welcome') return send(res, page('Later', '<h1>Welcome to Later</h1><p>Finish setting up your profile.</p><a href="/logout">Log out</a>'));
      if (url.pathname === '/settings/verify') {
        const s = session(req);
        const acct = s && state.accounts.get(key(site, s.email));
        if (!acct) return redirect(res, '/signup');
        if (req.method === 'GET') {
          acct.code = token().slice(0, 6).toUpperCase().replace(/^[A-F]/, '7');
          state.secrets.add(acct.code);
          mailbox.add({ from: 'Later <team@later.localhost>', to: s.email, subject: 'Confirm your email', text: `Enter this code to confirm your email: ${acct.code}` });
          return send(res, page('Later', `<h1>Confirm your email</h1><p>Enter the code we emailed you.</p>
            <form method="post"><label for="o">Code</label><input id="o" name="otp" autocomplete="one-time-code"><button type="submit">Confirm</button></form>`));
        }
        const b = await body(req);
        if (b.otp !== acct.code) return send(res, page('Later', '<div class="error" role="alert">Wrong code</div>'), 400);
        acct.verified = true;
        return redirect(res, '/welcome');
      }
    },

    // Workday-style: the real submit button does nothing; a transparent layer on top handles the click.
    'cibc.workday.localhost': async (req, res, url) => {
      const site = 'cibc.workday.localhost';
      if (url.pathname === '/signup') {
        return send(res, page('Create Account', `<h1>Create Account</h1>
          <form id="f"><label for="e">Email Address*</label><input id="e" type="text" autocomplete="email" aria-required="true">
          <label for="p">Password*</label><input id="p" type="password" autocomplete="new-password" aria-required="true">
          <label for="v">Verify New Password*</label><input id="v" type="password" autocomplete="new-password" aria-required="true">
          <label><input id="agree" type="checkbox"> I agree to the above</label>
          <div style="position:relative;display:inline-block;margin-top:14px">
            <button type="submit" style="margin:0">Create Account</button>
            <div role="button" aria-label="Create Account" data-automation-id="click_filter" style="position:absolute;inset:0"></div>
          </div><div id="err" role="alert"></div></form>
          <button type="submit" form="none">Sign In</button>
          <script>
            document.getElementById('f').addEventListener('submit', e => e.preventDefault());
            document.querySelector('[data-automation-id=click_filter]').addEventListener('click', async () => {
              const v = id => document.getElementById(id).value;
              if (!document.getElementById('agree').checked) return void (document.getElementById('err').textContent = 'You must agree to continue.');
              if (v('p') !== v('v')) return void (document.getElementById('err').textContent = 'Passwords do not match.');
              const r = await fetch('/api/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: v('e'), password: v('p') }) }).then(r => r.json());
              if (r.ok) location.href = '/verify-notice'; else document.getElementById('err').textContent = r.error;
            });
          </script>`));
      }
      if (url.pathname === '/api/signup') {
        const b = await body(req);
        state.posts.push({ site, path: '/api/signup' });
        if (state.accounts.has(key(site, b.email))) return json(res, { ok: false, error: 'An account with this email already exists.' });
        const t = token();
        state.accounts.set(key(site, b.email), { password: b.password, verified: false, token: t });
        state.passwords.set(site, b.password);
        state.secrets.add(t);
        mailbox.add({
          from: 'CIBC <cibc@myworkday.localhost>', to: b.email, subject: 'Verify your candidate account',
          html: `<p>Please verify your account.</p><p><a href="${origin(site)}/verify?token=${t}">Verify Account</a></p>`, text: 'Verify your account in the HTML version.',
        });
        return json(res, { ok: true });
      }
      if (url.pathname === '/verify-notice') {
        return send(res, page('Verify', '<h1>Verify your account</h1><p>An email has been sent to verify your account. Check your email to continue.</p>'));
      }
      if (url.pathname === '/verify') {
        for (const [k, acct] of state.accounts) {
          if (k.startsWith(`${site}|`) && acct.token === url.searchParams.get('token')) { acct.verified = true; return send(res, page('Verified', '<h1>Account verified</h1>')); }
        }
        return send(res, page('Verify', '<h1>Link expired</h1>'), 400);
      }
    },

    'wrong.localhost': async (req, res, url) => {
      if (url.pathname === '/login') return req.method === 'GET' ? send(res, loginForm('Sign in to Wrong')) : classicLogin('wrong.localhost', req, res);
    },

    'captcha.localhost': async (req, res, url) => {
      if (url.pathname === '/login') {
        return send(res, loginForm('Sign in to Captcha', '', `<div class="g-recaptcha"><iframe src="/recaptcha/anchor" title="reCAPTCHA" width="304" height="78"></iframe>
          <textarea name="g-recaptcha-response" style="display:none"></textarea></div>`));
      }
      if (url.pathname === '/recaptcha/anchor') return send(res, '<div>I am not a robot</div>');
    },

    'phone.localhost': async (req, res, url) => {
      const site = 'phone.localhost';
      if (url.pathname === '/login') {
        return req.method === 'GET' ? send(res, loginForm('Sign in to Phone')) : classicLogin(site, req, res, (email, r) => redirect(r, '/2fa'));
      }
      if (url.pathname === '/2fa') {
        return send(res, page('Phone', `<h1>Two-step verification</h1><p>Enter the code we texted to your phone ending in 42.</p>
          <form method="post"><label for="c">Code</label><input id="c" name="code" autocomplete="one-time-code"><button type="submit">Verify</button></form>`));
      }
    },

    'frame.localhost': async (req, res, url) => {
      if (url.pathname === '/') {
        return send(res, page('Careers', `<h1>Careers portal</h1><iframe src="${origin('auth.frame.localhost')}/login" width="420" height="420" style="border:1px solid #ccc"></iframe>`));
      }
    },

    'auth.frame.localhost': async (req, res, url) => {
      const site = 'auth.frame.localhost';
      if (url.pathname === '/login') {
        return req.method === 'GET'
          ? send(res, loginForm('Sign in'))
          : classicLogin(site, req, res, (email, r) => send(r, page('Signed in', '<p>You are signed in.</p><a href="/logout">Sign out</a>'), 200, { 'Set-Cookie': startSession(site, email) }));
      }
    },

    'jobs.evil.localhost': async (req, res, url) => {
      if (url.pathname === '/login') return req.method === 'GET' ? send(res, loginForm('Sign in to Jobs Board')) : classicLogin('jobs.evil.localhost', req, res);
    },

    'plain.example': async (req, res, url) => {
      if (url.pathname === '/login') return req.method === 'GET' ? send(res, loginForm('Plain')) : classicLogin('plain.example', req, res);
    },
  };

  const server = createHttp(async (req, res) => {
    const host = (req.headers.host || '').split(':')[0];
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      const handled = await sites[host]?.(req, res, url);
      if (!res.writableEnded && handled === undefined) send(res, page('Not found', '<h1>Not found</h1>'), 404);
    } catch (err) {
      if (!res.writableEnded) send(res, `fixture error: ${esc(err.message)}`, 500);
    }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  state.port = server.address().port;
  state.server = server;
  state.origin = origin;
  return state;
}
