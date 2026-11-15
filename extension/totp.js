// Time-based one-time codes (RFC 6238) and the setup keys sites hand out for them.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(text) {
  const clean = String(text || '').toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  if (!clean || /[^A-Z2-7]/.test(clean)) return null;
  const out = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

// A setup key as the user or a page gives it: grouped, lower case, or inside an otpauth:// link.
export function parseKey(input) {
  const text = String(input || '').trim();
  if (/^otpauth:\/\//i.test(text)) return parseOtpauth(text);
  const secret = text.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  const bytes = base32Decode(secret);
  if (!bytes || bytes.length < 10) return null;
  return { secret, digits: 6, period: 30, algorithm: 'SHA-1', issuer: '', account: '' };
}

export function parseOtpauth(uri) {
  let url;
  try { url = new URL(uri); } catch { return null; }
  if (url.protocol !== 'otpauth:' || url.hostname.toLowerCase() !== 'totp') return null;
  const params = url.searchParams;
  const secret = (params.get('secret') || '').toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  const bytes = base32Decode(secret);
  if (!bytes || bytes.length < 10) return null;
  const label = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  const [labelIssuer, account] = label.includes(':') ? label.split(/:(.*)/s) : ['', label];
  const algorithm = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' }[(params.get('algorithm') || 'SHA1').toUpperCase()];
  const digits = Number(params.get('digits') || 6);
  const period = Number(params.get('period') || 30);
  if (!algorithm || ![6, 7, 8].includes(digits) || !(period >= 10 && period <= 120)) return null;
  return { secret, digits, period, algorithm, issuer: (params.get('issuer') || labelIssuer || '').slice(0, 80), account: (account || '').slice(0, 120) };
}

export async function totp(key, at = Date.now()) {
  const { secret, digits = 6, period = 30, algorithm = 'SHA-1' } = key;
  const bytes = base32Decode(secret);
  if (!bytes) throw new Error('bad key');
  const counter = Math.floor(at / 1000 / period);
  const message = new Uint8Array(8);
  new DataView(message.buffer).setUint32(0, Math.floor(counter / 2 ** 32));
  new DataView(message.buffer).setUint32(4, counter >>> 0);
  const hmacKey = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: algorithm }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, message));
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export const secondsLeft = (key, at = Date.now()) => {
  const period = key.period || 30;
  return period - (Math.floor(at / 1000) % period);
};

// A code that will still be valid by the time the site checks it.
export async function freshCode(key, wait = ms => new Promise(r => setTimeout(r, ms))) {
  const left = secondsLeft(key);
  if (left < 4) await wait(left * 1000 + 250);
  return totp(key);
}
