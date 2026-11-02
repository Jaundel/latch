// Read-only dry run of Latch's page logic against real application sites.
// Opens each site in a signed-out browser, follows links to its sign-in or
// sign-up page, loads extension/page.js and reports what Latch would detect
// and which button it would press. Nothing is typed and nothing is submitted.
//
//   node test/real-sites.mjs            all targets
//   node test/real-sites.mjs workday    targets whose name contains "workday"
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../extension/page.js', import.meta.url)), 'utf8')
  .replace('globalThis.__latch = {', 'globalThis.__latch = { findSubmit, byRef,');

// steps: text or CSS of links/buttons to click on the way (navigation only).
export const TARGETS = [
  { name: 'workday-cibc-signup', url: 'https://cibc.wd3.myworkdayjobs.com/en-US/campus/job/Toronto%2C-ON/Corporate-Security-Coordinator-Co-op_2622551/apply/autofillWithResume', expect: 'signup' },
  { name: 'workday-cibc-signin', url: 'https://cibc.wd3.myworkdayjobs.com/en-US/campus/job/Toronto%2C-ON/Corporate-Security-Coordinator-Co-op_2622551/apply/autofillWithResume', steps: ['[data-automation-id="signInLink"]'], expect: 'login' },
  { name: 'oracle-cx-signin', url: 'https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_45001', steps: ['#user-menu-header'], expect: 'login' },
  { name: 'taleo-textron-signin', url: 'https://textron.taleo.net/careersection/textron/jobsearch.ftl', steps: ['#signin-link'], expect: 'login' },
  { name: 'taleo-textron-newuser', url: 'https://textron.taleo.net/careersection/textron/jobsearch.ftl', steps: ['#signin-link', 'input[value="Create a New Account"]'], expect: 'signup' },
  { name: 'workday-td-signin', url: 'https://td.wd3.myworkdayjobs.com/en-US/TD_Bank_Careers/login', expect: 'login' },
  { name: 'workday-rbc-signin', url: 'https://rbc.wd3.myworkdayjobs.com/en-US/RBCGLOBAL1/login', expect: 'login' },
  { name: 'icims-statefarm-login', url: 'https://careers-statefarm.icims.com/jobs/login?loginOnly=1', expect: 'login' },
  { name: 'icims-shimmick-login', url: 'https://careers-shimmick.icims.com/jobs/login?loginOnly=1', expect: 'login' },
  { name: 'successfactors-sap', url: 'https://jobs.sap.com/talentcommunity/subscribe/', expect: 'none' },
  { name: 'greenhouse-apply', url: 'https://job-boards.greenhouse.io/anthropic', steps: ['a[href*="/jobs/"]', 'text=Apply'], expect: 'none' },
  { name: 'lever-apply', url: 'https://jobs.lever.co/palantir', steps: ['a[href*="jobs.lever.co/palantir/"]', 'a[href$="/apply"]'], expect: 'none' },
];

async function dryRunFrame(frame) {
  return frame.evaluate(src => {
    (0, eval)(src);
    const L = globalThis.__latch;
    const snap = L.inspect();
    const kinds = snap.fields.map(f => f.kind + (f.confirm ? '(confirm)' : '') + (f.isNew ? '(new)' : ''));
    const pw = snap.fields.filter(f => f.kind === 'password');
    const ident = snap.fields.find(f => f.kind === 'email' || f.kind === 'username');
    const code = snap.fields.find(f => f.kind === 'code');
    const state = snap.captcha ? 'captcha' : (snap.digits.length >= 4 || code) ? 'code' : pw.length ? 'password' : ident ? 'identifier' : 'none';
    const describe = (anchorField, purpose) => {
      const anchor = anchorField && L.byRef(anchorField.ref);
      const btn = anchor && L.findSubmit(anchor, purpose);
      if (!btn) return null;
      btn.scrollIntoView({ block: 'center' });
      const r = btn.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const label = el => (el.value || el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40);
      return { press: label(btn), covered: !!(hit && hit !== btn && !btn.contains(hit) && !hit.contains(btn)), coveredBy: hit && hit !== btn && !btn.contains(hit) ? (hit.getAttribute('data-automation-id') || hit.tagName) : '' };
    };
    const anchorFor = purpose => purpose === 'signup' ? pw.at(-1) || ident : pw[0] || ident;
    const required = [...document.querySelectorAll('input, select, textarea')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 3 && r.height > 3 && (el.required || el.getAttribute('aria-required') === 'true')
        && !['password', 'email'].includes(el.type) && !/e-?mail|password/i.test(el.getAttribute('autocomplete') || '');
    }).map(el => ([...(el.labels || [])].map(l => l.innerText).join(' ') || el.getAttribute('aria-label') || el.name || el.id || el.type).trim().replace(/\s+/g, ' ').slice(0, 40));
    return {
      url: location.hostname + location.pathname,
      state, kinds, digits: snap.digits.length, captcha: snap.captcha, auth: snap.auth,
      flags: Object.entries(snap.flags).filter(([, v]) => v).map(([k]) => k),
      login: describe(anchorFor('login'), 'login'),
      signup: describe(anchorFor('signup'), 'signup'),
      otherRequired: required,
    };
  }, source);
}

