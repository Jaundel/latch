import assert from 'node:assert/strict';
import { test } from 'node:test';
import { siteFor } from '../extension/domains.js';

const vault = { sites: { 'trimble.wd1.myworkdayjobs.com': { password: 'synthetic-trimble-password' } } };
test('Workday employer passwords stay scoped to their tenant host', () => {
  assert.equal(siteFor(vault, 'trimble.wd1.myworkdayjobs.com').password, 'synthetic-trimble-password');
  assert.equal(siteFor(vault, 'cibc.wd3.myworkdayjobs.com'), null);
  assert.equal(siteFor(vault, 'altera.wd1.myworkdayjobs.com'), null);
});
test('a sole saved password remains usable across an ordinary site login subdomain', () => {
  const site = siteFor({ sites: { 'www.example.com': { password: 'synthetic-password' } } }, 'login.example.com');
  assert.equal(site.password, 'synthetic-password');
});
