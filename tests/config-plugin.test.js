const assert = require('node:assert/strict');
const { dom, load, until, tick, vaultEvents } = require('./helpers');
const { encryptSecret } = require('../codec.ts');
const { hashText, findPasswordBlocks, replacePayloads } = load('rotation.ts');
const { CHECK_TEXT } = load('passwords.ts');
const copy = value => JSON.parse(JSON.stringify(value));
const wrap = value => `\`\`\`password\n${value}\n\`\`\`\n`;

async function fixture(initial, notes = [], secrets = new Map()) {
  const h = dom(); const Plugin = load('main.ts', h.obsidian).default; const plugin = new Plugin();
  let disk = typeof initial === 'string' ? initial : JSON.stringify(initial), writes = 0, noteWrites = 0, secretReads = 0, secretWrites = 0, nameReads = 0;
  let settingTab; const controls = { onSave: async () => {}, onReadNote: async () => {}, onProcess: async () => {}, onSecret: () => {} };
  const readPaths = [], commands = [];
  plugin.addSettingTab = tab => { settingTab = tab; };
  plugin.addCommand = command => commands.push(command);
  plugin.saveData = async value => { await controls.onSave(value); writes++; disk = JSON.stringify(value); };
  plugin.app = { vault: { configDir: '.obsidian', adapter: { exists: async path => { readPaths.push(path); return disk != null; }, read: async () => disk },
    ...vaultEvents(), getAllLoadedFiles: () => [], getMarkdownFiles: () => notes, getFileByPath: path => notes.find(n => n.path === path),
    read: async file => { await controls.onReadNote(file); return file.text; },
    process: async (file, fn) => { file.text = fn(file.text); noteWrites++; await controls.onProcess(file); } },
    secretStorage: { getSecret: id => { secretReads++; return secrets.get(id) ?? null; },
      setSecret: (id, value) => { secretWrites++; secrets.set(id, value); controls.onSecret(); }, listSecrets: () => { nameReads++; return [...secrets.keys()]; } } };
  await plugin.onload();
  return { ...h, plugin, notes, secrets, controls, commands, readPaths, tab: () => settingTab, disk: () => disk, set: value => { disk = value == null || typeof value === 'string' ? value : JSON.stringify(value); },
    counts: () => ({ writes, noteWrites, secretReads, secretWrites, nameReads }), close: () => { plugin.onunload(); h.instance.window.close(); } };
}
async function clickModal(f, heading, button) {
  await until(() => f.openModals.some(m => m.titleEl.textContent === heading), heading);
  const modal = f.openModals.find(m => m.titleEl.textContent === heading);
  const el = [...modal.contentEl.querySelectorAll('button')].find(b => b.textContent === button);
  assert.ok(el, `Missing ${button}`); el.click();
}
async function typePrompt(f, value) {
  await until(() => f.openModals.some(m => m.contentEl.querySelector('input')), 'password prompt');
  const modal = f.openModals.find(m => m.contentEl.querySelector('input'));
  modal.contentEl.querySelector('input').value = value;
  [...modal.contentEl.querySelectorAll('button')].find(b => b.textContent === 'Confirm').click();
}
async function reload(f, button = 'Reload configuration') {
  const operation = f.plugin.reloadConfiguration(); await clickModal(f, 'Reload configuration', button); await operation;
}
(async () => {
  const cipher = await encryptSecret('SYNTHETIC-SECRET', 'original-master', 32, 'original-key', 100000);
  const replacement = await encryptSecret('SYNTHETIC-SECRET', 'target-master', 32, 'target-key', 100000);
  const check = await encryptSecret(CHECK_TEXT, 'target-master', 32, 'target-key', 100000);
  const before = wrap(cipher); const blocks = findPasswordBlocks(before);
  const completed = { version: 1, targetKeyId: 'target-key', previousKeyId: 'original-key', state: 'complete', notes: [{ path: 'a.md', beforeHash: await hashText(before), afterHash: await hashText(replacePayloads(before, blocks, [replacement])), blocks, replacements: [replacement], done: true }] };
  const valid = { storageMode: 'secret-storage', activeKeyId: 'original-key', legacyKeyId: 'original-key', keys: { 'original-key': { secretId: 'original-ref', createdAt: 0 } } };

  // Broken JSON must still load the plugin and support strictly manual recovery.
  let f = await fixture('{ PRIVATE damaged JSON', [{ path: 'a.md', text: before }], new Map([['original-ref', 'original-master']]));
  assert.equal(f.plugin.configurationState, 'recovery'); assert.ok(f.commands.some(c => c.id === 'open-password-blocks'));
  assert.equal(f.readPaths[0], '.obsidian/plugins/encrypt-password-blocks/data.json');
  f.tab().display(); assert.match(f.tab().containerEl.textContent, /Read-only recovery mode/);
  assert.equal(f.tab().containerEl.querySelector('select'), null); assert.equal(f.tab().containerEl.querySelector('input[type=range]'), null);
  assert.ok(!f.tab().containerEl.textContent.includes('PRIVATE'));
  f.plugin.blockIndex.activate(); await until(() => !f.plugin.blockIndex.snapshot().busy);
  const block = f.plugin.blockIndex.snapshot().notes[0].blocks[0];
  assert.equal(f.plugin.blockIndex.status(block).label, 'Configuration unavailable');
  assert.equal((await f.plugin.blockIndex.resolveJump(block)).line, 1);
  let reveal = f.plugin.revealPassword(cipher); await typePrompt(f, 'original-master'); assert.equal(await reveal, 'SYNTHETIC-SECRET');
  reveal = f.plugin.revealPassword(cipher); const wrong = assert.rejects(() => reveal); await typePrompt(f, 'wrong'); await wrong;
  reveal = f.plugin.revealPassword(cipher); const cancelled = assert.rejects(() => reveal); await until(() => f.openModals.length); f.plugin.lock(); await cancelled;
  await assert.rejects(() => f.plugin.setStorageMode('prompt'));
  await assert.rejects(() => f.plugin.setNumericSetting('parity', 64));
  await assert.rejects(() => f.plugin.saveSettings());
  let inserts = 0; await f.plugin.insertBlock({ getCursor: () => ({}), getValue: () => '', replaceRange: () => inserts++ });
  await f.plugin.changeMasterPassword(); await f.plugin.resumeMigration(); await f.plugin.clearCompletedMigration();
  assert.equal(inserts, 0); assert.deepEqual(f.counts(), { writes: 0, noteWrites: 0, secretReads: 0, secretWrites: 0, nameReads: 0 });
  assert.equal(f.disk(), '{ PRIVATE damaged JSON');
  await reload(f); assert.equal(f.plugin.configurationState, 'recovery');
  f.set(valid); await reload(f, 'Cancel'); assert.equal(f.plugin.configurationState, 'recovery');
  await reload(f); assert.equal(f.plugin.configurationState, 'ready');
  assert.equal(await f.plugin.revealPassword(cipher), 'SYNTHETIC-SECRET'); assert.equal(f.counts().writes, 0); f.close();

  // External change does not replace in-memory settings until explicit reload.
  f = await fixture(valid, [{ path: 'a.md', text: before }], new Map([['original-ref', 'original-master']]));
  const oldManager = f.plugin.passwords; f.set({ ...valid, storageMode: 'prompt' }); await f.plugin.onExternalSettingsChange();
  assert.equal(f.plugin.configurationState, 'conflict'); assert.equal(f.plugin.settings.storageMode, 'secret-storage');
  await reload(f, 'Cancel'); assert.equal(f.plugin.configurationState, 'conflict');
  await reload(f); assert.equal(f.plugin.configurationState, 'ready'); assert.notEqual(f.plugin.passwords, oldManager);
  reveal = f.plugin.revealPassword(cipher); await typePrompt(f, 'original-master'); assert.equal(await reveal, 'SYNTHETIC-SECRET'); assert.equal(f.counts().secretReads, 0);
  f.set(null); await f.plugin.onExternalSettingsChange(); await reload(f); assert.equal(f.plugin.configurationState, 'recovery'); assert.equal(f.counts().writes, 0); f.close();

  // Pending insertion/recovery prompts are cancelled, without persisting a typed secret.
  f = await fixture({ ...valid, storageMode: 'prompt' }, [{ path: 'a.md', text: before }]);
  inserts = 0; let operation = f.plugin.insertBlock({ getCursor: () => ({ line: 0, ch: 0 }), getValue: () => '', replaceRange: () => inserts++ });
  await until(() => f.openModals.some(m => m.contentEl.querySelector('input')));
  f.openModals[0].contentEl.querySelector('input').value = 'PRIVATE-PENDING';
  f.set({ ...valid, parity: 64 }); await f.plugin.onExternalSettingsChange(); await operation;
  assert.equal(inserts, 0); assert.equal(f.openModals.length, 0); assert.equal(f.counts().writes, 0); f.close();

  // Reload waits for and invalidates an active manual reveal.
  f = await fixture('{invalid'); reveal = f.plugin.revealPassword(cipher); const aborted = assert.rejects(() => reveal);
  await until(() => f.openModals.some(m => m.contentEl.querySelector('input')));
  f.set(valid); await reload(f); await aborted; assert.equal(f.plugin.configurationState, 'ready'); assert.equal(f.plugin.activeOperations, 0); f.close();

  // A change after a recovered password was entered but before binding blocks SecretStorage writes.
  f = await fixture(valid, [{ path: 'a.md', text: before }]);
  reveal = f.plugin.revealPassword(cipher); const bindingFailure = assert.rejects(() => reveal); await typePrompt(f, 'original-master');
  await until(() => f.openModals.some(m => m.titleEl.textContent === 'Password verified'));
  f.set({ ...valid, parity: 64 });
  await clickModal(f, 'Password verified', 'Save recovered password'); await bindingFailure;
  assert.equal(f.plugin.configurationState, 'conflict'); assert.equal(f.counts().secretWrites, 0); assert.equal(f.counts().writes, 0); f.close();

  // Completed record cleanup has confirmation, identity, and persistence checks.
  const withRecord = { ...valid, migration: completed, keyChecks: { 'target-key': check } };
  f = await fixture(withRecord, [{ path: 'a.md', text: wrap(replacement) }], new Map([['original-ref', 'original-master']]));
  f.tab().display(); assert.match(f.tab().containerEl.textContent, /Latest record: complete; 1 notes; 1 blocks/); assert.ok(!f.tab().containerEl.textContent.includes(cipher));
  operation = f.plugin.clearCompletedMigration(); await clickModal(f, 'Clear completed migration record', 'Cancel'); await operation;
  assert.equal(f.counts().writes, 0); assert.ok(f.plugin.settings.migration);
  operation = f.plugin.clearCompletedMigration(); await clickModal(f, 'Clear completed migration record', 'Clear record'); await operation;
  const cleared = JSON.parse(f.disk()); assert.equal(cleared.migration, undefined); assert.deepEqual(cleared.keys, withRecord.keys); assert.deepEqual(cleared.keyChecks, withRecord.keyChecks);
  assert.equal(f.counts().writes, 1); assert.equal(f.counts().noteWrites, 0); assert.equal(f.counts().secretWrites, 0); assert.equal(f.notes[0].text, wrap(replacement)); f.close();

  f = await fixture(withRecord); operation = f.plugin.clearCompletedMigration();
  await until(() => f.openModals.some(m => m.titleEl.textContent === 'Clear completed migration record'));
  f.set({ ...withRecord, parity: 64 }); await clickModal(f, 'Clear completed migration record', 'Clear record'); await operation;
  assert.equal(f.counts().writes, 0); assert.ok(JSON.parse(f.disk()).migration); assert.equal(f.plugin.configurationState, 'conflict'); f.close();
  f = await fixture(withRecord); operation = f.plugin.clearCompletedMigration();
  await until(() => f.openModals.length); f.plugin.settings.migration.notes[0].afterHash = 'a'.repeat(64);
  await clickModal(f, 'Clear completed migration record', 'Clear record'); await operation; assert.equal(f.counts().writes, 0); f.close();
  f = await fixture(withRecord); f.controls.onSave = async () => { throw Error('save failed'); };
  operation = f.plugin.clearCompletedMigration(); await clickModal(f, 'Clear completed migration record', 'Clear record'); await operation;
  assert.ok(f.plugin.settings.migration); assert.ok(JSON.parse(f.disk()).migration); assert.equal(f.plugin.configurationState, 'recovery'); f.close();
  const paused = copy(completed); paused.state = 'paused'; paused.notes[0].done = false;
  f = await fixture({ ...valid, migration: paused }); await f.plugin.clearCompletedMigration(); assert.equal(f.counts().writes, 0); assert.equal(f.openModals.length, 0); f.close();

  // A migration stopped between two writes retains a recoverable journal and old keys.
  const task = copy(paused); task.notes.push({ ...copy(task.notes[0]), path: 'b.md' });
  const migrationSettings = { ...valid, migration: task, keyChecks: { 'target-key': check }, keys: { ...valid.keys, 'target-key': { secretId: 'target-ref', createdAt: 0 } } };
  f = await fixture(migrationSettings, [{ path: 'a.md', text: before }, { path: 'b.md', text: before }], new Map([['original-ref', 'original-master'], ['target-ref', 'target-master']]));
  f.controls.onProcess = async () => { const external = JSON.parse(f.disk()); external.parity = 64; f.set(external); await f.plugin.onExternalSettingsChange(); };
  await f.plugin.resumeMigration(); assert.equal(f.counts().noteWrites, 1); assert.equal(f.notes[0].text, wrap(replacement)); assert.equal(f.notes[1].text, before);
  assert.equal(f.plugin.configurationState, 'conflict'); assert.equal(JSON.parse(f.disk()).migration.notes[0].done, false);
  assert.equal(JSON.parse(f.disk()).activeKeyId, 'original-key'); assert.equal(f.secrets.size, 2);
  f.controls.onProcess = async () => {}; await reload(f); await f.plugin.resumeMigration();
  assert.equal(f.counts().noteWrites, 2); assert.equal(JSON.parse(f.disk()).migration.state, 'complete'); assert.equal(JSON.parse(f.disk()).activeKeyId, 'target-key'); f.close();

  // Conflict at the pre-note checkpoint leaves every note unchanged.
  f = await fixture(migrationSettings, [{ path: 'a.md', text: before }, { path: 'b.md', text: before }], new Map([['target-ref', 'target-master']]));
  f.controls.onReadNote = async () => { f.set({ ...JSON.parse(f.disk()), parity: 64 }); };
  await f.plugin.resumeMigration(); assert.equal(f.counts().noteWrites, 0); assert.equal(f.plugin.configurationState, 'conflict'); f.close();
  await tick(); console.log('read-only recovery, reload, protected operations, cleanup, and migration conflict tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
