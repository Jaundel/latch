# Launch posts

Ready to paste. Swap the GitHub release link for the Chrome Web Store link once the listing is live.

Links:
- Site: https://jaundel.github.io/latch
- Code: https://github.com/Jaundel/latch
- Practice site: https://jaundel.github.io/latch/demo/

## Show HN

**Title:** Show HN: Latch – let browser AIs sign in for you without seeing your password

**Text:**

AI agents that browse for you (Claude in Chrome, ChatGPT agent, Codex) keep hitting the same wall: a sign-in page. You either paste your password into the chat or do it yourself.

Latch is a Chrome extension that puts a small panel on sign-in, sign-up, 2FA and password-reset pages with a button like "Sign in with Latch", plus one sentence telling AI assistants to press it instead of typing credentials. The agent presses it like any other button. Latch fills the site's own form inside the page and tells the agent the result ("Signed in. Continue your task in this tab."). Setup is your email and password, once.

Some details that took the most work:

- Agents read pages through the DOM, and their page-reading tools skip shadow DOM entirely, so the buttons are light-DOM elements slotted into a closed shadow root that holds the styling. Page CSS can't restyle them.
- Because the buttons live in the page, a page could try to press them. Latch only counts trusted input events, only while the panel is unobscured (Intersection Observer v2) and unchanged, and ignores key presses unless the button was reached by Tab or a pointer.
- A prompt-injected agent could be steered to some random site and told to press the button. So the first time your main password would go to a site, Latch asks you in its own extension window, which agents acting inside tabs can't reach. Look-alike domains, bare IPs and forms that post elsewhere are refused outright.
- It also handles authenticator codes (including reading a site's 2FA key from the setup page, text or QR), forgotten passwords end to end, and emailed codes.

No servers, no account, no analytics; everything is encrypted in your browser profile. There's an optional MCP server for Claude Code and Codex CLI. MIT licensed. The security design and its limits are in SECURITY.md, and I'd love to hear where it breaks.

## LinkedIn / X

I built Latch, a free Chrome extension that lets AI assistants sign in for you without ever seeing your password.

When Claude, ChatGPT or another AI browsing for you reaches a sign-in page, it sees a "Sign in with Latch" button and presses it. Latch fills the form privately and handles 2FA codes and password resets too. Setup is just your email and password.

Open source, no servers, no tracking: https://jaundel.github.io/latch

## Product Hunt

**Name:** Latch
**Tagline:** Let your AI sign in for you, without seeing your password
**Description:** A Chrome extension that gives browser AIs (Claude in Chrome, ChatGPT agent, Codex) a "Sign in with Latch" button on sign-in pages. Latch fills your credentials privately, enters 2FA codes, creates accounts with strong passwords and resets forgotten ones. You approve each new site once. Free and open source.
**Topics:** Chrome Extensions, Artificial Intelligence, Privacy, Productivity
