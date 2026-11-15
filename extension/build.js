// Popup pages load when opened; editing them does not replace the running worker.
// 3: per-call deadlines and cancel, answers bound to the socket a request came on.
export const BRIDGE_PROTOCOL = 3;
export const BUILD_FILES = ['manifest.json', 'background.js', 'page.js', 'bar.js', 'totp.js', 'vendor/jsqr.js', 'id.js', 'build.js', 'domains.js', 'auth-result.js', 'guard.js', 'application-scan.js', 'application.js'];

export async function fingerprint(read) {
  // The store build leaves out the job application files, so a missing file reads as empty.
  const source = JSON.stringify(await Promise.all(BUILD_FILES.map(name => Promise.resolve().then(() => read(name)).catch(() => ''))));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
