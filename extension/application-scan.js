globalThis.__jobApplyScan = (
() => {
  const vis = (el) => {
    if (el?.closest?.("latch-bar")) return false;
    if (!el || !el.isConnected) return false;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    const toggle = el.type === 'file' || el.type === 'radio' || el.type === 'checkbox';
    // React widgets keep 1px, transparent inputs around for form validation; they are not fields.
    if (!toggle && el.tagName === 'INPUT' && el.getAttribute('role') !== 'combobox' &&
        (Number(st.opacity) === 0 || (r.width < 4 && r.height < 4))) return false;
    if (toggle && el.type !== 'file' && r.width === 0 && r.height === 0) {
      // Zero-size toggles are real only when a visible label stands in for them.
      const l = el.closest('label') || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`));
      if (!l) return false;
      const lr = l.getBoundingClientRect();
      return lr.width > 0 && lr.height > 0;
    }
    return r.width > 0 || r.height > 0 || toggle;
  };
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const text = (el) => clean(el ? (el.innerText || el.textContent) : '');
  let next = Number(document.documentElement.getAttribute('data-ja-next') || '1');
  const tag = (el) => {
    globalThis.__jobApplyAssertActive?.();
    if (!el.getAttribute('data-ja')) { el.setAttribute('data-ja', String(next++)); }
    return el.getAttribute('data-ja');
  };
  const byIds = (ids) => clean((ids || '').split(/\s+/).map(id => text(document.getElementById(id))).join(' '));
  const wrapperOf = (el) => el.closest('[data-automation-id^="formField"], .field, .form-group, .application-question, ' +
    '.ashby-application-form-field-entry, [class*="field-wrapper"], [class*="FormField"], li.application-field, fieldset');
  const fileScopeOf = el => el.closest('[data-automation-id="attachments-FileUpload"]') || wrapperOf(el) || el.parentElement;
  const uploadProblem = shown => {
    if (/\b(?:not(?: yet)? (?:be |been )?(?:successfully )?uploaded|never uploaded|upload (?:has |was )?(?:failed|cancelled|canceled)|failed to upload|could not upload|unable to upload|error (?:during|while) upload|upload error)\b/i.test(shown)) return 'failed';
    return /\b(?:uploading|loading|pending|queued|processing|in progress)\b/i.test(shown) ? 'pending' : '';
  };
  const attachmentsOf = el => {
    const scope = fileScopeOf(el);
    if (!scope || scope.querySelectorAll('input[type="file"]').length !== 1 || uploadProblem(text(scope))) return [];
    const items = [...scope.querySelectorAll('[data-automation-id="file-upload-item"]')];
    // Saved Workday drafts may leave the native file input empty. Only a
    // positive upload status inside this file widget is a portal witness.
    const candidates = items.length ? items : scope.matches('[data-automation-id="attachments-FileUpload"]') ? [scope] : [];
    const filename = /^[^<>:"/\\|?*\r\n]+\.(?:pdf|docx?|txt|rtf|odt|png|jpe?g|gif|webp|csv|xlsx?)$/i;
    return candidates.slice(0, 20).flatMap(item => {
      const shown = text(item);
      const lines = (item.innerText || item.textContent || '').split(/\r?\n/).map(clean);
      const leaves = [...item.querySelectorAll('*')].filter(node => !node.children.length).map(text);
      if (!vis(item) || uploadProblem(shown) || ![...lines,...leaves].some(line => /^successfully uploaded[!.]?$/i.test(line))) return [];
      const names = [...new Set([...lines, ...leaves].filter(name => filename.test(name)))];
      if (names.length !== 1) return []; // Do not guess among several filenames.
      const size = /\b[\d.,]+\s*(?:bytes?|[KMGT]i?B)\b/i.exec(shown);
      return [{name:names[0], status:'uploaded', source:'portal', witness_id:tag(item), ...(size ? {size_text:clean(size[0])} : {})}];
    });
  };
  const labelOf = (el) => {
    const parts = [];
    if (el.id) document.querySelectorAll(`label[for="${CSS.escape(el.id)}"]`).forEach(l => parts.push(text(l)));
    if (el.getAttribute('aria-labelledby')) parts.push(byIds(el.getAttribute('aria-labelledby')));
    const aria = clean(el.getAttribute('aria-label'));
    // Workday names its dropdown buttons "Select One Required"; the question is in the field's label.
    // Once answered they read "Yes Required", which is the answer and not the question.
    const own = el.tagName === 'BUTTON' && aria.replace(/\s*required$/i, '') === text(el);
    if (aria && !own && !/^(select|choose)( one)?( required)?$/i.test(aria)) parts.push(aria);
    const wrap = el.closest('label'); if (wrap && !parts.filter(Boolean).length) parts.push(text(wrap));
    if (!parts.filter(Boolean).length) {
      const w = wrapperOf(el);
      if (w) {
        const l = w.querySelector('label, legend, [data-automation-id="formLabel"], .label, [class*="label"], [class*="Label"]');
        if (l && !l.contains(el)) parts.push(text(l));
      }
    }
    if (!parts.filter(Boolean).length) {
      let n = el, d = 0;
      while (n && d < 4 && !parts.filter(Boolean).length) {
        let p = n.previousElementSibling;
        while (p && !text(p)) p = p.previousElementSibling;
        if (p && text(p).length < 250) parts.push(text(p));
        n = n.parentElement; d++;
      }
    }
    if (!parts.filter(Boolean).length) parts.push(clean(el.getAttribute('placeholder') || el.name || el.id || ''));
    return clean(parts.filter(Boolean)[0] || '').replace(/\s*\*\s*$/, '').slice(0, 400);
  };
  // Workday's banners come and go above the first field, and must not change which section it is in.
  const banner = (t) => /^(errors?( and alerts?)?|alerts?) found$/i.test(t);
  const sectionOf = (el) => {
    let n = el;
    while (n && n !== document.body) {
      let p = n.previousElementSibling;
      while (p) {
        if ((/^H[1-4]$/.test(p.tagName) || p.getAttribute('role') === 'heading') && !banner(text(p))) return text(p).slice(0, 120);
        const h = p.querySelector && p.querySelector('h1,h2,h3,h4,[role="heading"]');
        if (h && vis(h) && !banner(text(h))) return text(h).slice(0, 120);
        p = p.previousElementSibling;
      }
      n = n.parentElement;
      if (n && n.tagName === 'FIELDSET') { const lg = n.querySelector('legend'); if (lg) return text(lg).slice(0, 120); }
    }
    return '';
  };
  const requiredOf = (el, label) => {
    const w = wrapperOf(el);
    return !!(el.required || el.getAttribute('aria-required') === 'true' ||
      (w && (w.querySelector('abbr[title*="required" i], [class*="required" i], .asterisk') || /\*\s*$/.test(text(w.querySelector('label, legend') || w).slice(0, 300))))) ||
      /\*$/.test(label);
  };
  const chrome = (el) => !!el.closest('header, nav, footer, [role="banner"], [role="navigation"], [role="contentinfo"]') &&
    !el.closest('form, [role="dialog"], [aria-modal="true"]');
  const panelOf = (el) => {
    // Workday repeats panels ("Work Experience 2") labelled by their own heading.
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const lb = n.getAttribute && n.getAttribute('aria-labelledby');
      if (lb && /-panel$/.test(lb) && document.getElementById(lb)) return n;
    }
    return null;
  };
  const entryOf = (el) => { const p = panelOf(el); return p ? text(document.getElementById(p.getAttribute('aria-labelledby'))).slice(0, 80) : ''; };
  const fields = [], groups = {}, capturedNativeSelects = new Set();
  const controls = document.querySelectorAll('input, select, textarea, [contenteditable="true"], [role="combobox"], ' +
    'button[aria-haspopup="listbox"], [role="radio"], [role="checkbox"], [data-automation-id="multiselectInputContainer"], ' +
    '[data-automation-id="dateInputWrapper"]');
  controls.forEach(el => {
    const tagName = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tagName === 'input' && ['hidden', 'submit', 'button', 'image', 'reset'].includes(type)) return;
    if (el.closest('[data-ja-ignore], #simplify-jobs-shadow-root, [aria-hidden="true"] [role="listbox"]')) return;
    if (el.parentElement && el.parentElement.closest('[role="option"]')) return; // controls inside an open dropdown
    if (tagName === 'input' && el.closest('[data-automation-id="dateInputWrapper"]')) return; // read through its wrapper
    if (type !== 'file' && !vis(el)) return;
    if (el.disabled || chrome(el)) return;
    if (el.matches('span.select2-selection[role="combobox"]')) {
      const container = el.closest('.select2-container');
      const native = container && container.previousElementSibling;
      const renderedId = native && native.id && `select2-${native.id}-container`;
      const rendered = renderedId && document.getElementById(renderedId);
      // Select2's answer renderer is the same field as its associated native
      // select, but only deduplicate when that select survived this capture.
      if (native && native.matches('select.select2-hidden-accessible') && capturedNativeSelects.has(native) &&
          (el.getAttribute('aria-labelledby') || '').split(/\s+/).includes(renderedId) && rendered && el.contains(rendered)) return;
    }
    if (tagName === 'input' && el.closest('[role="combobox"]') && el.closest('[role="combobox"]') !== el) return;
    if (el.getAttribute('data-automation-id') === 'multiselectInputContainer') {
      if (el.querySelector('input')) return; // handled through its search input below
    }
    let kind = 'text';
    const dateParts = el.getAttribute('data-automation-id') === 'dateInputWrapper';
    if (dateParts) kind = 'date_parts';
    else if (tagName === 'select') kind = el.multiple ? 'multiselect' : 'select';
    else if (tagName === 'textarea') kind = 'textarea';
    else if (el.getAttribute('contenteditable') === 'true') kind = 'textarea';
    else if (tagName === 'button') kind = 'listbox';
    else if (el.getAttribute('role') === 'radio') kind = 'radio';
    else if (el.getAttribute('role') === 'checkbox') kind = 'checkbox';
    else if (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete') === 'list') kind = 'combobox';
    else if (['radio', 'checkbox', 'file', 'email', 'tel', 'url', 'number', 'date', 'month', 'password'].includes(type)) kind = type;
    if (tagName === 'input' && (el.getAttribute('data-automation-id') === 'searchBox' ||
        el.closest('[data-automation-id="multiselectInputContainer"]'))) kind = 'multiselect_prompt';
    const label = labelOf(el);
    const id = tag(el);
    const required = requiredOf(el, label);
    if (kind === 'radio' || (kind === 'checkbox' && el.name && (panelOf(el) || document).querySelectorAll(`input[type="checkbox"][name="${CSS.escape(el.name)}"]`).length > 1)) {
      const group = el.closest('[role="radiogroup"], [role="group"], fieldset');
      const key = kind + ':' + (el.name || (group ? tag(group) : label)) + ':' + entryOf(el);
      let glabel = '';
      if (group) glabel = clean(group.getAttribute('aria-label') || byIds(group.getAttribute('aria-labelledby')) || text(group.querySelector('legend')));
      if (!glabel) { const w = wrapperOf(group || el.parentElement); if (w) { const l = w.querySelector('label, legend, [class*="label"]'); if (l && l.contains(el) === false) glabel = text(l); } }
      if (!glabel) glabel = sectionOf(el);
      const optLabel = labelOf(el) || clean(el.value);
      const checked = el.checked || el.getAttribute('aria-checked') === 'true';
      if (groups[key] !== undefined) {
        const g = fields[groups[key]];
        g.options.push(optLabel); g.option_ids.push(id);
        if (checked) g.value = kind === 'radio' ? optLabel : [...(g.value || []), optLabel];
        g.required = g.required || required;
        return;
      }
      groups[key] = fields.length;
      fields.push({id, kind: kind === 'radio' ? 'radio' : 'checkgroup', label: glabel.replace(/\s*\*\s*$/, ''), options: [optLabel], option_ids: [id],
        value: checked ? (kind === 'radio' ? optLabel : [optLabel]) : (kind === 'radio' ? '' : []), required, section: sectionOf(el), name: el.name || '', entry: entryOf(el), parts: []});
      return;
    }
    let options = [], value = '', parts = [], attachments, upload_state;
    if (dateParts) {
      const ins = [...el.querySelectorAll('input[data-automation-id^="dateSection"]')];
      parts = ins.map(i => i.getAttribute('data-automation-id').replace('dateSection', '').replace('-input', ''));
      value = ins.every(i => i.value) ? ins.map(i => i.value).join('/') : '';
    } else if (tagName === 'select') {
      options = [...el.options].map(o => clean(o.textContent)).filter(o => o && !/^(select|choose|please select|--|- select -)/i.test(o));
      value = el.selectedIndex >= 0 && el.value !== '' ? clean(el.options[el.selectedIndex].textContent) : '';
      if (/^(select|choose|please)/i.test(value)) value = '';
    } else if (kind === 'checkbox') value = (el.checked || el.getAttribute('aria-checked') === 'true');
    else if (kind === 'file') {
      attachments = attachmentsOf(el);
      const scope = fileScopeOf(el);
      upload_state = uploadProblem(scope ? text(scope) : '') || (attachments.length ? 'uploaded' : 'unknown');
      value = el.files && el.files.length ? el.files[0].name : attachments.length === 1 ? attachments[0].name : '';
    }
    else if (kind === 'listbox') { value = text(el); if (/^select one$|^select$|^choose/i.test(value)) value = ''; }
    else if (kind === 'combobox') {
      const ctl = el.closest('[class*="control"], [class*="select__control"]') || el.parentElement;
      const single = ctl && ctl.querySelector('[class*="singleValue"], [class*="single-value"]');
      value = single ? text(single) : clean(el.value || '');
    } else if (kind === 'multiselect_prompt') {
      const c = el.closest('[data-automation-id="multiselectInputContainer"]') || el.parentElement;
      const w = wrapperOf(el) || (c && c.parentElement);
      value = [...(w ? w.querySelectorAll('[data-automation-id="selectedItem"]') : [])].map(text).join('; ');
    } else if (el.getAttribute('contenteditable') === 'true') value = text(el);
    else value = el.value || '';
    let filesNear = '';
    if (kind === 'file') { const w = fileScopeOf(el); filesNear = w ? text(w).slice(0, 200) : ''; }
    fields.push({id, kind, label, options, value, required, section: sectionOf(el), name: el.name || el.id || '',
      placeholder: el.getAttribute('placeholder') || '', maxlength: el.maxLength > 0 ? el.maxLength : null,
      autocomplete: el.getAttribute('autocomplete') || '', automation: el.getAttribute('data-automation-id') || '',
      near: filesNear, entry: entryOf(el), parts, ...(attachments ? {attachments, upload_state} : {})});
    if (tagName === 'select') capturedNativeSelects.add(el);
  });
  const buttons = [];
  document.querySelectorAll('button, input[type="submit"], input[type="button"], a[role="button"], [role="button"], a[href]').forEach(el => {
    if (!vis(el) || el.closest('[data-ja-ignore]')) return;
    const t = clean(el.tagName === 'INPUT' ? el.value : (el.innerText || el.getAttribute('aria-label') || ''));
    if (!t || t.length > 60) return;
    if (chrome(el) && !/reject|decline|necessary|essential|accept/i.test(t)) return;
    if (el.tagName === 'A' && !/apply|next|continue|submit|sign ?in|log ?in|sign ?up|create (an |my |a new |new )?account|new user|register|start|review|back/i.test(t)) return;
    buttons.push({id: tag(el), text: t, automation: el.getAttribute('data-automation-id') || '', type: el.getAttribute('type') || '',
      disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true')});
  });
  const errors = [];
  const errorSelector = '[role="alert"], [data-automation-id="errorMessage"], .error-message, .field-error, [class*="error-text"], [class*="errorMessage"]';
  const invalidSelector = errorSelector + ', [aria-invalid="true"], [aria-errormessage], .invalid, .has-error, .is-invalid, [class*="--invalid"], [class*="--error"]';
  document.querySelectorAll(errorSelector + ', [aria-live="assertive"]').forEach(el => {
    const t = text(el);
    const control = el.tagName === 'LABEL' && el.getAttribute('role') === 'status' ? el.control : null;
    const row = control && (control.closest('.input-row') || wrapperOf(control) || el.parentElement);
    // Some portals announce ordinary checkbox labels through an assertive
    // status region. Only a positively valid, optional native control makes
    // that label benign; explicit alerts, error messages and invalid states stay.
    if (control && control.type === 'checkbox' && !control.required && control.getAttribute('aria-required') !== 'true' &&
        control.getAttribute('aria-invalid') === 'false' && row &&
        !el.closest(invalidSelector) && !control.closest(invalidSelector) &&
        ![...row.querySelectorAll(errorSelector)].some(node => vis(node) && text(node))) return;
    // Portals announce good news in the same alert regions, such as a finished upload.
    if (t && vis(el) && t.length < 300 && !errors.includes(t) && !/successfully|didn.?t autofill/i.test(t)) errors.push(t);
  });
  // Workday's list of failed fields stays on the page after its alert role is gone.
  const validation = [...document.querySelectorAll('[data-automation-id="errorHeading"] li')].map(text).filter(Boolean).slice(0, 20);
  const body = text(document.body).slice(0, 20000);
  const pw = [...document.querySelectorAll('input[type="password"]')].filter(vis);
  const signals = {
    password_fields: pw.length,
    captcha: [...document.querySelectorAll('iframe[title*="challenge" i], iframe[src*="hcaptcha"], iframe[src*="recaptcha"][src*="anchor"], .h-captcha, .g-recaptcha:not([data-size="invisible"])')]
      .some(el => vis(el) && !el.closest('.grecaptcha-badge') && el.getBoundingClientRect().width > 120 && el.getBoundingClientRect().height > 40),
    confirmation: /thank you for (applying|your application|submitting)|application (has been |was )?(successfully )?(submitted|received)|we('|’)ve received your application|your application (is|has been) (complete|submitted)|successfully applied|congratulations.{0,40}submitted/i.test(body),
    already_applied: /you('|’)ve already applied|you have already applied|already submitted an application|already applied (for|to) this/i.test(body),
    verify_email: /verify your (email|account)|verification (email|link|code)|check your (email|inbox)|confirm your email|activate your account|we sent (you )?(an? )?(email|code|link)/i.test(body) ||
      /(enter|type) (the|your)( \d+.digit)? (code|passcode)|code (we|that we|was) (just )?sent|sent (you )?(a|an|the)( \d+.digit)? (code|passcode|one.time)/i.test(body),
    closed: /no longer (accepting|available)|this (job|position|posting) (is|has been) (closed|filled|removed)|page (you are looking for )?(does not|doesn('|’)t) exist|job not found/i.test(body),
    signup_text: /create (an )?account|sign up|register/i.test(body),
    signin_text: /sign in|log in|login/i.test(body),
    review_text: /review (your )?(application|information)|please review|summary of your application/i.test(body),
  };
  const headings = [...document.querySelectorAll('h1, h2, [data-automation-id="progressBarActiveStep"], [aria-current="step"]')].filter(vis).map(text).filter(Boolean).slice(0, 8);
  // Blocking dialogs (agreements, confirmations) sit on top of the form and swallow clicks.
  const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]')]
    .filter(el => vis(el) && el.getBoundingClientRect().width > 150 && !/cookie/i.test(text(el).slice(0, 200)))
    .map(el => ({id: tag(el), title: text(el.querySelector('h1,h2,h3,h4,[class*="title"]')).slice(0, 120), text: text(el).slice(0, 1200),
      buttons: [...el.querySelectorAll('button, [role="button"], a[role="button"]')].filter(vis).map(b => ({id: tag(b), text: clean(b.innerText || b.getAttribute('aria-label') || '')}))}));
  globalThis.__jobApplyAssertActive?.();
  document.documentElement.setAttribute('data-ja-next', String(next));
  return {url: location.href, title: document.title, headings, fields, buttons, errors, validation, signals, dialogs, body_excerpt: body.slice(0, 1500)};
}
);
