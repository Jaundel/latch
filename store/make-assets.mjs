// Renders the Chrome Web Store screenshots and promo tiles, and the website's images,
// from the real extension running in Chrome against a made-up demo site.
//   node store/make-assets.mjs
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { launchWithExtension } from '../test/launch.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const storeDir = join(root, 'store');
const imgDir = join(root, 'docs', 'img');
mkdirSync(imgDir, { recursive: true });
const W = 1280, H = 800;
const LOGO = '<svg viewBox="0 0 28 28" width="%s" height="%s"><rect width="28" height="28" rx="8" fill="#16161a"/><circle cx="14" cy="11.6" r="3.6" fill="#e2a336"/><path d="M12.4 13.4h3.2l1.1 7.4h-5.4z" fill="#e2a336"/></svg>';
const logo = size => LOGO.replaceAll('%s', size);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- the demo site

const SITE_CSS = `
  *{box-sizing:border-box} body{margin:0;font:15px/1.5 "Segoe UI",system-ui,sans-serif;background:#f4f6fb;color:#1d2433}
  .nav{height:64px;background:#fff;border-bottom:1px solid #e3e7ef;display:flex;align-items:center;padding:0 40px;gap:10px;font-weight:700;font-size:18px}
  .nav i{width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,#3b82f6,#6366f1);display:inline-block}
  main{display:grid;place-items:center;padding:70px 20px}
  .card{width:420px;background:#fff;border:1px solid #e3e7ef;border-radius:16px;padding:36px;box-shadow:0 10px 30px rgba(30,40,80,.06)}
  h1{font-size:26px;margin:0 0 6px;letter-spacing:-.02em} p.sub{color:#5b6475;margin:0 0 24px}
  label{display:block;font-weight:600;font-size:14px;margin:0 0 14px} input{display:block;width:100%;height:44px;margin-top:6px;border:1px solid #cdd4e1;border-radius:10px;padding:0 12px;font:inherit}
  button{width:100%;height:46px;border:0;border-radius:10px;background:#3b5bdb;color:#fff;font:600 15px system-ui;margin-top:6px}
  .links{display:flex;justify-content:space-between;margin-top:16px;font-size:14px;color:#3b5bdb}
  .qr{display:flex;gap:20px;align-items:center;margin:0 0 20px} .qr img{border:1px solid #e3e7ef;border-radius:10px}
  code{background:#f1f3f8;padding:3px 8px;border-radius:6px;font-size:13px}`;
const sitePage = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${SITE_CSS}</style></head><body><div class="nav"><i></i>Northwind</div><main>${body}</main></body></html>`;
const signIn = sitePage('Sign in · Northwind', `<div class="card"><h1>Welcome back</h1><p class="sub">Sign in to your Northwind account.</p>
  <form method="post" action="/login"><label>Email<input type="email" name="email" autocomplete="username"></label>
  <label>Password<input type="password" name="password" autocomplete="current-password"></label><button type="submit">Sign in</button></form>
  <div class="links"><a>Forgot your password?</a><a>Create account</a></div></div>`);
const KEY = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const twoFa = async () => sitePage('Two-factor authentication · Northwind', `<div class="card" style="width:520px"><h1>Set up two-factor authentication</h1>
  <p class="sub">Scan this QR code with your authenticator app.</p>
  <div class="qr"><img alt="QR code" width="150" height="150" src="${await QRCode.toDataURL(`otpauth://totp/Northwind:you?secret=${KEY}&issuer=Northwind`, { margin: 1, width: 150 })}">
  <div style="font-size:14px;color:#5b6475">Can't scan it? Enter this setup key:<br><code>jbsw y3dp ehpk 3pxp jbsw y3dp ehpk 3pxp</code></div></div>
  <form method="post"><label>6-digit code from the app<input name="code" autocomplete="one-time-code" inputmode="numeric"></label><button type="submit">Verify and turn on</button></form></div>`);

// ---------- capture from the real extension

const work = mkdtempSync(join(tmpdir(), 'latch-assets-'));
const ext = join(work, 'extension');
cpSync(join(root, 'extension'), ext, { recursive: true });
const { context, id } = await launchWithExtension(join(work, 'profile'), ext, { viewport: { width: W, height: H } });
const twoFaHtml = await twoFa();
await context.route(/^https:\/\/[a-z.]+\.example\//, route => {
  const u = new URL(route.request().url());
  const body = u.pathname.startsWith('/security') ? twoFaHtml : signIn;
  return route.fulfill({ contentType: 'text/html', body });
});
const shots = {};
const shot = async (page, name, opts = {}) => { shots[name] = await page.screenshot({ type: 'png', ...opts }); };
const ext_ = path => `chrome-extension://${id}/${path}`;

