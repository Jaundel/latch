const view = document.getElementById('view');
const conn = document.getElementById('conn');

const call = (type, data = {}) => chrome.runtime.sendMessage({ type, ...data });

let state = null;
let screen = null;     // 'identity' | 'inbox' | 'connect' | 'home' | 'activity' | 'settings'
let onboarding = false;
let revealed = {};     // host -> password, popup memory only
let page = null;       // what the active tab offers: { kind, host, saved }
let tabRun = null;     // { busy } or the result of running Latch on the active tab
let allSites = false;

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}

const CLIENT_NAMES = { 'claude-code': 'Claude Code', 'claude-ai': 'Claude', 'codex-mcp-client': 'Codex', codex: 'Codex', you: 'You' };
const clientName = c => CLIENT_NAMES[c] || c || 'Your AI';

function connectedClients() {
  return [...new Set((state?.clients || []).map(clientName))];
}

function renderConnection() {
  const clients = connectedClients();
  const on = state?.connected;
  conn.classList.toggle('on', !!on);
  conn.querySelector('.conn-text').textContent = on
    ? (clients.length ? clients[0] + (clients.length > 1 ? ` +${clients.length - 1}` : '') : 'Connected')
    : 'No AI connected';
  conn.title = on ? `Connected to ${clients.join(', ') || 'your AI'}` : 'Latch connects when your AI starts with the Latch tool added.';
}

function ago(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 172800) return 'yesterday';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function passwordInput(id, attrs) {
  const input = h('input', { id, type: 'password', autocomplete: 'off', spellcheck: 'false', ...attrs });
  const peek = h('button', {
    class: 'peek', type: 'button', 'aria-controls': id,
    onclick: () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      peek.textContent = show ? 'Hide' : 'Show';
    },
  }, 'Show');
  return h('div', { class: 'input' }, input, peek);
}

