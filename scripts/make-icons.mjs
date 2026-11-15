// Renders the toolbar and store icons at each size Chrome asks for.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../extension/icons/', import.meta.url));
export const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28">
  <rect width="28" height="28" rx="8" fill="#16161a"/>
  <circle cx="14" cy="11.6" r="3.6" fill="#e2a336"/><path d="M12.4 13.4h3.2l1.1 7.4h-5.4z" fill="#e2a336"/></svg>`;

const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  // The store wants 128px icons drawn at 96px with transparent padding around them.
  const inner = size === 128 ? 96 : size;
  await page.setContent(`<style>html,body{margin:0;background:transparent}div{width:${size}px;height:${size}px;display:grid;place-items:center}svg{display:block;width:${inner}px;height:${inner}px}</style><div>${ICON}</div>`);
  await page.locator('div').screenshot({ path: `${out}${size}.png`, omitBackground: true });
}
await browser.close();
console.log('icons written');
