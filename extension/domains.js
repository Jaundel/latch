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

export function siteFor(vault, host) {
  if (vault.sites[host]) return { host, ...vault.sites[host] };
  // The same Workday service hosts independent employers with separate accounts.
  if (host.endsWith('.myworkdayjobs.com')) return null;
  const base = baseDomain(host);
  const same = Object.entries(vault.sites).filter(([h, s]) => baseDomain(h) === base && s.password);
  return same.length === 1 ? { host: same[0][0], ...same[0][1] } : null;
}
