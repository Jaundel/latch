# Latch beta routing checkpoint

2026-11-02. Preserve Claude's dirty multi-browser branch. Read AGENTS.md before editing.
User authorized Codex to fix Latch while testing job-apply in installed Google Chrome.

Latest checkpoint, 2026-11-02 04:59 Toronto:
- Added read-only MCP inspect_connection, used by jobctl latch-check and a mandatory job-apply
  credential preflight. It reports build/protocol and target lookup without authentication.
- Worker sends BRIDGE_PROTOCOL2; server requires matching fingerprint AND protocol before any
  credential dispatch. A matching disk hash alone did not prove the cached worker handles locate.
- Bridge regression covers inspection with two browsers, no-match refusals, delayed reconnect
  after5.2s, stale builds and missing protocol. All passed. Inspector waits up to30s for reconnect.
- Actual connected Chrome: exact Altera URL now reports reload_required/stale_worker,
  connected1,ready1,current0,lookup_replies0,matched0. No credential action sent. Sign-in remains open.
- `npm run test:chrome` passes13 checks and bridge. Page/popup fixtures now launch installed
  Google Chrome; discovered and corrected inherited Chromium launches. Full loading/E2E extension
  fixtures still use Chromium and were not run for this beta. Do not cite those as live acceptance.
- Manual reload/file access setting is still required. Existing security denial forbids alternate
  UI/CDP/shell routes. No new attempt to automate settings. Do not run auth as a connection probe.

Earlier checkpoint:

Actual evidence: a sign_in call for an inexact Altera Workday URL returned no_form for
github.com with zero actions. The server's single-browser fast path skipped locate entirely.
The exact current Workday URL includes /en-US and /apply/useMyLastApplication.

Codex changed server/index.js to require a positive locate for every named target, including
a sole browser. Missing targets return tab_not_found before dispatching any credential call.
Unscoped popup/current-tab operation keeps its original behavior. Build/reload guards remain.
test/bridge.mjs reproduced the old failure then passed. Bridge plus 13 unit checks passed.
The actual full Altera URL now returns tab_not_found, no action sent. This is a verified
refusal, not a successful employer login. No Latch account creation has been verified live.

Correct-profile extension routing/reload remains open. Browser explicitly denied automating
chrome://extensions and alternate routes. Manual reload requested, no answer. Do not bypass
that denial. No real application Submit is allowed in this beta.

Coordination: jobctl coordinate inbox in sibling job-apply; message8 has details. Claude has
not acknowledged messages4-8 yet. No claim that an idle desktop chat was awakened.
