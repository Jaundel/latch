// Injected into the page's isolated world. It reports page structure (never
// field values) and fills fields the background script hands it.
(() => {
  if (globalThis.__latch) return;

  const refs = new Map();
  const filled = new Set();
  let nextRef = 1;

  function refOf(el) {
    for (const [id, weak] of refs) if (weak.deref() === el) return id;
    const id = `f${nextRef++}`;
    refs.set(id, new WeakRef(el));
    return id;
  }
  const byRef = id => refs.get(id)?.deref() ?? null;

  // Latch's own on-page bar is never part of the site's form, wording or errors.
  const OURS = 'latch-bar';
  const ours = el => !!el?.closest?.(OURS);
  const barText = () => [...document.querySelectorAll(OURS)].map(el => el.innerText || '').join(' ');

  function visible(el) {
    if (!el?.isConnected || ours(el)) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    return r.right > 0 && r.bottom + scrollY > 0 && r.left < innerWidth + 2000;
  }

  const textOf = node => (node?.innerText || node?.textContent || '').replace(/\s+/g, ' ').trim();

  // Shadow roots are collected once per scan, so repeated lookups stay cheap.
  let scanRoots = null;
  function shadowOf(el) {
    if (el.shadowRoot) return el.shadowRoot;
    try { return globalThis.chrome?.dom?.openOrClosedShadowRoot?.(el) || null; } catch { return null; }
  }
  function collectRoots(root = document, out = []) {
    for (const el of root.querySelectorAll('*')) {
      if (el.localName === OURS) continue;
      const shadow = shadowOf(el);
      if (shadow) { out.push(shadow); collectRoots(shadow, out); }
    }
    return out;
  }
  const shadowRoots = () => scanRoots || collectRoots();
  function scan(fn) {
    if (scanRoots) return fn();
    scanRoots = collectRoots();
    try { return fn(); } finally { scanRoots = null; }
  }
  const treeRoot = el => { const root = el?.getRootNode?.(); return root instanceof ShadowRoot ? root : null; };
  const lookupRoot = el => treeRoot(el) || document;

  function deepContains(scope, node) {
    for (; node; node = treeRoot(node)?.host) if (scope.contains(node)) return true;
    return false;
  }
  const inside = (scope, shadow) => scope === document || (shadow !== scope && deepContains(scope, shadow.host));

  function deepAll(selector, root = document) {
    const out = [...root.querySelectorAll(selector)];
    for (const shadow of shadowRoots()) if (inside(root, shadow)) out.push(...shadow.querySelectorAll(selector));
    return out.filter(el => !ours(el));
  }

  const SKIP_TEXT = /^(?:STYLE|SCRIPT|TEMPLATE|LINK|NOSCRIPT)$/;
  const fragmentText = root => [...root.children].filter(el => !SKIP_TEXT.test(el.tagName)).map(el => el.innerText ?? el.textContent ?? '').join(' ');
  function deepText(root, limit) {
    let text = root === document ? (document.body?.innerText || '') : root instanceof ShadowRoot ? fragmentText(root) : (root.innerText || root.textContent || '');
    const bar = root === document || deepContains(root, document.querySelector(OURS)) ? barText() : '';
    if (bar) text = text.replace(/\s+/g, ' ').replace(bar.replace(/\s+/g, ' ').trim(), ' ');
    for (const shadow of shadowRoots()) {
      if (text.length >= limit) break;
      if (inside(root, shadow)) text += ` ${fragmentText(shadow)}`;
    }
    return text.slice(0, limit);
  }

  // The nearest container around el, across shadow boundaries.
  const CONTAINER = '[role=dialog], [role=form], section, main';
  function containerOf(el) {
    for (let node = el; node; node = treeRoot(node)?.host) {
      const hit = node.closest?.(`form, ${CONTAINER}`);
      if (hit) return hit;
    }
    return null;
  }

  function labelText(el) {
    const parts = [];
    for (const label of el.labels || []) parts.push(textOf(label));
    parts.push(el.getAttribute('aria-label') || '');
    for (const id of (el.getAttribute('aria-labelledby') || '').split(/\s+/)) {
      if (id) parts.push(textOf(lookupRoot(el).getElementById(id)));
    }
    parts.push(el.placeholder || '', el.name || '', el.id || '', el.getAttribute('autocomplete') || '');
    if (!el.labels?.length && !el.getAttribute('aria-label')) {
      const prev = el.previousElementSibling;
      if (prev && prev.tagName !== 'INPUT') parts.push(textOf(prev).slice(0, 60));
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 240);
  }

  const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'checkbox', 'radio', 'file', 'image', 'reset', 'range',
    'color', 'date', 'datetime-local', 'month', 'week', 'time', 'search']);
  const CONFIRM = /confirm|repeat|retype|re-?enter|again|verify/;
  const NOT_CODE = /promo|coupon|discount|zip|postal|country|area|referral|gift|invite|phone|tel\b|voucher/;
  // SuccessFactors masks the passcode it emails, so a password input can still be a code box.
  const ONE_TIME = /passcode|one[- ]?time[- ]?(?:pass|code)|\botp\b/;

  function kindOf(el) {
    if (el.tagName !== 'INPUT' || el.disabled || el.readOnly) return null;
    const type = (el.type || 'text').toLowerCase();
    if (SKIP_TYPES.has(type)) return null;
    const auto = (el.getAttribute('autocomplete') || '').toLowerCase();
    const label = labelText(el).toLowerCase();
    if (type === 'password') {
      if (auto.includes('one-time-code') || ONE_TIME.test(label)) return { kind: 'code' };
      return { kind: 'password', isNew: auto.includes('new-password') || /new|create|choose|set up|confirm|repeat|retype/.test(label), confirm: CONFIRM.test(label) };
    }
    if (el.maxLength === 1) return { kind: 'digit' };
    if (auto.includes('one-time-code') || (/\b(code|otp|pin|passcode|token)\b|verification/.test(label) && !NOT_CODE.test(label))) {
      return { kind: 'code' };
    }
    if (type === 'email' || auto.includes('email') || /e-?mail/.test(label)) return { kind: 'email', confirm: CONFIRM.test(label) };
    if (auto.includes('username') || /user ?name|user ?id|login|log in|sign in|identifier|account/.test(label)) return { kind: 'username' };
    return { kind: 'other' };
  }

  function digitGroup(fields) {
    const digits = fields.filter(f => f.kind === 'digit');
    if (digits.length < 4 || digits.length > 8) return [];
    const parent = byRef(digits[0].ref)?.parentElement?.parentElement;
    return digits.filter(d => parent?.contains(byRef(d.ref))).map(d => d.ref);
  }

  function captchaBlocking() {
    const widgets = deepAll('iframe, .g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey]').filter(el => {
      if (!visible(el) || el.closest('.grecaptcha-badge')) return false;
      const hint = el.tagName === 'IFRAME' ? `${el.src} ${el.title}` : 'captcha';
      const r = el.getBoundingClientRect();
      return /captcha|challenges\.cloudflare|turnstile|arkoselabs|funcaptcha/i.test(hint) && r.width > 100 && r.height > 40;
    });
    if (!widgets.length) return false;
    const solved = deepAll('[name="g-recaptcha-response"], [name="h-captcha-response"], [name="cf-turnstile-response"]')
      .some(el => (el.value || '').length > 20);
    return !solved;
  }

  function pageFlags() {
    const body = deepText(document, 20000).toLowerCase();
    const heads = [document.title, ...deepAll('h1, h2, button, [role=button], input[type=submit]')
      .slice(0, 40).map(el => el.value || textOf(el))].join(' ').toLowerCase();
    return {
      loginish: /sign ?in|log ?in|welcome back|continue with email|enter your (e-?mail|password)/.test(heads),
      signupish: /sign ?up|create (an |your )?account|register|join|get started/.test(heads),
      emailCode: /(sent|emailed|e-?mail(ed)? you)[^.]{0,80}(code|link)|(code|link)[^.]{0,80}(sent|emailed) to (your )?(e-?mail|inbox)|check your (e-?mail|inbox)|(sent|emailed)[^.]{0,80}one[- ]?time password[^.]{0,80}(e-?mail|inbox)|one[- ]?time password[^.]{0,80}(sent|emailed)[^.]{0,80}(e-?mail|inbox)/.test(body),
      phoneCode: /text message|\bsms\b|texted|phone (number )?ending|sent to (your )?(phone|mobile)|mobile number ending/.test(body),
      appCode: /authenticator|authentication app|2fa app|totp|google auth/.test(body),
      passkey: /passkey|security key|windows hello|face id|touch id|use your device/.test(body),
      push: /approve (the )?(sign-?in|request)|tap yes|check your (phone|device) for|sent a notification/.test(body),
      checkEmail: /check your (e-?mail|inbox)|verify your (e-?mail|account)|confirm your (e-?mail|account)|(sent|emailed) you (a|an) (verification |confirmation |activation )?(link|email)|(link|email) (has been )?sent to/.test(body),
      recoverySent: /(?:sent|emailed)\b[^.]{0,100}(?:reset|recovery)[^.]{0,80}(?:link|instructions|email)|(?:reset|recovery)[^.]{0,80}(?:link|instructions|email)[^.]{0,80}(?:sent|emailed)|if (?:an? )?account (?:exists|is found)[^.]{0,100}(?:email|link|instructions)/.test(body),
      exists: /already (exists|registered|in use|taken|associated)|account (already )?exists|account with (this|that) e-?mail/.test(body),
      locked: /too many (attempts|tries)|account (is )?(locked|disabled|suspended)|temporarily (locked|blocked)/.test(body),
      resetDone: /password (?:has been |was )?(?:successfully )?(?:changed|reset|updated)|successfully (?:changed|reset|updated) (?:your )?password|sign in with your new password/.test(body),
      signedIn: deepAll('a, button, [role=button], [role=menuitem]').slice(0, 400)
        .some(el => visible(el) && (/^(?:sign ?out|log ?(?:out|off))$/i.test(textOf(el)) || el.matches('#accountSettingsButton, [data-automation-id="accountSettingsButton"]'))),
    };
  }

  // Status lines share the live regions errors use. One that also reports trouble stays an error.
  const PASSWORD_OK = /^(?:your )?passwords? (?:is |are |has been |was )?(?:accepted|valid|strong|match(?:es)?)[.!]?$|^password strength:? (?:good|strong|very strong|excellent)[.!]?$/i;
  const CODE_TIMER = /\b(?:request|resend|send|get)\b[^.]{0,30}\b(?:pass ?code|code|one[- ]?time password)\b[^.]{0,20}\b(?:in|after) \d|\b(?:pass ?code|code|one[- ]?time password)\b[^.]{0,30}\bexpires? in \d/i;
  const CODE_TROUBLE = /invalid|incorrect|wrong|expired|too many|fail|unable|could ?n.?t|can ?not|locked|blocked|not (?:valid|correct|accepted|recogni[sz]ed)/i;
  const statusLine = text => PASSWORD_OK.test(text) || (CODE_TIMER.test(text) && !CODE_TROUBLE.test(text));

  function errorText() {
    const nodes = deepAll('[role=alert], [aria-live=assertive], [aria-live=polite], .error, .errors, .alert-danger, .invalid-feedback, [class*="error" i], [id*="error" i]');
    for (const node of nodes) {
      const text = textOf(node);
      if (text && text.length > 3 && visible(node) && !statusLine(text)) return text.slice(0, 160);
    }
    return '';
  }

  const inspect = () => scan(inspectNow);

  function inspectNow() {
    const fields = [];
    for (const el of deepAll('input')) {
      if (!visible(el)) continue;
      const k = kindOf(el);
      if (!k) continue;
      fields.push({
        ref: refOf(el), ...k,
        empty: !el.value,
        required: el.required,
        maxLength: el.maxLength > 0 ? el.maxLength : 0,
        minLength: el.minLength > 0 ? el.minLength : 0,
        pattern: el.getAttribute('pattern') || '',
        form: el.form ? refOf(el.form) : '',
      });
    }
    let active = document.activeElement;
    for (let inner; active && (inner = shadowOf(active)?.activeElement); ) active = inner;
    const focused = active && active.tagName === 'INPUT' && fields.find(f => byRef(f.ref) === active);
    const auth = authIntents(fields);
    const choices = deepAll('a, button, [role=button], input[type=submit], input[type=button]')
      .filter(visible).map(el => el.tagName === 'INPUT' ? el.value : textOf(el));
    const offers = pattern => choices.some(label => pattern.test(label));
    // Where each password form would send its data; read the attribute, since an
    // input named "action" shadows form.action.
    const actions = {};
    for (const f of fields) {
      if (f.kind !== 'password' || !f.form || f.form in actions) continue;
      try { actions[f.form] = new URL(byRef(f.form).getAttribute('action') || location.href, location.href).hostname; } catch {}
    }
    return {
      url: location.href,
      host: location.hostname,
      top: window === window.top,
      fields: fields.filter(f => f.kind !== 'digit'),
      digits: digitGroup(fields),
      focused: focused && ['email', 'other', 'username'].includes(focused.kind) ? focused.ref : '',
      captcha: captchaBlocking(),
      flags: pageFlags(),
      error: errorText(),
      recovery: recoveryForm(),
      reset: resetForm(),
      totpSetup: totpSetup(),
      busy: deepAll('[aria-busy=true], button[disabled][type=submit]').some(visible),
      auth,
      actions,
      paths: {
        email: (auth.login || auth.signup) && fields.some(f => ['email', 'username'].includes(f.kind)),
        password: fields.some(f => f.kind === 'password'),
        google: offers(/(?:with|using|via)\s+google/i),
        linkedin: offers(/(?:with|using|via)\s+linkedin/i),
        microsoft: offers(/(?:with|using|via)\s+microsoft/i),
        apple: offers(/(?:with|using|via)\s+apple/i),
        facebook: offers(/(?:with|using|via)\s+facebook/i),
        sso: offers(/\bsso\b|single sign.on|corporate login/i),
        create_account: auth.signup || offers(/create\b.{0,30}\b(?:account|profile)|sign ?up|register/i),
        guest: offers(/(?:as (?:a )?guest|guest (?:access|checkout|application)|apply without (?:an )?account)/i),
      },
    };
  }

  const sameHttps = href => {
    try { const url = new URL(href, location.href); return url.origin === location.origin && url.protocol === 'https:'; } catch { return false; }
  };
  const formAction = form => form.getAttribute('action') || location.href;

  // Labelled-by text, input labels and visible text, minus links and any `skip`
  // buttons: a sign-in page says "Forgot password?" too.
  function wordingOf(scope, skip = () => false) {
    const el = scope instanceof Element ? scope : null;
    const associated = (el?.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
      .map(id => lookupRoot(el).getElementById(id)).filter(node => node && visible(node)).map(textOf);
    let text = deepText(scope, 4000).replace(/\s+/g, ' ');
    for (const link of deepAll('a[href]', scope)) {
      const label = textOf(link);
      if (label) text = text.replace(label, ' ');
    }
    for (const label of deepAll(BUTTONS, scope).map(buttonLabel).filter(skip)) text = text.replace(label, ' ');
    const labels = deepAll('input', scope).filter(visible).map(labelText);
    return `${associated.join(' ')} ${labels.join(' ')} ${text.slice(0, 1200)}`;
  }

  // Only an explicit, same-origin email recovery form is eligible. Never handle
  // a new-password form or follow a recovery link here.
  const RECOVERY_WORDING = /forgot (?:your )?password|reset (?:your )?password|recover (?:your )?(?:password|account)/i;
  const RECOVERY_BUTTON = /^(?:send (?:reset |recovery )?(?:email|link|instructions)|reset password|recover (?:password|account)|continue|submit|send|next|request (?:a )?(?:reset|recovery) link|email me (?:a )?(?:reset )?link|reset)$/i;
  const recoveryForm = () => scan(findRecovery);

  function findRecovery() {
    if (captchaBlocking()) return null;
    const scopes = new Set();
    for (const el of deepAll('input')) {
      if (!visible(el) || kindOf(el)?.kind !== 'email') continue;
      const scope = el.form || containerOf(el);
      if (scope && (scope === el.form || scope.tagName !== 'FORM')) scopes.add(scope);
    }
    // Most sites put "Forgot your password?" in the page heading, outside the form. That
    // heading speaks for the form only when the page has no other email form and no password.
    const alone = scopes.size === 1 && !deepAll('input[type=password]').some(visible);
    const heading = alone ? [document.title, ...deepAll('h1, h2, h3, [role=heading]').filter(visible).map(textOf)].join(' ') : '';
    const candidates = [...scopes].map(scope => recoveryIn(scope, heading)).filter(Boolean);
    return candidates.length === 1 ? candidates[0] : null;
  }

  function recoveryIn(scope, heading = '') {
    const isForm = scope.tagName === 'FORM';
    // A "Forgot your password?" button leads to the recovery form; it does not make this one.
    const leadsAway = label => RECOVERY_WORDING.test(label) && !RECOVERY_BUTTON.test(label);
    if (!visible(scope) || !RECOVERY_WORDING.test(`${heading} ${wordingOf(scope, leadsAway)}`)) return null;
    if (deepAll('input[type=password]', scope).some(visible)) return null;
    if (isForm && !sameHttps(formAction(scope))) return null;
    const emails = deepAll('input', scope).filter(el => visible(el) && kindOf(el)?.kind === 'email' && (isForm || !el.form));
    const selector = isForm ? 'button,input[type=submit],input[type=button]' : 'button,input[type=submit],input[type=button],[role=button],a[href]';
    const buttons = deepAll(selector, scope).filter(el => {
      if (!visible(el) || el.disabled || !RECOVERY_BUTTON.test(buttonLabel(el))) return false;
      if (isForm) return el.form === scope && sameHttps(el.getAttribute('formaction') || formAction(scope));
      if (el.form) return false;
      return el.tagName !== 'A' || !el.hasAttribute('href') || sameHttps(el.getAttribute('href'));
    });
    if (emails.length !== 1 || buttons.length !== 1) return null;
    return { email: refOf(emails[0]), button: refOf(buttons[0]), scope: refOf(scope) };
  }

  // A new-password form reached from a recovery email. Latch fills it only when
  // the user asks from the popup, and never presses its button.
  const RESET_WORDING = /reset (?:your )?password|new password|change (?:your )?password|set (?:a |your )?(?:new )?password|choose (?:a )?(?:new )?password|create (?:a )?new password/i;
  const SIGNUP_WORDING = /\bsign ?up\b|create (?:an |a |your )?(?:new )?(?:account|profile)|\bregister\b/i;
  const CURRENT = /current|\bold|existing|temporary/;
  const RESET_BUTTON = /\b(?:reset|change|save|update|set|submit|continue|confirm)\b/i;
  const RESET_NOT = /cancel|back|sign ?up|register|create (?:an |your )?account|show|hide|resend|google|apple|microsoft|facebook|linkedin/i;
  const resetForm = () => scan(findReset);

  function findReset() {
    if (captchaBlocking()) return null;
    const scopes = new Set();
    for (const el of deepAll('input[type=password]')) {
      if (visible(el)) scopes.add(el.form || containerOf(el) || el.getRootNode());
    }
    const candidates = [...scopes].map(resetIn).filter(Boolean);
    return candidates.length === 1 ? candidates[0] : null;
  }

  function resetIn(scope) {
    const isForm = scope.tagName === 'FORM';
    if (scope instanceof Element && !visible(scope)) return null;
    const wording = wordingOf(scope);
    if (!RESET_WORDING.test(wording) || SIGNUP_WORDING.test(wording)) return null;
    if (isForm && !sameHttps(formAction(scope))) return null;
    const inputs = deepAll('input', scope).filter(visible);
    const passwords = inputs.filter(el => el.type === 'password').map(el => ({ el, k: kindOf(el), label: labelText(el).toLowerCase() }));
    if (passwords.some(p => !p.k || CURRENT.test(p.label))) return null;
    if (passwords.length !== 2) return null;
    let fresh = passwords.filter(p => !p.k.confirm), confirm = passwords.filter(p => p.k.confirm);
    if (!confirm.length && passwords.every(p => p.k.isNew)) [fresh, confirm] = [[passwords[0]], [passwords[1]]];
    if (fresh.length !== 1 || confirm.length !== 1) return null;
    if (inputs.some(el => !el.value && ['email', 'username', 'other'].includes(kindOf(el)?.kind))) return null;
    // The user presses this button, so one disabled until both fields are filled still counts.
    const buttons = deepAll(BUTTONS, scope).filter(el => {
      const label = buttonLabel(el);
      if (!visible(el) || !RESET_BUTTON.test(label) || RESET_NOT.test(label)) return false;
      if (isForm && ['BUTTON', 'INPUT'].includes(el.tagName)) return el.form === scope && sameHttps(el.getAttribute('formaction') || formAction(scope));
      if (!isForm && el.form) return false;
      return el.tagName !== 'A' || !el.hasAttribute('href') || sameHttps(el.getAttribute('href'));
    });
    if (buttons.length !== 1) return null;
    return { pw: [refOf(fresh[0].el), refOf(confirm[0].el)], button: refOf(buttons[0]), scope: refOf(scope) };
  }

  // An authenticator setup screen: wording about an authenticator app plus a setup key,
  // an otpauth:// link or a QR code. inspect() reports only that these exist; the key
  // itself leaves the page through readTotpSetup, which the 2FA setup flow alone calls.
  const SETUP_WORDING = /authenticator|two[- ]?factor|\b2fa\b|two[- ]?step|2-step|multi[- ]?factor|\bmfa\b|\btotp\b/i;
  const SETUP_ACTION = /scan|qr|set ?up|secret|setup key|text code|manually|enter (?:this|the) (?:key|code)|can.?t scan/i;
  // In running text a following word can look like one more group of a key ("... 3pxp then"),
  // so text matches count only when no element holds a key on its own.
  const GROUPED_KEY = /(?:^|[^a-z0-9])((?:[a-z2-7]{4}[ -]){3,15}[a-z2-7]{1,4})(?=$|[^a-z0-9])/gi;
  const SOLID_KEY = /(?:^|[^A-Za-z0-9])([A-Z2-7]{16,64})(?=$|[^A-Za-z0-9])/g;
  const KEY_HOLDERS = 'input[readonly], input[disabled], code, kbd, samp, pre, span, strong, b, p, div, td, li, dd';
  // One token, or groups of one length ("abcd efgh ..."), of base32 letters. Words in a sentence
  // vary in length, and a real key almost always has a digit or is written in capitals.
  const asKey = value => {
    const raw = String(value || '').trim();
    const groups = raw.split(/[ -]/);
    const shaped = groups.length === 1 || (groups.length >= 4 && new Set(groups.slice(0, -1).map(g => g.length)).size === 1);
    const key = groups.join('').toUpperCase();
    if (!shaped || !/^[A-Z2-7]{16,128}$/.test(key)) return '';
    return /[2-7]/.test(key) || raw === raw.toUpperCase() ? key : '';
  };
  const totpSetup = () => scan(findTotpSetup);

  function keyCandidates(text) {
    const held = new Set();
    for (const el of deepAll(KEY_HOLDERS)) {
      if (el.tagName !== 'INPUT' && el.children.length) continue;
      const key = asKey(el.tagName === 'INPUT' ? el.value : textOf(el));
      if (key && visible(el)) held.add(key);
    }
    if (held.size) return [...held];
    const found = new Set();
    for (const re of [GROUPED_KEY, SOLID_KEY]) {
      for (const m of text.matchAll(re)) {
        const key = asKey(m[1]);
        if (key) found.add(key);
      }
    }
    return [...found];
  }

  function qrCandidate() {
    const hint = el => `${el.getAttribute('alt') || ''} ${el.getAttribute('aria-label') || ''} ${el.id} ${el.className?.baseVal ?? el.className} ${el.getAttribute('src') || ''} ${el.getAttribute('title') || ''}`;
    const near = el => /qr|barcode|authenticator|totp|2fa|mfa|otp/i.test(hint(el));
    const squares = deepAll('img, canvas, svg').filter(el => {
      if (!visible(el) || el.closest('latch-bar')) return false;
      const r = el.getBoundingClientRect();
      return r.width >= 80 && r.width <= 600 && Math.abs(r.width - r.height) <= r.width * 0.12;
    });
    const pick = squares.find(near) || (squares.length === 1 ? squares[0] : null);
    return pick && window === window.top ? pick : null;
  }

  // Brings the QR code into view and says where it is, for the setup flow's screenshot.
  function qrRect() {
    const pick = scan(qrCandidate);
    if (!pick) return null;
    pick.scrollIntoView({ block: 'center', inline: 'center' });
    const r = pick.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, dpr: devicePixelRatio };
  }

  function findTotpSetup() {
    const text = deepText(document, 20000);
    if (!SETUP_WORDING.test(text) || !SETUP_ACTION.test(text)) return null;
    // A sign-in that merely asks for an app code has neither a key nor a QR code.
    const uris = deepAll('a[href]').map(a => a.getAttribute('href')).filter(h => /^otpauth:\/\/totp\//i.test(h || ''));
    const keys = keyCandidates(text);
    const qr = uris.length || keys.length ? null : qrCandidate();
    if (!uris.length && keys.length !== 1 && !qr) return null;
    return { uri: uris.length === 1, key: keys.length === 1, qr: !!qr };
  }

  function readTotpSetup() {
    const text = deepText(document, 20000);
    if (!SETUP_WORDING.test(text)) return {};
    const uris = deepAll('a[href]').map(a => a.getAttribute('href')).filter(h => /^otpauth:\/\/totp\//i.test(h || ''));
    if (uris.length === 1) return { uri: uris[0] };
    const keys = keyCandidates(text);
    return keys.length === 1 ? { secret: keys[0] } : {};
  }

  // Fills a new password into both reset fields and presses the form's own button.
  function fillResetAndSubmit({ refs: targets, value, expectedUrl } = {}) {
    const current = resetForm();
    const filledIn = fillReset({ refs: targets, value, expectedUrl });
    if (!filledIn.ok) return filledIn;
    for (const ref of targets) filled.add(ref);
    const button = byRef(current?.button);
    if (!button?.isConnected) return { ok: false, filled: true };
    let event = null;
    const onSubmit = e => { event = e; };
    addEventListener('submit', onSubmit, true);
    try { press(button); } finally { removeEventListener('submit', onSubmit, true); }
    if (event && !event.defaultPrevented) {
      for (const ref of targets) { const el = byRef(ref); if (el) el.value = ''; }
    }
    return { ok: true, submitted: true };
  }

  // Fills the new and confirm fields only; the user presses the page's button.
  function fillReset({ refs: targets, value, expectedUrl } = {}) {
    if (location.href !== expectedUrl || !Array.isArray(targets) || targets.length !== 2 || typeof value !== 'string' || !value) return { ok: false };
    const current = resetForm();
    if (!current || current.pw[0] !== targets[0] || current.pw[1] !== targets[1]) return { ok: false };
    const fields = targets.map(byRef);
    if (!fields.every(el => el?.isConnected)) return { ok: false };
    for (const el of fields) setValue(el, value);
    return { ok: true };
  }

  async function requestRecovery({ email, expectedUrl, runId, deadline }) {
    let acted = false;
    const stopped = () => typeof runId !== 'string' || !Number.isFinite(deadline) || Date.now() >= deadline || globalThis.__latchRecoveryCancelled?.has(runId);
    const interrupted = () => ({ ok: false, stopped: true, acted });
    if (stopped()) return interrupted();
    if (location.href !== expectedUrl) return { ok: false };
    const recovery = recoveryForm();
    if (!recovery) return { ok: false };
    const field = byRef(recovery.email), button = byRef(recovery.button);
    if (!field || !button) return { ok: false };
    if (stopped()) return interrupted();
    focusOn(field);
    if (stopped()) return interrupted();
    field.value = email;
    acted = true;
    filled.add(recovery.email);
    if (stopped()) return interrupted();
    field.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText' }));
    if (stopped()) return interrupted();
    field.dispatchEvent(new Event('change', { bubbles: true }));
    if (stopped()) return interrupted();
    leave(field);
    if (stopped()) return interrupted();
    // Give a queued cancellation a chance to reach this isolated world before submission.
    await new Promise(resolve => setTimeout(resolve, 50));
    if (stopped()) return interrupted();
    const verified = recoveryForm();
    if (location.href !== expectedUrl || !field.isConnected || !button.isConnected || !verified || verified.email !== recovery.email || verified.button !== recovery.button || (field.form && !field.form.checkValidity())) return { ok: false, acted };
    if (stopped()) return interrupted();
    button.click();
    globalThis.__latchRecoveryCancelled?.delete(runId);
    return { ok: true };
  }

  // A tab without window focus may dispatch no native focus events. Match
  // normal focus ordering so reactive auth forms commit their entered values.
  function focusOn(el) {
    const silent = !document.hasFocus();
    el.focus();
    if (silent) for (const type of ['focus', 'focusin'])
      el.dispatchEvent(new FocusEvent(type, { bubbles: type === 'focusin', composed: true }));
  }

  function leave(el) {
    const silent = !document.hasFocus();
    el.blur();
    if (silent) for (const type of ['blur', 'focusout'])
      el.dispatchEvent(new FocusEvent(type, { bubbles: type === 'focusout', composed: true }));
  }

  function setValue(el, value) {
    focusOn(el);
    el.value = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    leave(el);
  }

  const BUTTONS = 'button, input[type=submit], input[type=button], input[type=image], [role=button], a[role=button]';
  const buttonLabel = el => ((el.tagName === 'INPUT' ? el.value : textOf(el)) || el.getAttribute('aria-label') || el.value || '').trim();
  const NON_AUTH_ACTION = /\bapplication\b|\bresume\b|\bsubscribe\b|\bnewsletter\b|\bapply\b/i;
  const ELSEWHERE = /google|apple|facebook|microsoft|github|linkedin|twitter|indeed|corporate|\bx\b|sso|single sign|passkey|forgot|reset|cancel|back|show|hide|eye|visibility|help/i;
  const INTENT = {
    login: { good: /sign ?in|log ?in|continue|next|submit|verify|confirm|go\b/i, bad: /sign ?up|create|register|join/i },
    signup: { good: /create|sign ?up|register|join|continue|next|submit|get started|agree|verify|confirm/i, bad: /sign ?in|log ?in/i },
    code: { good: /verify|confirm|continue|next|submit|done|sign ?in|log ?in/i, bad: /resend|send again|new (?:pass ?)?code|different/i },
  };

  // A sign-in block that shares one page-wide form with a sign-up block, as on
  // ASP.NET portals (a "Returning User" block beside "New Applicant"): the
  // nearest ancestor of a lone password that holds one identifier and its own
  // button, said to be for returning users or signing in, and stopping before
  // it takes in a second identifier or password.
  const RETURNING_SECTION = /\b(?:returning|existing) (?:user|applicant|candidate|member|customer)s?\b/i;
  const SIGN_IN_SECTION = /\bsign ?in\b|\blog ?in\b/i;
  const SIGNUP_SECTION = /\bsign ?up\b|\bregister\b|create (?:an |a |your )?(?:new )?(?:account|profile)|\bnew (?:user|applicant|candidate|member|customer)s?\b/i;

  // Shadow trees compare as disconnected, so a button inside one stands at its host's place.
  function follows(field, el) {
    while (treeRoot(el) && treeRoot(el) !== treeRoot(field)) el = treeRoot(el).host;
    return !!(field.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  // A flat page's section also holds its header link and search submit, so what follows the password comes first.
  function sectionButton(pw, buttons) {
    const { good } = INTENT.login;
    const pick = list => list.find(b => b.type === 'submit') || list.find(b => good.test(buttonLabel(b))) || (list.length === 1 ? list[0] : null);
    return pick(buttons.filter(b => follows(pw, b))) || pick(buttons);
  }

  // The heading may be any element in or above the form, so read back from the password:
  // the first heading or sign-up wording decides, and only a short line counts as one.
  function underReturningHeading(pw) {
    const walker = document.createTreeWalker(document, NodeFilter.SHOW_TEXT);
    walker.currentNode = pw;
    for (let lines = 0; lines < 12 && walker.previousNode(); ) {
      const holder = walker.currentNode.parentElement;
      const text = textOf(walker.currentNode);
      if (!text || !visible(holder)) continue;
      lines++;
      if (SIGNUP_SECTION.test(text)) return false;
      if (RETURNING_SECTION.test(text)) return text.length <= 60;
      if (holder.closest('h1, h2, h3, h4, h5, h6, legend, [role=heading]')) return false;
    }
    return false;
  }

  // Njoyn gives returning users a form of their own, and its submit says "Apply": the one
  // place that word signs in. The form asks for an identifier and this password, nothing else.
  function returningForm(pw) {
    if (!pw.form) return null;
    const controls = deepAll('input, button').filter(el => el.form === pw.form && visible(el));
    const kinds = controls.map(kindOf).filter(Boolean);
    if (kinds.length !== 2 || !kinds.some(x => x.kind === 'email' || x.kind === 'username') || !underReturningHeading(pw)) return null;
    const { bad } = INTENT.login;
    const button = sectionButton(pw, controls.filter(el => {
      const label = buttonLabel(el);
      return el.matches(BUTTONS) && !el.disabled && !ELSEWHERE.test(label) && !bad.test(label) && (/^apply$/i.test(label) || !NON_AUTH_ACTION.test(label));
    }));
    return button ? { node: pw.form, button } : null;
  }

  function loginSection(pw) {
    const k = pw && kindOf(pw);
    if (k?.kind !== 'password' || k.confirm) return null;
    // Only an autocomplete hint can be overruled; a label asking for a new password means what it says.
    if (/new|create|choose|set up/.test(labelText(pw).toLowerCase().replace(/new-password/g, ''))) return null;
    return sharedSection(pw, k) || returningForm(pw);
  }

  function sharedSection(pw, k) {
    const { bad } = INTENT.login;
    let near = null; // the button belongs to the nearest level that has one, not to wherever the wording is
    for (let node = pw.parentElement; node && node !== document.documentElement; node = node.parentElement) {
      const kinds = deepAll('input', node).filter(visible).map(kindOf).filter(Boolean);
      if (kinds.filter(x => x.kind === 'password').length > 1) return null;
      const ids = kinds.filter(x => x.kind === 'email' || x.kind === 'username').length;
      if (ids > 1) return null;
      const buttons = deepAll(`${BUTTONS}, a[href]`, node).filter(el => {
        const label = buttonLabel(el);
        if (!visible(el) || el.disabled || ELSEWHERE.test(label) || bad.test(label) || NON_AUTH_ACTION.test(label)) return false;
        if (el.tagName === 'A' && !el.matches('[role=button]')) return /^(?:sign|log) ?in$/i.test(label);
        return !pw.form || !['BUTTON', 'INPUT'].includes(el.tagName) || el.form === pw.form;
      });
      if (ids !== 1 || !buttons.length) continue;
      near ||= buttons;
      const inputLabels = deepAll('input[type=submit], input[type=button]', node).map(el => el.value).join(' ');
      if (SIGNUP_SECTION.test(`${deepText(node, 4000)} ${inputLabels}`)) return null;
      let words = deepText(node, 4000).replace(/\s+/g, ' ');
      for (const el of deepAll(`${BUTTONS}, a[href]`, node)) {
        const label = textOf(el);
        if (label) words = words.replace(label, ' ');
      }
      // Sign-up forms ask for a new password and say "sign in" too; only returning-user wording overrules the hint.
      if (!RETURNING_SECTION.test(words) && (k.isNew || !SIGN_IN_SECTION.test(words))) continue;
      const button = sectionButton(pw, near);
      return button ? { node, button } : null;
    }
    return null;
  }

  function findSubmit(anchor, purpose) {
    const { good, bad } = INTENT[purpose] || INTENT.login;
    if (purpose === 'login') {
      const section = loginSection(anchor);
      if (section) return section.button;
    }
    const label = buttonLabel;
    const usable = el => visible(el) && !el.disabled && !ELSEWHERE.test(label(el)) && !bad.test(label(el)) && !NON_AUTH_ACTION.test(label(el));
    // An unrelated header login must never be used to submit a different form.
    const scopes = [anchor?.form || scopeOf(anchor)];
    for (const scope of scopes) {
      const buttons = deepAll(BUTTONS, scope).filter(usable);
      const typed = buttons.find(b => b.type === 'submit' && (anchor?.form ? b.form === anchor.form : true));
      if (typed) return typed;
      const named = buttons.find(b => good.test(label(b)));
      if (named) return named;
    }
    return null;
  }

  // A shadow root holding buttons is its own scope; one that wraps only an
  // input defers to the host's surroundings.
  function scopeOf(anchor) {
    for (let node = anchor; node; ) {
      const hit = node.closest?.(node === anchor ? CONTAINER : `form, ${CONTAINER}`);
      if (hit) return hit;
      const root = treeRoot(node);
      if (!root) return document;
      if (deepAll(BUTTONS, root).some(visible)) return root;
      node = root.host;
    }
    return document;
  }

  function authIntents(fields) {
    const passwords = fields.filter(f => f.kind === 'password');
    const first = passwords[0] || fields.find(f => ['email', 'username'].includes(f.kind));
    const anchor = first && byRef(first.ref);
    if (!anchor) return { login: false, signup: false };
    // CGI marks its returning-user password new-password; the section decides.
    if (passwords.length === 1 && loginSection(anchor)) return { login: true, signup: false };
    const scope = anchor.form || scopeOf(anchor);
    const buttonText = purpose => {
      const button = findSubmit(anchor, purpose);
      return button ? buttonLabel(button) : '';
    };
    const heads = [document.title, ...deepAll('h1,h2,h3', scope.closest?.('main, section, [role=dialog]') || document)
      .filter(visible).map(textOf), (location.pathname + location.hash).replace(/[-_/#]+/g, ' ')].join(' ');
    const loginButton = buttonText('login');
    const signupButton = buttonText('signup');
    const login = /sign ?in|log ?in|welcome back|enter your (e-?mail|password)/i;
    const signup = /sign ?up|create\b.{0,50}\baccount|register|join (us|now)/i;
    const isNew = passwords.some(f => f.isNew || f.confirm);
    return {
      login: !!loginButton && (login.test(loginButton) || (!isNew && (passwords.length > 0 || login.test(heads)))),
      // A plain password box next to both "Login" and "Create a New Account" (Taleo) is a sign-in form.
      signup: !!signupButton && (isNew || ((signup.test(signupButton) || signup.test(heads)) && !(passwords.length && login.test(loginButton)))),
    };
  }

  // Press whatever sits on top at the button's centre, as a real click would.
  // Workday, for one, lays a transparent layer over its buttons and listens there.
  function press(el) {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const hit = lookupRoot(el).elementFromPoint(x, y);
    const covered = hit && hit !== el && !el.contains(hit) && !hit.contains(el)
      && (hit.closest('[role=button]') || el.parentElement?.parentElement?.contains(hit));
    const target = covered ? hit : el;
    const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, pointerType: 'mouse' };
    target.dispatchEvent(new PointerEvent('pointerdown', init));
    target.dispatchEvent(new MouseEvent('mousedown', init));
    target.dispatchEvent(new PointerEvent('pointerup', init));
    target.dispatchEvent(new MouseEvent('mouseup', init));
    target.click();
  }

  // Submit events do not cross shadow boundaries, so listen on the form and its root too.
  function submit(anchor, purpose) {
    let event = null;
    const onSubmit = e => { event = e; };
    const targets = [...new Set([globalThis, anchor?.form, treeRoot(anchor)].filter(Boolean))];
    for (const target of targets) target.addEventListener('submit', onSubmit);
    try {
      const button = scan(() => findSubmit(anchor, purpose));
      if (button) press(button);
      else if (anchor?.form) anchor.form.requestSubmit();
      else if (anchor) {
        for (const type of ['keydown', 'keypress', 'keyup']) {
          anchor.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        }
      }
      return { clicked: !!button, native: !!event && !event.defaultPrevented };
    } finally {
      for (const target of targets) target.removeEventListener('submit', onSubmit);
    }
  }

  // Regional variants of a form (EA's Chinese and Korean fields) stay in the DOM, hidden but required.
  // Only fields the user could see and fill count as missing.
  function shown(el) {
    if (visible(el) || visible(el.closest('label'))) return true;
    const label = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    return !!label && visible(label);
  }

  function invalidFields(form, ours) {
    return [...form.elements].filter(el => el.willValidate && !el.checkValidity() && !ours.has(el) && shown(el));
  }

  function invalidLabels(form, ours) {
    return invalidFields(form, ours)
      .map(el => labelText(el).split(' ').slice(0, 6).join(' ') || el.name || el.type)
      .slice(0, 10);
  }

  // Fill and submit in one synchronous task, so no other script on the page
  // can run between the password going in and the form being sent.
  function fillAndSubmit({ fills, submitRef, purpose, validate }) {
    // Check before credentials enter the page. Email fields alone are not login forms.
    if (['login', 'signup'].includes(purpose) && !inspect().auth[purpose]) {
      return { ok: false, noForm: true };
    }
    // The sign-up block sharing a sign-in section's form keeps its own email field empty.
    const section = purpose === 'login' && scan(() => loginSection(byRef(submitRef)))?.node;
    // A form can own fields outside itself, as when the parser lifts it out of a table.
    if (section) fills = fills.filter(f => deepContains(section, byRef(f.ref)) || byRef(f.ref)?.form === section);
    const ours = new Set();
    for (const f of fills) {
      const el = byRef(f.ref);
      if (!el) return { ok: false, gone: true };
      setValue(el, f.value);
      filled.add(f.ref);
      ours.add(el);
    }
    const anchor = byRef(submitRef);
    if (!anchor) return { ok: true, submitted: false };
    const ownInvalid = validate && anchor.form && [...ours].some(el => !el.checkValidity());
    if (validate && anchor.form && (ownInvalid || invalidFields(anchor.form, ours).length)) {
      const missing = invalidLabels(anchor.form, ours);
      clearFilled(true);
      return { ok: false, ownInvalid, missing };
    }
    const result = submit(anchor, purpose);
    if (result.native) {
      // A normal form post has already captured its data; the old page can drop the values now.
      for (const f of fills) { const el = byRef(f.ref); if (el) el.value = ''; }
      filled.clear();
    }
    return { ok: true, submitted: true, ...result };
  }

  function fillCode({ refs: targets, code, submitRef }) {
    if (targets.length === 1) {
      setValue(byRef(targets[0]), code);
      filled.add(targets[0]);
    } else {
      targets.forEach((ref, i) => { const el = byRef(ref); if (el) { setValue(el, code[i] || ''); filled.add(ref); } });
    }
    const anchor = byRef(submitRef || targets[targets.length - 1]);
    return { ok: true, ...submit(anchor, 'code') };
  }

  function fillOne({ ref, value }) {
    const el = byRef(ref);
    if (!el) return { ok: false };
    setValue(el, value);
    return { ok: true };
  }

  function clearFilled(withEvents = true) {
    let cleared = 0;
    for (const ref of filled) {
      const el = byRef(ref);
      if (el?.isConnected && el.value) {
        if (withEvents) setValue(el, '');
        else el.value = '';
        cleared++;
      }
    }
    filled.clear();
    return { cleared };
  }

  function secretsLeft() {
    for (const ref of filled) if (byRef(ref)?.value) return true;
    return false;
  }

  globalThis.__latch = { inspect, fillAndSubmit, fillCode, fillOne, clearFilled, secretsLeft, requestRecovery, fillReset, fillResetAndSubmit, readTotpSetup, qrRect };
})();
