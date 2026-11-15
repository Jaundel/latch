// Page-side application executor. The host supplies __jobApplyScan and trusted plans.
(() => {
  'use strict';
  const VERSION = '1.3.13';
  if (globalThis.__jobApply && globalThis.__jobApply.version === VERSION) return;
  const clean = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const key = s => clean(s).toLocaleLowerCase(); // Preserve punctuation in option matching.
  const secret = /password|passcode|verification code|one.?time.?code|security code|\botp\b|\bpin\b|captcha/i;
  const submit = /^(submit|submit application|submit your application|send application|complete application|finish|submit my application|send|apply)$/i;
  const safeNext = /^(next|continue|save (?:and|&) continue)$/i;
  const forbidden = /\b(submit|apply|send|sign.?in|log.?in|sign.?up|register|verify|account|captcha)\b/i;
  let activeRun = null;
  class RunStopped extends Error {}
  function ensureActive(acted = false) {
    if (!activeRun || activeRun.cancelled || Date.now() >= activeRun.deadline) throw new RunStopped();
    if (acted) activeRun.acted = true;
  }
  // Chrome limits timers in background tabs to one a second, so waits here yield through a message port instead.
  const nap = ms => new Promise(resolve => {
    const end = performance.now() + ms, {port1, port2} = new MessageChannel();
    port1.onmessage = () => { if (performance.now() >= end) { port1.close(); resolve(); } else port2.postMessage(0); };
    port2.postMessage(0);
  });
  const pause = async ms => { ensureActive(); await nap(ms); ensureActive(); };
  const uploaded = new Map();
  const documentId = [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2,'0')).join('');
  let receiptUrl = location.href;
  const wantedEntries = new Map();
  const optionCache = new Map();
  const elementIds = new WeakMap(), elements = new Map();
  let nextId = 1;
  const visible = el => {
    if (!el || !el.isConnected) return false;
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && (r.width > 0 || r.height > 0);
  };
  const idEl = id => {
    const el = elements.get(String(id));
    return el && el.isConnected && elementIds.get(el) === String(id) && el.getAttribute('data-ja') === String(id) ? el : null;
  };
  function trustedScan() {
    ensureActive();
    // Scanner IDs are internal capabilities, not attributes supplied by the page.
    for (const [id, el] of elements) { ensureActive(); if (el.isConnected) el.setAttribute('data-ja', id); }
    for (const el of document.querySelectorAll('[data-ja]')) {
      ensureActive();
      const known = elementIds.get(el);
      if (known) el.setAttribute('data-ja', known); else el.removeAttribute('data-ja');
    }
    ensureActive(); document.documentElement.setAttribute('data-ja-next', String(nextId));
    let inv;
    globalThis.__jobApplyAssertActive = () => ensureActive();
    try { inv = globalThis.__jobApplyScan(); }
    finally { delete globalThis.__jobApplyAssertActive; }
    for (const el of document.querySelectorAll('[data-ja]')) {
      const id = el.getAttribute('data-ja');
      if (!elementIds.has(el)) { elementIds.set(el, id); elements.set(id, el); }
    }
    nextId = Number(document.documentElement.getAttribute('data-ja-next')) || nextId;
    return inv;
  }
  const allowedOrigin = expected => {
    try { const u = new URL(location.href); return /^https?:$/.test(u.protocol) && u.origin === expected; }
    catch (_) { return false; }
  };
  // Do not invoke the scanner on credential forms: it reads field values.
  const credentialWall = () => {
    const inputs = [...document.querySelectorAll('input')].filter(visible);
    if (inputs.some(e => e.type.toLowerCase() === 'password' || e.autocomplete === 'one-time-code')) return 'credential field';
    if (inputs.some(e => secret.test([e.getAttribute('aria-label'), e.name, e.id, e.placeholder].join(' ')))) return 'credential field';
    if (inputs.some(e => [...(e.labels || [])].some(l => secret.test(l.textContent || '')))) return 'credential field';
    if (inputs.some(e => (e.getAttribute('aria-labelledby') || '').split(/\s+/).some(id => secret.test(document.getElementById(id)?.textContent || '')))) return 'credential field';
    const headings = [...document.querySelectorAll('h1,h2,h3,[role="heading"]')].filter(visible).map(e => clean(e.textContent)).join(' ');
    const pageText = clean(document.body && document.body.innerText).slice(0, 20000);
    if (/verify your (?:email|account)|verification (?:code|email)|enter (?:the|your) (?:code|passcode)|check your (?:email|inbox)/i.test(pageText)) return 'verification step';
    if (/sign.?in|log.?in|sign.?up|create (?:an? |my )?account|register/i.test(headings)) return 'authentication step';
    const actions = [...document.querySelectorAll('button,input[type="submit"],[role="button"]')].filter(visible).map(e => clean(e.textContent || e.getAttribute('aria-label') || e.value));
    if (inputs.length && inputs.every(e => /email|user|login/i.test([e.type,e.name,e.id,e.getAttribute('aria-label')].join(' '))) && actions.some(t => /^(sign.?in|log.?in|sign.?up|create account|register|next|continue)$/i.test(t)) && /sign.?in|log.?in|sign.?up|create account|register/i.test(pageText)) return 'authentication step';
    if ([...document.querySelectorAll('iframe[title*="challenge" i],iframe[src*="hcaptcha"],iframe[src*="recaptcha"][src*="anchor"],.h-captcha,.g-recaptcha:not([data-size="invisible"])')].some(el => {
      const r = el.getBoundingClientRect();
      return visible(el) && !el.closest('.grecaptcha-badge, [data-size="invisible"]') && r.width > 120 && r.height > 40;
    })) return 'captcha';
    return '';
  };
  const minimal = reason => ({url: location.href, page: clean(document.title).slice(0, 80) || 'Form', fields: [], errors: [], validation: [], blocking: [reason]});
  function snapshot(inv) {
    const fields = inv.fields.filter(f => f.kind !== 'password' && f.autocomplete !== 'one-time-code' && !secret.test(f.label || '') &&
      !idEl(f.id)?.closest('[data-automation-id="selectedItemList"]')).map(f => {
      const x = {...f};
      if ((!x.options || !x.options.length) && optionCache.has(String(x.id))) x.options = optionCache.get(String(x.id));
      if (x.kind === 'multiselect_prompt') x.value = clean(x.value) ? x.value.split(/\s*;\s*/).filter(Boolean) : [];
      if (x.kind === 'multiselect') {
        const el = idEl(x.id); x.value = el ? [...el.selectedOptions].map(o => clean(o.textContent)) : [];
      }
      if (x.kind === 'file') {
        const receipt = uploadReceipt(x, idEl(x.id));
        if (receipt) x.upload_receipt = receipt;
        x.attachments = (x.attachments || []).map(({witness_id, ...witness}) => witness);
      }
      return x;
    });
    const step = [...document.querySelectorAll('[data-automation-id="progressBarActiveStep"], [aria-current="step"]')].find(visible);
    const functional = /^(my information|my experience|application questions?(?: \d+)?|voluntary disclosures?|self identify|self.identification|review(?: and submit)?|personal information|work experience|education|attachments|additional information)$/i;
    const progressText = step && clean(step.innerText || step.textContent).replace(/^current step \d+ of \d+\s*/i, '').replace(/^step \d+ of \d+\s*/i, '');
    const page = (progressText || inv.headings.map(x => clean(x).replace(/^current step \d+ of \d+\s*/i, '')).find(x => functional.test(x)) || inv.headings.find(x => x && x.length < 80) || inv.title || 'Form').slice(0, 80);
    const finalButton = inv.buttons.find(b => !b.disabled && submit.test(clean(b.text)) && (key(b.text) !== 'apply' || fields.length));
    const blocking = [];
    if (inv.signals.captcha) blocking.push('captcha');
    if (inv.signals.verify_email) blocking.push('verification step');
    if (inv.signals.confirmation) blocking.push('application already submitted');
    if (inv.signals.already_applied) blocking.push('already applied');
    if (inv.signals.closed) blocking.push('posting closed');
    if (inv.dialogs.length) blocking.push('blocking dialog');
    const entry_sections = entryGroups().map(({key, label, count, required}) => {
      const wanted = key === 'certifications' ? 0 : wantedEntries.has(key) ? wantedEntries.get(key) : null;
      if (key === 'unknown') blocking.push(`unsupported repeatable section: ${label}`);
      if (key === 'certifications') {
        const complete = required === false && count === 0;
        if (!complete) blocking.push('certifications require manual support');
        return {key, label, count, wanted, complete, required};
      }
      return {key, label, count, wanted, complete: key === 'unknown' ? false : wanted === null ? null : count >= wanted};
    });
    const result = {url: inv.url, document_id:documentId, page, fields, errors: inv.errors, validation: inv.validation || [], signals: inv.signals, blocking, entry_sections,
      open_options: openOptions().slice(0, 5).map(optText)};
    // Workday holds this button disabled until the step has loaded, and can show the last step's fields until then.
    const footer = document.querySelector('[data-automation-id="pageFooterNextButton"]');
    if (footer && (footer.disabled || footer.getAttribute('aria-disabled') === 'true')) result.busy = true;
    if (inv.signals.already_applied) { result.already_applied = true; result.status_text = 'Portal reports an existing application'; }
    if (finalButton) { result.final = true; result.submit_label = finalButton.text; }
    return result;
  }
  function scan(expected) {
    if (!allowedOrigin(expected)) return {status: 'blocked', snapshot: minimal('origin mismatch or unsupported protocol')};
    const wall = credentialWall();
    if (wall) return {status: 'blocked', snapshot: minimal(wall)};
    if (receiptUrl !== location.href) { for (const id of uploaded.keys()) forgetUpload(id); receiptUrl = location.href; }
    const inv = trustedScan();
    const snap = snapshot(inv);
    return {status: snap.blocking.length ? 'blocked' : 'page', snapshot: snap, inv};
  }
  const emit = el => { for (const type of ['input','change','blur']) { ensureActive(true); el.dispatchEvent(new Event(type, {bubbles: true})); } };
  // Chrome sends no focus events to a page without window focus, and Workday commits a date when focus leaves it.
  function focusOn(el) {
    const silent = !document.hasFocus();
    el.focus();
    if (silent) for (const type of ['focus','focusin']) el.dispatchEvent(new FocusEvent(type, {bubbles: type === 'focusin', composed:true}));
  }
  function leave(el) {
    const silent = !document.hasFocus();
    el.blur();
    if (silent) for (const type of ['blur','focusout']) el.dispatchEvent(new FocusEvent(type, {bubbles: type === 'focusout', composed:true}));
  }
  function setText(el, value, commit = false) {
    ensureActive(true);
    const v = String(value == null ? '' : value);
    if (commit) focusOn(el);
    if (el.isContentEditable) el.textContent = v;
    else {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, v);
    }
    if (commit) {
      // Use the native setter above, rather than a framework's own value setter,
      // so a controlled input can observe the new value during its input event.
      el.dispatchEvent(new InputEvent('input', {bubbles:true, composed:true, inputType:'insertText', data:v}));
      el.dispatchEvent(new Event('change', {bubbles:true}));
      leave(el); // React's onBlur listens to focusout; an unfocused blur alone cannot commit.
    } else emit(el);
    return clean(el.isContentEditable ? el.textContent : el.value) === clean(v);
  }
  function check(el, wanted) {
    if (!el || !el.isConnected || el.disabled || !((el.tagName === 'INPUT' && /^(checkbox|radio)$/i.test(el.type)) || /^(checkbox|radio|button)$/i.test(el.getAttribute('role') || ''))) return false;
    if (!safeFieldClick(el)) return false;
    const current = () => typeof el.checked === 'boolean' ? el.checked : el.hasAttribute('aria-checked') ? el.getAttribute('aria-checked') === 'true' : el.getAttribute('aria-pressed') === 'true';
    if (current() !== wanted) { ensureActive(true); el.click(); }
    return current() === wanted;
  }
  const match = (a,b) => key(a) === key(b);
  const skillKey = value => {
    const name = key(value).replace(/\s*\(programming language\)\s*$/i, '');
    return ({'python numpy': 'numpy', 'altera quartus': 'intel quartus prime',
      'structured query language (sql)': 'sql', 'siemens/mentor modelsim': 'modelsim/questa',
      'playwright (software)': 'playwright', 'webgl': 'webgl 2', 'model context protocol': 'mcp',
      'oauth': 'oauth 2.0', 'siemens modelsim': 'modelsim/questa', 'fpga design': 'fpga/rtl'})[name] || name;
  };
  const skillMatch = (a,b) => skillKey(a) === skillKey(b);
  const optText = e => clean(e.innerText || e.textContent || e.getAttribute('aria-label'));
  function safeFieldClick(el) {
    // Effective .type catches <button> without a type attribute: HTML defaults it to submit.
    return !!el && el.isConnected && !el.disabled && !/^(submit|image)$/i.test(el.type || '') &&
      !el.closest('a[href]') && !forbidden.test(optText(el));
  }
  // Workday's Add buttons have no type attribute, so HTML calls them submit buttons. Only this exact control is exempt.
  function safeAddClick(el) {
    return !!el && el.isConnected && !el.disabled && el.getAttribute('data-automation-id') === 'add-button' &&
      /(^|\.)myworkdayjobs\.com$/i.test(location.hostname) && !el.closest('a[href]') && !forbidden.test(optText(el));
  }
  const uploadScope = el => el.closest('[data-automation-id="attachments-FileUpload"], [data-automation-id^="formField"], .field, .form-group, .application-question, .ashby-application-form-field-entry, [class*="field-wrapper"], [class*="FormField"], fieldset') || el.parentElement;
  function attachmentShown(el, name) {
    const scope = uploadScope(el);
    return !!scope && clean(scope.innerText || scope.textContent).includes(name);
  }
  function sameAttachment(el, name, bytes) {
    const scope = uploadScope(el);
    if (!scope) return false;
    return [...scope.querySelectorAll('[data-automation-id="file-upload-item"]')].some(item => {
      const shown = clean(item.innerText || item.textContent);
      const size = /([\d.,]+)\s*KB/i.exec(shown);
      return shown.includes(name) && !!size && Math.abs(Number(size[1].replace(/,/g, '')) - bytes / 1024) < 0.02;
    });
  }
  function uploading(el) {
    const scope = uploadScope(el);
    return !!scope && [...scope.querySelectorAll('[role="progressbar"], [aria-busy="true"], [data-automation-id*="uploadProgress" i], [class*="uploading" i]')].some(visible);
  }
  const witnessText = node => clean(node && (node.innerText || node.textContent));
  function sizeMatches(shown, bytes) {
    const match = /^([\d,.]+)\s*(bytes?|[KMGT]i?B)$/i.exec(clean(shown));
    if (!match) return false;
    const number = match[1].replace(/,/g,''), unit = match[2].toLowerCase();
    const power = /^bytes?$/.test(unit) ? 0 : 'kmgt'.indexOf(unit[0]) + 1;
    const precision = 10 ** -(number.split('.')[1] || '').length;
    return Math.abs(Number(number) - bytes / (1024 ** power)) <= precision + 1e-8;
  }
  function completedWitness(field, file, scope, before, pendingSeen) {
    const matches = (field.attachments || []).filter(item => item.name === file.name);
    if (matches.length > 1) return {error:'uploaded attachment is ambiguous'};
    if (!matches.length) return null;
    const item = matches[0], node = idEl(item.witness_id);
    if (!node || !scope.contains(node) || !sizeMatches(item.size_text, file.size)) return {error:'uploaded attachment size or control did not match'};
    const text = witnessText(node);
    if (before.has(node) && !(pendingSeen && before.get(node) !== text)) return null;
    return {node, text, name:item.name, size_text:item.size_text};
  }
  function forgetUpload(id) {
    const record = uploaded.get(id);
    if (record?.invalidate) for (const type of ['input','change']) record.control.removeEventListener(type, record.invalidate);
    record?.observer?.disconnect();
    uploaded.delete(id);
  }
  function uploadReceipt(field, el) {
    const uploadKey = `${location.href}|${field.id}`, record = uploaded.get(uploadKey);
    if (!record) return null;
    if (!el || !el.isConnected || record.control !== el || uploadScope(el) !== record.scope || el.files?.length > 1 ||
        (el.files?.length === 1 && record.file !== el.files[0]) || record.receipt.url !== location.href || field.upload_state === 'failed') {
      forgetUpload(uploadKey); return null;
    }
    if (record.witness) {
      const matches = (field.attachments || []).filter(item => item.name === record.file.name);
      if (uploading(el) || field.upload_state === 'pending' || matches.length !== 1 || idEl(matches[0].witness_id) !== record.witness.node ||
          witnessText(record.witness.node) !== record.witness.text || !sizeMatches(matches[0].size_text, record.file.size)) {
        forgetUpload(uploadKey); return null;
      }
    } else if (el.files?.length !== 1) { forgetUpload(uploadKey); return null; }
    else if (uploading(el) || field.upload_state === 'pending') return null;
    return record.receipt;
  }
  async function waitFor(fn, ms = 4000) {
    const end = Date.now() + ms;
    do { ensureActive(); const x = fn(); if (x) return x; await pause(150); } while (Date.now() < end);
    return null;
  }
  const optionSelector = '[role="option"], [data-automation-id="promptOption"], [data-automation-id="menuItem"]';
  const openOptions = () => [...document.querySelectorAll(optionSelector)].filter(e => visible(e) && !e.closest('[data-automation-id="selectedItemList"]'));
  // Workday often ignores a synthetic Escape on the control: try the list, the toggle, then a click outside.
  // A background tab runs the page's timers once a second, so a closing list needs longer there.
  const closing = ms => document.hidden ? ms + 1100 : ms;
  async function closeLists(expected, control) {
    if (!openOptions().length) return true;
    const escape = target => { if (target) for (const type of ['keydown', 'keyup']) target.dispatchEvent(new KeyboardEvent(type, {key:'Escape', code:'Escape', keyCode:27, which:27, bubbles:true, cancelable:true})); };
    const first = openOptions()[0];
    ensureActive(true);
    escape(document.activeElement);
    escape(first && first.closest('[role="listbox"], [data-automation-id="activeListContainer"]'));
    if (control && control.isConnected) escape(control);
    if (await waitFor(() => !openOptions().length, closing(400))) return true;
    const toggle = control && control.isConnected && control.getAttribute('aria-expanded') === 'true' ? control :
      [...document.querySelectorAll('[aria-expanded="true"]')].find(e => visible(e) && (e.getAttribute('aria-haspopup') || e.getAttribute('role') === 'combobox'));
    if (toggle && allowedOrigin(expected) && !credentialWall() && safeFieldClick(toggle)) {
      ensureActive(true); toggle.click();
      if (await waitFor(() => !openOptions().length, closing(400))) return true;
    }
    ensureActive(true);
    if (document.activeElement && document.activeElement !== document.body && typeof document.activeElement.blur === 'function') leave(document.activeElement);
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
      document.body.dispatchEvent(new MouseEvent(type, {bubbles:true, cancelable:true, view:window, clientX:1, clientY:1}));
    return !!(await waitFor(() => !openOptions().length, closing(600)));
  }
  const bare = s => key(s).replace(/\s*\([^)]*\)\s*$/, '');
  function canSearchWithEnter(input) {
    // Some application frameworks submit on Enter in any input. This fallback is
    // only for Workday's known search widget outside any form. A framework can
    // submit from a form key handler even when it renders no submit button.
    if (!input || !input.isConnected || !/(^|\.)myworkdayjobs\.com$/i.test(location.hostname) ||
        (input.getAttribute('data-automation-id') !== 'searchBox' && input.getAttribute('data-uxi-widget-type') !== 'selectinput')) return false;
    const form = input.form || input.closest('form');
    return !form;
  }
  async function pickExact(label, expected, equal = match, skillControl = null, input = null, selected = null) {
    const popupFor = () => {
      if (!skillControl || idEl(skillControl.id) !== skillControl.el || !skillControl.el.isConnected ||
          skillControl.el.getAttribute('data-uxi-multiselect-id') !== skillControl.widget) return null;
      const popups = [...document.querySelectorAll('[role="listbox"][data-automation-id="activeListContainer"]')].filter(p => visible(p) &&
        [...p.querySelectorAll('[data-uxi-multiselect-id]')].some(node => node.getAttribute('data-uxi-multiselect-id') === skillControl.widget));
      return popups.length === 1 ? popups[0] : null;
    };
    const choose = () => {
      if (!allowedOrigin(expected) || credentialWall()) return null;
      const popup = skillControl ? popupFor() : document;
      if (!popup) return null;
      const options = [...popup.querySelectorAll(optionSelector)].filter(e => visible(e) && !e.closest('[data-automation-id="selectedItemList"]') &&
        (!skillControl || [...e.querySelectorAll('[data-uxi-multiselect-id]')].some(node => node.getAttribute('data-uxi-multiselect-id') === skillControl.widget)));
      // Workday nests option inside option and can list the same name twice; identical names are one answer.
      const leaves = options.filter(e => !options.some(other => other !== e && e.contains(other)));
      const matches = leaves.filter(e => equal(optText(e), label));
      const exact = matches.filter(e => match(optText(e), label));
      if (exact.length && new Set(exact.map(e => key(optText(e)))).size === 1) return exact[0];
      if (exact.length || matches.length > 1) return null;
      if (matches.length === 1) return matches[0];
      // The value plus a qualifier, e.g. "Docker (Software)", when only one option has it.
      const near = leaves.filter(e => bare(optText(e)) === key(label) || key(optText(e)).startsWith(key(label) + ' ('));
      return near.length === 1 ? near[0] : null;
    };
    // Workday's search prompts show nothing until Enter, so there is no list to wait for first.
    const searchable = canSearchWithEnter(input);
    let el = searchable ? null : await waitFor(choose, input ? 1500 : 4000);
    if (!el && searchable && allowedOrigin(expected) && !credentialWall()) {
      // Workday search prompts list matches only after Enter, and pick a single match by themselves.
      ensureActive(true);
      for (const type of ['keydown', 'keypress', 'keyup']) input.dispatchEvent(new KeyboardEvent(type, {key:'Enter', code:'Enter', keyCode:13, which:13, bubbles:true, cancelable:true}));
      // A search takes about a second, and a value the portal does not offer should not cost the full wait.
      // The box first shows the previous search's list, so only a changed list counts as an answer.
      const listText = () => { const list = skillControl ? popupFor() : null; return list ? clean(list.innerText || '').slice(0, 300) : ''; };
      const stale = listText(), asked = Date.now();
      el = await waitFor(() => {
        if (selected && selected()) return 'selected';
        const found = choose();
        if (found) return found;
        const shown = listText();
        return shown && shown !== stale && Date.now() - asked > 700 ? 'none' : null;
      }, 3000);
      if (el === 'selected') return true;
      if (el === 'none') el = null;
    }
    if (!el && skillControl) {
      const popup = popupFor();
      if (!popup || !allowedOrigin(expected) || credentialWall()) return false;
      ensureActive(true); popup.scrollTop = popup.scrollHeight;
      await pause(250);
      el = await waitFor(choose, 2000);
    }
    if (!el) return false;
    if (!allowedOrigin(expected) || credentialWall() || !safeFieldClick(el) || (skillControl && (!popupFor()?.contains(el) || idEl(skillControl.id) !== skillControl.el))) return false;
    // Workday listens on the inner label of a search result, not on the option row around it.
    ensureActive(true); (el.querySelector('[data-automation-id="promptOption"]') || el).click(); await pause(200); return true;
  }
  // Portals name their sources differently and the answer carries little weight, so take the closest one offered.
  const SOURCE_TERMS = ['Job Board', 'Online', 'Internet', 'Career', 'Website', 'LinkedIn', 'Indeed', 'Other'];
  async function pickSource(el, field, wanted, expected) {
    const chips = () => {
      const now = scanCurrentField(field.id, expected);
      return now ? (Array.isArray(now.value) ? now.value : [now.value]).filter(Boolean) : [];
    };
    const rows = () => [...document.querySelectorAll('[data-automation-id="promptOption"]')].filter(e => visible(e) && !e.closest('[data-automation-id="selectedItemList"]'));
    if (chips().length) return '';
    for (const term of [...wanted.map(String), ...SOURCE_TERMS]) {
      if (!allowedOrigin(expected) || credentialWall() || !el.isConnected) return 'page changed during option selection';
      if (openOptions().length && !(await closeLists(expected))) return 'another option list would not close';
      ensureActive(true); el.click(); focusOn(el);
      if (!setText(el, term)) continue;
      for (const type of ['keydown', 'keypress', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, {key:'Enter', code:'Enter', keyCode:13, which:13, bubbles:true, cancelable:true}));
      const found = await waitFor(() => (chips().length ? 'chip' : rows().find(row => key(optText(row)).includes(key(term))) || null), 2200);
      if (found && found !== 'chip' && safeFieldClick(found)) {
        ensureActive(true); found.click();
        // A category opens its own list; its first entry will do.
        const inner = await waitFor(() => (chips().length ? 'chip' : rows().find(row => row !== found) || null), 1500);
        if (inner && inner !== 'chip' && safeFieldClick(inner)) { ensureActive(true); inner.click(); await waitFor(() => chips().length, 1200); }
      }
      if (chips().length) { await closeLists(expected, el); return ''; }
      if (el.value) setText(el, '');
    }
    return `options not resolved: ${wanted.join(', ')}`;
  }
  async function prompt(el, field, value, expected) {
    const values = Array.isArray(value) ? value : [value];
    if (field.kind === 'multiselect_prompt' && /how did you hear/i.test(field.label || '') && canSearchWithEnter(el)) return pickSource(el, field, values, expected);
    const missed = [];
    const equal = field.kind === 'multiselect_prompt' && (/^skills?$/i.test(clean(field.label)) ||
      (/^type to add skills?$/i.test(clean(field.label)) && /^skills$/i.test(clean(field.section)))) ? skillMatch : match;
    const skillControl = equal === skillMatch && el.getAttribute('data-uxi-multiselect-id')
      ? { id:field.id, el, widget:el.getAttribute('data-uxi-multiselect-id') } : null;
    if (equal === skillMatch && !skillControl) return 'skills popup identity unavailable';
    for (const v of values) {
      ensureActive();
      const current = scanCurrentField(field.id, expected);
      if (!current) return 'field disappeared';
      const existing = Array.isArray(current.value) ? current.value : clean(current.value).split(/\s*;\s*/);
      const path = String(v).split(' > ').map(clean);
      if (existing.some(x => equal(x, path[path.length - 1]) || bare(x) === key(path[path.length - 1]))) continue;
      if (openOptions().length && !(await closeLists(expected))) return 'another option list would not close';
      if (!safeFieldClick(el) || !allowedOrigin(expected) || credentialWall()) return 'unsafe dropdown control';
      ensureActive(true); el.click();
      let typedOnly = false;
      if (path.length > 1) {
        let ok = true;
        for (const p of path) if (!(await pickExact(p, expected, equal, skillControl))) { ok = false; break; }
        if (!ok) missed.push(String(v));
      } else {
        const base = equal === skillMatch ? skillKey(path[0]) : '';
        const query = base === 'intel quartus prime' ? 'Quartus' : base === 'modelsim/questa' ? 'ModelSim' :
          equal === skillMatch ? path[0].replace(/\s*\(programming language\)\s*$/i, '') : path[0];
        const input = el.tagName === 'INPUT' ? el : null;
        // Workday shows a prompt's results only while its box has focus.
        if (input) focusOn(input);
        if (input && !setText(input, query)) { missed.push(String(v)); continue; }
        const selected = () => {
          const now = scanCurrentField(field.id, expected);
          return !!now && (Array.isArray(now.value) ? now.value : clean(now.value).split(/\s*;\s*/)).some(x => equal(x, path[0]) || bare(x) === key(path[0]));
        };
        if (!(await pickExact(path[0], expected, equal, skillControl, input, selected))) {
          // Address and postal autocompletes may offer nothing to pick; then the typed text is the answer.
          if (input && field.kind === 'combobox' && !openOptions().length && match(input.value, path[0])) typedOnly = true;
          else missed.push(String(v));
        }
      }
      if (!allowedOrigin(expected) || credentialWall() || !el.isConnected) return 'page changed during option selection';
      if (typedOnly) continue;
      if (field.kind === 'multiselect_prompt' && el.tagName === 'INPUT' && el.value) setText(el, '');
      await closeLists(expected, el);
      if (!missed.includes(String(v))) {
        const selected = await waitFor(() => {
          const f = scanCurrentField(field.id, expected);
          const got = f && (Array.isArray(f.value) ? f.value : [f.value]);
          return got && got.some(x => equal(x, path[path.length - 1]) || bare(x) === key(path[path.length - 1]));
        }, 1500);
        if (!selected) missed.push(String(v));
      }
    }
    return missed.length ? `options not resolved: ${missed.join(', ')}` : '';
  }
  function scanCurrentField(id, expected) {
    if (!allowedOrigin(expected) || credentialWall()) return null;
    const inv = trustedScan();
    return snapshot(inv).fields.find(f => String(f.id) === String(id));
  }
  async function fillOne(plan, field, expected) {
    const el = idEl(field.id), v = plan.value;
    if (!el || !el.isConnected || el.disabled) return 'field unavailable';
    if (!allowedOrigin(expected) || credentialWall()) return 'page changed';
    if (secret.test(field.label) || field.kind === 'password' || field.autocomplete === 'one-time-code' || /password/i.test(el.type || '') || el.autocomplete === 'one-time-code' || secret.test([el.name,el.id,el.getAttribute('aria-label')].join(' '))) return 'credential field';
    const kind = field.kind, tag = el.tagName, type = (el.getAttribute('type') || 'text').toLowerCase();
    if ((['text','email','tel','url','number','date','month'].includes(kind) && !(tag === 'INPUT' && (type === kind || (kind === 'text' && type === 'text')))) ||
        (kind === 'textarea' && tag !== 'TEXTAREA' && !el.isContentEditable) ||
        (['select','multiselect'].includes(kind) && tag !== 'SELECT') ||
        (kind === 'file' && !(tag === 'INPUT' && type === 'file')) ||
        (kind === 'date_parts' && el.getAttribute('data-automation-id') !== 'dateInputWrapper')) return 'field control changed';
    // Observed Workday role descriptions can appear filled but disappear after save.
    // Require native input and a later persisted readback instead of claiming success.
    if (kind === 'textarea' && tag === 'TEXTAREA' && /(?:^|\.)myworkdayjobs\.com$/i.test(location.hostname) &&
        /^workExperience-\d+--roleDescription$/i.test(el.id || '') && /^your experience\b/i.test(field.entry || '')) return 'native_input_required';
    if (['text','email','tel','url','number','date','month','textarea'].includes(field.kind)) {
      if (field.maxlength && String(v).length > field.maxlength) return 'value exceeds field limit';
      if (!setText(el, v, field.kind === 'textarea')) return 'value did not read back';
      return '';
    }
    if (field.kind === 'select' || field.kind === 'multiselect') {
      const values = field.kind === 'multiselect' && Array.isArray(v) ? v : [v];
      const opts = [...el.options];
      const chosen = values.map(x => opts.filter(o => match(o.textContent, x)));
      if (chosen.some(x => x.length !== 1)) return 'option missing or ambiguous';
      ensureActive(true);
      if (field.kind === 'multiselect') chosen.forEach(x => { ensureActive(true); x[0].selected = true; });
      else el.value = chosen[0][0].value;
      emit(el);
      return chosen.every(x => x[0].selected) ? '' : 'selection did not read back';
    }
    if (field.kind === 'checkbox') return typeof v === 'boolean' && check(el, v) ? '' : 'checkbox did not read back';
    if (field.kind === 'radio' || field.kind === 'checkgroup') {
      const vals = Array.isArray(v) ? v : [v];
      for (const value of vals) {
        const indices = (field.options || []).map((o,i) => match(o,value) ? i : -1).filter(i => i >= 0);
        if (indices.length !== 1) return 'option missing or ambiguous';
        const option = idEl(field.option_ids[indices[0]]);
        if (!option || !check(option, true)) return 'option did not read back';
      }
      return '';
    }
    if (field.kind === 'date_parts') {
      const m = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/.exec(String(v));
      if (!m) return 'invalid date';
      const parts = {Year:m[1], Month:(m[2] || '01').padStart(2,'0'), Day:(m[3] || '01').padStart(2,'0')};
      const names = [...el.querySelectorAll('input[data-automation-id^="dateSection"]')].map(i => i.getAttribute('data-automation-id').replace('dateSection','').replace('-input',''));
      if (!names.length || names.some(name => !parts[name]) || new Set(names).size !== names.length) return 'date parts unavailable';
      const currentInput = name => {
        if (!allowedOrigin(expected) || credentialWall()) return null;
        const inv = trustedScan();
        const same = inv.fields.filter(f => f.kind === 'date_parts' && f.label === field.label && f.section === field.section && f.entry === field.entry);
        if (same.length !== 1) return null;
        const wrapper = idEl(same[0].id);
        const matches = wrapper ? [...wrapper.querySelectorAll('input[data-automation-id^="dateSection"]')].filter(i => i.getAttribute('data-automation-id').replace('dateSection','').replace('-input','') === name) : [];
        return matches.length === 1 && matches[0].isConnected ? matches[0] : null;
      };
      for (const name of names) {
        const input = currentInput(name);
        if (!input) return 'date field changed';
        // Workday's month box keeps typed input only, and shows 05 as 5.
        ensureActive(true); focusOn(input); input.select();
        if (!document.execCommand('insertText', false, parts[name])) setText(input, parts[name]);
        await pause(100);
        const actual = currentInput(name);
        if (!actual || Number(clean(actual.value)) !== Number(parts[name])) return 'date part did not read back';
      }
      ensureActive(true); leave(document.activeElement === document.body ? currentInput(names[names.length - 1]) || document.body : document.activeElement);
      await pause(100);
      if (names.some(name => { const actual = currentInput(name); return !actual || Number(clean(actual.value)) !== Number(parts[name]); })) return 'date parts did not persist';
      return '';
    }
    if (['combobox','listbox','multiselect_prompt'].includes(field.kind)) return prompt(el, field, v, expected);
    if (field.kind === 'file') {
      const d = plan.document;
      if (!d || !d.name || !d.mime || !d.base64 || !/^[a-f\d]{64}$/i.test(d.sha256 || '')) return 'approved document missing';
      let bytes;
      try { bytes = Uint8Array.from(atob(d.base64), c => c.charCodeAt(0)); } catch (_) { return 'invalid document encoding'; }
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2,'0')).join('');
      ensureActive();
      if (hash !== d.sha256.toLowerCase()) return 'document digest mismatch';
      if (!allowedOrigin(expected) || credentialWall() || !el.isConnected) return 'page changed before upload';
      const uploadUrl = location.href, uploadKey = `${uploadUrl}|${field.id}`, receipt = uploadReceipt(field, el);
      if (uploading(el) || field.upload_state === 'pending') return 'upload pending or attachment not confirmed';
      // Only this helper's completed upload has an observed content digest.
      // A portal filename or rounded size alone cannot attest to exact bytes.
      if (receipt && receipt.name === d.name && receipt.sha256 === hash) return '';
      if ((el.files?.length && field.value === d.name) || (field.attachments || []).some(item => item.name === d.name) || sameAttachment(el, d.name, bytes.length))
        return 'existing attachment content not verified; browser owner must replace only this attachment with its existing Delete control before one new upload attempt';
      const transfer = new DataTransfer(); transfer.items.add(new File([bytes], d.name, {type:d.mime}));
      ensureActive(true); el.files = transfer.files;
      const actual = el.files?.[0];
      if (!actual || el.files.length !== 1 || actual.name !== d.name || actual.size !== bytes.length) return 'selected document did not read back';
      // Hash bytes read from the browser's actual selected File, after assignment.
      // The desired payload's digest alone is not an upload receipt.
      const actualHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await File.prototype.arrayBuffer.call(actual)))].map(byte => byte.toString(16).padStart(2,'0')).join('');
      ensureActive();
      if (location.href !== uploadUrl || !allowedOrigin(expected) || credentialWall() || !el.isConnected || el.files?.length !== 1 || el.files[0] !== actual) return 'native file changed during verification';
      if (actualHash !== hash) return 'selected document digest mismatch';
      const scope = uploadScope(el);
      if (!scope || scope.querySelectorAll('input[type="file"]').length !== 1) return 'file upload widget is ambiguous';
      const before = new Map([scope, ...scope.querySelectorAll('[data-automation-id="file-upload-item"]')].map(node => [node,witnessText(node)]));
      emit(el);
      let stableSince = 0, stableWitness = null, pendingSeen = false;
      const verified = await waitFor(() => {
        if (location.href !== uploadUrl || !allowedOrigin(expected) || credentialWall() || !el.isConnected || uploadScope(el) !== scope ||
            el.files?.length > 1 || (el.files?.length === 1 && el.files[0] !== actual)) return {error:'native file changed before receipt'};
        const current = trustedScan().fields.find(item => String(item.id) === String(field.id));
        if (!current) return {error:'file control changed before receipt'};
        if (current.upload_state === 'failed') return {error:'portal reports failed upload'};
        if (uploading(el) || current.upload_state === 'pending') { pendingSeen = true; stableSince = 0; stableWitness = null; return false; }
        const witness = completedWitness(current, actual, scope, before, pendingSeen);
        if (witness?.error) return witness;
        if (!el.files?.length && !witness) { stableSince = 0; return false; }
        const status = witness ? 'uploaded' : 'selected';
        if (witness?.node !== stableWitness?.node || witness?.text !== stableWitness?.text) { stableSince = 0; stableWitness = witness; }
        if (!stableSince) stableSince = Date.now();
        return Date.now() - stableSince >= (status === 'uploaded' ? 800 : 300) ? {status, witness} : false;
      }, 30000);
      if (!verified) return 'upload pending or attachment not confirmed';
      if (verified.error) return verified.error;
      const record = {file:actual, control:el, scope, witness:verified.witness, receipt:Object.freeze({sha256:actualHash, name:actual.name, size:actual.size,
        source:'helper-upload', status:verified.status, url:location.href, control_id:String(field.id),
        run_id:activeRun.id, verified_at:new Date().toISOString(), document_id:documentId})};
      record.invalidate = () => { if (uploaded.get(uploadKey) === record) forgetUpload(uploadKey); };
      for (const type of ['input','change']) el.addEventListener(type, record.invalidate);
      if (record.witness) {
        record.observer = new MutationObserver(changes => {
          if (changes.some(change => change.target === record.witness.node || record.witness.node.contains(change.target) ||
              [...change.removedNodes].some(node => node === record.witness.node || node.contains?.(record.witness.node)))) record.invalidate();
        });
        record.observer.observe(scope, {subtree:true, childList:true, characterData:true});
      }
      uploaded.set(uploadKey, record);
      return '';
    }
    return 'unsupported field kind';
  }
  // Review shows no fields, so checking a finished draft again means walking back through its steps.
  async function stepBack(expected) {
    const button = document.querySelector('[data-automation-id="pageFooterBackButton"]');
    if (!button || !visible(button) || button.disabled || !/^back$/i.test(clean(button.innerText || button.textContent))) return 'no back control';
    const before = scan(expected).snapshot.page;
    ensureActive(true); button.click();
    return await waitFor(() => { const x = scan(expected); return x.status !== 'blocked' && x.snapshot.page !== before; }, 15000) ? '' : 'back did not move';
  }
  // Some saved drafts refuse their direct address, and only Candidate Home's Continue Application opens them.
  async function resumeDraft(wanted, expected) {
    const keys = (Array.isArray(wanted) ? wanted : [wanted]).map(key).filter(Boolean);
    const rows = await waitFor(() => { const x = [...document.querySelectorAll('[data-automation-id="taskListRow"]')].filter(visible); return x.length ? x : null; }, 8000);
    const row = (rows || []).find(r => keys.some(k => key(r.innerText || r.textContent).includes(k)));
    const menu = row && row.querySelector('[data-automation-id="actionMenuTarget"]');
    if (!menu) return 'draft not on Candidate Home';
    ensureActive(true); menu.click();
    const link = await waitFor(() => document.querySelector('[data-automation-id="continueApplication"]'), 3000);
    if (!link || !/^continue application$/i.test(clean(link.innerText || link.textContent))) return 'no Continue Application for this draft';
    if (!allowedOrigin(expected) || credentialWall()) return 'page changed before opening the draft';
    ensureActive(true); link.click();
    return '';
  }
  function entryGroups() {
    const names = {'work experience':'work', 'professional experience':'work', 'employment history':'work',
      'work history':'work', experience:'work', 'your experience':'work', education:'education', 'your education':'education', websites:'websites', links:'websites',
      languages:'languages', projects:'projects'};
    return [...document.querySelectorAll('[role="group"][aria-labelledby$="-section"]')].flatMap(group => {
      const sectionId = group.getAttribute('aria-labelledby'), heading = document.getElementById(sectionId);
      const label = clean(heading && heading.textContent);
      const certification = /^certifications\s*[*✱]?$/i.test(label);
      const prop = certification ? 'certifications' : names[key(label)];
      if (!visible(group) && !visible(heading)) return [];
      const count = group.querySelectorAll('[aria-labelledby$="-panel"]').length;
      const offered = count || [...group.querySelectorAll('[data-automation-id="add-button"]')].some(visible);
      if (!prop && !offered) return [];
      const required = certification && (group.getAttribute('aria-required') === 'true' || group.hasAttribute('required') ||
        /[*✱]/.test(label) || !!group.querySelector('[required], [aria-required="true"]'));
      return [{group, sectionId, key:prop || 'unknown', label, count, ...(certification ? {required} : {})}];
    });
  }
  async function addEntries(entries, expected) {
    if (!entries) return '';
    for (const prop of ['work','education','websites','languages','projects']) {
      const n = Array.isArray(entries[prop]) ? entries[prop].length : entries[prop];
      if (Number.isInteger(n) && n >= 0 && n <= 100) wantedEntries.set(prop, n);
    }
    for (let count = 0; count < 12; count++) {
      ensureActive();
      if (!allowedOrigin(expected) || credentialWall()) return 'page changed before adding entries';
      let todo = null;
      for (const section of entryGroups()) {
        const {group, key:prop, count:existing} = section, n = wantedEntries.get(prop) || 0;
        const buttons = [...group.querySelectorAll('[data-automation-id="add-button"]')].filter(e => visible(e) && !e.disabled && /^add(?:\s|$)/i.test(clean(e.innerText || e.textContent || e.getAttribute('aria-label'))) && !forbidden.test(clean(e.innerText || e.textContent || e.getAttribute('aria-label'))));
        if (n > existing && buttons.length) { todo = {...section, existing, button:buttons[buttons.length-1]}; break; }
        if (n > existing && !buttons.length) return 'entry add button unavailable';
      }
      if (!todo) return '';
      if (!safeAddClick(todo.button)) return 'unsafe entry control';
      ensureActive(true); todo.button.click();
      if (!(await waitFor(() => allowedOrigin(expected) && !credentialWall() && entryGroups().some(section =>
        section.sectionId === todo.sectionId && section.key === todo.key && section.label === todo.label && section.count > todo.existing)))) return 'entry did not appear';
    }
    return entryGroups().some(section => section.count < (wantedEntries.get(section.key) || 0)) ? 'entry limit reached' : '';
  }
  async function peekEmptyOptions(expected) {
    optionCache.clear();
    let state = scan(expected);
    if (state.status !== 'page') return 'page blocked during option preview';
    // Search-only prompts have no list worth reading; small Workday prompts such as Disability do.
    const searchOnly = /skill|school|university|field of study|phone code|how did you hear/i;
    const candidates = state.inv.fields.filter(f => (['combobox','listbox'].includes(f.kind) || (f.kind === 'multiselect_prompt' && !searchOnly.test(f.label || ''))) && !(f.options || []).length &&
      (Array.isArray(f.value) ? !f.value.length : !clean(f.value)) && !secret.test(f.label || ''));
    const stopAt = Date.now() + 20000;
    for (const candidate of candidates.slice(0, 30)) {
      ensureActive();
      if (Date.now() >= stopAt) return 'option preview time limit reached';
      state = scan(expected);
      if (state.status !== 'page') return 'page blocked during option preview';
      const field = state.inv.fields.find(f => String(f.id) === String(candidate.id) && f.label === candidate.label && f.kind === candidate.kind);
      const el = field && idEl(field.id);
      if (!el || !el.isConnected || el.disabled || !allowedOrigin(expected) || credentialWall()) return 'field changed during option preview';
      if (field.kind === 'multiselect_prompt') {
        if (!canSearchWithEnter(el) || !safeFieldClick(el)) continue;
        if (openOptions().length && !(await closeLists(expected))) return 'another option list is already open';
        ensureActive(true); el.click(); focusOn(el);
        const listed = await waitFor(() => {
          const rows = [...document.querySelectorAll('[data-automation-id="promptOption"]')].filter(row => visible(row) && !row.closest('[data-automation-id="selectedItemList"]')).map(optText).filter(Boolean);
          return rows.length ? [...new Set(rows)].slice(0, 100) : null;
        }, 1500);
        if (listed) optionCache.set(String(field.id), listed);
        await closeLists(expected, el);
        continue;
      }
      const isControl = field.kind === 'listbox' ? el.tagName === 'BUTTON' && el.getAttribute('type') === 'button' && el.getAttribute('aria-haspopup') === 'listbox' :
        (el.getAttribute('role') === 'combobox' || (el.tagName === 'INPUT' && el.getAttribute('aria-autocomplete') === 'list'));
      if (!isControl || !safeFieldClick(el)) return 'dropdown control changed during option preview';
      if (openOptions().length && !(await closeLists(expected))) return 'another option list is already open';
      ensureActive(true); el.click();
      const choices = await waitFor(() => {
        if (!allowedOrigin(expected) || credentialWall()) return null;
        const options = [...document.querySelectorAll(optionSelector)].filter(option => visible(option) && !option.closest('[data-automation-id="selectedItemList"]')).map(optText).filter(Boolean);
        return options.length ? [...new Set(options)].slice(0, 300) : null;
      }, 1800);
      if (!allowedOrigin(expected) || credentialWall() || !el.isConnected) return 'page changed during option preview';
      if (choices) optionCache.set(String(field.id), choices);
      const currentControl = () => {
        const fresh = scanCurrentField(field.id, expected);
        return fresh && fresh.label === field.label && fresh.kind === field.kind ? idEl(field.id) : null;
      };
      let control = currentControl();
      if (!control || !safeFieldClick(control)) return 'dropdown identity changed during option preview';
      for (const type of ['keydown', 'keyup']) { ensureActive(true); control.dispatchEvent(new KeyboardEvent(type, {key:'Escape', code:'Escape', keyCode:27, which:27, bubbles:true})); }
      const closeState = () => {
        const fresh = currentControl();
        if (!fresh) return 'changed';
        const expanded = fresh.getAttribute('aria-expanded');
        const visibleOptions = [...document.querySelectorAll(optionSelector)].some(option => visible(option) && !option.closest('[data-automation-id="selectedItemList"]'));
        return expanded !== 'true' && !visibleOptions ? 'closed' : null;
      };
      let closed = await waitFor(closeState, 1200);
      if (closed === 'changed') return 'dropdown identity changed during option preview';
      if (!closed) {
        control = currentControl();
        if (!control || control.getAttribute('aria-expanded') !== 'true' || !safeFieldClick(control) || !allowedOrigin(expected) || credentialWall()) return 'dropdown did not close safely';
        ensureActive(true); control.click();
        closed = await waitFor(closeState, 1200);
        if (!closed && await closeLists(expected, currentControl())) closed = 'closed';
        if (closed !== 'closed') return closed === 'changed' ? 'dropdown identity changed during option preview' : 'dropdown did not close';
      }
    }
    return candidates.length > 30 ? 'too many dropdowns to preview' : '';
  }
  globalThis.__jobApply = {version: VERSION,
    cancel: id => { if (activeRun && activeRun.id === id) activeRun.cancelled = true; },
    run: async payload => {
    const p = payload || {}, expected = p.expectedOrigin;
    if (activeRun) return {status:'blocked', message:'Another application operation is still running.'};
    if (globalThis.__jobApplyCancelled?.delete(p.runId)) return {status:'expired', reason:'cancelled', message:'The application operation was cancelled before starting.'};
    if (typeof p.runId !== 'string' || !Number.isFinite(p.deadline) || p.deadline <= Date.now()) return {status:'expired', message:'The application operation expired before starting.'};
    const run = {id:p.runId, deadline:Math.min(p.deadline, Date.now() + 42000), cancelled:false, acted:false};
    activeRun = run;
    const results = [];
    try {
      let state = scan(expected);
      if (state.status === 'blocked' || p.operation === 'scan') { delete state.inv; return state; }
      if (!['fill','next'].includes(p.operation)) return {status:'blocked', snapshot:state.snapshot, results:[{id:'',ok:false,reason:'unsupported operation'}]};
      if (p.operation === 'fill') {
        const added = await addEntries(p.entries, expected);
        if (added) results.push({id:'entries',ok:false,reason:added});
        state = scan(expected);
        if (state.status === 'blocked') { delete state.inv; return {...state,results}; }
        if (p.entries && !(p.fills || []).length && !added) {
          // The preview only gathers option hints for the resolver; a failure here must not block the page.
          const reason = await peekEmptyOptions(expected);
          if (reason) { results.push({id:'options',ok:true,note:true,reason}); await closeLists(expected); }
        }
        for (const plan of p.fills || []) {
          ensureActive();
          if (plan.action === 'back' || plan.action === 'resume') {
            const reason = plan.action === 'back' ? await stepBack(expected) : await resumeDraft(plan.value, expected);
            results.push({id:plan.id, ok:!reason, reason});
            continue;
          }
          state = scan(expected);
          if (state.status === 'blocked') { results.push({id:plan.id,ok:false,reason:'page became blocked'}); break; }
          const field = state.inv.fields.find(f => String(f.id) === String(plan.id));
          const kind = field && field.kind === 'text' && /^(?:phone|mobile|cell|telephone)(?: number)?\*?$/i.test(field.label) ? 'tel' : field && field.kind;
          let reason = '';
          if (!field || kind !== plan.kind || field.label !== plan.label) reason = 'field identity changed';
          else if (!allowedOrigin(expected)) reason = 'origin changed';
          else reason = await fillOne(plan, field, expected);
          results.push({id:plan.id, ok:!reason, reason});
        }
        state = scan(expected); delete state.inv;
        return {...state, status: state.status === 'blocked' || results.some(x => !x.ok) ? 'blocked' : 'page', results};
      }
      if (state.snapshot.errors.length || state.snapshot.final || !state.inv.fields.length) {
        delete state.inv; return {...state,status:'blocked',results:[{id:'next',ok:false,reason:'final, validation, or non-form page'}]};
      }
      // Workday keeps the button disabled while a step loads or saves.
      const usable = s => s.inv.buttons.filter(b => !b.disabled && safeNext.test(clean(b.text)) && !forbidden.test(b.text));
      if (usable(state).length !== 1) await waitFor(() => {
        const x = scan(expected);
        if (x.status !== 'page' || usable(x).length !== 1) return false;
        state = x; return true;
      }, 6000);
      const buttons = usable(state);
      if (buttons.length !== 1) {
        const seen = state.inv.buttons.filter(b => /next|continue|save/i.test(b.text)).map(b => b.text + (b.disabled ? ' (disabled)' : '')).join(', ');
        delete state.inv;
        return {...state,status:'blocked',results:[{id:'next',ok:false,reason:`next control missing or ambiguous: ${seen || 'none on page'}`}]};
      }
      const signature = s => JSON.stringify([s.url,s.page,s.fields.map(f => [f.id,f.label]),s.errors,s.validation]);
      const before = signature(state.snapshot);
      const button = idEl(buttons[0].id);
      const buttonText = button && clean(button.innerText || button.textContent || button.getAttribute('aria-label') || button.value);
      const buttonType = button && (button.getAttribute('type') || '').toLowerCase();
      const buttonControl = button && (button.tagName === 'BUTTON' || (button.tagName === 'INPUT' && ['button','submit'].includes(buttonType)) || button.getAttribute('role') === 'button');
      if (!buttonControl || !visible(button) || button.disabled || button.getAttribute('aria-disabled') === 'true' || !safeNext.test(buttonText) || forbidden.test(buttonText) || !allowedOrigin(expected) || credentialWall()) { delete state.inv; return {...state,status:'blocked',results:[{id:'next',ok:false,reason:'next control unavailable or changed'}]}; }
      ensureActive(true); button.click();
      const changed = await waitFor(() => {
        const x = scan(expected);
        if (x.status === 'blocked') return x;
        return signature(x.snapshot) !== before ? x : null;
      }, 15000);
      state = changed || scan(expected); delete state.inv;
      const portal = state.snapshot.validation || [];
      const ok = !!changed && state.status !== 'blocked' && !state.snapshot.errors.length && !portal.length;
      return {...state,status:ok?'page':'blocked',results:[{id:'next',ok,reason:ok?'':['navigation did not complete or is blocked', ...portal].join(': ')}]};
    } catch (err) {
      if (err instanceof RunStopped) return {status:run.acted ? 'outcome_unknown' : 'expired', reason:run.cancelled ? 'cancelled' : 'timed_out',
        message:run.acted ? 'The operation stopped partway. Inspect the page before repeating any action.' : 'The operation stopped before any application action.', results};
      return {status:run.acted ? 'outcome_unknown' : 'blocked',snapshot:minimal('executor error'),results:[...results,{id:'',ok:false,reason:'executor error'}]};
    } finally { globalThis.__jobApplyCancelled?.delete(run.id); if (activeRun === run) activeRun = null; }
  }};
})();