function favicon(host) {
  const letter = (host || '?').replace(/^www\./, '')[0] || '?';
  const box = h('span', { class: 'fav', 'aria-hidden': 'true' }, letter);
  if (host && !/\.(test|localhost)$|^localhost$|^[\d.]+$/.test(host)) {
    const img = h('img', { alt: '', src: chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent('https://' + host)}&size=32`) });
    img.onload = () => box.replaceChildren(img);
  }
  return box;
}

function backButton(to) {
  return h('button', { class: 'back', type: 'button', onclick: () => show(to) }, '← Back');
}

const steps = n => h('p', { class: 'step' }, `Step ${n} of 3`);

// ---------- what a result means, in a few words

const NEEDS = {
  captcha: 'Needs you: CAPTCHA', phone_code: 'Needs you: phone code', authenticator_code: 'Needs you: authenticator code',
  passkey: 'Needs you: passkey', push_approval: 'Needs you: approve on your phone', locked: 'Account locked', mailbox: 'Needs your inbox',
};

function outcome(a) {
  const good = { signed_in: 'Signed in', account_created: 'Created an account', verified: 'Verified email', filled: 'Filled in your email' };
  if (good[a.status]) return { text: good[a.status], tone: 'good' };
  const waiting = {
    check_inbox: 'Code emailed; your AI is fetching it', verification_pending: 'Waiting for the email', needs_user: NEEDS[a.reason] || 'Needs you',
    unconfirmed: 'Sign-in not confirmed', retry_blocked: 'Holding off before retrying', reload_required: 'Update ready: reload Latch',
  };
  if (waiting[a.status]) return { text: waiting[a.status], tone: 'wait' };
  const neutral = { no_form: 'No sign-in form on the page', account_exists: 'Account already existed', no_account: 'No account there yet', paused: 'Skipped while paused', not_set_up: 'Not set up' };
  if (neutral[a.status]) return { text: neutral[a.status], tone: 'muted' };
  const bad = {
    blocked: a.reason === 'suspicious_site' ? 'Refused a suspicious page' : 'Refused an insecure page',
    wrong_password: 'Password rejected', credentials_or_account_problem: 'Sign-in rejected', sign_in_failed: 'Sign-in failed',
    sign_up_failed: 'Sign-up failed', verification_failed: 'Code not accepted', unavailable: 'Chrome not reachable', error: 'Something went wrong',
  };
  return { text: bad[a.status] || String(a.status || '').replace(/_/g, ' '), tone: 'bad' };
}

// ---------- setup 1: email and password

function identityScreen() {
  const editing = state.setup;
  const email = h('input', { id: 'email', type: 'email', placeholder: 'you@example.com', autocomplete: 'off', value: state.email || '' });
  const pw = passwordInput('password', { placeholder: editing ? 'Leave blank to keep current' : 'Your password' });
  const go = h('button', { class: 'btn primary block', type: 'submit', disabled: true }, editing ? 'Save' : 'Continue');
  const valid = () => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim()) && (editing || pw.querySelector('input').value.length > 0);
  const update = () => { go.disabled = !valid(); };

  const form = h('form', {
    onsubmit: async e => {
      e.preventDefault();
      if (!valid()) return;
      go.disabled = true;
      await call('saveIdentity', { email: email.value.trim(), password: pw.querySelector('input').value });
      await refresh();
      if (editing) show('home');
      else { onboarding = true; show('inbox'); }
    },
    oninput: update,
  },
    editing ? backButton('home') : steps(1),
    h('h1', {}, editing ? 'Your sign-in details' : 'Set up Latch'),
    h('p', { class: 'lede' }, 'Your AI uses these to sign in and create accounts for you. They stay on this computer, and the AI never sees them.'),
    h('label', { class: 'field' }, h('span', {}, 'Email'), email),
    h('label', { class: 'field' }, h('span', {}, 'Password'), pw),
    go,
  );
  view.replaceChildren(form);
  update();
  (state.email ? pw.querySelector('input') : email).focus();
}

// ---------- setup 2: inbox (optional)

async function inboxScreen() {
  const editing = !!state.mailbox;
  const user = state.mailbox?.user || state.email;
  const provider = await call('provider', { email: user });
  const host = h('input', { type: 'text', value: state.mailbox?.host || provider.host || '', spellcheck: 'false' });
  const port = h('input', { type: 'number', value: state.mailbox?.port || provider.port || 993 });
  const username = h('input', { type: 'text', value: user, spellcheck: 'false' });
  const tls = h('input', { type: 'checkbox', checked: state.mailbox ? state.mailbox.secure : true });
  const pass = passwordInput('app-password', { placeholder: provider.host === 'imap.gmail.com' ? 'xxxx xxxx xxxx xxxx' : 'App password' });
  const notice = h('p', { class: 'notice', role: 'status' });
  const go = h('button', { class: 'btn primary', type: 'submit' }, editing ? 'Save' : 'Connect inbox');
  const next = () => show(onboarding ? 'connect' : 'settings');

  const card = h('div', { class: 'provider' },
    h('div', { class: 'row' }, h('strong', {}, provider.name || 'Your mail'), h('span', { class: 'muted' }, provider.host || '')),
    provider.unsupported
      ? h('p', {}, provider.unsupported)
      : h('p', {},
        provider.help ? h('a', { href: provider.help, target: '_blank', rel: 'noreferrer' }, 'Create an app password') : 'Use an app password from your mail provider.',
        provider.note ? ` · ${provider.note}` : ''),
  );

  const form = h('form', {
    onsubmit: async e => {
      e.preventDefault();
      const secret = pass.querySelector('input').value;
      if (!secret) { notice.className = 'notice bad'; notice.textContent = 'Paste the app password first.'; return; }
      go.disabled = true;
      notice.className = 'notice';
      notice.textContent = 'Checking your inbox…';
      const r = await call('saveMailbox', { mailbox: { user: username.value, pass: secret, host: host.value, port: port.value, secure: tls.checked } });
      go.disabled = false;
      if (!r.ok) {
        notice.className = 'notice bad';
        notice.textContent = r.reason === 'auth'
          ? 'That password was not accepted. Check it and try again.'
          : 'Could not reach that mail server. Check the server settings.';
        return;
      }
      await refresh();
      next();
    },
  },
    onboarding ? steps(2) : backButton('settings'),
    h('h1', {}, 'Connect your inbox'),
    h('p', { class: 'lede' }, 'Optional. With it, Latch enters emailed codes itself. Without it, your AI reads them from your webmail in another tab.'),
    card,
    h('label', { class: 'field' }, h('span', {}, 'App password'), pass),
    h('details', { class: 'adv' }, h('summary', {}, 'Server settings'),
      h('div', { class: 'adv-grid' },
        h('label', { class: 'field' }, h('span', {}, 'Server'), host),
        h('label', { class: 'field' }, h('span', {}, 'Port'), port),
        h('label', { class: 'field full' }, h('span', {}, 'Username'), username),
        h('label', { class: 'check full' }, tls, h('span', {}, h('b', {}, 'Use TLS'))))),
    notice,
    h('div', { class: 'actions' }, go, onboarding ? h('button', { class: 'link', type: 'button', onclick: next }, 'Skip') : null),
  );
  view.replaceChildren(form);
  pass.querySelector('input').focus();
  if (!state.connected) notice.textContent = 'Latch will check this the first time your AI needs it.';
}

// ---------- setup 3: connect the AI

async function installInfo() {
  try { return await (await fetch(chrome.runtime.getURL('install.json'))).json(); } catch { return null; }
}

async function connectScreen() {
  const install = await installInfo();
  const q = s => `"${s}"`;
  const commands = install ? [
    ['Claude Code', `claude mcp add --scope user latch -- node ${q(install.server)}`],
    ['Codex', `node ${q(install.setup)} --codex`],
    ['Claude Desktop', `node ${q(install.setup)} --claude-desktop`],
  ] : [];
  const status = h('div', { class: 'live', role: 'status' });
  const paint = () => {
    const on = state.connected;
    status.className = `live${on ? ' on' : ''}`;
    status.replaceChildren(h('span', { class: 'dot' }), on ? `Connected to ${connectedClients().join(', ') || 'your AI'}` : 'Waiting for your AI…');
  };
  paint();
  connectScreen.paint = paint;

  view.replaceChildren(
    onboarding ? steps(3) : backButton('settings'),
    h('h1', {}, 'Connect your AI'),
    h('p', { class: 'lede' }, 'Run one of these in a terminal, then restart that AI. It can then call Latch whenever a page asks it to sign in.'),
    status,
    commands.length
      ? h('ul', { class: 'cmds' }, commands.map(([name, cmd]) => {
        const copy = h('button', {
          class: 'row-action', type: 'button',
          onclick: async () => { await navigator.clipboard.writeText(cmd); copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1500); },
        }, 'Copy');
        return h('li', {}, h('div', { class: 'cmd-head' }, h('b', {}, name), copy), h('code', {}, cmd));
      }))
      : h('p', { class: 'notice' }, 'Run npm run setup in the Latch folder first; this screen then shows the exact commands.'),
    h('button', { class: 'btn primary block', type: 'button', onclick: () => { onboarding = false; show('home'); } }, state.connected ? 'Done' : 'Finish later'),
  );
}

// ---------- home

const PAGE = {
  sign_in: { title: 'Sign-in page', sub: p => (p.saved ? 'Latch has a saved account for this site.' : 'Latch will use your email and password.'), tool: 'sign_in', action: 'Sign in' },
  sign_up: { title: 'Sign-up page', sub: () => 'Latch will create the account with a new strong password.', tool: 'create_account', action: 'Create account' },
  code: { title: 'Asking for a code', sub: () => (state.mailbox ? 'Latch can read it from your inbox.' : 'Connect your inbox and Latch can enter it.'), tool: 'verify_email', action: 'Enter code' },
  check_email: { title: 'Waiting on an email link', sub: () => (state.mailbox ? 'Latch can open it from your inbox.' : 'Your AI can open it from your webmail.'), tool: 'verify_email', action: 'Verify email' },
  captcha: { title: 'CAPTCHA on this page', sub: () => 'Solve it in the page, then let your AI carry on.' },
  signed_in: { title: 'Signed in', sub: () => 'Nothing for Latch to do here.' },
  none: { title: 'Nothing to sign in to', sub: () => 'Latch steps in when a page asks for an account.' },
  blank: { title: 'Open a website', sub: () => 'Latch works on the page in front of you.' },
};

function pageCard() {
  if (!page) return h('section', { class: 'page loading', 'aria-busy': 'true' }, h('div', { class: 'page-title' }, 'Reading this page…'));
  const info = PAGE[page.kind] || PAGE.none;
  const result = tabRun && !tabRun.busy ? outcome(tabRun) : null;
  return h('section', { class: 'page', 'aria-label': 'This page' },
    h('div', { class: 'page-head' },
      page.host ? favicon(page.host) : null,
      h('div', { style: 'min-width:0' },
        page.host ? h('div', { class: 'page-host', title: page.host }, page.host) : null,
        h('div', { class: 'page-title' }, info.title))),
    h('p', { class: 'page-sub' }, info.sub(page)),
    info.tool ? h('button', {
      class: 'btn primary block', type: 'button', disabled: !!tabRun?.busy || state.settings.paused,
      onclick: async () => {
        tabRun = { busy: true };
        render();
        tabRun = await call('runHere', { tool: info.tool });
        page = await call('pageState');
        await refresh();
        render();
      },
    }, tabRun?.busy ? 'Working…' : info.action) : null,
    result ? h('p', { class: `notice ${result.tone === 'good' ? 'good' : result.tone === 'bad' ? 'bad' : ''}`, role: 'status' },
      tabRun.message || result.text) : null);
}

function activityRow(a) {
  const o = outcome(a);
  return h('li', { class: 'row act' },
    h('span', { class: `tone ${o.tone}`, 'aria-hidden': 'true' }),
    h('div', { style: 'min-width:0' },
      h('div', { class: 'name' }, o.text),
      h('div', { class: 'sub' }, [a.site, clientName(a.client), ago(a.at)].filter(Boolean).join(' · '))));
}

function siteRow(site) {
  const status = site.status === 'pending' ? 'Sign-up in progress' : site.source === 'latch' ? 'Created by Latch' : 'Signed in';
  const row = h('li', { class: 'row' },
    favicon(site.host),
    h('div', { style: 'min-width:0' }, h('div', { class: 'name' }, site.host), h('div', { class: 'sub' }, [status, ago(site.lastUsed || site.createdAt)].filter(Boolean).join(' · '))),
    site.hasPassword
      ? h('button', {
        class: 'row-action', type: 'button', 'aria-label': `${revealed[site.host] ? 'Hide' : 'Show'} password for ${site.host}`,
        onclick: async () => {
          if (revealed[site.host]) delete revealed[site.host];
          else revealed[site.host] = (await call('reveal', { host: site.host })).password;
          render();
        },
      }, revealed[site.host] ? 'Hide' : 'Show')
      : h('span'),
  );
  if (revealed[site.host]) {
    const copy = h('button', {
      class: 'row-action', type: 'button',
      onclick: async () => { await navigator.clipboard.writeText(revealed[site.host]); copy.textContent = 'Copied'; },
    }, 'Copy');
    row.append(h('div', { class: 'secret' }, h('span', {}, revealed[site.host]), copy));
  }
  return row;
}

function homeScreen() {
  const s = state;
  if (!page && !homeScreen.reading) {
    homeScreen.reading = true;
    call('pageState').catch(() => ({ kind: 'none', host: '' })).then(p => {
      page = p;
      homeScreen.reading = false;
      if (screen === 'home') render();
    });
  }
  const parts = [pageCard()];

  parts.push(h('div', { class: 'identity' },
    h('div', { class: 'avatar', 'aria-hidden': 'true' }, s.email[0] || '?'),
    h('div', { style: 'min-width:0' },
      h('div', { class: 'email', title: s.email }, s.email),
      h('div', { class: 'meta' }, 'Password saved · ', s.mailbox
        ? 'Inbox connected'
        : h('button', { class: 'link inline', type: 'button', onclick: () => { onboarding = false; show('inbox'); } }, 'Connect inbox'))),
    h('button', { class: 'link', type: 'button', onclick: () => show('identity') }, 'Edit')));

  if (!s.connected) {
    parts.push(h('div', { class: 'banner' }, 'No AI is connected. ',
      h('button', { class: 'link inline', type: 'button', onclick: () => { onboarding = false; show('connect'); } }, 'Connect one')));
  }

  if (s.activity.length) {
    parts.push(h('div', { class: 'section-head' }, h('h2', {}, 'Recent'),
      h('button', { class: 'link small', type: 'button', onclick: () => show('activity') }, 'All activity')));
    parts.push(h('ul', { class: 'list' }, s.activity.slice(0, 3).map(activityRow)));
  }

  parts.push(h('div', { class: 'section-head' }, h('h2', {}, 'Accounts'), s.sites.length ? h('span', {}, String(s.sites.length)) : null));
  if (s.sites.length) {
    const shown = allSites ? s.sites : s.sites.slice(0, 4);
    parts.push(h('ul', { class: 'list' }, shown.map(siteRow)));
    if (s.sites.length > 4) {
      parts.push(h('button', { class: 'link small more', type: 'button', onclick: () => { allSites = !allSites; render(); } },
        allSites ? 'Show fewer' : `Show all ${s.sites.length}`));
    }
  } else {
    parts.push(h('p', { class: 'empty' }, 'Accounts show up here after your AI signs in or creates one.'));
  }

  const toggle = h('input', {
    type: 'checkbox', checked: !s.settings.paused,
    onchange: async e => { await call('settings', { patch: { paused: !e.target.checked } }); await refreshAndRender(); },
  });
  parts.push(h('div', { class: 'foot' },
    h('label', { class: 'switch' }, toggle, h('span', { class: 'track' }), s.settings.paused ? 'Paused' : 'On'),
    h('button', { class: 'link', type: 'button', onclick: () => show('settings') }, 'Settings')));

  view.replaceChildren(...parts);
}

// ---------- activity

function activityScreen() {
  const days = new Map();
  for (const a of state.activity) {
    const day = new Date(a.at).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(a);
  }
  view.replaceChildren(
    backButton('home'),
    h('h1', {}, 'Activity'),
    state.activity.length
      ? [...days].map(([day, items]) => h('div', {}, h('div', { class: 'section-head' }, h('h2', {}, day)), h('ul', { class: 'list' }, items.map(activityRow))))
      : h('p', { class: 'empty' }, 'Nothing yet. Every sign-in and sign-up your AI runs through Latch is listed here.'),
  );
}

// ---------- settings

function settingsScreen() {
  const s = state;
  const mode = value => h('button', {
    type: 'button', 'aria-pressed': String(s.settings.newPasswords === value),
    onclick: async () => { await call('settings', { patch: { newPasswords: value } }); await refreshAndRender(); },
  }, value === 'unique' ? 'Unique' : 'Same as mine');

  const erase = h('div', {});
  erase.append(h('button', {
    class: 'link danger', type: 'button',
    onclick: () => erase.replaceChildren(h('div', { class: 'confirm' },
      h('p', {}, 'This removes your email, password, inbox connection and every saved account password from Latch.'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn small', type: 'button', onclick: () => render() }, 'Cancel'),
        h('button', { class: 'btn primary small', type: 'button', onclick: async () => { await call('erase'); revealed = {}; await refresh(); show('identity'); } }, 'Erase everything')))),
  }, 'Erase everything'));

  const clients = connectedClients();
  view.replaceChildren(
    backButton('home'),
    h('h1', {}, 'Settings'),
    h('div', { class: 'block-setting' },
      h('b', {}, 'New account passwords'),
      h('div', { class: 'segmented', role: 'group', 'aria-label': 'New account passwords' }, mode('unique'), mode('mine')),
      h('small', {}, s.settings.newPasswords === 'unique'
        ? 'Each new account gets its own strong password. You can view them under Accounts.'
        : 'New accounts use the password you saved in Latch.')),
    h('div', { class: 'setting' },
      h('div', { style: 'min-width:0' }, h('b', {}, 'AI connections'),
        h('small', {}, s.connected ? clients.join(', ') || 'Connected' : 'None connected')),
      h('button', { class: 'link', type: 'button', onclick: () => { onboarding = false; show('connect'); } }, 'Connect')),
    h('div', { class: 'setting' },
      h('div', { style: 'min-width:0' }, h('b', {}, 'Inbox'),
        h('small', {}, s.mailbox ? `${s.mailbox.user} · ${s.mailbox.host}` : 'Not connected')),
      h('div', { class: 'actions', style: 'margin:0' },
        h('button', { class: 'link', type: 'button', onclick: () => { onboarding = false; show('inbox'); } }, s.mailbox ? 'Change' : 'Connect'),
        s.mailbox ? h('button', { class: 'link', type: 'button', onclick: () => call('removeMailbox').then(refreshAndRender) }, 'Disconnect') : null)),
    h('div', { class: 'setting' }, erase),
  );
}

// ---------- plumbing

async function refresh() {
  state = await call('state');
  renderConnection();
}

function render() {
  if (screen === 'identity') return identityScreen();
  if (screen === 'inbox') return inboxScreen();
  if (screen === 'connect') return connectScreen();
  if (screen === 'activity') return activityScreen();
  if (screen === 'settings') return settingsScreen();
  return homeScreen();
}

async function refreshAndRender() {
  const before = JSON.stringify(state);
  await refresh();
  if (JSON.stringify(state) === before) return;
  if (screen === 'connect') connectScreen.paint?.();
  else if (['home', 'activity', 'settings'].includes(screen)) render();
}

function show(next) {
  screen = next;
  render();
}

chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type === 'changed') refreshAndRender();
});

await call('connect');
await refresh();
show(state.setup ? 'home' : 'identity');
setInterval(refreshAndRender, 4000);
