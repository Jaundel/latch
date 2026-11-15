import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAtsHost, isCandidatePortal, recoverySite, resetLinkAllowed, sharedHost, siteFor } from '../extension/domains.js';

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
test('employee systems on job portal domains are not candidate portals unless the page is a career page', () => {
  for (const url of ['https://acme.wd1.myworkdayjobs.com/en-US/careers/login', 'https://careers-acme.icims.com/forgot', 'https://acme.taleo.net/x',
    'https://recruiting.paylocity.com/recruiting/jobs/All', 'https://acme.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/a',
    'https://jobs.dayforcehcm.com/en-US/acme/CANDIDATEPORTAL', 'https://acme.bamboohr.com/careers', 'https://career5.successfactors.com/sfcareer/x']) {
    assert.equal(isCandidatePortal(url), true, url);
  }
  for (const url of ['https://wd5.myworkday.com/acme/login.htmld', 'https://my.adp.com/forgot', 'https://workforcenow.adp.com/login', 'https://app.rippling.com/forgot',
    'https://acme.bamboohr.com/login.php', 'https://acme.fa.us2.oraclecloud.com/fscmUI/faces/FuseWelcome', 'https://example.com/careers', 'not a url']) {
    assert.equal(isCandidatePortal(url), false, url);
  }
});
test('a reset link stays on its tenant for a job portal and on its base domain elsewhere', () => {
  assert.equal(resetLinkAllowed('acme.fa.us2.oraclecloud.com', 'acme.fa.us2.oraclecloud.com'), true);
  assert.equal(resetLinkAllowed('login.acme.taleo.net', 'acme.taleo.net'), true);
  assert.equal(resetLinkAllowed('objectstorage.us-ashburn-1.oraclecloud.com', 'acme.fa.us2.oraclecloud.com'), false);
  assert.equal(resetLinkAllowed('beta.wd1.myworkdayjobs.com', 'acme.wd1.myworkdayjobs.com'), false);
  assert.equal(resetLinkAllowed('accounts.example.com', 'jobs.example.com'), true);
  assert.equal(resetLinkAllowed('example.org', 'jobs.example.com'), false);
});
test('a pending recovery is found on the host and on an ordinary sibling, never across job portal tenants', () => {
  const sites = { 'jobs.example.com': { recovery: { requestedAt: 5 } }, 'help.example.com': { recovery: { requestedAt: 9 } }, 'acme.icims.com': { recovery: { requestedAt: 1 } } };
  assert.equal(recoverySite({ sites }, 'jobs.example.com').host, 'jobs.example.com');
  assert.equal(recoverySite({ sites }, 'accounts.example.com').host, 'help.example.com');
  assert.equal(recoverySite({ sites }, 'acme.icims.com').host, 'acme.icims.com');
  assert.equal(recoverySite({ sites }, 'beta.icims.com'), null);
  assert.equal(recoverySite({ sites: { 'jobs.example.com': {} } }, 'jobs.example.com'), null);
});
test('a Workday site host is shared by employers', () => {
  assert.equal(sharedHost('wd3.myworkdaysite.com'), true);
  assert.equal(sharedHost('acme.wd1.myworkdayjobs.com'), false);
});
test('job portal hosts are recognized by exact domain or subdomain only', () => {
  for (const host of ['acme.wd1.myworkdayjobs.com', 'myworkdayjobs.com', 'www.dayforcehcm.com', 'careers-acme.icims.com',
    'acme.taleo.net', 'job-boards.greenhouse.io', 'jobs.lever.co', 'Jobs.AshbyHQ.com', 'acme.breezy.hr', 'app.eightfold.ai']) {
    assert.equal(isAtsHost(host), true, host);
  }
  for (const host of ['example.com', 'evilmyworkdayjobs.com', 'myworkdayjobs.com.evil.test', 'lever.co.uk', 'notadp.com', '', null]) {
    assert.equal(isAtsHost(host), false, String(host));
  }
});
