// Latch's on-page control. Every frame reports whether it holds sign-in style
// inputs; the top frame draws the bar the service worker describes.
//
// The bar's buttons and text live in the light DOM, slotted into a closed
// shadow root that holds the styling. Browser AIs (Claude in Chrome, ChatGPT
// agent, Codex) read pages through the light DOM only, so this is what lets
// them see "Sign in with Latch" and press it. The bar never contains
// credentials. A press counts only when it is a trusted input event on a bar
// that is unobscured and has not been tampered with.
(() => {
  // After an update the old copy of this script is orphaned; a live copy keeps the page.
  if (globalThis.__latchBar?.alive() || !globalThis.chrome?.runtime?.id) return;
  const runtime = globalThis.chrome.runtime;
  globalThis.__latchBar = { alive: () => !!runtime?.id };

  const isTop = window === window.top;
  // Bar state. Declared before the subframe return so shared helpers can read it.
  let host = null;
  let parts = {};
  let tag = null;        // observes the bar for edits by the page
  let parentTag = null;  // notices the bar being removed
  let model = null;
  let tamperedAt = -Infinity;
  let rebuilds = 0;
  let visibleSince = 0;
  let visibility = null;
  let dismissed = false;
  let pending = false;
  let painted = '';      // the model last drawn

  const alive = () => !!runtime?.id;
  const send = msg => {
    if (!alive()) { teardown(); return Promise.resolve(null); }
    return chrome.runtime.sendMessage(msg).catch(() => null);
  };

  // ---------- probe: a cheap look for inputs a sign-in, sign-up or code step would use

  const CODE_HINT = /code|otp|pin\b|passcode|token|2fa|mfa|verif/i;
  function shown(el) {
    if (!el.isConnected || el.disabled || el.type === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width >= 4 && r.height >= 4;
  }
  function inputsIn(root, out, budget) {
    for (const el of root.querySelectorAll('input')) out.push(el);
    if (out.length || budget.left <= 0) return;
    for (const el of root.querySelectorAll('*')) {
      if (--budget.left <= 0) return;
      let shadow = el.shadowRoot;
      if (!shadow) { try { shadow = chrome.dom?.openOrClosedShadowRoot?.(el) || null; } catch { shadow = null; } }
      if (shadow) inputsIn(shadow, out, budget);
    }
  }
  function signature() {
    const inputs = [];
    inputsIn(document, inputs, { left: 4000 });
    let pw = 0, ident = 0, code = 0;
    for (const el of inputs) {
      if (!shown(el)) continue;
      const type = (el.type || 'text').toLowerCase();
      const auto = (el.getAttribute('autocomplete') || '').toLowerCase();
      const hint = `${el.name} ${el.id} ${el.placeholder || ''} ${el.getAttribute('aria-label') || ''}`;
      if (type === 'password') pw++;
      else if (type === 'email' || /email|username/.test(auto) || /e-?mail|user/i.test(hint)) ident++;
      else if (auto.includes('one-time-code') || el.maxLength === 1 || CODE_HINT.test(hint)) code++;
    }
    return pw || ident || code ? `${pw}.${ident}.${code}` : '';
  }

  let lastSig = null;
  let probeTimer = null;
  let lastProbe = 0;
  function probe() {
    if (probeTimer) return;
    const wait = Math.max(0, 700 - (Date.now() - lastProbe));
    probeTimer = setTimeout(() => {
      probeTimer = null;
      lastProbe = Date.now();
      if (!alive()) return teardown();
      const sig = signature();
      if (sig === lastSig) return;
      const first = lastSig === null;
      lastSig = sig;
      if (first && !sig && !isTop) return;
      send({ type: 'bar:probe', sig, url: location.href });
    }, wait);
  }

  const watcher = new MutationObserver(records => {
    if (host && records.every(r => host.contains(r.target) || r.target === host)) return;
    probe();
  });
  watcher.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['type', 'style', 'class', 'hidden', 'disabled'] });
  addEventListener('pageshow', () => { lastSig = null; probe(); });
  addEventListener('focusin', probe, true);
  probe();

  if (!isTop) return;

  // ---------- the bar (top frame only)

  const CSS = `
    /* The host carries the panel's colours too, so tools that cannot see into the closed
       shadow root (screen-reader and contrast checkers) still find the real background. */
    :host {
      all: initial;
      --bg: #ffffff; --fg: #16161a; --fg2: #5d5d66; --line: rgba(22,22,26,.10); --btn: #16161a; --btnfg: #ffffff;
      --good: #18794e; --bad: #c0352b; --wait: #8a5a00; --ring: #3b6ef5; --brass: #e2a336;
      background: var(--bg) !important; color: var(--fg) !important; border-radius: 14px !important;
    }
    .bar {
      box-sizing: border-box; display: grid; grid-template-columns: 28px 1fr auto; gap: 4px 10px; align-items: center;
      width: min(372px, calc(100vw - 24px)); padding: 12px 12px 12px 12px; border-radius: 14px;
      background: var(--bg); color: var(--fg); border: 1px solid var(--line);
      box-shadow: 0 12px 32px rgba(0,0,0,.18), 0 2px 6px rgba(0,0,0,.08);
      font: 13px/1.4 "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
      -webkit-font-smoothing: antialiased; text-align: left; direction: ltr;
    }
    @media (prefers-color-scheme: dark) {
      :host { --bg: #1b1b1e; --fg: #ececef; --fg2: #a3a3ab; --line: rgba(255,255,255,.12); --btn: #ececef; --btnfg: #161618;
        --good: #5fd39a; --bad: #f27b72; --wait: #f1b45a; --ring: #7b9cff; }
    }
    .logo { width: 28px; height: 28px; display: block; }
    .head { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
    .close { justify-self: end; align-self: start; }
    .body { grid-column: 1 / -1; display: grid; gap: 8px; margin-top: 4px; }
    .actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    ::slotted([slot=title]) { all: unset !important; font-weight: 650 !important; font-size: 13px !important; color: var(--fg) !important; }
    ::slotted([slot=host]) { all: unset !important; font-size: 12px !important; color: var(--fg2) !important; overflow: hidden !important;
      text-overflow: ellipsis !important; white-space: nowrap !important; min-width: 0 !important; }
    ::slotted([slot=note]) { all: unset !important; display: block !important; font-size: 12.5px !important; color: var(--fg) !important; }
    ::slotted([slot=agent]) { all: unset !important; display: block !important; font-size: 11.5px !important; color: var(--fg2) !important; }
    ::slotted([slot=status]) { all: unset !important; display: block !important; font-size: 12.5px !important; color: var(--fg2) !important; }
    ::slotted([slot=status][data-tone=good]) { color: var(--good) !important; font-weight: 600 !important; }
    ::slotted([slot=status][data-tone=bad]) { color: var(--bad) !important; font-weight: 600 !important; }
    ::slotted([slot=status][data-tone=wait]) { color: var(--wait) !important; font-weight: 600 !important; }
    ::slotted([slot=status]:empty), ::slotted([slot=note]:empty), ::slotted([slot=agent]:empty) { display: none !important; }
    ::slotted([slot=primary]) {
      all: unset !important; box-sizing: border-box !important; display: inline-flex !important; align-items: center !important; justify-content: center !important;
      min-height: 36px !important; padding: 0 16px !important; border-radius: 10px !important; cursor: pointer !important;
      background: var(--btn) !important; color: var(--btnfg) !important; font: 600 13px/1 "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif !important;
      white-space: nowrap !important;
    }
    ::slotted([slot=primary][hidden]), ::slotted([slot=link][hidden]) { display: none !important; }
    ::slotted([slot=primary][aria-disabled=true]) { opacity: .55 !important; cursor: progress !important; }
    ::slotted([slot=link]) {
      all: unset !important; box-sizing: border-box !important; display: inline-flex !important; align-items: center !important; min-height: 36px !important;
      padding: 0 14px !important; border-radius: 10px !important; border: 1px solid var(--line) !important; cursor: pointer !important;
      color: var(--fg) !important; font: 600 13px/1 "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif !important;
    }
    ::slotted([slot=close]) {
      all: unset !important; box-sizing: border-box !important; display: inline-grid !important; place-items: center !important; width: 26px !important; height: 26px !important;
      border-radius: 8px !important; cursor: pointer !important; color: var(--fg2) !important; font: 18px/1 system-ui, sans-serif !important;
    }
    ::slotted([slot=close]:hover) { background: rgba(127,127,127,.14) !important; }
    ::slotted(:focus-visible) { outline: 2px solid var(--ring) !important; outline-offset: 2px !important; }
  `;
  const LOGO = `<svg class="logo" viewBox="0 0 28 28" aria-hidden="true"><rect width="28" height="28" rx="8" fill="#16161a"/>
    <circle cx="14" cy="11.6" r="3.6" fill="#e2a336"/><path d="M12.4 13.4h3.2l1.1 7.4h-5.4z" fill="#e2a336"/></svg>`;

  function make(tagName, slot, attrs = {}) {
    const el = document.createElement(tagName);
    el.slot = slot;
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }

  function build() {
    for (const stale of document.querySelectorAll('latch-bar')) stale.remove();
    host = document.createElement('latch-bar');
    host.setAttribute('popover', 'manual');
    host.setAttribute('role', 'region');
    host.setAttribute('aria-label', 'Latch');
    host.setAttribute('data-latch', '');
    // Undo the browser's popover box so only the shadow bar draws.
    host.style.cssText = 'all: initial !important; position: fixed !important; inset: 12px 12px auto auto !important; margin: 0 !important;' +
      'padding: 0 !important; border: 0 !important; overflow: visible !important; display: block !important;' +
      'width: auto !important; height: auto !important; z-index: 2147483647 !important; color-scheme: light dark !important;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${CSS}</style><div class="bar">${LOGO}<div class="head"><slot name="title"></slot><slot name="host"></slot></div>` +
      '<div class="close"><slot name="close"></slot></div><div class="body"><slot name="note"></slot><div class="actions"><slot name="primary"></slot>' +
      '<slot name="link"></slot></div><slot name="status"></slot><slot name="agent"></slot></div></div>';
    parts = {
      title: make('span', 'title'),
      host: make('span', 'host'),
      close: make('button', 'close', { type: 'button', 'aria-label': 'Hide Latch on this page', title: 'Hide Latch on this page' }),
      note: make('span', 'note'),
      primary: make('button', 'primary', { type: 'button' }),
      link: make('a', 'link', { target: '_blank', rel: 'noopener noreferrer' }),
      status: make('span', 'status', { role: 'status', 'aria-live': 'polite' }),
      agent: make('span', 'agent'),
    };
    parts.title.textContent = 'Latch';
    parts.close.textContent = '×';
    host.append(...Object.values(parts));

    parts.primary.addEventListener('click', onPrimary, true);
    parts.primary.addEventListener('focus', earnFocus);
    parts.primary.addEventListener('blur', () => { earnedFocusAt = 0; });
    parts.close.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      if (!e.isTrusted) return;
      dismissed = true;
      teardown(false);
    }, true);
    parts.link.addEventListener('click', e => {
      e.stopPropagation();
      if (!e.isTrusted) e.preventDefault();
    }, true);

    tag = new MutationObserver(() => {
      tamperedAt = performance.now();
      rebuild();
    });
    attach();
  }

  function container() {
    // A modal dialog makes everything outside it inert, so the bar moves inside it.
    let modal = null;
    try { modal = document.querySelector('dialog:modal'); } catch {}
    return modal || document.body || document.documentElement;
  }

  function attach() {
    const where = container();
    if (host.parentNode !== where) where.append(host);
    try { if (!host.matches(':popover-open')) host.showPopover(); } catch {}
    tag.observe(host, { attributes: true, childList: true, subtree: true, characterData: true });
    parentTag?.disconnect();
    parentTag = new MutationObserver(() => {
      if (!host) return;
      if (!host.isConnected) {
        tamperedAt = performance.now();
        rebuild();
      } else if (host.parentNode !== container()) {
        container().append(host);
        try { host.showPopover(); } catch {}
      }
    });
    parentTag.observe(document.documentElement, { childList: true, subtree: true });
    watchVisibility();
  }

  // Our own edits are taken back out of the observer, so only the page's count as tampering.
  function quietly(fn) {
    fn();
    tag?.takeRecords();
  }

  function rebuild() {
    if (!host) return;
    if (++rebuilds > 12) return teardown(false);
    const keep = model;
    teardown(false);
    build();
    paint(keep);
  }

  function teardown(clear = true) {
    painted = '';
    visibility?.disconnect();
    tag?.disconnect();
    parentTag?.disconnect();
    visibility = tag = parentTag = null;
    try { host?.hidePopover(); } catch {}
    host?.remove();
    host = null;
    parts = {};
    if (clear) model = null;
  }

  // Intersection Observer v2 reports whether the button is actually visible: not covered,
  // faded, filtered or transformed. Presses on a covered bar are ignored.
  function watchVisibility() {
    visibility?.disconnect();
    visibleSince = 0;
    try {
      visibility = new IntersectionObserver(entries => {
        for (const e of entries) {
          const seen = 'isVisible' in e ? e.isVisible : e.isIntersecting;
          visibleSince = seen ? (visibleSince || performance.now()) : 0;
          if (!seen && host) raise();
        }
      }, { threshold: [1], trackVisibility: true, delay: 100 });
      visibility.observe(parts.primary);
    } catch {
      visibleSince = performance.now();
    }
  }

  let lastRaise = 0;
  function raise() {
    if (Date.now() - lastRaise < 2000 || !host) return;
    lastRaise = Date.now();
    quietly(() => {
      try { host.hidePopover(); } catch {}
      try { host.showPopover(); } catch {}
    });
  }

  // Why a press cannot count right now, or '' when it can. A press in the first moment after
  // the bar appears is ignored too, so a click aimed at the page cannot land on it by surprise.
  const REFUSED = {
    changed: 'Latch ignored that press because the page changed the Latch panel. Press again.',
    covered: 'Latch ignored that press because something on the page is covering the Latch panel. Press again.',
    new: 'Latch had only just appeared, so it ignored that press. Press again.',
    key: 'Latch ignored a key press it did not get directly. Click the button, or Tab to it and press Enter.',
  };

  // Text a page could slip into the panel with CSS (::before or ::after content).
  const PSEUDO = ['::before', '::after'];
  function decorated() {
    for (const el of [host, ...Object.values(parts)]) {
      for (const pseudo of PSEUDO) {
        const content = getComputedStyle(el, pseudo).content;
        if (content && content !== 'none' && content !== 'normal') return true;
      }
    }
    return false;
  }

  function refusal() {
    if (!host?.isConnected || performance.now() - tamperedAt < 1000) return 'changed';
    try { if (!host.matches(':popover-open')) return 'changed'; } catch { return 'changed'; }
    if (parts.primary.parentNode !== host || parts.primary.hidden || decorated()) return 'changed';
    if (!visibleSince) return 'covered';
    return performance.now() - visibleSince < 250 ? 'new' : '';
  }

  // A key press reaches the button only if it had focus. A page can move focus there with
  // .focus() just before the user or an AI presses Enter for something else, so a press from
  // the keyboard counts only when the button was reached by Tab or a pointer.
  let lastTab = -Infinity;
  let lastPoint = -Infinity;
  let earnedFocusAt = 0;
  addEventListener('keydown', e => { if (e.isTrusted && e.key === 'Tab') lastTab = performance.now(); }, true);
  addEventListener('pointerdown', e => { if (e.isTrusted) lastPoint = performance.now(); }, true);
  function earnFocus() {
    const t = performance.now();
    earnedFocusAt = t - lastTab < 400 || t - lastPoint < 400 ? t : 0;
  }
  const fromKeyboard = e => e.detail === 0;

  async function onPrimary(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!e.isTrusted || pending || !model?.action) return;
    const refused = fromKeyboard(e) && (!earnedFocusAt || performance.now() - earnedFocusAt < 250) ? 'key' : refusal();
    if (refused) {
      raise();
      quietly(() => {
        parts.status.dataset.tone = 'bad';
        parts.status.textContent = REFUSED[refused];
      });
      return;
    }
    pending = true;
    quietly(() => {
      parts.primary.setAttribute('aria-disabled', 'true');
      parts.status.dataset.tone = 'wait';
      parts.status.textContent = 'Working…';
    });
    const r = await send({ type: 'bar:act', action: model.action, url: location.href });
    pending = false;
    if ((!r || r.ok === false) && host) {
      quietly(() => {
        parts.primary.removeAttribute('aria-disabled');
        parts.status.dataset.tone = 'bad';
        parts.status.textContent = r?.message || 'Latch did not respond. Press again.';
      });
    }
  }

  function paint(next) {
    // An unchanged model leaves the bar alone, so a message about the last press stays up.
    const key = JSON.stringify(next);
    if (host && key === painted) return;
    painted = key;
    model = next;
    if (!model || dismissed) return teardown();
    if (!host) build();
    quietly(() => {
      parts.host.textContent = model.host ? `· ${model.host}` : '';
      parts.note.textContent = model.note || '';
      parts.agent.textContent = model.agent || '';
      parts.primary.hidden = !model.action;
      parts.primary.textContent = model.label || '';
      if (model.busy) parts.primary.setAttribute('aria-disabled', 'true');
      else parts.primary.removeAttribute('aria-disabled');
      const href = /^https:\/\//.test(model.linkUrl || '') ? model.linkUrl : '';
      parts.link.hidden = !href;
      if (href) parts.link.setAttribute('href', href); else parts.link.removeAttribute('href');
      parts.link.textContent = href ? model.linkLabel || 'Open' : '';
      parts.status.textContent = model.status || '';
      if (model.tone) parts.status.dataset.tone = model.tone; else delete parts.status.dataset.tone;
    });
  }

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (sender.id !== chrome.runtime.id || msg?.type !== 'bar:state') return;
    if (msg.origin && msg.origin !== location.origin) return;
    paint(msg.model || null);
  });

  addEventListener('pagehide', () => { lastSig = null; });
})();
