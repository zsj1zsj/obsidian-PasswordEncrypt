const assert = require('node:assert/strict');
const { dom, load, tick } = require('./helpers');
(async () => {
  const h = dom(); const { ValueModal, ChoiceModal, RevealController, promptValue } = load('ui.ts', h.obsidian);
  let result = 'pending';
  let modal = new ValueModal({}, 'Enter password', value => { result = value; }); modal.open();
  let input = modal.contentEl.querySelector('input'); input.value = 'test-only';
  modal.contentEl.querySelectorAll('button')[1].click();
  assert.equal(result, 'test-only'); assert.equal(h.document.querySelector('input'), null);
  modal = new ValueModal({}, 'Enter password', value => { result = value; }); modal.open(); modal.close(); assert.equal(result, null);
  modal = new ValueModal({}, 'Block title', value => { result = value; }, { type: 'text', defaultValue: 'Encrypted password' }); modal.open();
  input = modal.contentEl.querySelector('input'); assert.equal(input.type, 'text'); assert.equal(input.value, 'Encrypted password');
  input.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); assert.equal(result, 'Encrypted password');
  modal = new ValueModal({}, 'Block title', value => { result = value; }, { type: 'text', defaultValue: 'Existing title' }); modal.open();
  input = modal.contentEl.querySelector('input'); input.value = '邮箱';
  input.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
  assert.ok(h.openModals.includes(modal), 'confirming an IME candidate must not submit the title');
  input.value = 'Updated title'; modal.contentEl.querySelectorAll('button')[1].click(); assert.equal(result, 'Updated title');
  const abort = new AbortController(); const pendingPrompt = promptValue({}, 'Block title', abort.signal, { type: 'text', defaultValue: 'Current title' });
  assert.equal([...h.openModals][0].contentEl.querySelector('input').value, 'Current title');
  abort.abort(); assert.equal(await pendingPrompt, null);
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

  const copied = []; Object.defineProperty(h.window.navigator, 'clipboard', { configurable: true, value: { writeText: async text => { copied.push(text); } } });
  const button = (element, text) => [...element.querySelectorAll('button')].find(candidate => candidate.textContent === text);
  const copyEl = h.document.createElement('div'); h.document.body.append(copyEl); let decryptions = 0;
  const copyView = new RevealController(copyEl, async () => { decryptions++; return 'copied-secret'; }, () => 30);
  button(copyEl, 'Copy password').click(); assert.ok([...copyEl.querySelectorAll('button')].every(b => b.disabled)); await tick();
  assert.deepEqual(copied, ['copied-secret']); assert.equal(copyEl.querySelector('.epb-secret'), null);
  assert.ok(!copyEl.textContent.includes('copied-secret')); assert.equal(copyEl.querySelector('.epb-status').textContent, 'Password copied');
  assert.ok([...copyEl.querySelectorAll('button')].every(b => !b.disabled)); assert.equal(decryptions, 1);
  button(copyEl, 'Reveal password').click(); await tick(); assert.equal(decryptions, 2);
  button(copyEl, 'Copy password').click(); await tick(); assert.equal(decryptions, 2, 'copying a visible password should reuse its plaintext');
  assert.equal(copyEl.querySelector('.epb-secret').textContent, 'copied-secret'); assert.equal(timers.size, 1);
  copyView.hide(); assert.equal(timers.size, 0);
  h.window.navigator.clipboard.writeText = async () => { throw new Error('copied-secret'); };
  button(copyEl, 'Copy password').click(); await tick();
  assert.equal(copyEl.querySelector('.epb-secret'), null); assert.ok(!copyEl.textContent.includes('copied-secret'));
  assert.match(copyEl.querySelector('.epb-status').textContent, /Could not copy password/);
  assert.ok(copyEl.querySelector('.epb-status').classList.contains('epb-error')); assert.ok([...copyEl.querySelectorAll('button')].every(b => !b.disabled));
  copyView.dispose();

  h.window.navigator.clipboard.writeText = async text => { copied.push(text); };
  for (const cancel of ['hide', 'blur', 'dispose']) {
    const pendingEl = h.document.createElement('div'); h.document.body.append(pendingEl); let complete;
    const pendingView = new RevealController(pendingEl, () => new Promise(resolve => { complete = resolve; }), () => 30);
    const before = copied.length; button(pendingEl, 'Copy password').click();
    if (cancel === 'blur') h.window.dispatchEvent(new h.window.Event('blur')); else pendingView[cancel]();
    complete('cancelled-secret'); await tick(); assert.equal(copied.length, before, `${cancel} must cancel a pending copy before it reaches the clipboard`);
    assert.equal(pendingEl.querySelector('.epb-secret'), null); assert.equal(pendingEl.querySelector('.epb-status').textContent, ''); pendingView.dispose();
  }

  // ClipboardItem lets WebKit accept the write during the click and await decryption.
  const clip = dom(); const clipItems = []; const clipBlobs = []; const clipWrites = [];
  const NativeBlob = clip.window.Blob;
  clip.window.Blob = class extends NativeBlob { constructor(parts, options) { super(parts, options); clipBlobs.push(parts); } };
  const ClipboardItem = class { constructor(data) { this.data = data; clipItems.push(this); } };
  clip.window.ClipboardItem = ClipboardItem;
  const clipboard = { write: async items => { clipWrites.push(items); await items[0].data['text/plain']; } };
  Object.defineProperty(clip.window.navigator, 'clipboard', { configurable: true, value: clipboard });
  const asyncEl = clip.document.createElement('div'); clip.document.body.append(asyncEl); let finishDecrypt; let asyncDecryptions = 0;
  const asyncView = new RevealController(asyncEl, () => { asyncDecryptions++; return new Promise(resolve => { finishDecrypt = resolve; }); }, () => 30);
  button(asyncEl, 'Copy password').click(); assert.equal(clipWrites.length, 1, 'clipboard.write must run synchronously in the click');
  assert.equal(asyncDecryptions, 0); await tick(); assert.equal(asyncDecryptions, 1); assert.equal(clipBlobs.length, 0);
  finishDecrypt('async-secret'); await tick(); assert.deepEqual(clipBlobs, [['async-secret']]);
  assert.equal(asyncEl.querySelector('.epb-status').textContent, 'Password copied'); assert.equal(asyncEl.querySelector('.epb-secret'), null);
  assert.ok(!asyncEl.textContent.includes('async-secret'));
  button(asyncEl, 'Reveal password').click(); finishDecrypt('shown-secret'); await tick();
  button(asyncEl, 'Copy password').click(); await tick(); assert.equal(asyncDecryptions, 2, 'ClipboardItem copy also reuses revealed text');
  assert.deepEqual(clipBlobs.at(-1), ['shown-secret']); asyncView.dispose();

  for (const cancel of ['hide', 'blur', 'dispose']) {
    const pendingEl = clip.document.createElement('div'); clip.document.body.append(pendingEl); let complete;
    const pendingView = new RevealController(pendingEl, () => new Promise(resolve => { complete = resolve; }), () => 30);
    const before = clipBlobs.length; button(pendingEl, 'Copy password').click();
    const payload = clipItems.at(-1).data['text/plain']; await tick();
    if (cancel === 'blur') clip.window.dispatchEvent(new clip.window.Event('blur')); else pendingView[cancel]();
    complete('cancelled-secret'); await assert.rejects(payload, /cancelled/); await tick();
    assert.equal(clipBlobs.length, before, `${cancel} must reject promised text before constructing a secret Blob`);
    assert.equal(pendingEl.querySelector('.epb-status').textContent, ''); pendingView.dispose();
  }

  const unhandled = []; const collectRejection = error => { unhandled.push(error); }; process.on('unhandledRejection', collectRejection);
  try {
    const failedEl = clip.document.createElement('div'); clip.document.body.append(failedEl); let complete; let started = 0;
    const failedView = new RevealController(failedEl, () => { started++; return new Promise(resolve => { complete = resolve; }); }, () => 30);
    clipboard.write = async () => { throw new Error('clipboard-secret-detail'); };
    const before = clipBlobs.length; button(failedEl, 'Copy password').click(); await tick();
    assert.equal(started, 1); assert.match(failedEl.querySelector('.epb-status').textContent, /Could not copy password/);
    assert.ok(!failedEl.textContent.includes('clipboard-secret-detail')); complete('late-secret'); await tick();
    assert.equal(clipBlobs.length, before, 'an early clipboard rejection must suppress a late secret Blob'); assert.deepEqual(unhandled, []);
    clip.window.ClipboardItem = class { constructor() { throw new Error('constructor-secret-detail'); } };
    button(failedEl, 'Copy password').click(); await tick();
    assert.equal(started, 1, 'a failed constructor must not start the deferred password operation');
    assert.match(failedEl.querySelector('.epb-status').textContent, /Could not copy password/);
    assert.ok(!failedEl.textContent.includes('constructor-secret-detail')); assert.deepEqual(unhandled, []); failedView.dispose();
  } finally { process.off('unhandledRejection', collectRejection); }

  clip.window.ClipboardItem = ClipboardItem;
  clipboard.write = async items => { await items[0].data['text/plain']; };
  const decryptErrorEl = clip.document.createElement('div'); clip.document.body.append(decryptErrorEl);
  const decryptErrorView = new RevealController(decryptErrorEl, async () => { throw new Error('Incorrect master password'); }, () => 30);
  button(decryptErrorEl, 'Copy password').click(); await tick();
  assert.equal(decryptErrorEl.querySelector('.epb-status').textContent, 'Incorrect master password'); decryptErrorView.dispose(); clip.instance.window.close();

  const titleEl = h.document.createElement('div'); h.document.body.append(titleEl); let finishRename;
  const titleView = new RevealController(titleEl, async () => 'secret', () => 30, { title: 'Mail account', rename: () => new Promise(resolve => { finishRename = resolve; }) });
  assert.equal(titleEl.querySelector('.epb-title').textContent, '🔒 Mail account');
  button(titleEl, 'Edit title').click(); assert.ok([...titleEl.querySelectorAll('button')].every(b => b.disabled));
  finishRename('<new title>'); await tick(); assert.equal(titleEl.querySelector('.epb-title').textContent, '🔒 <new title>'); assert.equal(titleEl.querySelector('.epb-title').children.length, 0);
  button(titleEl, 'Edit title').click(); finishRename(null); await tick(); assert.equal(titleEl.querySelector('.epb-title').textContent, '🔒 <new title>');
  assert.ok([...titleEl.querySelectorAll('button')].every(b => !b.disabled)); titleView.dispose();
  // Timers and blur listeners belong to the rendered document's window.
  const other = dom(); const otherEl = other.document.createElement('div'); other.document.body.append(otherEl);
  const otherView = new RevealController(otherEl, async () => 'other-window', () => 30);
  const otherCopied = []; Object.defineProperty(other.window.navigator, 'clipboard', { value: { writeText: async text => { otherCopied.push(text); } } });
  button(otherEl, 'Copy password').click(); await tick(); assert.deepEqual(otherCopied, ['other-window']);
  otherEl.querySelector('button').click(); await tick();
  h.window.dispatchEvent(new h.window.Event('blur'));
  assert.equal(otherEl.querySelector('.epb-secret').textContent, 'other-window');
  other.window.dispatchEvent(new other.window.Event('blur'));
  assert.equal(otherEl.querySelector('.epb-secret'), null);
  otherView.dispose(); other.instance.window.close();
  h.instance.window.close(); console.log('DOM lifecycle and modal tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
