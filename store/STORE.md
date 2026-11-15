# Chrome Web Store listing

Build the upload with `npm run package` (writes `dist/latch-<version>.zip` without the development key or the job application module). The same zip is attached to each GitHub release. Images in this folder come from `npm run store-assets`.

## Submitting

1. Sign in to https://chrome.google.com/webstore/devconsole with a personal Google account (school and work accounts are often blocked from registering) and pay the one-time US$5 developer fee.
2. Click New item and upload `latch-1.0.0.zip`.
3. Store listing tab: paste the text below, pick the category, and upload the icon, screenshots and promo tiles from this folder.
4. Privacy practices tab: paste the single purpose and the permission justifications, answer No to remote code, tick the three data types, certify, and enter the privacy policy URL.
5. Paste the reviewer test instructions at the end of this file into the test instructions field, then Submit for review. Reviews usually take a few days.
6. Once it has an ID, put it in `STORE_ID` in `extension/id.js` and push, so the optional local helper accepts the store copy, and point the site's "Add to Chrome" buttons at the listing.

## Store listing tab

**Name** (from the manifest): Latch: sign-ins for your AI

**Summary** (from the manifest, 132 characters max):
Let Claude, ChatGPT and other browser AIs sign in, create accounts and pass 2FA for you without ever seeing your password.

**Description:**

Latch lets the AI that browses for you sign in to websites, create accounts, get through two-factor checks and reset forgotten passwords. Your AI never sees your email, password, codes or keys.

How it works
1. Add Latch and enter the email and password you use for most sites. That is the whole setup.
2. Ask your AI to do something that needs an account.
3. On the sign-in page, your AI sees a small Latch panel with a "Sign in with Latch" button and presses it. Latch fills the site's own form privately and tells the AI the result.

Works with Claude in Chrome, ChatGPT agent, Codex, Perplexity Comet and any AI that browses in your Chrome. Nothing to configure on the AI's side: the panel tells it what to do in plain words. Claude Code, Codex CLI and other MCP apps can connect through an optional local helper.

What Latch handles
- Sign-in, including email-first pages, user-name logins and forms inside frames
- New accounts, each with its own strong password
- Authenticator (TOTP) 2FA codes, and saving a site's 2FA key while your AI turns 2FA on, from the text key or the QR code
- Forgotten passwords: asks for the reset email, then sets and saves a strong new password
- Emailed codes: your AI reads them from your inbox, or Latch does with the optional helper

Built for safety
- Your AI never receives your credentials, only short results like "Signed in".
- The first time your password would go to a new site, Latch asks you in its own window, which neither the page nor the AI can press.
- Refuses look-alike sites, bare IP addresses, plain http pages and forms that post your password elsewhere.
- Web pages cannot press Latch's buttons, or press them while covering them up.
- Encrypted on your device. No servers, no account, no analytics, no remote code. Open source.

CAPTCHAs, text-message codes and passkeys are handed back to you.

Source code, security design and support: https://github.com/Jaundel/latch

**Category:** Productivity (Tools)

**Language:** English

**Graphics:**
- Store icon: `extension/icons/128.png`
- Screenshots (1280x800): `screenshot-1.png` to `screenshot-5.png`
- Small promo tile (440x280): `promo-small-440x280.png`
- Marquee promo tile (1400x560): `promo-marquee-1400x560.png`

**Official URL / homepage:** https://jaundel.github.io/latch
**Support URL:** https://github.com/Jaundel/latch/issues

## Privacy practices tab

**Single purpose:**
Signs the user in, creates accounts, enters two-factor codes and resets passwords on websites on behalf of the user's AI assistant, without exposing the user's credentials to that assistant.

**Permission justifications:**

| Permission | Justification |
|---|---|
| `storage` | Keeps the user's encrypted credentials, 2FA keys, settings and a list of recent actions on their computer. |
| `scripting` | Reads the structure of the sign-in, sign-up, 2FA or password reset form on the page and fills it when the user or their AI presses a Latch button. |
| `alarms` | Reconnects to the optional local helper program after Chrome suspends the extension's service worker. |
| `favicon` | Shows each site's icon next to saved accounts in the popup and settings page. |
| Host permission (all sites) | Sign-in pages can be on any website. The content script finds sign-in and 2FA forms so it can offer the Latch button there, and the extension fills the form on that page when asked. It also takes a screenshot of the current tab only when the user or their AI presses "Set up 2FA with Latch" on a page whose 2FA key is shown only as a QR code. |

**Remote code:** No. All code is in the package.

**Data usage** (check these):
- Personally identifiable information: the user's email address.
- Authentication information: passwords and two-factor keys the user saves, and passwords Latch generates.
- Website content: the structure of forms on pages where Latch acts.

Certify all three: not sold or transferred to third parties outside the approved use cases; not used for purposes unrelated to the single purpose; not used to determine creditworthiness or for lending.

**Privacy policy URL:** https://jaundel.github.io/latch/privacy.html

## Test instructions for the reviewer

1. Install the extension. The setup page opens. Enter any email and a made-up password (for example `reviewer@example.com` / `Test-password-1`) and click Start using Latch.
2. Open https://jaundel.github.io/latch/demo/ . The Latch panel appears with a "Sign in with Latch" button.
3. Press it. Because the demo site is new to Latch, a Latch window asks whether to allow it. Click Allow. The demo page reports that it was signed in. The demo page runs in the browser only and sends nothing anywhere.
4. Open https://jaundel.github.io/latch/demo/2fa.html and press "Set up 2FA with Latch". Latch saves the demo key and confirms it with a code. The code is then visible in the toolbar popup.