// Setup screen, before any details are saved.
const welcome = await context.newPage();
await welcome.setViewportSize({ width: W, height: H });
await welcome.goto(ext_('app.html#welcome'));
await welcome.getByRole('button', { name: 'Start using Latch' }).waitFor();
await welcome.fill('#email', 'you@example.com');
await welcome.fill('#password', 'correct horse battery staple');
await welcome.locator('body').click({ position: { x: 5, y: 5 } });
await shot(welcome, 'welcome');
await welcome.evaluate(() => chrome.runtime.sendMessage({ type: 'saveIdentity', email: 'you@example.com', password: 'correct horse battery staple' }));
await welcome.evaluate(() => chrome.runtime.sendMessage({ type: 'settings', patch: { approvedSites: [] } }));

// The bar on a sign-in page.
const login = await context.newPage();
await login.goto('https://accounts.northwind.example/sign-in');
await login.bringToFront();
await login.getByRole('button', { name: 'Sign in with Latch' }).waitFor({ timeout: 20000 });
await sleep(900);
await shot(login, 'bar');
// The hero: the sign-in card and the panel, close up.
await shot(login, 'hero', { clip: { x: 400, y: 0, width: 880, height: 600 } });

// The approval window, asked for by a press on the bar.
await login.getByRole('button', { name: 'Sign in with Latch' }).click();
let approval = null;
for (let i = 0; i < 60 && !approval; i++) { approval = context.pages().find(p => p.url().includes('approve.html')); await sleep(250); }
await approval.setViewportSize({ width: 440, height: 520 });
await approval.getByRole('button', { name: 'Allow', exact: true }).waitFor();
await sleep(900);
await shot(approval, 'approveWindow');
await sleep(300);
await shot(login, 'barWaiting');
await approval.getByRole('button', { name: 'Don\'t allow' }).click();
await sleep(600);
// The same page without the bar, for laying the popup over.
await login.getByRole('button', { name: 'Hide Latch on this page' }).click();
await sleep(300);
await shot(login, 'plain');

// 2FA setup.
const setup = await context.newPage();
await setup.goto('https://app.northwind.example/security/two-factor');
await setup.bringToFront();
await setup.getByRole('button', { name: 'Set up 2FA with Latch' }).waitFor({ timeout: 20000 });
await sleep(900);
await shot(setup, 'twofa');
await context.close();
rmSync(work, { recursive: true, force: true });

// ---------- the popup, drawn with fixed example content

