const TWO_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'co.in',
  'com.br', 'com.mx', 'co.za', 'com.sg', 'com.hk', 'com.tr', 'com.cn', 'co.kr', 'com.ar', 'on.ca',
]);
// Under a country code these second levels are registries, not organisations (gov.au, ac.jp).
const CC_SECOND_LEVELS = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'gob', 'mil', 'nic', 'sch', 'ltd', 'plc', 'nhs', 'gv', 'qc', 'bc', 'ab']);
// Hosting services where every customer gets a subdomain. Each customer is its own site, so
// approving or knowing one must never vouch for another (a slice of the Public Suffix List).
const SHARED_SUFFIXES = new Set([
  'github.io', 'gitlab.io', 'bitbucket.io', 'vercel.app', 'now.sh', 'netlify.app', 'netlify.com', 'pages.dev', 'workers.dev',
  'herokuapp.com', 'appspot.com', 'web.app', 'firebaseapp.com', 'azurewebsites.net', 'azurestaticapps.net', 'cloudfront.net',
  'amazonaws.com', 's3.amazonaws.com', 'elasticbeanstalk.com', 'blogspot.com', 'wordpress.com', 'wixsite.com', 'weebly.com',
  'squarespace.com', 'myshopify.com', 'webflow.io', 'framer.app', 'framer.website', 'carrd.co', 'notion.site', 'onrender.com',
  'fly.dev', 'glitch.me', 'repl.co', 'replit.app', 'replit.dev', 'surge.sh', 'deno.dev', 'ngrok.io', 'ngrok-free.app',
  'trycloudflare.com', 'pythonanywhere.com', 'readthedocs.io', 'gitbook.io', 'sharepoint.com', 'googleusercontent.com',
  'blob.core.windows.net', 'web.core.windows.net', 'translate.goog', 'duckdns.org', 'no-ip.org', 'ddns.net', 'hopto.org',
  'github.dev', 'codesandbox.io', 'csb.app', 'stackblitz.io', 'streamlit.app', 'hf.space', 'lovable.app', 'bolt.new',
]);

// The registrable domain: the part an organisation owns, with the shared suffix it sits under.
export function baseDomain(host) {
  host = String(host || '').toLowerCase().replace(/\.$/, '');
  if (/^[\d.]+$/.test(host) || host.includes(':')) return host;
  const parts = host.split('.');
  for (let n = Math.min(4, parts.length - 1); n >= 2; n--) {
    if (SHARED_SUFFIXES.has(parts.slice(-n).join('.'))) return parts.slice(-(n + 1)).join('.');
  }
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2);
  const twoPart = TWO_PART_TLDS.has(lastTwo.join('.')) || (lastTwo[1].length === 2 && CC_SECOND_LEVELS.has(lastTwo[0]));
  return parts.slice(twoPart ? -3 : -2).join('.');
}

// Applicant tracking systems where job portal accounts live.
const ATS_DOMAINS = [
  'myworkdayjobs.com', 'myworkdaysite.com', 'myworkday.com', 'workday.com', 'dayforcehcm.com', 'icims.com', 'taleo.net',
  'successfactors.com', 'successfactors.eu', 'sapsf.com', 'oraclecloud.com', 'greenhouse.io', 'lever.co', 'smartrecruiters.com',
  'ashbyhq.com', 'jobvite.com', 'bamboohr.com', 'workable.com', 'recruitee.com', 'ultipro.com', 'ukg.net', 'brassring.com',
  'avature.net', 'fitzii.com', 'adp.com', 'paylocity.com', 'breezy.hr', 'applytojob.com', 'teamtailor.com', 'jazzhr.com',
  'rippling.com', 'eightfold.ai', 'phenompeople.com',
];

export function isAtsHost(host) {
  host = String(host || '').toLowerCase();
  return ATS_DOMAINS.some(d => host === d || host.endsWith(`.${d}`));
}

// Employee systems that share a domain with career sites: here only a career page counts as a job portal.
const EMPLOYEE_DOMAINS = ['myworkday.com', 'workday.com', 'dayforcehcm.com', 'adp.com', 'paylocity.com', 'rippling.com', 'ultipro.com', 'ukg.net',
  'bamboohr.com', 'sapsf.com', 'successfactors.com', 'successfactors.eu', 'oraclecloud.com'];
const CAREER_PAGE = /career|recruit|candidate|applicant|jobs?\b|talent|hiring/i;

export function isCandidatePortal(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  const host = u.hostname.toLowerCase();
  if (!isAtsHost(host)) return false;
  return !EMPLOYEE_DOMAINS.some(d => host === d || host.endsWith(`.${d}`)) || CAREER_PAGE.test(`${host}${u.pathname}`);
}

// One host serves many employers, with the tenant in the path, so its entry cannot stand for one account.
export const sharedHost = host => String(host || '').toLowerCase().endsWith('.myworkdaysite.com');

// Where a reset link for `host` may point. Tenants of a job portal are separate sites on one base domain.
export function resetLinkAllowed(linkHost, host) {
  linkHost = String(linkHost || '').toLowerCase();
  host = String(host || '').toLowerCase();
  if (isAtsHost(host)) return linkHost === host || linkHost.endsWith(`.${host}`);
  return baseDomain(linkHost) === baseDomain(host);
}

// The entry waiting on a recovery email for this host, the newest if several on one site are.
export function recoverySite(vault, host) {
  if (vault.sites[host]?.recovery) return { host, ...vault.sites[host] };
  if (isAtsHost(host)) return null;
  const base = baseDomain(host);
  const [hit] = Object.entries(vault.sites).filter(([h, s]) => baseDomain(h) === base && s.recovery)
    .sort(([, a], [, b]) => (b.recovery.requestedAt || 0) - (a.recovery.requestedAt || 0));
  return hit ? { host: hit[0], ...hit[1] } : null;
}

export function siteFor(vault, host) {
  if (vault.sites[host]) return { host, ...vault.sites[host] };
  // The same Workday service hosts independent employers with separate accounts.
  if (host.endsWith('.myworkdayjobs.com')) return null;
  const base = baseDomain(host);
  const same = Object.entries(vault.sites).filter(([h, s]) => baseDomain(h) === base && s.password);
  return same.length === 1 ? { host: same[0][0], ...same[0][1] } : null;
}
