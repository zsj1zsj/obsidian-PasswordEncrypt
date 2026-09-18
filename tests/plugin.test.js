const assert = require('node:assert/strict');
const { dom, load, tick } = require('./helpers');
const { encryptSecret, decryptSecret, inspectEnvelope } = require('../codec.ts');
const copy = value => JSON.parse(JSON.stringify(value));

async function fixture(initial, notes, secrets = new Map()) {
  const h = dom(); const Plugin = load('main.ts', h.obsidian).default; const plugin = new Plugin();
  let disk = copy(initial); const saves = []; let writes = 0;
  const controls = { failSave: () => false, failProcess: () => false };
  plugin.loadData = async () => copy(disk);
  plugin.saveData = async value => {
    if (controls.failSave(value)) throw new Error('simulated settings failure');
    disk = copy(value); saves.push(copy(value));
  };
  plugin.app = { secretStorage: { getSecret: id => secrets.get(id) ?? null, setSecret: (id, value) => secrets.set(id, value) },
    vault: { adapter: { exists: async () => true, read: async () => JSON.stringify(disk) }, getMarkdownFiles: () => notes, getFileByPath: path => notes.find(n => n.path === path), read: async file => file.text, process: async (file, fn) => {
      if (controls.failProcess(writes)) throw new Error('simulated note failure');
      file.text = fn(file.text); writes++;
    } } };
  await plugin.onload();
  return { ...h, plugin, controls, secrets, saves, disk: () => disk, writes: () => writes };
}
async function drive(f, operation, values = [], option = 'Re-encrypt existing blocks', cancelScan = false) {
  let finished = false; let failure;
  operation.finally(() => { finished = true; }).catch(error => { failure = error; });
  const seen = new Set(); const start = Date.now();
  while (!finished) {
    if (Date.now() - start > 20000) throw new Error('UI operation timed out');
    for (const modal of [...f.openModals]) {
      if (seen.has(modal)) continue; seen.add(modal);
      const input = modal.contentEl.querySelector('input');
      if (input) {
        const value = values.shift();
        if (value == null) modal.close();
        else { input.value = value; [...modal.contentEl.querySelectorAll('button')].find(b => b.textContent === 'Confirm').click(); }
      } else {
        const buttons = [...modal.contentEl.querySelectorAll('button')];
        if (modal.titleEl.textContent === 'Master password migration') {
          if (cancelScan) modal.close();
        } else {
          const button = buttons.find(b => b.textContent === option) || buttons.find(b => b.textContent === 'Close') || buttons.find(b => b.textContent === 'Cancel');
          button.click();
        }
      }
    }
    await tick();
  }
  if (failure) throw failure;
}
function dispose(f) { f.plugin.onunload(); f.instance.window.close(); }
(async () => {
  const old = await encryptSecret('synthetic-secret', 'old-master', 32, 'old-key', 100000);
  const wrap = cipher => `# Keep\n\n\`\`\`password\n${cipher}\n\`\`\`\n`;
  const { findPasswordBlocks } = load('rotation.ts');
  const initial = { storageMode: 'secret-storage', activeKeyId: 'old-key', legacyKeyId: 'old-key', keys: { 'old-key': { secretId: 'old-secret', createdAt: 0 } } };
  let notes = [{ path: 'a.md', text: wrap(old) }, { path: 'b.md', text: wrap(old) }];
  let f = await fixture(initial, notes, new Map([['old-secret', 'old-master']]));
  f.controls.failProcess = writes => writes === 1;
  await drive(f, f.plugin.changeMasterPassword(), ['new-master', 'new-master']);
  assert.equal(f.writes(), 1); assert.equal(f.disk().activeKeyId, 'old-key');
  const target = f.disk().migration.targetKeyId; const restart = f.disk(); const secrets = f.secrets;
  assert.equal(await decryptSecret(findPasswordBlocks(notes[0].text)[0].source, 'new-master'), 'synthetic-secret');
  dispose(f);
  f = await fixture(restart, notes, secrets);
  await drive(f, f.plugin.resumeMigration());
  assert.equal(f.disk().activeKeyId, target); assert.equal(f.disk().migration.state, 'complete');
  assert.equal(f.writes(), 1, 'resume must skip the already migrated note');
  assert.equal(inspectEnvelope(findPasswordBlocks(notes[1].text)[0].source).keyId, target);
  dispose(f);

  notes = [{ path: 'a.md', text: wrap(old) }];
  f = await fixture(initial, notes, new Map([['old-secret', 'old-master']]));
  f.controls.failSave = value => value.migration?.notes.some(n => n.done);
  await drive(f, f.plugin.changeMasterPassword(), ['new-master', 'new-master']);
  assert.equal(f.writes(), 1); assert.equal(f.disk().migration.notes[0].done, false);
  const journal = f.disk(); const retained = f.secrets; dispose(f);
  f = await fixture(journal, notes, retained); await drive(f, f.plugin.resumeMigration());
  assert.equal(f.writes(), 0); assert.equal(f.disk().migration.state, 'complete'); dispose(f);

  f = await fixture(initial, [{ path: 'a.md', text: wrap(old) }], new Map([['old-secret', 'old-master']]));
  f.controls.failSave = () => true;
  await drive(f, f.plugin.changeMasterPassword(), ['new-master', 'new-master']);
  assert.equal(f.writes(), 0); assert.equal(f.disk().activeKeyId, 'old-key'); dispose(f);

  f = await fixture(initial, [{ path: 'a.md', text: wrap(old) }], new Map([['old-secret', 'old-master']]));
  await drive(f, f.plugin.changeMasterPassword(), [], 'Cancel'); assert.equal(f.saves.length, 0); dispose(f);
  f = await fixture(initial, [{ path: 'a.md', text: wrap(old) }], new Map([['old-secret', 'old-master']]));
  await drive(f, f.plugin.changeMasterPassword(), [], 'Cancel', true); assert.equal(f.saves.length, 0); dispose(f);

  f = await fixture(initial, [{ path: 'a.md', text: wrap(old) }], new Map([['old-secret', 'old-master']]));
  await drive(f, f.plugin.changeMasterPassword(), ['new-master', 'different']); assert.equal(f.writes(), 0); assert.equal(f.saves.length, 0); dispose(f);
  f = await fixture(initial, [{ path: 'a.md', text: wrap(old) }], new Map([['old-secret', 'old-master']]));
  await drive(f, f.plugin.changeMasterPassword(), ['new-master', 'new-master'], 'New blocks only');
  assert.equal(f.writes(), 0); assert.notEqual(f.disk().activeKeyId, 'old-key'); assert.equal(f.secrets.get('old-secret'), 'old-master');
  const key = f.plugin.settings.activeKeyId;
  await f.plugin.setStorageMode('session'); await f.plugin.setStorageMode('prompt');
  assert.equal(f.disk().activeKeyId, key); assert.equal(f.secrets.size, 2); dispose(f);

  f = await fixture({ masterPassword: 'legacy-test' }, [], new Map());
  assert.equal(f.disk().masterPassword, undefined); assert.equal(f.secrets.size, 1); assert.ok(f.disk().legacyKeyId); dispose(f);
  // A load-time save failure must leave the old on-disk master field available for retry.
  const h = dom(); const Plugin = load('main.ts', h.obsidian).default; const p = new Plugin();
  const raw = { masterPassword: 'legacy-test' }; const store = new Map();
  p.loadData = async () => raw; p.saveData = async () => { throw new Error('disk failed'); };
  p.app = { vault: { adapter: { exists: async () => true, read: async () => JSON.stringify(raw) } }, secretStorage: { setSecret: (id, s) => store.set(id, s), getSecret: id => store.get(id) } };
  await p.loadSettings(); assert.equal(p.configurationState, 'recovery'); assert.equal(raw.masterPassword, 'legacy-test'); h.instance.window.close();

  notes = [{ path: 'manual.md', text: wrap(old) }];
  f = await fixture({ ...initial, storageMode: 'prompt' }, notes, new Map());
  await drive(f, f.plugin.changeMasterPassword(), ['new-master', 'new-master', 'old-master']);
  assert.equal(f.writes(), 1); assert.equal(f.secrets.size, 0); assert.equal(f.disk().migration.state, 'complete');
  assert.ok(!JSON.stringify(f.disk()).includes('new-master'));
  assert.ok(!JSON.stringify(f.disk()).includes('synthetic-secret'));
  dispose(f);

  // Paused prompt-mode migration resumes after restart without any persisted password.
  notes = [{ path: 'one.md', text: wrap(old) }, { path: 'two.md', text: wrap(old) }];
  f = await fixture({ ...initial, storageMode: 'prompt' }, notes, new Map());
  const originalProcess = f.plugin.app.vault.process;
  f.plugin.app.vault.process = async (file, fn) => {
    await originalProcess(file, fn);
    f.openModals.find(m => m.titleEl.textContent === 'Master password migration').stopped = true;
  };
  await drive(f, f.plugin.changeMasterPassword(), ['new-master', 'new-master', 'old-master', 'old-master']);
  assert.equal(f.writes(), 1); assert.equal(f.disk().migration.state, 'paused'); assert.equal(f.secrets.size, 0);
  const paused = f.disk(); const sameTarget = paused.migration.targetKeyId; dispose(f);
  f = await fixture(paused, notes, new Map());
  await drive(f, f.plugin.resumeMigration(), ['new-master']);
  assert.equal(f.disk().activeKeyId, sameTarget); assert.equal(f.writes(), 1); assert.equal(f.secrets.size, 0); dispose(f);

  // Editing unrelated notes during a task does not invalidate prepared targets.
  notes = [{ path: 'target.md', text: wrap(old) }, { path: 'unrelated.md', text: 'before' }];
  f = await fixture(initial, notes, new Map([['old-secret', 'old-master']]));
  const read = f.plugin.app.vault.read;
  f.plugin.app.vault.read = async file => { if (file.path === 'target.md') notes[1].text = 'external edit'; return read(file); };
  await drive(f, f.plugin.changeMasterPassword(), ['new-master', 'new-master']);
  assert.equal(f.disk().migration.state, 'complete'); assert.equal(notes[1].text, 'external edit'); dispose(f);
  console.log('plugin integration, persistence, and restart tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
