# Latch

Latch lets an AI that browses in Chrome sign in, create accounts and get through email verification without seeing your email address or password.

You enter your email and password once, in the Latch extension. When your AI hits a login or sign-up page, it calls a Latch tool instead of typing anything. Latch fills the form in that same tab and submits it. If the site emails a code or link, Latch reads that one message and finishes the step. The AI gets back a short status such as `signed_in` and carries on with its own browser tools.

## Parts

- `extension/` is the Chrome extension: the setup popup, the encrypted vault, and the code that fills forms in the tab.
- `server/` is the MCP server your AI loads. It exposes the tools below, reads verification emails over IMAP, and talks to the extension on `127.0.0.1:47801`.

| Tool | Use it when |
|---|---|
| `sign_in` | A page asks the user to log in, or a session expired |
| `create_account` | On a sign-up page. The AI fills the other fields first and leaves email and password empty |
| `verify_email` | A page says a code or link was sent to the user's email |
| `fill_email` | A form (a job application, say) needs the user's email address |

The popup's **This tab** section runs the same flows on the page you're looking at: Sign in here, Create account here, Verify email.

Each tool takes an optional `tabId` (the Chrome tab ID from the AI's browser tools) and returns JSON with `status`, `site` and a one-line `message`.

Results also include visible `paths` (email, password, supported social providers, SSO, account creation and guest access), `next_action`, and `evidence` containing attempted actions and observed page signals. These describe available choices; Latch does not click social sign-in automatically. A `lock_text` signal means lock-related wording was observed, not that the account is known to be locked.

Mixed errors such as “incorrect email or password, or account might be locked” return `credentials_or_account_problem`, preserve the redacted site message, and set `retryable: false`. Latch blocks another sign-in attempt to that host for 60 seconds within the running worker. It does not infer account existence or recommend changing the password from an ambiguous error.

The `account` object separates `creation`, `email_verification`, and `session`. Unknown states stay `unknown`; account creation does not imply email verification or an authenticated session. Existing pending credentials remain available for resuming signup.

`timings.scope` is `tool_call`. Milliseconds cover total call time, page detection, combined filling/submission, page waiting, and verification. Filling and submission remain one operation to limit password exposure. Detection overlaps page waiting, and verification can include submission; these counters must not be added together. Navigation before the call, external Gmail or SSO steps, and human intervention are outside this measurement. An orchestrating agent must measure those separately to report a whole journey.

Latch waits through empty redirect pages and forms that are still rendering. A disappearing sign-in form alone is not proof of authentication: `signed_in` requires an authenticated account control. If the page never provides a usable next step or success evidence, the tool returns `unconfirmed`; the AI must inspect the tab before continuing.

Many application sites, including Greenhouse and Lever, accept applications without an account. On those forms, `sign_in` and `create_account` return `no_form` and leave the application untouched. Use `fill_email` to fill the email field separately; it does not submit the application.

After updating the authentication runtime, reload Latch on `chrome://extensions`. The server compares a content fingerprint before filling credentials and returns `reload_required` if Chrome is still running an older copy. Timestamp-only changes and popup edits do not require a reload. It waits for the extension's ready message before sending an operation.

## Install

Requires Node 20 or later and Chrome 116 or later.

```
npm install
npm run setup
```

`npm run setup` prints the steps:

1. Load `extension/` with "Load unpacked" on `chrome://extensions` (Developer mode on).
2. Click the Latch icon and enter your email, password and an app password for your inbox.
3. Connect your AI. The last setup screen in the popup shows the exact command for Claude Code, Codex and Claude Desktop, and turns green once one connects. From a terminal you can also run `npm run setup -- --claude-code`, `--claude-desktop` or `--codex`.

After setup, nothing asks for approval. The popup's home screen shows what the page in front of you offers (a sign-in page, a sign-up page, a code prompt) with one button to run Latch on it, followed by recent activity and the accounts Latch knows.

The inbox step is optional. Gmail app passwords need 2-Step Verification, many school and work Google accounts block them, and Outlook.com no longer accepts them for mail. Without an inbox connection, when a site emails a code or confirmation link, Latch returns `check_inbox` with your webmail address (for example `https://mail.google.com`). The AI uses its connected mail tools when available, otherwise webmail, to read only the newest matching verification message and finish the step itself. The user does not need to retrieve the email. In that case the AI sees that email; your password still stays private.

## What the AI sees

- Tool results never include the email, passwords, codes or links. The one exception is the `check_inbox` fallback above, where the AI reads the code from your webmail itself. Every result goes through a fixed schema and a redaction pass before it leaves the extension or the server.
- While Latch fills a form, the AI is blocked waiting on the tool call. On normal forms the password goes in and the form is submitted in one script task, and the fields are emptied as soon as the browser has captured them. On single-page forms the password stays in the field until the site answers (about 0.4 s in the test), and Latch empties the fields before it returns.
- Passwords Latch generates only go to the site they were made for. Your main password is used without prompts, but Latch first checks the page itself and refuses, with `blocked` / `suspicious_site`, when the address imitates a site you have an account on, your email's domain or a commonly impersonated brand (near-miss spellings, swapped characters like `paypa1`, the real name buried in someone else's domain); when the page is on a bare IP address or uses look-alike international characters; or when the form would send the password to a different site. `test/real-sites.mjs` checks that real application sites are not refused.
- Latch fills credentials only on https pages, and on http when the page is local.

Latch can't hide what a site shows you after you sign in, like a profile menu with your email in it. `fill_email` also leaves the address in the field, where the AI could read it back. Anything running as you on this computer can read Chrome's extension storage. That includes an AI with a shell or full desktop control. Latch keeps your details from an AI whose only reach is the browser.

## What it hands back to you

CAPTCHAs, codes sent to your phone, authenticator apps, passkeys, push approvals and locked accounts come back as `needs_user`, with a reason. Latch stops before filling anything it can't finish. It doesn't use "Continue with Google"-style buttons. It fills the site's own form.

## Publish

`npm run package` builds `dist/latch-<version>.zip` for the Chrome Web Store, without the development key. `docs/STORE.md` has the listing text, permission justifications and data disclosures. `docs/PRIVACY.md` is the privacy policy to host and link. After the first upload, put the store's extension ID in `STORE_ID` in `extension/id.js`.

## Test

```
npm test
```

The test starts local practice sites and a fake IMAP inbox, loads the extension in Chromium, and calls the tools through a real MCP client. It covers sign-up with code and link verification, sign-in, two-step single-page logins, retries, wrong passwords, CAPTCHA and phone hand-offs, the webmail fallback, iframes, lookalike sites, insecure pages and pausing. It then checks the tool results, the page, the server log and the saved data for anything private. Set `HEADED=1` to watch it run.
