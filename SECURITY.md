# Security

## Reporting a problem

Please report vulnerabilities privately through GitHub's "Report a vulnerability" button on this repository's Security tab, rather than in a public issue. Include the Latch version, the page or steps involved, and what an attacker gains.

## What Latch protects

Latch holds the user's main email and password, passwords for individual sites, and authenticator (TOTP) keys. Its job is to let an AI agent use those accounts while the agent, and the pages it visits, never learn the secrets.

The threats it is designed for:

- A web page that tries to read credentials, fake a press of Latch's buttons, or trick the user or the AI into pressing them.
- An AI agent that has been prompt-injected by a page into signing in somewhere it should not.
- An AI agent that would otherwise see the secrets in tool results, page text or field values.

Out of scope: malware running as the user, anything with full control of the computer (including an AI with shell or desktop access), other extensions with broad permissions, and a site that is itself compromised after the user signs in to it.

## Design

### The on-page panel

Browser agents read pages through the DOM. Content inside shadow roots is invisible to them (we checked Claude in Chrome's page reading tools: open and closed shadow roots are both skipped), so the panel's buttons and text are ordinary light-DOM elements slotted into a closed shadow root that holds the layout and styles.

Because the buttons are in the page's DOM, page scripts can see and touch them. The panel therefore:

- Acts only on `isTrusted` events. `element.click()` and `dispatchEvent` from page scripts are ignored.
- Lives in the browser's top layer (a manual popover), so ordinary page elements cannot be drawn over it regardless of `z-index`.
- Uses Intersection Observer v2 (`trackVisibility`) and ignores presses unless the button has been visibly unobscured, unfaded and untransformed for at least 250 ms. A page that puts its own top-layer element over the panel gets presses refused, and the panel raises itself back on top.
- Watches its own nodes. If the page edits, moves or removes them, the panel is rebuilt and presses are refused for a second.
- Styles slotted content with `!important` rules in the shadow root, which outrank page styles, including the page's own `!important` rules.
- Never contains a credential, code, key or link. It shows only what a page could already infer: that it has a sign-in form.

The service worker then checks that the press matches what it is currently offering on that tab, that the message came from the tab's top frame and that frame's host still matches the tab, and rate-limits presses per tab.

### Where the main password may go

Before the main password is filled anywhere, `extension/guard.js` refuses pages whose address imitates a commonly impersonated brand, a site in the vault or the user's email domain (near-miss spellings, digit and letter swaps such as `paypa1`, a brand name buried inside someone else's domain), bare IP addresses, IDN look-alikes, and forms whose action posts to another site. Credentials are only filled on https pages (http only on localhost).

A prompt-injected agent could still be sent to an ordinary site that imitates nothing. So the first time the main password would go to a site Latch has no account for, Latch opens an approval window (`approve.html`). It is a separate extension window: page scripts cannot reach it and browser agents, which act inside their tabs, cannot script or click it. "Allow" is disabled for 700 ms after it appears, focus starts on "Don't allow", and Escape answers no. An allowed site is remembered by its registrable domain. Users whose agent runs unattended can turn this off; installs that predate the setting keep running without it.

New accounts, password resets and 2FA setup never need approval, because they only ever put freshly generated secrets into the page, which are useless anywhere else.

### What the AI sees

Every result leaving the extension is built from fixed fields, and the local MCP server re-validates it against a strict schema. A final pass replaces anything in the vault (emails, user names, passwords, previous passwords, TOTP keys, inbox password) with `[hidden]`. The panel shows the same results. Activity records keep statuses only.

Values Latch fills are written and submitted in one script task where the form allows it, and cleared from the fields as soon as the browser has captured them. The remaining exposure is single-page apps that read fields while their request is in flight.

### Storage

The vault is one AES-256-GCM blob in `chrome.storage.local`, encrypted with a non-extractable WebCrypto key kept in the extension's IndexedDB. This keeps secrets out of plain-text storage and away from code that can only read storage values, but anything able to read the browser profile on disk as the user can recover them.

Keeping TOTP keys next to passwords means one compromise of the profile yields both factors. That is the trade-off the user opts into by adding keys; password managers with built-in authenticators make the same one.

### Two-factor setup

On a 2FA setup page Latch prefers an `otpauth://` link, then a setup key shown as text. Text is accepted as a key only when it is a single token, or uniform groups, of base32 characters and contains a digit or is in capitals, and only when exactly one such key is on the page. If the key appears only as a QR code, Latch brings the tab to the front, takes one screenshot with `captureVisibleTab`, crops it to the QR code and decodes it with the bundled jsQR. The screenshot is never stored. The key is kept only if the site accepts the code Latch generates from it.

### Password resets

The recovery form gets the user's email (or the saved user name for that site), except on employee systems such as a company's own Workday, where the account likely uses a work identity. The reset link is opened by the agent from the user's inbox, or by the optional helper, which only accepts https links on the site's own domain. On the reset page Latch generates the new password, saves it before submitting, and restores the previous entry only if the site visibly rejects the change.

### Extension hardening

- Manifest V3, no remote code, one bundled third-party library (jsQR 1.4.0, Apache-2.0).
- Extension pages run under `script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`. No resources are web-accessible, and there is no `externally_connectable`, so web pages cannot message the extension.
- Message handlers accept extension-page messages only from the extension's own origin, and content-script messages only for the bar's two message types.
- Permissions: `storage`, `scripting`, `alarms`, `favicon` and host access to all sites, which a sign-in helper needs. No `tabs`, `cookies`, `webRequest`, `history` or `identity`.
- The optional MCP server listens on 127.0.0.1 only and accepts WebSocket connections from the extension's own origins.

## Known limits

- Sites can display the user's email after sign-in, where an agent may read it.
- Without the inbox helper, an agent reads verification emails (codes and reset links) in the user's webmail.
- The panel's existence tells a page that Latch is installed.
- Detection is heuristic. When Latch is unsure it reports `unconfirmed` or `no_form` instead of guessing.
