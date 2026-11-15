// Helpers shared by the popup, the Latch app page and the approval window.

export const call = (type, data = {}) => chrome.runtime.sendMessage({ type, ...data });

export function h(tag, attrs = {}, ...children) {
  const svg = ['svg', 'rect', 'circle', 'path'].includes(tag);
  const el = svg ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.setAttribute('class', v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}

export function logo(size = 24) {
  return h('svg', { class: 'mark', viewBox: '0 0 28 28', width: size, height: size, 'aria-hidden': 'true' },
    h('rect', { width: 28, height: 28, rx: 8, fill: '#16161a' }),
    h('circle', { cx: 14, cy: 11.6, r: 3.6, fill: '#e2a336' }),
    h('path', { d: 'M12.4 13.4h3.2l1.1 7.4h-5.4z', fill: '#e2a336' }));
}

export const CLIENT_NAMES = { 'claude-code': 'Claude Code', 'claude-ai': 'Claude', 'codex-mcp-client': 'Codex', codex: 'Codex', you: 'You', page: 'On-page button' };
export const clientName = c => CLIENT_NAMES[c] || c || 'Your AI';

export function ago(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 172800) return 'yesterday';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());

export function passwordInput(id, attrs = {}) {
  const input = h('input', { id, type: 'password', autocomplete: 'off', spellcheck: 'false', ...attrs });
  const peek = h('button', {
    class: 'peek', type: 'button', 'aria-controls': id, 'aria-label': 'Show password',
    onclick: () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      peek.textContent = show ? 'Hide' : 'Show';
      peek.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    },
  }, 'Show');
  const box = h('div', { class: 'input' }, input, peek);
  box.input = input;
  return box;
}

// A labelled field for a control that carries its own buttons (the password Show button):
// label[for] keeps the button's text out of the field's accessible name.
export function field(label, box, { hint, full } = {}) {
  const input = box.input || box;
  return h('div', { class: full ? 'field full' : 'field' }, h('label', { for: input.id }, label), box, hint ? h('small', {}, hint) : null);
}

const favicons = new Map();
export function favicon(host, placement = 'account') {
  const key = `${placement}:${host}`;
  if (favicons.has(key)) return favicons.get(key);
  const letter = (host || '?').replace(/^www\./, '')[0] || '?';
  const box = h('span', { class: 'fav', 'aria-hidden': 'true' }, letter);
  favicons.set(key, box);
  if (host && !/\.(test|localhost)$|^localhost$|^[\d.]+$/.test(host)) {
    const img = h('img', { alt: '', src: chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent('https://' + host)}&size=32`) });
    img.onload = () => { img.onload = null; box.replaceChildren(img); };
  }
  return box;
}

const NEEDS = {
  captcha: 'Needs you: CAPTCHA', phone_code: 'Needs you: phone code', authenticator_code: 'Needs you: authenticator code',
  passkey: 'Needs you: passkey', push_approval: 'Needs you: approve on your phone', locked: 'Account locked', mailbox: 'Needs your inbox',
  recovery_pending: 'Reset email on its way', recovery_requested: 'Reset email sent', approval_denied: 'You said no to this site',
  approval_missing: 'Waiting for your OK', totp_key_unreadable: 'Needs you: 2FA key not readable', identity_uncertain: 'Needs you: account unclear',
};

// A result or activity entry in a few words, and how it went.
export function outcome(a) {
  const good = { signed_in: 'Signed in', account_created: 'Created an account', verified: a.reason === 'authenticator_code' ? 'Entered a 2FA code' : 'Verified email',
    filled: 'Filled in your email', two_factor_saved: 'Saved a 2FA key', password_reset: 'Set a new password' };
  if (good[a.status]) return { text: good[a.status], tone: 'good' };
  const waiting = {
    check_inbox: 'Code emailed; your AI is fetching it', verification_pending: 'Waiting for the email', needs_user: NEEDS[a.reason] || 'Needs you',
    unconfirmed: 'Not confirmed yet', retry_blocked: 'Holding off before retrying', reload_required: 'Update ready: reload Latch',
  };
  if (waiting[a.status]) return { text: waiting[a.status], tone: 'wait' };
  const neutral = { no_form: 'Nothing to fill on that page', account_exists: 'Account already existed', no_account: 'No account there yet',
    paused: 'Skipped while paused', not_set_up: 'Not set up', expired: 'Skipped: ran out of time', form_incomplete: 'Other fields needed first' };
  if (neutral[a.status]) return { text: neutral[a.status], tone: '' };
  const bad = {
    blocked: a.reason === 'suspicious_site' ? 'Refused a suspicious page' : 'Refused an insecure page',
    wrong_password: 'Password rejected', credentials_or_account_problem: 'Sign-in rejected', sign_in_failed: 'Sign-in failed',
    sign_up_failed: 'Sign-up failed', verification_failed: 'Code not accepted', reset_failed: 'New password not accepted',
    unavailable: 'Chrome not reachable', error: 'Something went wrong', outcome_unknown: 'Stopped partway',
  };
  return { text: bad[a.status] || String(a.status || '').replace(/_/g, ' '), tone: 'bad' };
}

export function copyButton(getText, label = 'Copy') {
  const btn = h('button', {
    class: 'btn small', type: 'button',
    onclick: async () => {
      await navigator.clipboard.writeText(await getText());
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = label; }, 1400);
    },
  }, label);
  return btn;
}

export const appUrl = route => chrome.runtime.getURL(`app.html#${route}`);
