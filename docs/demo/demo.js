// The practice site works entirely in the page. Forms never submit anywhere: each handler
// stops the submission, clears what was typed, and shows the next screen.
const KEY = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const $ = id => document.getElementById(id);
const swap = (from, to) => { $(from).hidden = true; $(to).hidden = false; };

function base32(text) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const out = [];
  let bits = 0, value = 0;
  for (const ch of text) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

async function code(step) {
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setUint32(4, step);
  const key = await crypto.subtle.importKey('raw', base32(KEY), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const o = mac[19] & 15;
  const n = ((mac[o] & 127) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3];
  return String(n % 1e6).padStart(6, '0');
}

function on(id, fn) {
  const form = $(id);
  if (!form) return;
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    for (const input of form.querySelectorAll('input')) input.value = '';
    await fn(values);
  });
}

on('login', () => swap('signin', 'done'));
$('signout')?.addEventListener('click', () => swap('done', 'signin'));
on('forgot', () => swap('forgot-card', 'done'));
on('reset', ({ password, confirm }) => {
  if (!password || password !== confirm) { $('reset-error').textContent = 'The passwords do not match.'; return; }
  swap('reset-card', 'done');
});
on('totp', async ({ code: typed }) => {
  const step = Math.floor(Date.now() / 30000);
  const good = await Promise.all([step - 1, step, step + 1].map(code));
  if (!good.includes(String(typed).trim())) { $('totp-error').textContent = 'That code is not right. Try the current one.'; return; }
  swap('setup', 'done');
});
