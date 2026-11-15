// Runs extension/background.js in a Node worker thread with stand-ins for the Chrome APIs it
// uses. `code` is the folder the worker loads its scripts from and `disk` the folder that
// chrome-extension:// fetches read, so a test can restart a worker on old code after the files
// change, the way Chrome restarts an idle worker from its cached copy.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import WS from 'ws';

export const TAB_URL = 'https://acme.wd1.myworkdayjobs.com/en-US/careers/login';

// A page as page.js would describe it; field values are never part of it.
export function page(fields, extra = {}) {
  return { url: TAB_URL, host: new URL(TAB_URL).hostname, top: true, fields, digits: [], error: '', captcha: false, busy: false,
    flags: {}, auth: { login: true }, actions: {}, paths: {}, ...extra };
}
export const PAGES = {
  identifier: page([{ kind: 'email', ref: 'f1', form: 0, empty: true }]),
  password: page([{ kind: 'password', ref: 'f2', form: 0, empty: true }]),
  signedIn: page([], { flags: { signedIn: true }, auth: {} }),
};

// storage: { local, session } carried from one worker start to the next.
// event: 'installed', 'startup' or null (an idle worker woken by an alarm or message).
export function startWorker({ code, disk, storage, event = null, extensionId }) {
  const worker = new Worker(new URL(import.meta.url), { workerData: { code, disk, storage, event, extensionId } });
  const fills = [];
  const opened = [];
  const replies = new Map();
  let seq = 0;
  worker.on('message', msg => {
    if (msg.type === 'storage') Object.assign(storage[msg.area], msg.items);
    else if (msg.type === 'fill') fills.push(msg);
    else if (msg.type === 'opened') opened.push(msg.url);
    else if (msg.type === 'reply') { replies.get(msg.id)?.(msg.result); replies.delete(msg.id); }
  });
  worker.on('error', err => console.error('worker:', err));
  return {
    fills,
    opened,
    popup: msg => new Promise(resolve => { const id = ++seq; replies.set(id, resolve); worker.postMessage({ type: 'popup', id, msg }); }),
    show: frame => worker.postMessage({ type: 'page', frame }),
    tab: patch => worker.postMessage({ type: 'tab', patch }),
    hold: on => worker.postMessage({ type: 'hold', on }),
    stop: () => worker.terminate(),
  };
}

if (!isMainThread) {
  const { code, disk, storage, event, extensionId } = workerData;
  const listeners = () => {
    const fns = [];
    return { addListener: fn => fns.push(fn), fire: (...args) => fns.forEach(fn => fn(...args)), fns };
  };
  const area = name => ({
    get: async keys => keys == null ? { ...storage[name] }
      : Object.fromEntries([keys].flat().filter(k => k in storage[name]).map(k => [k, storage[name][k]])),
    set: async items => { Object.assign(storage[name], items); parentPort.postMessage({ type: 'storage', area: name, items }); },
    clear: async () => {
      const gone = Object.fromEntries(Object.keys(storage[name]).map(k => [k, undefined]));
      for (const k of Object.keys(storage[name])) delete storage[name][k];
      parentPort.postMessage({ type: 'storage', area: name, items: gone });
    },
  });
  const tab = { id: 7, url: TAB_URL, active: true, windowId: 1, status: 'complete' };
  const openedTabs = new Map();
  let frame = null;
  let gate = Promise.resolve();
  let open = () => {};
  // The main password the popup saved, so a fill can be tagged 'main' or 'site' without sending any value back.
  let mainPassword = null;
  const sourceOf = (op, arg) => {
    const pwRefs = new Set((frame?.fields || []).filter(x => x.kind === 'password').map(x => x.ref));
    const values = op === 'fillReset' ? [arg?.value] : (arg?.fills || []).filter(f => pwRefs.has(f.ref)).map(f => f.value);
    if (!values.length) return '';
    return values.every(v => v === mainPassword) ? 'main' : 'site';
  };
  const fill = (op, arg) => {
    parentPort.postMessage({ type: 'fill', op, purpose: arg?.purpose || '', source: sourceOf(op, arg) });
    return { ok: true, submitted: true };
  };
  globalThis.__latch = {
    inspect: () => (frame ? structuredClone(frame) : null),
    fillAndSubmit: arg => fill('fillAndSubmit', arg),
    fillCode: arg => fill('fillCode', arg),
    fillOne: arg => fill('fillOne', arg),
    requestRecovery: arg => fill('requestRecovery', arg),
    fillReset: arg => fill('fillReset', arg),
    clearFilled: () => ({ cleared: 0 }),
  };
  const runtime = {
    id: extensionId,
    getURL: path => `chrome-extension://${extensionId}/${path}`,
    onInstalled: listeners(), onStartup: listeners(), onMessage: listeners(),
    sendMessage: async () => {},
  };
  globalThis.chrome = {
    runtime,
    storage: { local: area('local'), session: area('session') },
    alarms: { create() {}, onAlarm: listeners() },
    tabs: {
      query: async () => [tab],
      get: async id => openedTabs.get(id) || tab,
      create: async ({ url }) => {
        parentPort.postMessage({ type: 'opened', url });
        const made = { id: 8, url, windowId: 1, status: 'complete' };
        openedTabs.set(made.id, made);
        return made;
      },
      remove: async id => { openedTabs.delete(id); },
    },
    windows: { get: async () => ({ focused: true }) },
    scripting: {
      executeScript: async ({ files, func, args }) => {
        if (files) { await gate; return []; }
        return [{ frameId: 0, result: func(...(args || [])) }];
      },
    },
  };
  const keys = new Map();
  const request = fn => { const req = {}; queueMicrotask(() => { req.result = fn(); req.onsuccess?.(); }); return req; };
  const store = { get: key => request(() => keys.get(key)), put: (value, key) => request(() => keys.set(key, value)), clear: () => request(() => keys.clear()) };
  globalThis.indexedDB = {
    open: () => request(() => ({ createObjectStore() {}, transaction: () => ({ objectStore: () => store }) })),
  };
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    if (u.protocol !== 'chrome-extension:') return nativeFetch(url, init);
    return new Response(readFileSync(join(disk, u.pathname.slice(1)), 'utf8'));
  };
  globalThis.WebSocket = class extends WS {
    constructor(url) { super(url, { origin: `chrome-extension://${extensionId}` }); }
  };
  parentPort.on('message', msg => {
    if (msg.type === 'page') frame = msg.frame;
    else if (msg.type === 'tab') Object.assign(tab, msg.patch);
    else if (msg.type === 'hold') {
      if (msg.on) gate = new Promise(resolve => { open = resolve; });
      else open();
    } else if (msg.type === 'popup') {
      if (msg.msg?.type === 'saveIdentity' && msg.msg.password) mainPassword = msg.msg.password;
      runtime.onMessage.fire(msg.msg, { id: extensionId, url: runtime.getURL('popup.html') },
        result => parentPort.postMessage({ type: 'reply', id: msg.id, result }));
    }
  });
  await import(pathToFileURL(join(code, 'background.js')).href);
  if (event === 'installed') runtime.onInstalled.fire({ reason: 'update' });
  else if (event === 'startup') runtime.onStartup.fire();
}
