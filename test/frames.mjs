import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const keepFrames = /function keepFrames\([^\n]*\) \{[\s\S]*?\r?\n\}\r?\n/.exec(source)[0];

function page() {
  const frames = new Map();
  let next = 1;
  const window = {
    requestAnimationFrame: callback => { frames.set(next, callback); return next++; },
    cancelAnimationFrame: handle => { frames.delete(handle); },
  };
  new Function('window', `${keepFrames}; keepFrames();`)(window);
  return { window, frames };
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a callback still runs when the tab paints no frames', async () => {
  const { window } = page();
  let ran = 0;
  window.requestAnimationFrame(() => { ran += 1; });
  await wait(200);
  assert.equal(ran, 1);
});

test('a real frame runs the callback once', async () => {
  const { window, frames } = page();
  let ran = 0;
  const handle = window.requestAnimationFrame(() => { ran += 1; });
  frames.get(handle)(16);
  await wait(200);
  assert.equal(ran, 1);
});

test('a cancelled callback never runs', async () => {
  const { window } = page();
  let ran = 0;
  window.cancelAnimationFrame(window.requestAnimationFrame(() => { ran += 1; }));
  await wait(200);
  assert.equal(ran, 0);
});

test('installing twice wraps once', () => {
  const { window } = page();
  const installed = window.requestAnimationFrame;
  new Function('window', `${keepFrames}; keepFrames();`)(window);
  assert.equal(window.requestAnimationFrame, installed);
});

const answered = /class Unanswered[\s\S]*?function answered\(work, ms\) \{[\s\S]*?\r?\n\}\r?\n/.exec(source)[0];
const limits = new Function(`${answered}; return { answered, Unanswered };`)();

test('a script step that never answers rejects at its limit', async () => {
  await assert.rejects(limits.answered(new Promise(() => {}), 20), limits.Unanswered);
});

test('a script step that answers keeps its result', async () => {
  assert.equal(await limits.answered(Promise.resolve('ok'), 1000), 'ok');
});

test('a step that fails keeps its own error', async () => {
  await assert.rejects(limits.answered(Promise.reject(new Error('no tab')), 1000), /no tab/);
});