const { chromium } = await import('playwright');
const browser = await chromium.launch({ channel: 'chrome' });
const stubPage = async (file, size, state, replies) => {
  const page = await browser.newPage({ viewport: size, deviceScaleFactor: 2 });
  await page.route('https://ext.example/**', route => {
    const name = new URL(route.request().url()).pathname.slice(1);
    if (name === 'stub.js') {
      return route.fulfill({ contentType: 'text/javascript', body: `const state=${JSON.stringify(state)};const replies=${replies};
        window.chrome={runtime:{getURL:p=>'https://ext.example/'+p.replace(/^\\//,''),getManifest:()=>({version:'1.0.0'}),sendMessage:async m=>m.type==='state'?state:(replies[m.type]?.(m)??{}),onMessage:{addListener(){}},connect:()=>({postMessage(){}})},tabs:{create(){}},action:{getUserSettings:async()=>({isOnToolbar:true})}};` });
    }
    if (name.startsWith('_favicon')) return route.fulfill({ status: 404, body: '' });
    let body = readFileSync(join(root, 'extension', name.split('?')[0]), 'utf8');
    if (name.endsWith('.html')) body = body.replace('<head>', '<head><script src="/stub.js"></script>');
    return route.fulfill({ contentType: name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'text/javascript' : 'text/html', body });
  });
  await page.goto(`https://ext.example/${file}`);
  return page;
};
const now = Date.now();
const popupState = { setup: true, email: 'you@example.com', connected: false, clients: [], mailbox: null, version: '1.0.0',
  settings: { paused: false, newPasswords: 'unique', confirmNewSites: true, bar: true, approvedSites: [] },
  activity: [
    { at: now - 60e3, tool: 'sign_in', site: 'accounts.northwind.example', status: 'signed_in', client: 'page' },
    { at: now - 25 * 60e3, tool: 'verify_email', site: 'github.com', status: 'verified', reason: 'authenticator_code', client: 'page' },
    { at: now - 3 * 3600e3, tool: 'create_account', site: 'shop.example', status: 'account_created', client: 'page' },
  ],
  sites: [{ host: 'accounts.northwind.example', status: 'active', source: 'main', totp: true, totpVerified: true, lastUsed: now }], resets: [] };
const popup = await stubPage('popup.html', { width: 360, height: 470 }, popupState,
  `{pageState:()=>({kind:'sign_in',host:'accounts.northwind.example',saved:true,totp:true}),codes:()=>[{host:'accounts.northwind.example',issuer:'Northwind',code:'482915',left:19,period:30,verified:true}]}`);
await popup.locator('.twofa').waitFor();
await sleep(300);
shots.popup = await popup.screenshot({ type: 'png' });

// ---------- composition

const b64 = buf => `data:image/png;base64,${buf.toString('base64')}`;
const page = await browser.newPage({ viewport: { width: W, height: H } });
const FONT = '"Segoe UI Variable Display","Segoe UI",system-ui,-apple-system,sans-serif';
async function compose(html, size = { width: W, height: H }) {
  await page.setViewportSize(size);
  await page.setContent(`<!doctype html><html><head><style>*{box-sizing:border-box}html,body{margin:0;width:${size.width}px;height:${size.height}px;overflow:hidden;font-family:${FONT};-webkit-font-smoothing:antialiased}</style></head><body>${html}</body></html>`);
  await page.evaluate(() => Promise.all([...document.images].map(i => i.decode().catch(() => {}))));
  return page.screenshot({ type: 'png' });
}
const frame = (src, w) => `<div style="width:${w}px;border-radius:14px;overflow:hidden;box-shadow:0 30px 70px rgba(20,18,10,.22),0 2px 6px rgba(20,18,10,.08);border:1px solid #e5e2da">
  <div style="height:30px;background:#efede8;display:flex;align-items:center;gap:6px;padding:0 12px">${'<i style="width:10px;height:10px;border-radius:50%;background:#d6d2c8;display:block"></i>'.repeat(3)}</div>
  <img src="${src}" style="display:block;width:100%"></div>`;

// Full-page views for the website, with the popup or approval window laid over the page.
const approveView = await compose(`<div style="position:relative;width:${W}px;height:${H}px">
  <img src="${b64(shots.barWaiting)}" style="position:absolute;inset:0;width:100%;filter:brightness(.55)">
  <div style="position:absolute;left:${(W - 440) / 2}px;top:${(H - 520) / 2 - 10}px;border-radius:12px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.45)">
  <div style="height:30px;background:#2b2b30;color:#cfcfd6;font:12px system-ui;display:flex;align-items:center;padding:0 12px">Latch: allow this site?</div>
  <img src="${b64(shots.approveWindow)}" style="display:block;width:440px"></div></div>`);
const popupView = await compose(`<div style="position:relative;width:${W}px;height:${H}px">
  <img src="${b64(shots.plain)}" style="position:absolute;inset:0;width:100%">
  <div style="position:absolute;inset:0;background:rgba(0,0,0,.12)"></div>
  <img src="${b64(shots.popup)}" style="position:absolute;right:28px;top:8px;width:360px;border-radius:12px;box-shadow:0 24px 60px rgba(0,0,0,.35);border:1px solid #d9d9df"></div>`);
