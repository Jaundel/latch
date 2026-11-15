// The one place Latch asks the user before using their main password on a new site.
// It is an extension window, so neither the page nor a browser AI driving the page can press it.
import { call, h, logo } from './ui.js';

const view = document.getElementById('view');
const id = location.hash.slice(1);
const port = chrome.runtime.connect({ name: 'approval' });
const ping = setInterval(() => port.postMessage('ping'), 10000);

function gone() {
  clearInterval(ping);
  view.replaceChildren(h('div', { class: 'brand' }, logo(24), 'Latch'),
    h('h1', {}, 'This request has ended'),
    h('p', {}, 'Your AI stopped waiting, or you already answered. You can close this window.'),
    h('button', { class: 'btn block', type: 'button', onclick: () => window.close() }, 'Close'));
}

const request = await call('approval:get', { id }).catch(() => ({ gone: true }));
if (request.gone) {
  gone();
} else {
  const { host, base } = request;
  const prefix = host.endsWith(base) ? host.slice(0, host.length - base.length) : '';
  const answer = async value => {
    await call('approval:answer', { id, answer: value });
    clearInterval(ping);
    window.close();
  };
  const allow = h('button', { class: 'btn primary', type: 'button', disabled: true, onclick: () => answer('allow') }, 'Allow');
  const deny = h('button', { class: 'btn', type: 'button', onclick: () => answer('deny') }, 'Don\'t allow');
  view.replaceChildren(
    h('div', { class: 'brand' }, logo(24), 'Latch'),
    h('h1', {}, 'Sign in to this site with your password?'),
    h('div', { class: 'site', title: host }, prefix, h('b', {}, base)),
    h('p', {}, 'Your AI wants Latch to sign in here with your email and main password. Latch has not used your password on this site before.'),
    h('div', { class: 'warn' }, 'Allow it only if you know this site and expected your AI to sign in to it.'),
    h('div', { class: 'buttons' }, deny, allow),
    h('p', { class: 'foot' }, 'If you allow it, Latch remembers this site. You can change that in Settings.'));
  deny.focus();
  // A short pause, so a click meant for something else cannot land on Allow as the window opens.
  setTimeout(() => { allow.disabled = false; }, 700);
  addEventListener('keydown', e => { if (e.key === 'Escape') answer('deny'); });
}
