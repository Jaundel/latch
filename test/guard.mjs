import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mainPasswordRisk } from '../extension/guard.js';

const known = ['cibc.wd3.myworkdayjobs.com', 'login.icims.com', 'textron.taleo.net'];
const risk = (host, extra = {}) => mainPasswordRisk({ host, knownHosts: known, email: 'someone@torontomu.ca', ...extra });

test('real application sites pass', () => {
  for (const host of ['td.wd3.myworkdayjobs.com', 'rbc.wd3.myworkdayjobs.com', 'login.icims.com', 'textron.taleo.net',
    'eeho.fa.us2.oraclecloud.com', 'job-boards.greenhouse.io', 'jobs.lever.co', 'accounts.google.com', 'www.linkedin.com',
    'careers.cibc.com', 'my.torontomu.ca', 'jobs.localhost', 'auth.frame.localhost',
    'clever.com', 'level.com', 'apply.com', 'cloud.com', 'officedepot.com', 'goggle.com', 'oracles.com']) {
    assert.equal(risk(host), null, host);
  }
});

test('look-alikes of known sites, brands and the user\'s own domain are refused', () => {
  for (const host of ['cibc.wd3.myworkdayjobss.com', 'myworkdayjobs.secure-login.net', 'linkedln.com', 'icims-login.com',
    'google-verify.com', 'torontomv.ca', 'torontomu-portal.com', 'paypa1.com', 'g00gle.com', 'rnicrosoft.com', 'linkedinn.com']) {
    assert.ok(risk(host), host);
  }
});

test('bare IPs and punycode addresses are refused', () => {
  assert.ok(risk('203.0.113.7'));
  assert.ok(risk('xn--lnkedin-7ya.com'));
  assert.equal(risk('127.0.0.1'), null);
});

test('a form that posts to another site is refused', () => {
  assert.ok(risk('careers.example.com', { formActionHost: 'collector.attacker.net' }));
  assert.equal(risk('careers.example.com', { formActionHost: 'login.example.com' }), null);
});
