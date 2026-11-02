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

  function visible(el) {
    if (!el?.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    return r.right > 0 && r.bottom > 0 && r.left < innerWidth + 2000;
  }

  const textOf = node => (node?.innerText || node?.textContent || '').replace(/\s+/g, ' ').trim();

  function labelText(el) {
    const parts = [];
    for (const label of el.labels || []) parts.push(textOf(label));
    parts.push(el.getAttribute('aria-label') || '');
    for (const id of (el.getAttribute('aria-labelledby') || '').split(/\s+/)) {
      if (id) parts.push(textOf(document.getElementById(id)));
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

  function kindOf(el) {
    if (el.tagName !== 'INPUT' || el.disabled || el.readOnly) return null;
    const type = (el.type || 'text').toLowerCase();
    if (SKIP_TYPES.has(type)) return null;
    const auto = (el.getAttribute('autocomplete') || '').toLowerCase();
    const label = labelText(el).toLowerCase();
    if (type === 'password') {
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
    const widgets = [...document.querySelectorAll('iframe, .g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey]')].filter(el => {
      if (!visible(el) || el.closest('.grecaptcha-badge')) return false;
      const hint = el.tagName === 'IFRAME' ? `${el.src} ${el.title}` : 'captcha';
      const r = el.getBoundingClientRect();
      return /captcha|challenges\.cloudflare|turnstile|arkoselabs|funcaptcha/i.test(hint) && r.width > 100 && r.height > 40;
    });
    if (!widgets.length) return false;
    const solved = [...document.querySelectorAll('[name="g-recaptcha-response"], [name="h-captcha-response"], [name="cf-turnstile-response"]')]
      .some(el => (el.value || '').length > 20);
    return !solved;
  }

  function pageFlags() {
    const body = (document.body?.innerText || '').slice(0, 20000).toLowerCase();
    const heads = [document.title, ...[...document.querySelectorAll('h1, h2, button, [role=button], input[type=submit]')]
      .slice(0, 40).map(el => el.value || textOf(el))].join(' ').toLowerCase();
    return {
      loginish: /sign ?in|log ?in|welcome back|continue with email|enter your (e-?mail|password)/.test(heads),
      signupish: /sign ?up|create (an |your )?account|register|join|get started/.test(heads),
      emailCode: /(sent|emailed|e-?mail(ed)? you)[^.]{0,80}(code|link)|(code|link)[^.]{0,80}(sent|emailed) to (your )?(e-?mail|inbox)|check your (e-?mail|inbox)/.test(body),
      phoneCode: /text message|\bsms\b|texted|phone (number )?ending|sent to (your )?(phone|mobile)|mobile number ending/.test(body),
      appCode: /authenticator|authentication app|2fa app|totp|google auth/.test(body),
      passkey: /passkey|security key|windows hello|face id|touch id|use your device/.test(body),
      push: /approve (the )?(sign-?in|request)|tap yes|check your (phone|device) for|sent a notification/.test(body),
      checkEmail: /check your (e-?mail|inbox)|verify your (e-?mail|account)|confirm your (e-?mail|account)|(sent|emailed) you (a|an) (verification |confirmation |activation )?(link|email)|(link|email) (has been )?sent to/.test(body),
      exists: /already (exists|registered|in use|taken|associated)|account (already )?exists|account with (this|that) e-?mail/.test(body),
      locked: /too many (attempts|tries)|account (is )?(locked|disabled|suspended)|temporarily (locked|blocked)/.test(body),
      signedIn: [...document.querySelectorAll('a, button, [role=button], [role=menuitem]')].slice(0, 400)
        .some(el => visible(el) && (/^(sign|log) ?out$/i.test(textOf(el)) || el.matches('#accountSettingsButton, [data-automation-id="accountSettingsButton"]'))),
    };
  }

  function errorText() {
    const nodes = document.querySelectorAll('[role=alert], [aria-live=assertive], [aria-live=polite], .error, .errors, .alert-danger, .invalid-feedback, [class*="error" i], [id*="error" i]');
    for (const node of nodes) {
      const text = textOf(node);
      if (text && text.length > 3 && visible(node)) return text.slice(0, 160);
    }
    return '';
  }

  function inspect() {
    const fields = [];
    for (const el of document.querySelectorAll('input')) {
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
    const active = document.activeElement;
    const focused = active && active.tagName === 'INPUT' && fields.find(f => byRef(f.ref) === active);
    const auth = authIntents(fields);
    const choices = [...document.querySelectorAll('a, button, [role=button], input[type=submit], input[type=button]')]
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
      busy: [...document.querySelectorAll('[aria-busy=true], button[disabled][type=submit]')].some(visible),
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
        create_account: auth.signup || offers(/create\b.{0,30}\baccount|sign ?up|register/i),
        guest: offers(/(?:as (?:a )?guest|guest (?:access|checkout|application)|apply without (?:an )?account)/i),
      },
    };
  }

  function setValue(el, value) {
    el.focus();
    el.value = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
  }

  const BUTTONS = 'button, input[type=submit], input[type=button], input[type=image], [role=button], a[role=button]';
  const buttonLabel = el => ((el.tagName === 'INPUT' ? el.value : textOf(el)) || el.getAttribute('aria-label') || el.value || '').trim();
  const NON_AUTH_ACTION = /\bapplication\b|\bresume\b|\bsubscribe\b|\bnewsletter\b|\bapply\b/i;
  const ELSEWHERE = /google|apple|facebook|microsoft|github|linkedin|twitter|indeed|corporate|\bx\b|sso|single sign|passkey|forgot|reset|cancel|back|show|hide|eye|visibility|help/i;
  const INTENT = {
    login: { good: /sign ?in|log ?in|continue|next|submit|verify|confirm|go\b/i, bad: /sign ?up|create|register|join/i },
    signup: { good: /create|sign ?up|register|join|continue|next|submit|get started|agree|verify|confirm/i, bad: /sign ?in|log ?in/i },
    code: { good: /verify|confirm|continue|next|submit|done|sign ?in|log ?in/i, bad: /resend|send again|new code|different/i },
  };

  function findSubmit(anchor, purpose) {
    const { good, bad } = INTENT[purpose] || INTENT.login;
    const label = buttonLabel;
    const usable = el => visible(el) && !el.disabled && !ELSEWHERE.test(label(el)) && !bad.test(label(el)) && !NON_AUTH_ACTION.test(label(el));
    // An unrelated header login must never be used to submit a different form.
    const scopes = anchor?.form ? [anchor.form] : [anchor?.closest('[role=dialog], [role=form], section, main') || document];
    for (const scope of scopes) {
      const buttons = [...scope.querySelectorAll(BUTTONS)].filter(usable);
      const typed = buttons.find(b => b.type === 'submit' && (anchor?.form ? b.form === anchor.form : true));
      if (typed) return typed;
      const named = buttons.find(b => good.test(label(b)));
      if (named) return named;
    }
    return null;
  }

  function authIntents(fields) {
    const passwords = fields.filter(f => f.kind === 'password');
    const first = passwords[0] || fields.find(f => ['email', 'username'].includes(f.kind));
    const anchor = first && byRef(first.ref);
    if (!anchor) return { login: false, signup: false };
    const scope = anchor.form || anchor.closest('[role=dialog], [role=form], section, main') || document;
    const buttonText = purpose => {
      const button = findSubmit(anchor, purpose);
      return button ? buttonLabel(button) : '';
    };
    const heads = [document.title, ...[...(scope.closest?.('main, section, [role=dialog]') || document).querySelectorAll('h1,h2,h3')]
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
    const hit = document.elementFromPoint(x, y);
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

  function submit(anchor, purpose) {
    let fired = false;
    let native = false;
    const onSubmit = e => { fired = true; native = !e.defaultPrevented; };
    addEventListener('submit', onSubmit);
    try {
      const button = findSubmit(anchor, purpose);
      if (button) press(button);
      else if (anchor?.form) anchor.form.requestSubmit();
      else if (anchor) {
        for (const type of ['keydown', 'keypress', 'keyup']) {
          anchor.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        }
      }
      return { clicked: !!button, native: fired && native };
    } finally {
      removeEventListener('submit', onSubmit);
    }
  }

  function invalidLabels(form, ours) {
    return [...form.elements]
      .filter(el => el.willValidate && !el.checkValidity() && !ours.has(el))
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
    if (validate && anchor.form && !anchor.form.checkValidity()) {
      const ownInvalid = [...ours].some(el => !el.checkValidity());
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

  globalThis.__latch = { inspect, fillAndSubmit, fillCode, fillOne, clearFilled, secretsLeft };
})();
