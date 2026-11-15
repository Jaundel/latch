import { ago, appUrl, call, clientName, copyButton, favicon, h, logo, outcome } from './ui.js';

const view = document.getElementById('view');
const conn = document.getElementById('conn');
// Lives outside the view: a live region only speaks when it changes, and every render replaces the view.
const announce = document.getElementById('announce');
document.getElementById('brand').prepend(logo(22));

let state = null;
let page = null;   // what the active tab offers
let run = null;    // { busy } or the result of running Latch on the active tab
let codes = [];

const openApp = route => { chrome.tabs.create({ url: appUrl(route) }); window.close(); };

const PAGE = {
  sign_in: { title: 'Sign-in page', sub: p => (p.saved ? 'Latch has your account for this site.' : 'Latch signs in with your email and password.'), tool: 'sign_in', label: 'Sign in with Latch' },
  sign_up: { title: 'Sign-up page', sub: () => 'Latch creates the account with your email and a new strong password.', tool: 'create_account', label: 'Create account with Latch' },
  code: { title: 'Asking for an emailed code', sub: () => (state.mailbox && state.connected ? 'Latch can read it from your inbox.' : 'Open your inbox to find the code, or let your AI fetch it.'),
    tool: () => (state.mailbox && state.connected ? 'verify_email' : null), label: 'Enter code with Latch' },
  totp: { title: 'Asking for a 2FA code', sub: p => (p.totp ? 'Latch has the 2FA key for this site.' : 'Add this site\'s 2FA key in Latch and it fills these codes for you.'),
    tool: p => (p.totp ? 'verify_email' : null), label: 'Enter 2FA code' },
  phone_code: { title: 'Asking for a texted code', sub: () => 'Type the code from your phone. Latch cannot read texts.' },
  totp_setup: { title: 'Two-factor setup', sub: () => 'Latch can save this site\'s 2FA key and confirm it with a code.', tool: 'setup_two_factor', label: 'Set up 2FA with Latch' },
  reset: { title: 'New password page', sub: () => 'Latch chooses a strong password, enters it and saves it for this site.', tool: 'set_new_password', label: 'Set new password' },
  recovery: { title: 'Forgot password page', sub: () => 'Latch enters your email address and asks for a reset link.', tool: 'request_password_recovery', label: 'Send reset email' },
  check_email: { title: 'Waiting on an email link', sub: () => 'Open the newest email from this site in your inbox.' },
  captcha: { title: 'CAPTCHA on this page', sub: () => 'Solve it, then Latch can carry on.' },
  signed_in: { title: 'Signed in', sub: () => 'Nothing for Latch to do here.' },
  none: { title: 'Nothing to sign in to', sub: () => 'Latch shows up on sign-in, sign-up, 2FA and password reset pages.' },
  blank: { title: 'Open a website', sub: () => 'Latch works on the page in front of you.' },
};

function renderConnection() {
  const paused = state?.settings?.paused;
  conn.classList.toggle('on', !!state?.setup && !paused);
  conn.classList.toggle('paused', !!paused);
  conn.querySelector('.conn-text').textContent = !state?.setup ? 'Not set up' : paused ? 'Paused' : 'On';
}

function setupScreen() {
  view.replaceChildren(h('section', { class: 'setup' },
    h('h1', {}, 'Let your AI sign in for you'),
    h('p', {}, 'Add your email and password once. When your AI reaches a sign-in page, it presses Sign in with Latch and never sees your password.'),
    h('ol', {}, h('li', {}, 'Add your email and password'), h('li', {}, 'Ask your AI to do something that needs an account'), h('li', {}, 'Latch handles the sign-in, 2FA and resets')),
    h('button', { class: 'btn primary block big', type: 'button', onclick: () => openApp('welcome') }, 'Set up Latch')));
}

