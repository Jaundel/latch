// Starts the installed Google Chrome with a throwaway profile and the extension loaded.
// Branded Chrome ignores --load-extension, so the extension goes in over the DevTools pipe.
import { chromium } from 'playwright';

export async function launchWithExtension(profile, extension, { headless = process.env.HEADED !== '1', viewport, args = [] } = {}) {
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chrome',
    headless,
    viewport,
    args: ['--enable-unsafe-extension-debugging', ...args],
    ignoreDefaultArgs: ['--disable-extensions'],
  });
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: extension });
  const ours = w => w.url().startsWith(`chrome-extension://${id}/`);
  const sw = context.serviceWorkers().find(ours) || await context.waitForEvent('serviceworker', { predicate: ours, timeout: 15000 });
  return { context, sw, id };
}
