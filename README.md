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

Each tool takes an optional `tabId` (the Chrome tab ID from the AI's browser tools) and returns JSON with `status`, `site` and a one-line `message`.

## Install

Requires Node 20 or later and Chrome 116 or later.

```
npm install
npm run setup
```

`npm run setup` prints the steps:

1. Load `extension/` with "Load unpacked" on `chrome://extensions` (Developer mode on).
2. Click the Latch icon and enter your email, password and an app password for your inbox.
3. Add the MCP server to your AI. Run `npm run setup -- --claude-code`, `--claude-desktop` or `--codex`.

Gmail app passwords need 2-Step Verification. Some school and work Google accounts block them. Outlook.com no longer accepts app passwords for mail, so skip the inbox step there; Latch will report when a code needs you.

## What the AI sees

- Tool results never include the email, passwords, codes or links. Every result goes through a fixed schema and a redaction pass before it leaves the extension or the server.
- While Latch fills a form, the AI is blocked waiting on the tool call. On normal forms the password goes in and the form is submitted in one script task, and the fields are emptied as soon as the browser has captured them. On single-page forms the password stays in the field until the site answers (about 0.4 s in the test), and Latch empties the fields before it returns.
- Saved passwords only go to the site they were saved for. Your main password goes to a new site only after you allow it in the popup, once per site. You can turn that question off in Settings.
- Latch fills credentials only on https pages, and on http when the page is local.

Latch can't hide what a site shows you after you sign in, like a profile menu with your email in it. `fill_email` also leaves the address in the field, where the AI could read it back. Anything running as you on this computer can read Chrome's extension storage. That includes an AI with a shell or full desktop control, which could also click the approval. Latch keeps your details from an AI whose only reach is the browser.

## What it hands back to you

CAPTCHAs, codes sent to your phone, authenticator apps, passkeys, push approvals and locked accounts come back as `needs_user`, with a reason. Latch stops before filling anything it can't finish. It doesn't use "Continue with Google"-style buttons. It fills the site's own form.

## Test

```
npm test
```

The test starts local practice sites and a fake IMAP inbox, loads the extension in Chromium, and calls the tools through a real MCP client. It covers sign-up with code and link verification, sign-in, two-step single-page logins, retries, wrong passwords, CAPTCHA and phone hand-offs, iframes, lookalike sites, insecure pages and pausing. It then checks the tool results, the page, the server log and the saved data for anything private. Set `HEADED=1` to watch it run.