// Like the extension: look at every frame and keep the one with the most auth-like form.
async function dryRun(page) {
  const rank = { captcha: 5, code: 4, password: 3, identifier: 2, none: 0 };
  let best = null;
  for (const frame of page.frames()) {
    const r = await dryRunFrame(frame).catch(() => null);
    if (r && (!best || rank[r.state] > rank[best.state] || (rank[r.state] === rank[best.state] && (r.auth?.login || r.auth?.signup)))) best = r;
  }
  return best;
}

async function waitForInputs(page) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  for (let i = 0; i < 20; i++) {
    let n = 0;
    for (const frame of page.frames()) n += await frame.locator('input:visible').count().catch(() => 0);
    if (n) break;
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(800);
}

const filter = process.argv[2] || '';
mkdirSync(fileURLToPath(new URL('./output/', import.meta.url)), { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', headless: process.env.HEADED !== '1' });
const context = await browser.newContext({ bypassCSP: true, viewport: { width: 1280, height: 900 }, locale: 'en-CA' });
const results = [];
for (const t of TARGETS.filter(t => t.name.includes(filter))) {
  const page = await context.newPage();
  try {
    await page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await waitForInputs(page);
    for (const step of t.steps || []) {
      if (step.startsWith('wait:')) {
        await page.waitForURL(u => u.href.includes(step.slice(5)), { timeout: 20000 });
        await waitForInputs(page);
        continue;
      }
      const before = page.url();
      // Old pages (Taleo) can ignore a click that lands before their scripts are ready.
      for (let attempt = 0; attempt < 3; attempt++) {
        await page.locator(step).first().click({ timeout: 15000 }).catch(e => { if (!attempt) throw e; });
        const moved = await page.waitForURL(u => u.href !== before, { timeout: 8000 }).then(() => true, () => false);
        if (moved || attempt === 2) break;
      }
      await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(2500);
      await waitForInputs(page);
    }
    const r = await dryRun(page);
    const acts = [r.auth?.login && 'login', r.auth?.signup && 'signup'].filter(Boolean).join('+') || 'none';
    results.push({ name: t.name, expect: t.expect, latchWouldAct: acts, ok: acts === t.expect || (t.expect === 'login' && acts === 'login+signup' && r.state === 'identifier'), ...r });
    if (acts !== t.expect) await page.screenshot({ path: fileURLToPath(new URL(`./output/real-${t.name}.png`, import.meta.url)) }).catch(() => {});
  } catch (err) {
    await page.screenshot({ path: fileURLToPath(new URL(`./output/real-${t.name}.png`, import.meta.url)) }).catch(() => {});
    results.push({ name: t.name, expect: t.expect, error: err.message.split('\n')[0].slice(0, 160) });
  }
  await page.close();
}
await browser.close();
mkdirSync(fileURLToPath(new URL('./output/', import.meta.url)), { recursive: true });
writeFileSync(fileURLToPath(new URL('./output/real-sites.json', import.meta.url)), JSON.stringify(results, null, 2));
for (const r of results) {
  if (r.error) { console.log(`ERROR ${r.name}: ${r.error}`); continue; }
  console.log(`${r.ok ? 'OK   ' : 'MISS '} ${r.name}  expect=${r.expect} latch=${r.latchWouldAct} state=${r.state} fields=[${r.kinds.join(', ')}]${r.digits ? ` digits=${r.digits}` : ''}`);
  console.log(`      login→ ${JSON.stringify(r.login)}  signup→ ${JSON.stringify(r.signup)}  captcha=${r.captcha} flags=${r.flags.join(',')}`);
  if (r.otherRequired.length) console.log(`      AI must fill: ${r.otherRequired.join(' | ')}`);
}
