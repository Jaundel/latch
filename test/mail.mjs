import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { extractLink, findVerification, headerScore, judgeMessage, RESET_LINK, RESET_SUBJECT } from '../server/mail.js';
import { Mailbox, startImap } from './fixture.js';

const HOST = 'acme.wd5.myworkdayjobs.com';
const from = (name, address) => ({ from: { value: [{ name, address }] } });

const verifyMail = {
  subject: 'Verify your email',
  text: 'Your verification code is 482913.',
  html: '<a href="https://acme.wd5.myworkdayjobs.com/verify?t=abc">Verify email</a> <a href="https://acme.wd5.myworkdayjobs.com/forgot?t=x">Forgot your password?</a>',
};
const resetMail = {
  subject: 'Reset your password',
  text: 'Use the link below.',
  html: '<a href="https://acme.wd5.myworkdayjobs.com/">Home</a> <a href="https://acme.wd5.myworkdayjobs.com/passwordreset?token=t0k">Reset password</a>',
};

test('reset wording matches the usual subjects and links', () => {
  for (const s of ['Reset your password', 'Password reset request', 'Forgot your password?', 'Recover your account', 'Change your password', 'Your new password link',
    'Reset your Acme password', 'Reset your Acme Careers password', 'Password recovery', 'Account recovery', 'Password change request', 'Password assistance for your Acme Careers profile']) {
    assert.ok(RESET_SUBJECT.test(s), s);
  }
  for (const s of ['Verify your email', 'Your sign-in code', 'Welcome to Acme', 'Your password was changed']) assert.ok(!RESET_SUBJECT.test(s), s);
  assert.ok(RESET_LINK.test('https://x.com/account/change-password'));
  assert.ok(RESET_LINK.test('https://acme.taleo.net/careersection/iam/setPassword.jsf?token=abc123'));
  assert.ok(!RESET_LINK.test('https://x.com/verify?t=1'));
});

test('verify never returns a reset link', () => {
  const html = '<a href="https://acme.wd5.myworkdayjobs.com/reset?t=1">Confirm</a> <a href="https://acme.wd5.myworkdayjobs.com/a">Reset your password</a>';
  assert.equal(extractLink({ html }, HOST), null);
  assert.equal(extractLink(verifyMail, HOST), 'https://acme.wd5.myworkdayjobs.com/verify?t=abc');
  assert.equal(extractLink({ text: 'Forgot your password? https://acme.wd5.myworkdayjobs.com/x?t=2' }, HOST), null);
});

test('verify skips messages with a reset subject', () => {
  assert.equal(headerScore({ ...from('Acme', 'noreply@myworkdayjobs.com'), subject: 'Reset your password' }, HOST), 0);
  assert.ok(headerScore({ ...from('Acme', 'noreply@myworkdayjobs.com'), subject: 'Verify your email' }, HOST) >= 3);
  assert.equal(judgeMessage(resetMail, HOST), null);
  assert.equal(judgeMessage({ ...resetMail, text: 'Your code is 482913' }, HOST), null);
});

test('verify refuses reset mail however it is worded', () => {
  const setPassword = 'https://acme.wd5.myworkdayjobs.com/iam/setPassword.jsf?token=abc123';
  const opaque = 'https://acme.wd5.myworkdayjobs.com/a/t/abc123';
  for (const subject of ['Password assistance for your Acme Careers profile', 'Reset your Acme password', 'Password recovery', 'Account recovery', 'Password change request']) {
    assert.equal(headerScore({ ...from('Acme', 'noreply@myworkdayjobs.com'), subject }, HOST), 0, subject);
    assert.equal(judgeMessage({ subject, html: `<a href="${opaque}">Click here</a>` }, HOST, { expect: 'link' }), null, subject);
  }
  assert.equal(extractLink({ html: `<a href="${setPassword}">Continue</a>` }, HOST), null);
  for (const text of ['We received a request to reset your Acme password.', 'Click the link below to choose a new password.', 'Here is your password reset link.']) {
    assert.equal(judgeMessage({ subject: 'Your Acme account', text, html: `<a href="${opaque}">Continue</a>` }, HOST, { expect: 'link' }), null, text);
  }
});

