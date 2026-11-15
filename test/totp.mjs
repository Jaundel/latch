import assert from 'node:assert/strict';
import { test } from 'node:test';
import { base32Decode, parseKey, parseOtpauth, totp } from '../extension/totp.js';

// RFC 6238 appendix B, SHA-1 seed "12345678901234567890".
const SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('matches the RFC 6238 SHA-1 vectors', async () => {
  const key = { secret: SEED, digits: 8, period: 30, algorithm: 'SHA-1' };
  for (const [seconds, code] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']]) {
    assert.equal(await totp(key, seconds * 1000), code, `at ${seconds}`);
  }
});

test('matches the RFC 6238 SHA-256 vector', async () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA';
  assert.equal(await totp({ secret, digits: 8, period: 30, algorithm: 'SHA-256' }, 59000), '46119246');
});

test('reads keys the way sites show them', () => {
  assert.deepEqual(base32Decode('mfrg gzdf'), new Uint8Array([0x61, 0x62, 0x63, 0x64, 0x65]));
  assert.equal(parseKey('jbsw y3dp ehpk 3pxp').secret, 'JBSWY3DPEHPK3PXP');
  assert.equal(parseKey('not a key'), null);
  assert.equal(parseKey('ABCD'), null, 'too short to be a real key');
  const uri = parseOtpauth('otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&digits=6&period=30');
  assert.equal(uri.issuer, 'GitHub');
  assert.equal(uri.account, 'octocat');
  assert.equal(parseOtpauth('otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP'), null, 'counter-based codes are not supported');
});
