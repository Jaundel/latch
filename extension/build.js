// Popup pages load when opened; editing them does not replace the running worker.
export const BUILD_FILES = ['manifest.json', 'background.js', 'page.js', 'id.js', 'build.js', 'domains.js', 'auth-result.js'];

export async function fingerprint(read) {
  const source = JSON.stringify(await Promise.all(BUILD_FILES.map(read)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