test('a footer about forgotten passwords does not hide a verification link', () => {
  const body = { subject: 'Confirm your email', text: 'Confirm your email to continue. Forgot your password?', html: '<a href="https://acme.wd5.myworkdayjobs.com/verify?t=abc">Confirm</a>' };
  assert.deepEqual(judgeMessage(body, HOST, { expect: 'link' }), { found: { link: 'https://acme.wd5.myworkdayjobs.com/verify?t=abc' }, bonus: 3 });
});

test('verify prefers a code and adds the same-site bonus', () => {
  assert.deepEqual(judgeMessage(verifyMail, HOST), { found: { code: '482913' }, bonus: 3 });
  assert.deepEqual(judgeMessage(verifyMail, HOST, { expect: 'link' }), { found: { link: 'https://acme.wd5.myworkdayjobs.com/verify?t=abc' }, bonus: 3 });
});

test('reset returns only a same-site https reset link and never a code', () => {
  assert.deepEqual(judgeMessage(resetMail, HOST, { purpose: 'reset' }), { found: { link: 'https://acme.wd5.myworkdayjobs.com/passwordreset?token=t0k' }, bonus: 5 });
  const withCode = { ...resetMail, text: 'Your code is 482913', html: '' };
  assert.equal(judgeMessage(withCode, HOST, { purpose: 'reset' }), null);
});

test('reset links must be https on the site base domain', () => {
  const offSite = { subject: 'Reset your password', html: '<a href="https://evil.example/reset?t=1">Reset password</a>' };
  assert.equal(extractLink(offSite, HOST, 'reset'), null);
  const plain = { subject: 'Reset your password', html: '<a href="http://acme.wd5.myworkdayjobs.com/reset?t=1">Reset password</a>' };
  assert.equal(extractLink(plain, HOST, 'reset'), null);
  const local = { subject: 'Reset your password', html: '<a href="http://jobs.localhost/reset?t=1">Reset password</a>' };
  assert.equal(extractLink(local, 'jobs.localhost', 'reset'), null);
});

test('reset needs a reset subject or a link that says reset', () => {
  const generic = { subject: 'Your Acme account', html: '<a href="https://acme.wd5.myworkdayjobs.com/t?token=1">Click here</a>' };
  assert.equal(extractLink(generic, HOST, 'reset'), null);
  const named = { subject: 'Your Acme account', html: '<a href="https://acme.wd5.myworkdayjobs.com/t?token=1">Reset your password</a>' };
  assert.equal(extractLink(named, HOST, 'reset'), 'https://acme.wd5.myworkdayjobs.com/t?token=1');
  const subjectOnly = { subject: 'Password reset', text: 'Click here: https://acme.wd5.myworkdayjobs.com/t?token=2' };
  assert.equal(extractLink(subjectOnly, HOST, 'reset'), 'https://acme.wd5.myworkdayjobs.com/t?token=2');
  assert.equal(extractLink({ subject: 'Password reset', html: '<a href="https://acme.wd5.myworkdayjobs.com/">Acme</a>' }, HOST, 'reset'), null);
});

test('reset prefers the exact host over another tenant on the same base domain', () => {
  const html = '<a href="https://other.wd5.myworkdayjobs.com/reset?t=1">Reset password</a> <a href="https://acme.wd5.myworkdayjobs.com/reset?t=2">Reset password</a>';
  assert.equal(extractLink({ subject: 'Reset your password', html }, HOST, 'reset'), 'https://acme.wd5.myworkdayjobs.com/reset?t=2');
});

test('reset links on a job portal stay on the tenant that asked', () => {
  const mail = href => ({ subject: 'Reset your password', html: `<a href="${href}">Reset password</a>` });
  assert.equal(judgeMessage(mail('https://objectstorage.us-ashburn-1.oraclecloud.com/n/x/b/y/o/reset.html'), 'acme.fa.us2.oraclecloud.com', { purpose: 'reset' }), null);
  assert.equal(judgeMessage(mail('https://beta.wd5.myworkdayjobs.com/reset?t=1'), HOST, { purpose: 'reset' }), null);
  assert.ok(judgeMessage(mail('https://acme.fa.us2.oraclecloud.com/reset?t=1'), 'acme.fa.us2.oraclecloud.com', { purpose: 'reset' }));
});

