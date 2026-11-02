# Chrome Web Store submission

Build the upload with `npm run package`. That writes `dist/latch-<version>.zip` without the
development `key`. After the first upload, copy the store's extension ID into `STORE_ID` in
`extension/id.js` so the local server accepts the store copy.

## Listing

**Name:** Latch

**Summary (132 characters max):**
Lets your AI sign in and create accounts in Chrome without ever seeing your email or password.

**Description:**

Latch handles sign-in pages for the AI that browses for you.

Set it up once with your email and password. When your AI reaches a login or sign-up page, it calls Latch instead of typing anything. Latch fills the form in that tab, submits it, finishes email verification if the site asks, and tells your AI whether it worked. Your AI never receives your password.

- Creates new accounts with a strong, unique password for each site, and keeps them so you can see them later.
- Handles sign-in pages that ask for your email first, user-name sign-ins, codes sent by email, and forms inside embedded frames.
- Refuses pages that imitate other sites, and forms that would send your password somewhere else.
- Stops and says so when a site needs you: CAPTCHAs, phone codes, passkeys.
- Runs on your computer. No accounts, no servers, no tracking.

Works with Claude Code, Claude Desktop and Codex through a small local helper. Setup shows the command to connect each one.

**Category:** Productivity

## Single purpose

Signs the user in and creates accounts on websites on behalf of the user's AI assistant, without exposing the user's credentials to that assistant.

## Permission justifications

| Permission | Why Latch needs it |
|---|---|
| `storage` | Keeps the encrypted credentials, settings and activity list on the user's computer. |
| `scripting` | Reads the sign-in form on the page and fills it when the user's AI asks. |
| `tabs` | Finds the tab the AI is working in, and opens a background tab to follow an email confirmation link. |
| `alarms` | Reconnects to the local helper after Chrome puts the extension to sleep. |
| `favicon` | Shows site icons next to saved accounts in the popup. |
| Host access to all sites | Sign-in and sign-up pages can be on any website the user's AI visits. Latch reads a page only when the AI or the user asks it to act on that page, or when the user opens the popup. |

## Data usage disclosures

- Collects: authentication information (email, passwords) and website content (form structure on pages it acts on).
- Not sold or transferred to third parties. Not used for anything unrelated to the single purpose. Not used for creditworthiness or lending.
- Credentials are sent only to the website being signed in to, and the inbox app password only to the user's own mail server.

## Remote code

None. Everything the extension runs is in the package.

## Privacy policy

Host `docs/PRIVACY.md` at a public URL and link it in the listing.
