const TWO_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'co.in',
  'com.br', 'com.mx', 'co.za', 'com.sg', 'com.hk', 'com.tr', 'com.cn', 'co.kr', 'com.ar', 'on.ca',
]);

export function baseDomain(host) {
  host = String(host || '').toLowerCase();
  if (/^[\d.]+$/.test(host) || host.includes(':')) return host;
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  return parts.slice(TWO_PART_TLDS.has(parts.slice(-2).join('.')) ? -3 : -2).join('.');
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
