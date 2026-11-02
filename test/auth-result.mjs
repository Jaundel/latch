import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifySignInError } from '../extension/auth-result.js';

test('mixed Workday failures never diagnose the password or account', () => {
  for (const message of [
    'The email or password you entered is incorrect, or your account might be locked.',
    'Invalid username or password.',
    'Your account may be locked or your email address and password may be incorrect.',
    'Wrong email address.',
    'Account not found or password invalid.',
  ]) assert.equal(classifySignInError(message, true), 'credentials_or_account_problem', message);
});

test('definite rejections retain their specific meaning', () => {
  assert.equal(classifySignInError('Wrong password. Try again.'), 'wrong_password');
  assert.equal(classifySignInError('The password is incorrect.'), 'wrong_password');
  assert.equal(classifySignInError('No account found for this email.'), 'no_account');
  assert.equal(classifySignInError('Your account is locked.'), 'locked');
  assert.equal(classifySignInError('Too many attempts. Try again later.'), 'locked');
  assert.equal(classifySignInError('Service is unavailable.'), 'sign_in_failed');
});
