const view = document.getElementById('view');
const conn = document.getElementById('conn');

const call = (type, data = {}) => chrome.runtime.sendMessage({ type, ...data });

let state = null;
let screen = null;   // 'identity' | 'inbox' | 'home' | 'settings'
let revealed = {};   // host -> password, popup memory only

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

const CLIENT_NAMES = { 'claude-code': 'Claude Code', 'claude-ai': 'Claude', 'codex-mcp-client': 'Codex', 'codex': 'Codex' };

function renderConnection() {
  const clients = [...new Set((state?.clients || []).map(c => CLIENT_NAMES[c] || c))];
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

// ---------- setup: identity

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
      show(editing ? 'home' : 'inbox');
    },
    oninput: update,
  },
    editing ? backButton('home') : h('p', { class: 'step' }, 'Step 1 of 2'),
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

// ---------- setup: inbox

async function inboxScreen() {
  const editing = !!state.mailbox;
  const user = state.mailbox?.user || state.email;
  const provider = await call('provider', { email: user });
  const host = h('input', { type: 'text', value: state.mailbox?.host || provider.host || '', spellcheck: 'false' });
  const port = h('input', { type: 'number', value: state.mailbox?.port || provider.port || 993 });
  const username = h('input', { type: 'text', value: user, spellcheck: 'false' });
  const tls = h('input', { type: 'checkbox', checked: state.mailbox ? state.mailbox.secure : true });
  const pass = passwordInput('app-password', { placeholder: provider.name === 'Gmail' || provider.host === 'imap.gmail.com' ? 'xxxx xxxx xxxx xxxx' : 'App password' });
  const notice = h('p', { class: 'notice', role: 'status' });
  const go = h('button', { class: 'btn primary', type: 'submit' }, editing ? 'Save' : 'Connect inbox');

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
      show('home');
    },
  },
    editing ? backButton('settings') : h('p', { class: 'step' }, 'Step 2 of 2'),
    h('h1', {}, 'Connect your inbox'),
    h('p', { class: 'lede' }, 'Optional. With it, Latch enters emailed verification codes for you, opening only recent messages from the site being signed in to. Without it, your AI reads the code from your inbox in another tab.'),
    card,
    h('label', { class: 'field' }, h('span', {}, 'App password'), pass),
    h('details', { class: 'adv' }, h('summary', {}, 'Server settings'),
      h('div', { class: 'adv-grid' },
        h('label', { class: 'field' }, h('span', {}, 'Server'), host),
        h('label', { class: 'field' }, h('span', {}, 'Port'), port),
        h('label', { class: 'field full' }, h('span', {}, 'Username'), username),
        h('label', { class: 'check full' }, tls, h('span', {}, h('b', {}, 'Use TLS'))))),
    notice,
    h('div', { class: 'actions' }, go, editing ? null : h('button', { class: 'link', type: 'button', onclick: () => show('home') }, 'Skip for now')),
  );
  view.replaceChildren(form);
  pass.querySelector('input').focus();
  if (!state.connected) {
    notice.textContent = 'Your AI isn’t connected, so Latch will check this the first time it’s needed.';
  }
}

// ---------- home

function favicon(host) {
  const letter = host.replace(/^www\./, '')[0] || '?';
  const box = h('span', { class: 'fav' }, letter);
  if (!/\.(test|localhost)$|^localhost$|^[\d.]+$/.test(host)) {
    const img = h('img', { alt: '', src: chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent('https://' + host)}&size=32`) });
    img.onload = () => box.replaceChildren(img);
  }
  return box;
}

function siteRow(site) {
  const status = site.status === 'pending' ? 'Sign-up in progress' : site.source === 'latch' ? 'Created by Latch' : 'Signed in';
  const when = ago(site.lastUsed || site.createdAt);
  const row = h('li', { class: 'row' },
    favicon(site.host),
    h('div', {}, h('div', { class: 'name' }, site.host), h('div', { class: 'sub' }, [status, when].filter(Boolean).join(' · '))),
    site.hasPassword
      ? h('button', {
        class: 'row-action', type: 'button',
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
  const inbox = s.mailbox ? 'Inbox connected' : h('span', { class: 'warn' }, 'Inbox not connected');
  const parts = [
    h('div', { class: 'identity' },
      h('div', { class: 'avatar' }, s.email[0] || '?'),
      h('div', { style: 'min-width:0' },
        h('div', { class: 'email', title: s.email }, s.email),
        h('div', { class: 'meta' }, 'Password saved · ', inbox)),
      h('button', { class: 'link', type: 'button', onclick: () => show('identity') }, 'Edit')),
  ];

  if (!s.mailbox) {
    parts.push(h('div', { class: 'banner' },
      'Optional: connect your inbox and Latch will enter emailed codes for you. ',
      h('button', { class: 'link', type: 'button', onclick: () => show('inbox') }, 'Connect')));
  }
  if (!s.connected) {
    parts.push(h('div', { class: 'banner' }, 'Waiting for your AI. Latch connects when Claude or Codex starts with the Latch tool added.'));
  }

  parts.push(h('div', { class: 'section-head' }, h('h2', {}, 'Sites'), s.sites.length ? h('span', {}, String(s.sites.length)) : null));
  parts.push(s.sites.length
    ? h('ul', { class: 'list' }, s.sites.map(siteRow))
    : h('p', { class: 'empty' }, 'Sites show up here after your AI signs in or creates an account.'));

  const toggle = h('input', {
    type: 'checkbox', checked: !s.settings.paused,
    onchange: async e => { await call('settings', { patch: { paused: !e.target.checked } }); await refreshAndRender(); },
  });
  parts.push(h('div', { class: 'foot' },
    h('label', { class: 'switch' }, toggle, h('span', { class: 'track' }), s.settings.paused ? 'AI sign-in paused' : 'AI sign-in on'),
    h('button', { class: 'link', type: 'button', onclick: () => show('settings') }, 'Settings')));

  view.replaceChildren(...parts);
}

// ---------- settings

function backButton(to) {
  return h('button', { class: 'back', type: 'button', onclick: () => show(to) }, '← Back');
}

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
      h('p', {}, 'This removes your email, password, inbox connection and every saved site password from Latch.'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn small', type: 'button', onclick: () => render() }, 'Cancel'),
        h('button', { class: 'btn primary small', type: 'button', onclick: async () => { await call('erase'); revealed = {}; await refresh(); show('identity'); } }, 'Erase everything')))),
  }, 'Erase everything'));

  view.replaceChildren(
    backButton('home'),
    h('h1', {}, 'Settings'),
    h('div', { class: 'block-setting' },
      h('b', {}, 'New account passwords'),
      h('div', { class: 'segmented', role: 'group' }, mode('unique'), mode('mine')),
      h('small', {}, s.settings.newPasswords === 'unique'
        ? 'Each new account gets its own strong password. You can view them on the main screen.'
        : 'New accounts use the password you saved in Latch.')),
    h('div', { class: 'setting' },
      h('div', { style: 'min-width:0' }, h('b', {}, 'Inbox'),
        h('small', {}, s.mailbox ? `${s.mailbox.user} · ${s.mailbox.host}` : 'Not connected')),
      h('div', { class: 'actions', style: 'margin:0' },
        h('button', { class: 'link', type: 'button', onclick: () => show('inbox') }, s.mailbox ? 'Change' : 'Connect'),
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
  if (screen === 'settings') return settingsScreen();
  return homeScreen();
}

async function refreshAndRender() {
  const before = JSON.stringify(state);
  await refresh();
  if ((screen === 'home' || screen === 'settings') && JSON.stringify(state) !== before) render();
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
