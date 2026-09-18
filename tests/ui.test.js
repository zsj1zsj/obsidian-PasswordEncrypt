const assert = require('node:assert/strict');
const { dom, load, tick } = require('./helpers');
(async () => {
  const h = dom(); const { ValueModal, ChoiceModal, RevealController } = load('ui.ts', h.obsidian);
  let result = 'pending';
  let modal = new ValueModal({}, 'Enter password', value => { result = value; }); modal.open();
  let input = modal.contentEl.querySelector('input'); input.value = 'test-only';
  modal.contentEl.querySelectorAll('button')[1].click();
  assert.equal(result, 'test-only'); assert.equal(h.document.querySelector('input'), null);
  modal = new ValueModal({}, 'Enter password', value => { result = value; }); modal.open(); modal.close(); assert.equal(result, null);
  modal = new ChoiceModal({}, 'Choose', 'Info', ['Use once', 'Save'], value => { result = value; }); modal.open();
  modal.contentEl.querySelector('button').click(); assert.equal(result, null);

  const el = h.document.createElement('div'); h.document.body.append(el);
  const timers = new Map(); let nextTimer = 0;
  h.window.setTimeout = fn => { timers.set(++nextTimer, fn); return nextTimer; };
  h.window.clearTimeout = id => { timers.delete(id); };
  let release; const view = new RevealController(el, () => new Promise(resolve => { release = resolve; }), () => 30);
  el.querySelector('button').click(); assert.equal(el.querySelector('button').disabled, true);
  h.window.dispatchEvent(new h.window.Event('blur')); release('must-not-appear'); await tick();
  assert.equal(el.querySelector('.epb-secret'), null); assert.equal(timers.size, 0);
  el.querySelector('button').click(); release('visible'); await tick(); assert.equal(el.querySelector('.epb-secret').textContent, 'visible');
  [...timers.values()][0](); assert.equal(el.querySelector('.epb-secret'), null); assert.equal(timers.size, 0);
  el.querySelector('button').click(); view.dispose(); release('late'); await tick(); assert.equal(el.querySelector('.epb-secret'), null);
  assert.equal(timers.size, 0);
  // Timers and blur listeners belong to the rendered document's window.
  const other = dom(); const otherEl = other.document.createElement('div'); other.document.body.append(otherEl);
  const otherView = new RevealController(otherEl, async () => 'other-window', () => 30);
  otherEl.querySelector('button').click(); await tick();
  h.window.dispatchEvent(new h.window.Event('blur'));
  assert.equal(otherEl.querySelector('.epb-secret').textContent, 'other-window');
  other.window.dispatchEvent(new other.window.Event('blur'));
  assert.equal(otherEl.querySelector('.epb-secret'), null);
  otherView.dispose(); other.instance.window.close();
  h.instance.window.close(); console.log('DOM lifecycle and modal tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