test('the exact host outranks a sibling subdomain between messages', () => {
  const mail = href => ({ subject: 'Reset your password', html: `<a href="${href}">Reset password</a>` });
  const exact = judgeMessage(mail('https://jobs.example.com/reset?t=1'), 'jobs.example.com', { purpose: 'reset' });
  const sibling = judgeMessage(mail('https://accounts.example.com/reset?t=2'), 'jobs.example.com', { purpose: 'reset' });
  assert.ok(exact.bonus > sibling.bonus);
});

test('reset header score favours reset subjects', () => {
  const head = { ...from('Acme', 'noreply@myworkdayjobs.com'), subject: 'Reset your password' };
  assert.ok(headerScore(head, HOST, 'reset') > headerScore({ ...head, subject: 'Welcome' }, HOST, 'reset'));
});

test('findVerification ranks a reset link on the exact host above a newer one on a sibling', async () => {
  const box = new Mailbox();
  const server = await startImap({ user: USER, pass: PASS, mailbox: box, stats: { logins: 0, failedLogins: 0, bodiesRead: 0 } });
  try {
    const link = href => `<a href="${href}">Reset password</a>`;
    box.add({ from: 'Acme <noreply@example.com>', to: USER, subject: 'Reset your password', text: 'Reset it.', html: link('https://jobs.example.com/reset?t=real') });
    box.add({ from: 'Acme <noreply@example.com>', to: USER, subject: 'Reset your password', text: 'Reset it.', html: link('https://shop.example.com/reset?t=other') });
    const hit = await findVerification({ imap: { host: '127.0.0.1', port: server.port, secure: false, user: USER, pass: PASS },
      site: { host: 'jobs.example.com' }, since: Date.now() - 60e3, waitMs: 500, expect: 'link', purpose: 'reset' });
    assert.equal(hit.link, 'https://jobs.example.com/reset?t=real');
  } finally { server.server.close(); }
});

const USER = 'reader@fixture.localhost';
const PASS = 'fixture-pass';
let imap;
const mailbox = new Mailbox();
const stats = { logins: 0, failedLogins: 0, bodiesRead: 0 };

before(async () => {
  imap = await startImap({ user: USER, pass: PASS, mailbox, stats });
  mailbox.add({ from: 'Acme <noreply@myworkdayjobs.com>', to: USER, subject: 'Reset your password', text: 'Reset it.', html: resetMail.html });
  mailbox.add({ from: 'Acme <noreply@myworkdayjobs.com>', to: USER, subject: 'Verify your email', text: 'Your verification code is 482913.' });
});
after(() => imap.server.close());

const request = extra => ({
  imap: { host: '127.0.0.1', port: imap.port, secure: false, user: USER, pass: PASS },
  site: { host: HOST }, since: Date.now() - 60e3, waitMs: 500, ...extra,
});

test('findVerification over IMAP returns the code for verify and the link for reset', async () => {
  const verify = await findVerification(request({ expect: 'code' }));
  assert.equal(verify.found, true);
  assert.equal(verify.code, '482913');
  assert.equal(verify.link, undefined);

  const reset = await findVerification(request({ expect: 'link', purpose: 'reset' }));
  assert.equal(reset.found, true);
  assert.equal(reset.link, 'https://acme.wd5.myworkdayjobs.com/passwordreset?token=t0k');
  assert.equal('code' in reset, false);
  assert.match(reset.key, /^[0-9a-f]{16}$/);

  const again = await findVerification(request({ expect: 'link', purpose: 'reset', exclude: [reset.key] }));
  assert.equal(again.found, false);
});

test('findVerification verify with expect link never opens the reset mail', async () => {
  const r = await findVerification(request({ expect: 'link' }));
  assert.equal(r.found, false);
});