function pageCard() {
  if (!page) return h('section', { class: 'page loading', 'aria-busy': 'true' }, h('div', { class: 'page-title' }, 'Reading this page…'));
  const info = PAGE[page.kind] || PAGE.none;
  const tool = typeof info.tool === 'function' ? info.tool(page) : info.tool;
  const result = run && !run.busy ? outcome(run) : null;
  return h('section', { class: 'page', 'aria-label': 'This page' },
    h('div', { class: 'page-head' },
      page.host ? favicon(page.host, 'page') : null,
      h('div', { style: 'min-width:0' },
        page.host ? h('div', { class: 'page-host', title: page.host }, page.host) : null,
        h('div', { class: 'page-title' }, info.title))),
    h('p', { class: 'page-sub' }, info.sub(page)),
    tool ? h('button', {
      class: 'btn primary block', type: 'button', disabled: !!run?.busy || state.settings.paused,
      onclick: async () => {
        run = { busy: true };
        announce.textContent = 'Working…';
        render();
        run = await call('runHere', { tool }).catch(() => ({ status: 'error', message: 'Latch could not run here.' }));
        announce.textContent = run.message || outcome(run).text;
        page = await call('pageState').catch(() => page);
        await refresh();
        render();
      },
    }, run?.busy ? 'Working…' : info.label) : null,
    result ? h('p', { class: `notice ${result.tone}` }, run.message || result.text) : null);
}

const base = host => host.split('.').slice(-2).join('.');
const codeFor = () => page?.host && (codes.find(c => c.host === page.host) || codes.find(c => base(c.host) === base(page.host)));
const spaced = code => `${code.slice(0, 3)} ${code.slice(3)}`;

function twoFactorCard() {
  const item = codeFor();
  if (!item) return null;
  return h('section', { class: 'twofa', 'aria-label': '2FA code for this site' },
    h('span', { class: 'ring', style: `--p:${item.left / item.period}`, 'aria-hidden': 'true' }),
    h('div', { class: 'grow' }, h('div', { class: 'label' }, `2FA code for ${item.host}`), h('div', { class: 'code' }, spaced(item.code))),
    copyButton(() => codeFor()?.code || ''));
}

// Ticks the code and its countdown in place, so the rest of the popup keeps focus.
function tickCode() {
  const item = codeFor();
  const card = view.querySelector('.twofa');
  if (!item || !card) return;
  card.querySelector('.code').textContent = spaced(item.code);
  card.querySelector('.ring').style.setProperty('--p', item.left / item.period);
}

function activityRow(a) {
  const o = outcome(a);
  return h('li', { class: 'row act' },
    h('span', { class: `tone ${o.tone}`, 'aria-hidden': 'true' }),
    h('div', { style: 'min-width:0' },
      h('div', { class: 'name' }, o.text),
      h('div', { class: 'sub' }, [a.site, clientName(a.client), ago(a.at)].filter(Boolean).join(' · '))));
}

function homeScreen() {
  const parts = [pageCard(), twoFactorCard()];
  if (state.activity.length) {
    parts.push(h('div', { class: 'section-head' }, h('h2', {}, 'Recent'),
      h('button', { class: 'link small', type: 'button', onclick: () => openApp('activity') }, 'All activity')));
    parts.push(h('ul', { class: 'list' }, state.activity.slice(0, 3).map(activityRow)));
  } else {
    parts.push(h('div', { class: 'section-head' }, h('h2', {}, 'How it works')));
    parts.push(h('p', { class: 'empty' }, 'When your AI reaches a sign-in page, it presses the Latch button there. Results show up here.'));
  }
  const toggle = h('input', {
    type: 'checkbox', checked: !state.settings.paused, 'aria-label': 'Latch on',
    onchange: async e => { await call('settings', { patch: { paused: !e.target.checked } }); await refresh(); render(); },
  });
  parts.push(h('div', { class: 'foot' },
    h('label', { class: 'switch' }, toggle, h('span', { class: 'track' }), state.settings.paused ? 'Paused' : 'On'),
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn small', type: 'button', onclick: () => openApp('accounts') }, `Accounts${state.sites.length ? ` (${state.sites.length})` : ''}`),
      h('button', { class: 'btn small', type: 'button', onclick: () => openApp('settings') }, 'Settings'))));
  view.replaceChildren(...parts.filter(Boolean));
}

function render() {
  renderConnection();
  if (!state.setup) return setupScreen();
  homeScreen();
}

async function refresh() {
  state = await call('state');
  codes = state.sites.some(s => s.totp) ? await call('codes').catch(() => []) : [];
}

chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type === 'changed') refresh().then(() => { if (!run?.busy) render(); });
});

await refresh();
render();
if (state.setup) {
  call('pageState').catch(() => ({ kind: 'none', host: '' })).then(p => { page = p; render(); });
  setInterval(async () => {
    if (!codes.length || run?.busy) return;
    codes = await call('codes').catch(() => codes);
    tickCode();
  }, 1000);
}