const views = { bar: shots.bar, hero: shots.hero, welcome: shots.welcome, approve: approveView, twofa: shots.twofa, popup: popupView };
for (const [name, buf] of Object.entries(views)) writeFileSync(join(imgDir, `${name}.png`), buf);
writeFileSync(join(imgDir, 'icon-128.png'), readFileSync(join(root, 'extension', 'icons', '128.png')));

// Store screenshots: a headline over each view.
const captioned = (title, sub, view) => compose(`<div style="width:${W}px;height:${H}px;background:radial-gradient(90% 70% at 85% 0%,#fbefd6 0%,#fbfaf7 55%);padding:44px 60px 0;color:#16161a">
  <div style="display:flex;align-items:center;gap:12px;font-weight:700;font-size:20px;margin-bottom:18px">${logo(30)}Latch</div>
  <div style="font-size:44px;font-weight:750;letter-spacing:-.03em;line-height:1.1">${title}</div>
  <div style="font-size:21px;color:#50505a;margin:10px 0 26px">${sub}</div>
  <div style="display:flex;justify-content:center">${frame(b64(view), 860)}</div></div>`);
const store = [
  ['Your AI presses one button. It never sees your password.', 'Works with Claude in Chrome, ChatGPT agent, Codex and any AI that browses for you.', views.bar],
  ['Set up in under a minute', 'Just your email and password. Encrypted, and only in your browser.', views.welcome],
  ['You approve every new site', 'A Latch window your AI and the page cannot press. Look-alike sites are refused outright.', views.approve],
  ['Two-factor codes, handled', 'Latch keeps authenticator keys and enters the codes, even saving the key while your AI turns 2FA on.', views.twofa],
  ['See everything Latch did', 'Your 2FA codes, recent sign-ins and saved accounts, one click away.', views.popup],
];
for (const [i, [title, sub, view]] of store.entries()) writeFileSync(join(storeDir, `screenshot-${i + 1}.png`), await captioned(title, sub, view));

// Promo tiles and the social preview.
const tile = (w, h, big) => compose(`<div style="width:${w}px;height:${h}px;background:#16161a;color:#fff;display:flex;align-items:center;gap:${big ? 64 : 22}px;padding:0 ${big ? 90 : 34}px;position:relative;overflow:hidden">
  <div style="position:absolute;right:-${big ? 120 : 60}px;top:-${big ? 160 : 90}px;width:${big ? 620 : 300}px;height:${big ? 620 : 300}px;border-radius:50%;background:radial-gradient(circle,rgba(226,163,54,.35),rgba(226,163,54,0) 70%)"></div>
  <div style="flex:none;line-height:0;border-radius:${big ? 44 : 23}px;box-shadow:0 0 0 ${big ? 3 : 2}px rgba(255,255,255,.16),0 20px 50px rgba(0,0,0,.5)">${logo(big ? 150 : 78)}</div>
  <div style="position:relative"><div style="font-size:${big ? 76 : 40}px;font-weight:750;letter-spacing:-.03em;line-height:1">Latch</div>
  <div style="font-size:${big ? 32 : 18}px;color:#d9d9e0;margin-top:${big ? 18 : 10}px;line-height:1.25;max-width:${big ? 720 : 270}px">Let your AI sign in for you, without seeing your password.</div></div></div>`, { width: w, height: h });
writeFileSync(join(storeDir, 'promo-small-440x280.png'), await tile(440, 280, false));
writeFileSync(join(storeDir, 'promo-marquee-1400x560.png'), await tile(1400, 560, true));
writeFileSync(join(imgDir, 'og.png'), await tile(1200, 630, true));
await browser.close();
console.log('store assets and site images written');

// The practice site's QR code, for the same key its page shows as text.
await QRCode.toFile(join(root, 'docs', 'demo', 'qr.png'), `otpauth://totp/Practice%20Co.:you?secret=${KEY}&issuer=Practice%20Co.`, { margin: 1, width: 300 });
