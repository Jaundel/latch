# Latch

Latch is a Chrome extension that lets an AI browsing for you sign in, create accounts, pass two-factor checks and reset forgotten passwords, without the AI seeing your email, password, codes or keys.

Website and screenshots: https://jaundel.github.io/latch

## How it works

You enter your email and password once. On sign-in, sign-up, 2FA and password reset pages, Latch shows a small panel with a button such as **Sign in with Latch**, and one sentence telling AI assistants to press it instead of typing credentials.

AIs that work in Chrome (Claude in Chrome, ChatGPT agent, Codex, Perplexity Comet) read pages through the DOM and its accessibility tree, so they find the button and press it like any other. Latch fills the site's own form in that tab, submits it, and writes the outcome in the panel, for example "Signed in. Continue your task in this tab." Nothing needs to be installed or configured on the AI's side.

| Page | Button | What Latch does |
|---|---|---|
| Sign-in | Sign in with Latch | Fills your email (or the user name saved for the site) and password, then any 2FA code it has a key for |
| Sign-up | Create account with Latch | Fills your email and a new strong password made for that site, and saves it |
| Authenticator code | Enter 2FA code with Latch | Enters the current code from the site's saved key |
| 2FA setup | Set up 2FA with Latch | Reads the setup key (text, `otpauth://` link or QR code), saves it, and confirms it with a code |
| Forgot password | Send reset email with Latch | Enters your email and asks for the reset link |
| New password | Set new password with Latch | Picks a strong password, enters it in both fields, submits and saves it |
| Emailed code | Enter code with Latch | With the optional inbox helper, reads the code itself. Without it, the panel tells the AI to read the newest email from that site in your webmail |

CAPTCHAs, codes sent by text message, passkeys and push approvals come back to the AI as "ask the user".

The toolbar popup shows what the current page offers, the 2FA code for the site, and recent activity. The Latch page (right-click the icon, Options) manages accounts, 2FA keys and settings.

## Safety

- The AI never receives your email, passwords, codes, keys or reset links from Latch. They are filled inside the page and the AI only gets a short status.
- The first time your main password would go to a site Latch has not signed in to before, Latch asks you in its own window. Pages and browser AIs cannot reach or press that window. You can turn this off in Settings if your AI works unattended.
- Latch refuses look-alike addresses (near-miss spellings, swapped characters, international look-alike letters), bare IP addresses, plain http pages, and forms that would send the password to another site.
- The panel's buttons only respond to trusted input events (real clicks and key presses, which page scripts cannot fake), and only while the panel is visible, uncovered and unchanged.
- Accounts Latch creates get unique random passwords. Everything is encrypted with AES-256-GCM under a non-exportable key and stays in your browser profile. There are no servers, analytics or remote code.

[SECURITY.md](SECURITY.md) has the full design and its limits. The [privacy policy](https://jaundel.github.io/latch/privacy.html) covers what is stored and what leaves your computer.

## Install

Latch is not on the Chrome Web Store yet. Until it is:

1. Download `latch-1.0.0.zip` from the [latest release](https://github.com/Jaundel/latch/releases/latest) and unzip it.
2. Open `chrome://extensions`, turn on Developer mode, click Load unpacked and pick the unzipped folder.
3. The setup page opens. Enter your email and password.

## Terminal and desktop AIs (optional)

Browser AIs need nothing else. Claude Code, Codex CLI, Claude Desktop and other MCP clients can use Latch as tools through a small local server (Node.js 20 or later):

```bash
claude mcp add --scope user latch -- npx -y github:Jaundel/latch
```

```bash
codex mcp add latch -- npx -y github:Jaundel/latch
```

For Claude Desktop and other apps, add `{"mcpServers": {"latch": {"command": "npx", "args": ["-y", "github:Jaundel/latch"]}}}` to the app's MCP config. The Latch page's Connect AIs screen shows these and turns green when one connects.

| Tool | Use it when |
|---|---|
| `sign_in` | A page asks the user to log in, or a session expired |
| `create_account` | On a sign-up page, after filling the non-credential fields |
| `verify_email` | A page asks for an emailed code or link, or an authenticator code |
| `fill_email` | A form needs the user's email address, without submitting it |
| `request_password_recovery` | On a "forgot password" form |
| `set_new_password` | On the page a reset link opens |
| `setup_two_factor` | On a site's authenticator-app setup page |
| `inspect_connection` | To check that Chrome is connected, without acting |

Each takes an optional `tabId` or `url` and returns JSON with `status`, `site`, a one-line `message`, and `next_action`. Results also describe the sign-in routes the page offers (`paths`), what Latch did and saw (`evidence`), the account state (`account`) and timings. Every result goes through a fixed schema and a scrub for anything in the vault before it leaves the extension.

The helper can also read verification emails over IMAP with an app password, so codes and links are handled without the AI opening webmail. Set it up on the Connect AIs screen.

## Development

```bash
npm install
npm test
```

`npm run test:unit` covers page detection, the guard, TOTP (RFC 6238 vectors) and the extension pages. `npm run test:extension` loads the extension into your installed Chrome with a throwaway profile (over the DevTools pipe, since Chrome no longer honours `--load-extension`) and drives the on-page panel end to end: approvals, refusals, hostile pages that restyle, cover or edit the panel, 2FA sign-in, 2FA setup from a text key and from a QR code, and the forgot-password flow. `node test/e2e.mjs` runs the MCP tools against local practice sites and a fake IMAP inbox and checks that nothing private reaches the AI.

To run the panel tests against the exact store build: `npm run package`, then set `LATCH_TEST_EXTENSION` to the `dist/latch-<version>` folder.

- `npm run package` builds `dist/latch-<version>.zip` for the Chrome Web Store. The store build leaves out the development key and the job application module.
- `npm run store-assets` regenerates the store screenshots, promo tiles and the website images from the real extension.
- `store/STORE.md` has the listing text, permission justifications and data disclosures.

## License

MIT
