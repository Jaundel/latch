import { ago, call, clientName, copyButton, favicon, field, h, isEmail, logo, outcome, passwordInput } from './ui.js';

const root = document.getElementById('root');
const announce = document.getElementById('announce');
const say = text => { announce.textContent = ''; setTimeout(() => { announce.textContent = text; }, 30); };

let state = null;
let codes = [];
let revealed = {};
let query = '';
let codeTimer = null;

const COMPANION = 'npx -y github:Jaundel/latch';
const NAV = [['accounts', 'Accounts'], ['codes', '2FA codes'], ['activity', 'Activity'], ['connect', 'Connect AIs'], ['settings', 'Settings'], ['security', 'How Latch keeps you safe']];

const route = () => location.hash.replace(/^#/, '') || (state?.setup ? 'accounts' : 'welcome');
const go = r => { if (location.hash === `#${r}`) render(); else location.hash = r; };

async function refresh() {
  state = await call('state');
  codes = state.sites.some(s => s.totp) ? await call('codes').catch(() => []) : [];
}

const shield = () => h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', 'aria-hidden': 'true' },
  h('path', { d: 'M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3z', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linejoin': 'round' }));

// ---------- welcome: the one required step

function welcome() {
  const email = h('input', { id: 'email', type: 'email', placeholder: 'you@example.com', autocomplete: 'email', required: true, value: state.email || '' });
  const pw = passwordInput('password', { placeholder: 'The password you use for most sites', autocomplete: 'current-password', required: true });
  const error = h('p', { class: 'error', role: 'alert' });
  const go_ = h('button', { class: 'btn primary big block', type: 'submit' }, 'Start using Latch');
  // Latch's own messages instead of the browser's bubbles: they stay on screen and are read aloud.
  const form = h('form', {
    novalidate: true,
    onsubmit: async e => {
      e.preventDefault();
      if (!isEmail(email.value)) { error.textContent = 'Enter the email address you sign in with.'; email.focus(); return; }
      if (!pw.input.value) { error.textContent = 'Enter your password.'; pw.input.focus(); return; }
      go_.disabled = true;
      await call('saveIdentity', { email: email.value.trim(), password: pw.input.value });
      pw.input.value = '';
      await refresh();
      say('Latch is set up.');
      go('ready');
    },
  },
    h('label', { class: 'field' }, h('span', {}, 'Email'), email),
    field('Password', pw),
    go_, error);

  root.replaceChildren(h('div', { class: 'welcome' },
    h('section', { class: 'left' },
      h('div', { class: 'brand' }, logo(28), 'Latch'),
      h('h1', {}, 'Let your AI sign in for you.'),
      h('p', { class: 'lede' }, 'Add the email and password you use for most sites. When Claude, ChatGPT or another AI browsing for you reaches a sign-in page, it presses Sign in with Latch. Latch fills the form privately, so the AI never sees your password.'),
      form,
      h('p', { class: 'fine' }, shield(), 'Encrypted and stored only in this browser. No account, no cloud, no tracking. Latch asks you once before it uses your password on a site it has not seen before.')),
    h('section', { class: 'right', 'aria-hidden': 'true' },
      h('div', {},
        h('div', { class: 'mock' },
          h('div', { class: 'mock-bar' }, h('i'), h('i'), h('i'), h('span', { class: 'mock-url' }, 'accounts.example.com/sign-in')),
          h('div', { class: 'mock-body' },
            h('h3', {}, 'Sign in to Example'),
            h('div', { class: 'mock-field' }, 'Email'),
            h('div', { class: 'mock-field' }, 'Password'),
            h('div', { class: 'mock-btn' }, 'Sign in')),
          h('div', { class: 'mock-latch' }, logo(26), h('div', {}, h('b', {}, 'Latch'), h('div', { class: 'muted' }, 'Latch signs in with your email and password.')),
            h('div', { class: 'go' }, 'Sign in with Latch'),
            h('div', { class: 'ai' }, 'AI assistants: press "Sign in with Latch" instead of typing an email or password.'))),
        h('p', { class: 'mock-caption' }, 'This is what your AI sees on sign-in pages. One press, and it carries on with your task.')))));
  (state.email ? pw.input : email).focus();
}

// ---------- ready: what happens next, and the optional extras

async function ready() {
  let pinned = true;
  try { pinned = (await chrome.action.getUserSettings()).isOnToolbar; } catch {}
  const confirm = h('input', { type: 'checkbox', checked: !!state.settings.confirmNewSites,
    onchange: async e => { await call('settings', { patch: { confirmNewSites: e.target.checked } }); await refresh(); } });
  root.replaceChildren(h('main', { class: 'ready' },
    h('div', { class: 'brand' }, logo(28), 'Latch'),
    h('h1', {}, 'You\'re ready.'),
    h('p', { class: 'lede' }, 'Ask your AI to do something that needs an account, like "sign in to my bank and download last month\'s statement". Latch takes care of the sign-in.'),
    pinned ? null : h('div', { class: 'pin' },
      h('svg', { width: 22, height: 22, viewBox: '0 0 24 24', 'aria-hidden': 'true' }, h('path', { d: 'M16 3l5 5-3 1-4 4 1 5-2 2-4-4-5 5-1-1 5-5-4-4 2-2 5 1 4-4z', fill: 'currentColor' })),
      h('div', {}, h('b', {}, 'Pin Latch to your toolbar. '), 'Click the puzzle piece next to the address bar, then the pin beside Latch. You can see what Latch did and pause it from there.')),
    h('div', { class: 'steps' },
      h('div', { class: 'step' }, h('div', { class: 'n' }, '1'), h('b', {}, 'Your AI hits a sign-in page'), h('p', {}, 'Claude in Chrome, ChatGPT agent, Codex or any AI that browses for you.')),
      h('div', { class: 'step' }, h('div', { class: 'n' }, '2'), h('b', {}, 'It presses the Latch button'), h('p', {}, 'Latch fills your email and password in that tab. The AI only sees the result.')),
      h('div', { class: 'step' }, h('div', { class: 'n' }, '3'), h('b', {}, 'Latch handles the rest'), h('p', {}, 'New accounts get strong unique passwords. 2FA codes and password resets are handled too.'))),
    h('div', { class: 'tiles' },
      h('div', { class: 'tile' }, h('b', {}, 'Ask before new sites'),
        h('p', {}, 'The first time Latch would use your password on a site, it asks you in a small Latch window. AIs cannot press that window\'s buttons.'),
        h('label', { class: 'switch' }, confirm, h('span', { class: 'track' }), 'Ask me first')),
      h('div', { class: 'tile' }, h('b', {}, 'Add your 2FA keys'),
        h('p', {}, 'Give Latch a site\'s authenticator key and it enters the 6-digit codes. It can also save keys while your AI turns on 2FA.'),
        h('button', { class: 'btn small', type: 'button', onclick: () => go('codes') }, 'Add a 2FA key')),
      h('div', { class: 'tile' }, h('b', {}, 'A different password for some sites?'),
        h('p', {}, 'Save it for that site and Latch uses it there instead of your main password.'),
        h('button', { class: 'btn small', type: 'button', onclick: () => go('accounts') }, 'Add an account')),
      h('div', { class: 'tile' }, h('b', {}, 'Using Claude Code or Codex in a terminal?'),
        h('p', {}, 'Browser AIs need nothing else. Terminal and desktop AIs connect with one command.'),
        h('button', { class: 'btn small', type: 'button', onclick: () => go('connect') }, 'Connect an AI'))),
    h('div', { class: 'actions', style: 'margin-top:28px' },
      h('button', { class: 'btn primary', type: 'button', onclick: () => go('accounts') }, 'Open Latch'),
      h('button', { class: 'btn', type: 'button', onclick: () => window.close() }, 'Close this tab'))));
}

// ---------- the manage shell

function shell(current, ...content) {
  root.replaceChildren(h('div', { class: 'shell' },
    h('aside', { class: 'side' },
      h('div', { class: 'brand' }, logo(26), 'Latch'),
      h('nav', { class: 'nav', 'aria-label': 'Latch' }, NAV.map(([r, label]) => h('a', { href: `#${r}`, 'aria-current': r === current ? 'page' : null }, label))),
      h('div', { class: 'who', title: state.email }, state.settings.paused ? 'Paused · ' : '', state.email)),
    h('main', { class: 'content' }, ...content)));
}

function siteRow(site) {
  const status = site.status === 'pending' ? 'Sign-up in progress'
    : site.source === 'latch' ? 'Password made by Latch' : site.source === 'you' ? 'Password saved by you' : 'Uses your main password';
  const extra = h('div', { style: 'grid-column:1/-1' });
  const row = h('li', { class: 'row' },
    favicon(site.host),
    h('div', { style: 'min-width:0' },
      h('div', { class: 'name', title: site.host }, site.host, ' ', site.totp ? h('span', { class: 'badge good' }, '2FA') : null),
      h('div', { class: 'sub' }, [site.username, status, ago(site.lastUsed || site.createdAt)].filter(Boolean).join(' · '))),
    h('div', { class: 'row-actions' },
      site.hasPassword ? h('button', {
        class: 'btn small', type: 'button', 'aria-label': `${revealed[site.host] ? 'Hide' : 'Show'} password for ${site.host}`,
        onclick: async () => {
          if (revealed[site.host]) delete revealed[site.host];
          else revealed[site.host] = (await call('reveal', { host: site.host })).password;
          render();
        },
      }, revealed[site.host] ? 'Hide' : 'Show') : null,
      site.totp ? null : h('button', { class: 'btn small', type: 'button', 'aria-label': `Add 2FA key for ${site.host}`, onclick: () => extra.replaceChildren(totpForm(site.host)) }, 'Add 2FA'),
      h('button', {
        class: 'btn small danger', type: 'button', 'aria-label': `Forget ${site.host}`,
        onclick: () => extra.replaceChildren(h('div', { class: 'confirm' },
          h('p', {}, `Forget ${site.host}? Latch deletes its saved password${site.totp ? ' and 2FA key' : ''}. The account on the site stays as it is.`),
          h('div', { class: 'actions' },
            h('button', { class: 'btn small', type: 'button', onclick: () => extra.replaceChildren() }, 'Cancel'),
            h('button', { class: 'btn small primary', type: 'button', onclick: async () => { await call('forget', { host: site.host }); await refresh(); say(`Forgot ${site.host}.`); render(); } }, 'Forget')))),
      }, 'Forget')),
    extra);
  if (revealed[site.host]) row.append(h('div', { class: 'secret' }, h('span', {}, revealed[site.host]), copyButton(() => revealed[site.host])));
  return row;
}

function addAccountForm(box) {
  const host = h('input', { type: 'text', placeholder: 'example.com', spellcheck: 'false', required: true });
  const user = h('input', { type: 'text', placeholder: state.email, spellcheck: 'false', autocomplete: 'off' });
  const pw = passwordInput('site-password', { required: true });
  const note = h('p', { class: 'notice', role: 'status' });
  return h('form', {
    class: 'card', style: 'margin-bottom:16px',
    onsubmit: async e => {
      e.preventDefault();
      const r = await call('saveSite', { host: host.value, username: user.value, password: pw.input.value });
      if (!r.ok) { note.className = 'notice bad'; note.textContent = 'Enter the site\'s address and its password.'; return; }
      await refresh();
      say(`Saved ${r.host}.`);
      box.replaceChildren();
      render();
    },
  },
    h('h2', {}, 'Add an account'),
    h('p', { class: 'muted' }, 'For a site where you use a different password or user name. Latch uses it there instead of your main password.'),
    h('div', { class: 'form-grid' },
      h('label', { class: 'field' }, h('span', {}, 'Site'), host),
      h('label', { class: 'field' }, h('span', {}, 'User name or email'), user, h('small', {}, 'Leave empty to use your main email.')),
      field('Password', pw, { full: true })),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save account'),
      h('button', { class: 'btn', type: 'button', onclick: () => box.replaceChildren() }, 'Cancel')),
    note);
}

function accounts() {
  const box = h('div');
  const search = h('input', { type: 'search', placeholder: 'Search accounts', value: query, 'aria-label': 'Search accounts',
    oninput: e => { query = e.target.value; paintList(); } });
  const list = h('ul', { class: 'list' });
  const paintList = () => {
    const q = query.trim().toLowerCase();
    const shown = state.sites.filter(s => !q || s.host.includes(q) || (s.username || '').toLowerCase().includes(q));
    list.replaceChildren(...(shown.length ? shown.map(siteRow) : [h('li', { class: 'empty' }, state.sites.length ? 'No accounts match.' : 'Accounts appear here after your AI signs in or creates one through Latch.')]));
  };
  paintList();
  const identityBox = h('div');
  shell('accounts',
    h('h1', {}, 'Accounts'),
    h('p', { class: 'lede' }, 'Sites Latch has signed in to or created accounts on.'),
    h('section', { class: 'card' },
      h('div', { class: 'setting' },
        h('div', { style: 'min-width:0' }, h('b', {}, 'Your main sign-in'), h('small', {}, `${state.email} · used on any site without its own password`)),
        h('button', { class: 'btn small', type: 'button', onclick: () => identityBox.replaceChildren(identityForm(identityBox)) }, 'Change')),
      identityBox),
    h('div', { class: 'toolbar', style: 'margin-top:20px' }, search, h('span', { class: 'grow' }),
      h('button', { class: 'btn', type: 'button', onclick: () => { box.replaceChildren(addAccountForm(box)); box.querySelector('input').focus(); } }, 'Add account')),
    box,
    h('section', { class: 'card' }, list));
}

function identityForm(box) {
  const email = h('input', { type: 'email', value: state.email, required: true });
  const pw = passwordInput('new-main', { placeholder: 'Leave empty to keep your current password' });
  const note = h('p', { class: 'notice', role: 'status' });
  return h('form', {
    style: 'margin-top:10px',
    onsubmit: async e => {
      e.preventDefault();
      if (!isEmail(email.value)) { note.className = 'notice bad'; note.textContent = 'Enter a valid email address.'; return; }
      await call('saveIdentity', { email: email.value.trim(), password: pw.input.value });
      await refresh();
      say('Saved your sign-in details.');
      render();
    },
  },
    h('label', { class: 'field' }, h('span', {}, 'Email'), email),
    field('Password', pw),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save'), h('button', { class: 'btn', type: 'button', onclick: () => box.replaceChildren() }, 'Cancel')),
    note);
}

// ---------- 2FA codes

function totpForm(presetHost = '') {
  const host = h('input', { type: 'text', placeholder: 'github.com', value: presetHost, spellcheck: 'false', required: true });
  const key = h('input', { type: 'text', placeholder: 'JBSW Y3DP EHPK 3PXP, or an otpauth:// link', spellcheck: 'false', autocomplete: 'off', required: true });
  const note = h('p', { class: 'notice', role: 'status' });
  return h('form', {
    style: 'margin-top:10px',
    onsubmit: async e => {
      e.preventDefault();
      const r = await call('addTotp', { host: host.value, key: key.value });
      if (!r.ok) {
        note.className = 'notice bad';
        note.textContent = r.reason === 'host' ? 'Enter the site\'s address, like github.com.' : 'That does not look like a setup key. Copy the key the site shows under "Can\'t scan the code?".';
        return;
      }
      key.value = '';
      await refresh();
      say(`Saved the 2FA key for ${r.host}.`);
      render();
    },
  },
    h('div', { class: 'form-grid' },
      h('label', { class: 'field' }, h('span', {}, 'Site'), host),
      h('label', { class: 'field' }, h('span', {}, 'Setup key'), key)),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save 2FA key')),
    note);
}

function codeCards() {
  return codes.map(c => h('div', { class: 'codecard', 'data-host': c.host },
    h('span', { class: 'ring', style: `--p:${c.left / c.period}`, 'aria-hidden': 'true' }),
    h('div', { style: 'min-width:0' }, h('div', { class: 'code' }, `${c.code.slice(0, 3)} ${c.code.slice(3)}`), h('div', { class: 'host' }, c.issuer && c.issuer.toLowerCase() !== c.host ? `${c.issuer} · ${c.host}` : c.host)),
    h('div', { class: 'row-actions' }, copyButton(() => codes.find(x => x.host === c.host)?.code || ''),
      h('button', { class: 'btn small danger', type: 'button', 'aria-label': `Remove 2FA key for ${c.host}`,
        onclick: async () => { await call('removeTotp', { host: c.host }); await refresh(); say(`Removed the 2FA key for ${c.host}.`); render(); } }, 'Remove'))));
}

function codesPage() {
  shell('codes',
    h('h1', {}, '2FA codes'),
    h('p', { class: 'lede' }, 'Latch enters these codes when a site asks for one from an authenticator app. You can copy them here too.'),
    codes.length ? h('div', { class: 'codes' }, codeCards()) : h('p', { class: 'empty' }, 'No 2FA keys yet.'),
    h('section', { class: 'card', style: 'margin-top:20px' },
      h('h2', {}, 'Add a 2FA key'),
      h('p', { class: 'muted' }, 'When a site shows a QR code for an authenticator app, choose "Can\'t scan it?" to see the setup key, and paste it here. Or let your AI turn on 2FA: on the setup page it presses Set up 2FA with Latch, and Latch saves the key itself.'),
      totpForm()));
  clearInterval(codeTimer);
  codeTimer = setInterval(async () => {
    if (route() !== 'codes' || !codes.length) return;
    codes = await call('codes').catch(() => codes);
    for (const c of codes) {
      const card = root.querySelector(`.codecard[data-host="${CSS.escape(c.host)}"]`);
      if (!card) continue;
      card.querySelector('.code').textContent = `${c.code.slice(0, 3)} ${c.code.slice(3)}`;
      card.querySelector('.ring').style.setProperty('--p', c.left / c.period);
    }
  }, 1000);
}

// ---------- activity

function activityPage() {
  const days = new Map();
  for (const a of state.activity) {
    const day = new Date(a.at).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(a);
  }
  shell('activity',
    h('h1', {}, 'Activity'),
    h('p', { class: 'lede' }, 'What Latch did, where, and who asked. Never any passwords or codes.'),
    state.activity.length
      ? [...days].map(([day, items]) => h('section', { class: 'card' }, h('h2', {}, day), h('ul', { class: 'list' }, items.map(a => {
        const o = outcome(a);
        return h('li', { class: 'row', style: 'grid-template-columns:auto 1fr auto' },
          h('span', { class: `tone ${o.tone}`, 'aria-hidden': 'true' }),
          h('div', { style: 'min-width:0' }, h('div', { class: 'name' }, o.text), h('div', { class: 'sub' }, [a.site, clientName(a.client)].filter(Boolean).join(' · '))),
          h('span', { class: 'muted small' }, new Date(a.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })));
      }))))
      : h('p', { class: 'empty' }, 'Nothing yet. Every sign-in, sign-up, 2FA code and reset Latch handles is listed here.'));
}

// ---------- connect AIs

async function companionCommands() {
  let install = null;
  try { install = await (await fetch(chrome.runtime.getURL('install.json'))).json(); } catch {}
  const q = s => `"${s}"`;
  if (install) {
    return [
      ['Claude Code', `claude mcp add --scope user latch -- node ${q(install.server)}`],
      ['Codex CLI', `node ${q(install.setup)} --codex`],
      ['Claude Desktop', `node ${q(install.setup)} --claude-desktop`],
    ];
  }
  return [
    ['Claude Code', `claude mcp add --scope user latch -- ${COMPANION}`],
    ['Codex CLI', `codex mcp add latch -- ${COMPANION}`],
    ['Claude Desktop, Cursor and other MCP apps', JSON.stringify({ mcpServers: { latch: { command: 'npx', args: ['-y', 'github:Jaundel/latch'] } } }, null, 2)],
  ];
}

async function connectPage() {
  const commands = await companionCommands();
  const clients = [...new Set((state.clients || []).map(clientName))];
  const live = h('span', { class: `live${state.connected ? ' on' : ''}` }, h('span', { class: 'dot' }),
    state.connected ? `Connected${clients.length ? ` to ${clients.join(', ')}` : ''}` : 'No terminal or desktop AI connected');
  shell('connect',
    h('h1', {}, 'Connect AIs'),
    h('p', { class: 'lede' }, 'Most people need nothing here.'),
    h('section', { class: 'card' },
      h('h2', {}, 'AIs that browse in Chrome'),
      h('p', { class: 'muted' }, 'Claude in Chrome, ChatGPT agent, Codex, Comet and any other assistant that works in your Chrome tabs. Nothing to install: on sign-in pages they see the Latch panel with a button such as "Sign in with Latch", and press it. The panel also tells them in plain words what to do.')),
    h('section', { class: 'card' },
      h('div', { class: 'setting' }, h('div', {}, h('h2', {}, 'Terminal and desktop AIs (optional)'),
        h('small', {}, 'Claude Code, Codex CLI, Claude Desktop and other MCP apps get Latch as a set of tools. Needs Node.js 20 or later.')), live),
      h('ul', { class: 'list' }, commands.map(([name, cmd]) => h('li', { style: 'padding:10px 0' },
        h('div', { class: 'setting', style: 'padding:0 0 6px;border:0' }, h('b', {}, name), copyButton(() => cmd)),
        h('pre', { class: 'cmd' }, cmd))))),
    h('section', { class: 'card' },
      h('h2', {}, 'Let Latch read emailed codes (optional)'),
      h('p', { class: 'muted' }, 'With the helper above running, Latch can read verification emails itself over IMAP using an app password. Without it, your AI opens your webmail and reads the code, which works everywhere.'),
      h('div', { id: 'inbox' })));
  inboxForm(root.querySelector('#inbox'));
}

async function inboxForm(box) {
  if (state.mailbox) {
    box.replaceChildren(h('div', { class: 'setting' },
      h('div', {}, h('b', {}, 'Inbox connected'), h('small', {}, `${state.mailbox.user} · ${state.mailbox.host}`)),
      h('button', { class: 'btn small', type: 'button', onclick: async () => { await call('removeMailbox'); await refresh(); render(); } }, 'Disconnect')));
    return;
  }
  const user = state.email;
  const provider = await call('provider', { email: user }).catch(() => ({}));
  const host = h('input', { type: 'text', value: provider.host || '', spellcheck: 'false' });
  const port = h('input', { type: 'number', value: provider.port || 993 });
  const username = h('input', { type: 'text', value: user, spellcheck: 'false' });
  const tls = h('input', { type: 'checkbox', checked: true });
  const pass = passwordInput('app-password', { placeholder: provider.host === 'imap.gmail.com' ? 'xxxx xxxx xxxx xxxx' : 'App password' });
  const note = h('p', { class: 'notice', role: 'status' });
  box.replaceChildren(h('form', {
    onsubmit: async e => {
      e.preventDefault();
      if (!pass.input.value) { note.className = 'notice bad'; note.textContent = 'Paste the app password first.'; return; }
      note.className = 'notice'; note.textContent = 'Checking your inbox…';
      const r = await call('saveMailbox', { mailbox: { user: username.value, pass: pass.input.value, host: host.value, port: port.value, secure: tls.checked } });
      if (!r.ok) { note.className = 'notice bad'; note.textContent = r.reason === 'auth' ? 'That app password was not accepted.' : 'Could not reach that mail server.'; return; }
      await refresh();
      render();
    },
  },
    provider.unsupported ? h('p', { class: 'notice wait' }, provider.unsupported) : null,
    h('p', { class: 'muted small' }, provider.name ? `${provider.name}. ` : '', provider.help ? h('a', { href: provider.help, target: '_blank', rel: 'noreferrer' }, 'Create an app password') : 'Use an app password from your mail provider.', provider.note ? ` ${provider.note}` : ''),
    field('App password', pass),
    h('details', {}, h('summary', {}, 'Server settings'),
      h('div', { class: 'form-grid' },
        h('label', { class: 'field' }, h('span', {}, 'Server'), host),
        h('label', { class: 'field' }, h('span', {}, 'Port'), port),
        h('label', { class: 'field full' }, h('span', {}, 'User name'), username),
        h('label', { class: 'switch full' }, tls, h('span', { class: 'track' }), 'Use TLS'))),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Connect inbox')),
    note));
}

// ---------- settings

function toggleSetting(key, label, help, invert = false) {
  const input = h('input', { type: 'checkbox', checked: invert ? !state.settings[key] : !!state.settings[key], 'aria-label': label,
    onchange: async e => { await call('settings', { patch: { [key]: invert ? !e.target.checked : e.target.checked } }); await refresh(); say(`${label}: ${e.target.checked ? 'on' : 'off'}.`); render(); } });
  return h('div', { class: 'setting' }, h('div', {}, h('b', {}, label), h('small', {}, help)), h('label', { class: 'switch' }, input, h('span', { class: 'track' })));
}

function settingsPage() {
  const mode = value => h('button', {
    type: 'button', 'aria-pressed': String(state.settings.newPasswords === value),
    onclick: async () => { await call('settings', { patch: { newPasswords: value } }); await refresh(); render(); },
  }, value === 'unique' ? 'Strong and unique' : 'Same as my main password');
  const approved = state.settings.approvedSites || [];
  const erase = h('div');
  erase.append(h('button', { class: 'btn danger', type: 'button',
    onclick: () => erase.replaceChildren(h('div', { class: 'confirm' },
      h('p', {}, 'This deletes your email, password, every saved account password and 2FA key, and the activity list from Latch. It cannot be undone.'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn small', type: 'button', onclick: () => render() }, 'Cancel'),
        h('button', { class: 'btn small primary', type: 'button', onclick: async () => { await call('erase'); revealed = {}; await refresh(); go('welcome'); } }, 'Erase everything')))) },
  'Erase everything'));

  shell('settings',
    h('h1', {}, 'Settings'),
    h('p', { class: 'lede' }, 'The defaults suit most people.'),
    h('section', { class: 'card' },
      h('h2', {}, 'Safety'),
      toggleSetting('confirmNewSites', 'Ask before using my password on a new site', 'A small Latch window asks you the first time. Sites Latch created or already signed in to never ask. Turn this off only if your AI works unattended.'),
      approved.length ? h('div', { class: 'setting', style: 'display:block' }, h('b', {}, 'Sites you allowed'),
        h('div', { class: 'chips', style: 'margin-top:8px' }, approved.map(site => h('span', { class: 'chip' }, site,
          h('button', { type: 'button', 'aria-label': `Remove ${site}`, onclick: async () => {
            await call('settings', { patch: { approvedSites: approved.filter(s => s !== site) } }); await refresh(); render();
          } }, '×'))))) : null),
    h('section', { class: 'card' },
      h('h2', {}, 'Behaviour'),
      toggleSetting('paused', 'Latch is on', 'When off, Latch does nothing on any page and tells AIs it is paused.', true),
      toggleSetting('bar', 'Show the Latch panel on sign-in pages', 'Browser AIs use this panel. Without it they cannot use Latch.'),
      h('div', { class: 'setting' }, h('div', {}, h('b', {}, 'Passwords for new accounts'),
        h('small', {}, state.settings.newPasswords === 'unique' ? 'Each new account gets its own strong password. Recommended.' : 'New accounts use your main password.')),
      h('div', { class: 'segmented', role: 'group', 'aria-label': 'Passwords for new accounts' }, mode('unique'), mode('mine')))),
    h('section', { class: 'card' }, h('h2', {}, 'Your data'),
      h('p', { class: 'muted' }, `Latch ${state.version} keeps everything encrypted in this browser profile. Nothing is sent to us.`), erase));
}

// ---------- security explainer

function securityPage() {
  const point = (title, text) => h('div', { class: 'setting', style: 'display:block' }, h('b', {}, title), h('small', {}, text));
  shell('security',
    h('h1', {}, 'How Latch keeps you safe'),
    h('p', { class: 'lede' }, 'Latch is built so the AI can use your accounts without ever holding your secrets.'),
    h('section', { class: 'card' },
      point('The AI never sees your password', 'Latch types it into the site\'s own form inside the page and returns only a short result such as "Signed in". Results are checked against a fixed list of fields and scrubbed for anything from your vault.'),
      point('Your password only goes where it belongs', 'Latch refuses pages that imitate a site you use (look-alike spellings, swapped characters, foreign letters), bare IP addresses, non-HTTPS pages, and forms that would send your password to another site.'),
      point('You approve new sites', 'The first time your main password would go to a site, a Latch window asks you. Page scripts and browser AIs cannot reach that window.'),
      point('A web page cannot press Latch\'s button', 'Latch accepts only real clicks and key presses, and ignores them when the panel is covered, faded or changed by the page.'),
      point('Encrypted on your device', 'AES-256-GCM with a key that cannot be exported, in this browser profile only. No servers, accounts, analytics or remote code.'),
      point('Unique passwords for new accounts', 'Each account Latch creates gets its own strong random password, so a leak on one site does not unlock another.'),
      point('What Latch cannot hide', 'Sites can show your email after you sign in, and an AI reading your webmail for a code sees that email. Anything that controls your whole computer can read the browser\'s storage.')));
}

// ---------- routing

async function render() {
  clearInterval(codeTimer);
  const r = route();
  if (!state.setup && !['welcome'].includes(r)) return go('welcome');
  if (r === 'welcome') return state.setup ? go('ready') : welcome();
  if (r === 'ready') return ready();
  if (r === 'codes') return codesPage();
  if (r === 'activity') return activityPage();
  if (r === 'connect') return connectPage();
  if (r === 'settings') return settingsPage();
  if (r === 'security') return securityPage();
  return accounts();
}

addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type !== 'changed' || route() === 'welcome') return;
  const active = document.activeElement;
  if (active && ['INPUT', 'TEXTAREA'].includes(active.tagName)) return;
  refresh().then(() => { if (['activity', 'accounts', 'connect'].includes(route())) render(); });
});

await refresh();
render();
