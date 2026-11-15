# Audit

What was checked before the 1.0 release, how, and what changed as a result. Each claim names the test that keeps it true.

## Setup and everyday use

| Practice | Latch 1.0 | Checked by |
|---|---|---|
| Onboarding opens by itself on install and asks for as little as possible | A welcome page opens on install with two fields, email and password. Inline errors replace browser bubbles so they stay visible and are read aloud | `test/bar.mjs` (install opens the welcome page), `test/popup.mjs` (welcome is one step) |
| Sign-in pages work before setup finishes | Sign-in pages show "Set up Latch", and pages already open update as soon as setup is saved | `test/bar.mjs` (before setup) |
| The AI needs no configuration | The panel's buttons are ordinary labelled elements with one sentence of instructions for AI assistants. Confirmed in a real Chrome with Claude in Chrome reading and pressing it on the practice site | `test/bar.mjs` (a browser AI sees the bar), manual check with Claude in Chrome |
| One primary action per screen | The panel and the popup's page card each offer the one action that fits the page | `test/popup.mjs` |
| Results say what to do next | Every result is a sentence for the AI, and the popup and activity list summarise it in a few words | `test/e2e.mjs` |
| Clear on/off | Pause switch in the popup footer and in Settings; paused Latch shows no panel | `test/bar.mjs` (pausing Latch removes the bar) |
| Pinning hint | The ready page shows how to pin Latch until it is pinned | manual |
| Keyboard shortcut | Alt+Shift+L opens the popup | manifest |
| Dark mode | All pages, the panel and the website follow the system theme | `test/a11y.mjs` (both schemes) |
| Fast pages | The content script does a cheap input count, throttled, and only asks the worker to look closer when sign-in style inputs appear | `test/bar.mjs` (pages without sign-in fields get no bar) |

## Accessibility

`test/a11y.mjs` runs axe-core 4.10 with the WCAG 2.1 A and AA rules on every screen: the popup (set up and not), the welcome and ready pages, accounts, 2FA codes, activity, connect, settings, security, the approval window, the on-page panel in a real extension, the website and the practice site, each in light and dark. All pass.

Fixed during the audit:
- Faint grey text (section labels, footnotes, the welcome illustration) raised to the readable grey.
- The panel's colours are also set on its host element, so contrast checkers and assistive tools see the real background behind the closed shadow root.
- The password field's Show button was inside its label, which made the field's name "Password Show"; fields now use `label for`.
- The website's command boxes can be reached with the keyboard, and its small label text meets contrast in light mode.

## Security

An independent review of the 1.0 code found two high, four medium and seven low issues. All were fixed or documented, with regression tests:

| Finding | Resolution | Test |
|---|---|---|
| Any saved entry let the main password skip approval, and some entries were created by page actions alone | Only an explicit allow, a site the user saved or gave a 2FA key, or a sign-in where the main password already worked counts | `test/bar.mjs` (a reset request on a new site does not let the main password in) |
| Emailed codes could match a look-alike page by brand name | The sender's registrable domain must be the page's, except on job portals | `test/mail.mjs` (a look-alike page never gets another site's code) |
| Shared hosting (github.io, vercel.app) counted as one site | Shared suffixes and country registries are treated as suffixes | `test/mail.mjs` (each customer of a hosting service is its own site) |
| A page could focus the button before a stray Enter | Key presses count only when the button was reached by Tab or a pointer | `test/bar.mjs` (a page cannot turn a stray key press into a press) |
| A local program could claim to be the user | The user flag is passed in code, never from a message | code review |
| Agents were handed reset links | Documented in SECURITY.md as the cost of agent-finished resets without the inbox helper | |
| CSS could add text to the panel | Presses are refused while `::before`/`::after` content is present | `test/bar.mjs` (text a page adds with CSS) |
| Approval windows could be repeated | A refusal holds for ten minutes | `test/bar.mjs` |
| A press could run after the tab navigated | The origin is checked again when the flow starts | code review |
| Results could miss secrets saved during the flow | Results are scrubbed against the vault before and after | code review |
| A QR screenshot could capture another tab | The tab must be in front, at the same address, before and after | `test/bar.mjs` (a key shown only as a QR code) |
| The panel revealed saved accounts and 2FA keys | Its wording no longer depends on what Latch holds | code review |
| A helper could make a store copy reload repeatedly | Only unpacked copies obey reload requests | code review |

Also checked and unchanged: trusted-event and visibility checks on presses, message sender checks, no web-accessible resources or `externally_connectable`, a strict extension CSP, no remote code, minimal permissions (`storage`, `scripting`, `alarms`, `favicon`, host access). The full design is in [SECURITY.md](SECURITY.md).

## Reliability fixes found while testing

- A page that says "check your email" and shows a code box now gets the code, instead of Latch waiting for a link that never comes.
- A new step after the email step is acted on after 1.2 s instead of 4 s.
- Presses in the first second after a page loaded were wrongly treated as tampering.
- After Chrome stops an idle worker, a press rebuilds what the page offers instead of failing.
- 2FA setup and new-password pages finish as soon as the site answers, instead of waiting out a timeout.

## Test totals for 1.0

Unit and page tests 95, on-page panel 17, accessibility 23, bridge (all sections), loading (all scenarios), end-to-end 82. All pass.
