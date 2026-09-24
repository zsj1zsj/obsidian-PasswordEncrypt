const assert = require('node:assert/strict');
const { dom, load, until, tick, vaultEvents } = require('./helpers');
const { encryptSecret, decryptSecret } = require('../codec.ts');
const { findPasswordBlocks } = load('rotation.ts');

const settings = {
  storageMode: 'secret-storage', activeKeyId: 'block-key', legacyKeyId: 'block-key',
  keys: { 'block-key': { secretId: 'block-master-ref', createdAt: 0 } },
};
const wrap = (cipher, title = '') => `\`\`\`password${title ? ` ${title}` : ''}\n${cipher}\n\`\`\`\n`;

async function fixture(text = '', configuration = settings) {
  const h = dom();
  const Plugin = load('main.ts', h.obsidian).default;
  const plugin = new Plugin();
  const note = { path: 'passwords.md', text };
  let disk = typeof configuration === 'string' ? configuration : JSON.stringify(configuration);
  let noteWrites = 0, configWrites = 0, secretReads = 0;
  const clipboard = [];
  const controls = { beforeProcess: () => {} };
  Object.defineProperty(h.window.navigator, 'clipboard', { value: { writeText: async value => { clipboard.push(value); } } });
  plugin.saveData = async value => { configWrites++; disk = JSON.stringify(value); };
  plugin.app = {
    vault: {
      configDir: '.obsidian',
      adapter: { exists: async () => true, read: async () => disk },
      ...vaultEvents(), getAllLoadedFiles: () => [], getMarkdownFiles: () => [note],
      getFileByPath: path => path === note.path ? note : null,
      read: async file => file.text,
      process: async (file, change) => { controls.beforeProcess(file); file.text = change(file.text); noteWrites++; },
    },
    secretStorage: {
      getSecret: id => { secretReads++; return id === 'block-master-ref' ? 'synthetic-master' : null; },
      setSecret: () => { throw new Error('Unexpected SecretStorage write'); },
      listSecrets: () => ['block-master-ref'],
    },
  };
  await plugin.onload();
  const children = [];
  return {
    ...h, plugin, note, controls, clipboard,
    counts: () => ({ noteWrites, configWrites, secretReads }),
    setConfiguration: value => { disk = typeof value === 'string' ? value : JSON.stringify(value); },
    render: (index = 0, sectionOverride) => {
      const snapshot = note.text;
      const lines = snapshot.split('\n');
      const starts = lines.map((line, i) => /^```password(?:\s|$)/.test(line) ? i : -1).filter(i => i >= 0);
      const lineStart = starts[index];
      assert.notEqual(lineStart, undefined, 'Fixture block must exist');
      const lineEnd = lines.findIndex((line, i) => i > lineStart && line === '```');
      const source = lines.slice(lineStart + 1, lineEnd).join('\n');
      const el = h.document.createElement('div'); h.document.body.append(el);
      plugin.renderBlock(source, el, {
        sourcePath: note.path,
        getSectionInfo: () => sectionOverride === undefined ? { text: snapshot, lineStart, lineEnd } : sectionOverride,
        addChild: child => children.push(child),
      });
      return el;
    },
    close: () => { for (const child of children) child.onunload?.(); plugin.onunload(); h.instance.window.close(); },
  };
}

function button(el, label) {
  const result = [...el.querySelectorAll('button')].find(candidate => candidate.textContent === label);
  assert.ok(result, `Missing ${label} button`);
  return result;
}
async function prompt(f, type) {
  await until(() => f.openModals.some(modal => modal.contentEl.querySelector(`input[type=${type}]`)), `${type} prompt`);
  const modal = f.openModals.find(modal => modal.contentEl.querySelector(`input[type=${type}]`));
  return { modal, input: modal.contentEl.querySelector('input') };
}
function editor(initial = '# Existing note\n') {
  let text = initial, inserts = 0;
  return {
    getCursor: () => ({ line: 1, ch: 0 }), getValue: () => text,
    replaceRange: value => { text += value; inserts++; },
    inserts: () => inserts,
  };
}
async function renamePrompt(f, el) {
  button(el, 'Edit title').click();
  const value = await prompt(f, 'text');
  assert.equal(value.modal.titleEl.textContent, 'Edit block title');
  return value;
}
async function finishRename(f, modal, value) {
  if (value === null) button(modal.contentEl, 'Cancel').click();
  else { modal.contentEl.querySelector('input').value = value; button(modal.contentEl, 'Confirm').click(); }
  await until(() => !f.plugin.isBusy, 'title edit finished');
  await tick();
}

(async () => {
  const cipher = await encryptSecret('SYNTHETIC-BLOCK-SECRET', 'synthetic-master', 32, 'block-key', 100000);

  // Inserting exposes an editable default title without changing password input handling.
  for (const customTitle of [null, 'Work account']) {
    const f = await fixture(); const edit = editor();
    const operation = f.plugin.insertBlock(edit);
    const secret = await prompt(f, 'password');
    secret.input.value = 'SYNTHETIC-INSERT-SECRET'; button(secret.modal.contentEl, 'Confirm').click();
    const title = await prompt(f, 'text');
    assert.equal(title.input.value, 'Encrypted password');
    if (customTitle !== null) title.input.value = customTitle;
    button(title.modal.contentEl, 'Confirm').click(); await operation;
    assert.equal(edit.inserts(), 1);
    assert.ok(edit.getValue().includes(`\`\`\`password ${customTitle ?? 'Encrypted password'}\n`));
    const blocks = findPasswordBlocks(edit.getValue());
    assert.equal(blocks.length, 1);
    assert.equal(await decryptSecret(blocks[0].source, 'synthetic-master'), 'SYNTHETIC-INSERT-SECRET');
    f.close();
  }

  let f = await fixture(); let edit = editor();
  let operation = f.plugin.insertBlock(edit);
  let value = await prompt(f, 'password'); value.input.value = 'SYNTHETIC-CANCELLED'; button(value.modal.contentEl, 'Confirm').click();
  value = await prompt(f, 'text'); button(value.modal.contentEl, 'Cancel').click(); await operation;
  assert.equal(edit.inserts(), 0);
  assert.deepEqual(f.counts(), { noteWrites: 0, configWrites: 0, secretReads: 0 }); f.close();

  // Existing untitled blocks render the default, and Copy decrypts directly without revealing.
  f = await fixture(wrap(cipher)); let el = f.render();
  assert.match(el.querySelector('.epb-title').textContent, /Encrypted password/);
  assert.equal(el.querySelector('.epb-secret'), null);
  button(el, 'Copy password').click();
  await until(() => f.clipboard.length === 1, 'password copied');
  assert.deepEqual(f.clipboard, ['SYNTHETIC-BLOCK-SECRET']);
  assert.equal(el.querySelector('.epb-secret'), null);
  assert.ok(!el.textContent.includes('SYNTHETIC-BLOCK-SECRET'));
  assert.equal(f.counts().noteWrites, 0); f.close();

  // Identical payloads and titles must still rename only the chosen occurrence.
  const duplicate = `# Accounts\n\n${wrap(cipher, 'Account')}\n${wrap(cipher, 'Account')}`;
  f = await fixture(duplicate); el = f.render(1);
  assert.match(el.querySelector('.epb-title').textContent, /Account/);
  value = await renamePrompt(f, el); assert.equal(value.input.value, 'Account');
  await finishRename(f, value.modal, 'Work <account>');
  const expected = `# Accounts\n\n${wrap(cipher, 'Account')}\n${wrap(cipher, 'Work <account>')}`;
  assert.equal(f.note.text, expected);
  assert.deepEqual(findPasswordBlocks(f.note.text).map(block => block.source), findPasswordBlocks(duplicate).map(block => block.source));
  assert.deepEqual(f.counts(), { noteWrites: 1, configWrites: 0, secretReads: 0 });
  const rendered = f.render(1); assert.match(rendered.querySelector('.epb-title').textContent, /Work <account>/);
  assert.equal(rendered.querySelector('account'), null); f.close();

  // Missing or ambiguous renderer locations must never select a block by payload alone.
  for (const section of [null, { text: duplicate, lineStart: 2, lineEnd: duplicate.split('\n').length - 1 }]) {
    f = await fixture(duplicate); el = f.render(0, section);
    button(el, 'Edit title').click();
    await until(() => !f.plugin.isBusy, 'unsafe title action'); await tick();
    assert.equal(f.openModals.length, 0);
    assert.match(el.querySelector('.epb-status').textContent, /Cannot locate this block safely/);
    assert.equal(f.note.text, duplicate);
    assert.deepEqual(f.counts(), { noteWrites: 0, configWrites: 0, secretReads: 0 }); f.close();
  }

  f = await fixture(wrap(cipher)); el = f.render(); value = await renamePrompt(f, el);
  assert.equal(value.input.value, 'Encrypted password');
  await finishRename(f, value.modal, null);
  assert.equal(f.note.text, wrap(cipher)); assert.equal(f.counts().noteWrites, 0); f.close();

  // Concurrent note edits are preserved, including an edit just before the atomic update.
  for (const editAtProcess of [false, true]) {
    f = await fixture(wrap(cipher, 'Before')); el = f.render(); value = await renamePrompt(f, el);
    const concurrent = `An unrelated concurrent edit\n${f.note.text}`;
    if (editAtProcess) f.controls.beforeProcess = note => { note.text = concurrent; };
    else f.note.text = concurrent;
    await finishRename(f, value.modal, 'After');
    assert.equal(f.note.text, concurrent);
    assert.equal(f.counts().noteWrites, 0);
    assert.match(el.querySelector('.epb-status').textContent, /changed/i); f.close();
  }

  // A changed configuration is checked before committing a pending title edit.
  f = await fixture(wrap(cipher, 'Before')); el = f.render(); value = await renamePrompt(f, el);
  f.setConfiguration({ ...settings, parity: 64 });
  await finishRename(f, value.modal, 'After');
  assert.equal(f.plugin.configurationState, 'conflict');
  assert.equal(f.note.text, wrap(cipher, 'Before'));
  assert.deepEqual(f.counts(), { noteWrites: 0, configWrites: 0, secretReads: 0 }); f.close();

  // Protected recovery mode cannot modify block metadata.
  f = await fixture(wrap(cipher, 'Before'), '{broken'); el = f.render();
  button(el, 'Edit title').click(); await tick();
  await until(() => !f.plugin.isBusy, 'read-only title action');
  assert.equal(f.openModals.length, 0);
  assert.equal(f.note.text, wrap(cipher, 'Before'));
  assert.deepEqual(f.counts(), { noteWrites: 0, configWrites: 0, secretReads: 0 }); f.close();

  console.log('password block insertion, direct copy, title editing, and conflict tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
