// Decides, without asking anyone, whether a page may receive the user's main
// password. Latch runs unattended, so these checks stand in for a human glance
// at the address bar. Passwords Latch generated never leave their own site anyway.
import { baseDomain } from './domains.js';

// Names worth impersonating: the user's own sites are added at call time.
const BRANDS = [
  'google', 'gmail', 'microsoft', 'outlook', 'office', 'linkedin', 'apple', 'icloud', 'amazon', 'paypal',
  'facebook', 'instagram', 'github', 'dropbox', 'indeed', 'glassdoor', 'workday', 'myworkdayjobs', 'icims',
  'taleo', 'oracle', 'oraclecloud', 'successfactors', 'greenhouse', 'lever', 'smartrecruiters', 'ashbyhq',
];
// Labels that name a function rather than an organisation.
const GENERIC = new Set(['www', 'login', 'signin', 'jobs', 'careers', 'career', 'apply', 'account', 'accounts', 'auth',
  'sso', 'my', 'app', 'portal', 'secure', 'mail', 'id', 'web', 'online', 'candidate', 'hr', 'talent', 'localhost']);

const isIp = host => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || /^\[.*\]$/.test(host);
const isLocal = host => host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost') || host.endsWith('.test');
const brandOf = host => baseDomain(host).split('.')[0];
// Characters swapped in to fake a name: paypa1, g00gle, rnicrosoft.
const unconfuse = s => s.replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/[1|]/g, 'l').replace(/0/g, 'o').replace(/3/g, 'e').replace(/5/g, 's');

function distance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

// Returns null when the page looks like the site it claims to be, else a short reason.
export function mainPasswordRisk({ host, formActionHost = '', knownHosts = [], email = '' }) {
  host = String(host || '').toLowerCase();
  if (!host) return null;
  const base = baseDomain(host);
  // Checked even on local pages: a form that ships the password off-site is never right.
  if (formActionHost && !isLocal(formActionHost) && baseDomain(formActionHost) !== base) {
    return `the form would send the password to ${baseDomain(formActionHost)}, not ${base}`;
  }
  if (isLocal(host)) return null;
  if (isIp(host)) return 'the page is on a bare IP address';
  if (host.split('.').some(label => label.startsWith('xn--'))) return 'the address uses look-alike international characters';

  const known = new Set(BRANDS);
  for (const h of knownHosts) if (h && !isLocal(h)) known.add(brandOf(h));
  const emailDomain = String(email).split('@')[1];
  if (emailDomain) known.add(brandOf(emailDomain));

  const label = brandOf(host);
  const labels = host.split('.');
  for (const brand of known) {
    if (!brand || GENERIC.has(brand) || brand === label) continue;
    // A known name buried in someone else's domain: cibc.com.secure-login.net, google-verify.com.
    if (labels.slice(0, -2).includes(brand) && brand.length >= 4) return `"${brand}" appears inside ${base}, which belongs to someone else`;
    if (brand.length >= 4 && label.split('-').includes(brand)) return `${base} borrows the name "${brand}"`;
    if (unconfuse(label) === brand) return `${base} imitates "${brand}" with look-alike characters`;
    // A letter or two off a long name: myworkdayjobss, linkedln. Short names (lever, apple)
    // have too many honest neighbours (clever, apply) to judge this way.
    if (brand.length >= 7 && distance(label, brand) <= (brand.length >= 10 ? 2 : 1)) return `${base} is spelled like "${brand}" but is a different site`;
  }
  return null;
}
