// Renders the toolbar icon at each size Chrome asks for.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../extension/icons/', import.meta.url));
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <defs><mask id="m"><rect width="24" height="24" fill="#fff"/>
    <circle cx="12" cy="10" r="3.1" fill="#000"/><path d="M10.7 11.6h2.6l.9 6.4h-4.4z" fill="#000"/></mask></defs>
  <rect width="24" height="24" rx="7" fill="#16161a" mask="url(#m)"/></svg>`;

const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  await page.locator('svg').screenshot({ path: `${out}${size}.png`, omitBackground: true });
}
await browser.close();
console.log('icons written');
