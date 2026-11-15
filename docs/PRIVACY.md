# Latch privacy policy

Last updated November 4, 2026.

Latch is a Chrome extension and a small program that runs on your computer. It has no servers and no accounts with us. We never receive your data.

## What Latch stores

- The email address and password you enter during setup.
- Passwords Latch generates for accounts it creates, along with the site each one belongs to.
- Your inbox app password, if you connect an inbox.
- A list of recent actions: the site, the outcome, which AI asked and when. It doesn't include credentials or codes.

All of it stays in Chrome's storage for the extension on your computer. Credentials are encrypted with a key that never leaves that storage. Anything running as your user on the computer can read Chrome's storage, so keep your computer account to yourself.

## What leaves your computer

- Your email and password go to the website your AI is signing in to, and to no other site. Latch refuses pages that imitate other sites and forms that would send the password elsewhere.
- If you connect an inbox, Latch signs in to your mail server to read the one verification email it needs. It reads only recent messages that match the site, and doesn't change or delete anything. Verification searches skip password reset emails.
- Password reset emails are read only when you click Open reset email in the Latch popup. Latch opens the reset link, which must be on the site's own domain, in a tab for you to finish. The link goes to the extension, never to your AI.
- To suggest the right mail server during setup, Latch looks up your email domain's public DNS records.

Nothing is sent to us or to any analytics service.

## What your AI sees

Your AI gets short results such as "signed in" or "needs a code". It never receives your email address, passwords, codes, confirmation links or password reset links from Latch. Your AI can ask a site to send a recovery email, but choosing and saving the new password is your action in the popup. If you skip the inbox step and a site emails a code, Latch tells the AI to open your webmail tab and fetch that email itself. In that case the AI sees that email. Sites can also show your email on their own pages after you sign in, where your AI may read it.

## Removing your data

Settings > Erase everything deletes all of it. Uninstalling the extension does too.

## Contact

Questions about this policy: open an issue on the project's repository.
