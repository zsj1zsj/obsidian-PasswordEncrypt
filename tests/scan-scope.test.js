const assert = require('node:assert/strict');
const { load, dom, until, vaultEvents } = require('./helpers');
const { normalizeScanFolders, isInScanFolders } = load('scan-scope.ts');
const { validateConfiguration } = load('config.ts');
const { PasswordBlockIndex } = load('block-index.ts');
const { encryptSecret } = require('../codec.ts');
const idle = index => until(() => !index.snapshot().busy);
const wrap = value => `\`\`\`password\n${value}\n\`\`\`\n`;

(async () => {
  assert.deepEqual(normalizeScanFolders([' Accounts\\Work/ ', '', 'Accounts/Work', '密码//工作/']), ['Accounts/Work', '密码/工作']);
  assert.deepEqual(normalizeScanFolders([]), []);
  for (const invalid of ['Folder', null, [3], ['/absolute'], ['C:\\Accounts'], ['\\\\server\\share'], ['../a'], ['a/../b'], ['./a'], ['a/./b'], ['a\nb']]) assert.throws(() => normalizeScanFolders(invalid));
  assert.equal(isInScanFolders('Accounts/a.md', ['Accounts']), true);
  assert.equal(isInScanFolders('Accounts/sub/a.md', ['Accounts']), true);
  assert.equal(isInScanFolders('Accounts2/a.md', ['Accounts']), false);
  assert.equal(isInScanFolders('accounts/a.md', ['Accounts']), false);
  assert.equal(isInScanFolders('root.md', ['Accounts']), false);
  assert.equal(isInScanFolders('root.md', []), true);
  assert.deepEqual(validateConfiguration({}).settings.scanFolders, []);
  assert.deepEqual(validateConfiguration({ scanFolders: ['a\\b/', 'a/b'] }).settings.scanFolders, ['a/b']);
  assert.throws(() => validateConfiguration({ scanFolders: '../bad' }), /scanFolders/);

  const cipher = await encryptSecret('synthetic-secret', 'synthetic-master', 32, 'test-key', 100000);
  const files = new Map([['Accounts/a.md', wrap(cipher)], ['Accounts/sub/b.md', wrap(cipher)], ['Accounts2/c.md', wrap(cipher)], ['Other/d.md', wrap(cipher)], ['root.md', wrap(cipher)]]);
  let folders = ['Accounts', 'Accounts/sub', 'Other'], listings = 0; const reads = [];
  const host = { paths: () => { listings++; return [...files.keys()]; }, hasFile: path => files.has(path), read: async path => { reads.push(path); return files.get(path); }, scanFolders: () => folders,
    settings: () => ({ storageMode: 'prompt', keys: {}, legacyKeyId: '' }), secretNames: () => { throw Error('No secret names needed'); } };
  const index = new PasswordBlockIndex(host, 10);
  index.refresh(); assert.equal(reads.length, 0); index.activate(); await idle(index);
  assert.deepEqual(reads.sort(), ['Accounts/a.md', 'Accounts/sub/b.md', 'Other/d.md']);
  assert.equal(index.snapshot().notes.length, 3, 'nested folders must not duplicate records');
  const initialListings = listings;
  index.changedFile('Accounts2/c.md', undefined, false); await idle(index); assert.equal(reads.length, 3);
  files.set('Accounts/new.md', files.get('Accounts2/c.md')); files.delete('Accounts2/c.md');
  index.changedFile('Accounts/new.md', 'Accounts2/c.md', false); await idle(index); assert.equal(index.snapshot().notes.length, 4);
  files.set('Outside/new.md', files.get('Accounts/new.md')); files.delete('Accounts/new.md');
  index.changedFile('Outside/new.md', 'Accounts/new.md', false); await idle(index); assert.equal(index.snapshot().notes.length, 3);
  assert.equal(listings, initialListings, 'scope moves use direct file events without listing the vault');
  folders = ['Missing']; index.refresh(); await idle(index); assert.equal(index.snapshot().notes.length, 0);
  folders = []; index.refresh(); await idle(index); assert.equal(index.snapshot().notes.length, 5);
  const paths = host.paths; host.paths = () => { throw Error('listing failed'); };
  folders = ['Other']; index.refresh(); assert.deepEqual(index.snapshot().notes.map(n => n.path), ['Other/d.md']);
  assert.ok(index.snapshot().error); host.paths = paths;
  // A late read and a debounced event from the old scope cannot repopulate it.
  let release; let pending = false;
  host.read = async path => { if (path === 'Accounts/a.md') { pending = true; return new Promise(resolve => { release = resolve; }); } return files.get(path); };
  folders = ['Accounts']; index.refresh(); await until(() => pending);
  index.changedFile('Accounts/sub/b.md'); folders = ['Other']; index.refresh();
  release(wrap(cipher)); await idle(index); assert.deepEqual(index.snapshot().notes.map(n => n.path), ['Other/d.md']);
  files.set('Moved/d.md', files.get('Other/d.md')); files.delete('Other/d.md'); index.changed('Moved', 'Other', false); await idle(index);
  assert.equal(index.snapshot().notes.length, 0, 'configured paths remain literal after a folder rename'); index.dispose();

  // Settings UI, lazy activation, failed saves, reload, and whole-vault safety scan.
  const h = dom(); const Plugin = load('main.ts', h.obsidian).default; const plugin = new Plugin();
  let disk = '{}', tab, failSave = false, saves = 0, pluginListings = 0; const pluginReads = [];
  const notes = [{ path: 'Accounts/a.md', text: wrap(cipher) }, { path: 'Other/b.md', text: wrap(cipher) }];
  plugin.addSettingTab = setting => { tab = setting; };
  plugin.saveData = async value => { if (failSave) throw Error('disk failed'); disk = JSON.stringify(value); saves++; };
  plugin.app = { vault: { ...vaultEvents(), adapter: { exists: async () => true, read: async () => disk }, getMarkdownFiles: () => { pluginListings++; return notes; },
    getAllLoadedFiles: () => [{ path: '/', children: [] }, { path: 'Accounts', children: [] }, { path: 'Accounts/sub', children: [] }, { path: 'Accounts/sub/third', children: [] }, { path: 'Other', children: [] }, { path: 'Empty', children: [] }, { path: 'root.md' }, { path: 'Accounts/note.md' }],
    getFileByPath: path => notes.find(note => note.path === path), read: async file => { pluginReads.push(file.path); return file.text; } },
    workspace: { on: () => ({}), detachLeavesOfType() {} },
    secretStorage: { listSecrets: () => [], getSecret: () => { throw Error('No master needed'); }, setSecret: () => { throw Error('No master needed'); } } };
  await plugin.onload(); tab.display();
  const timeout = tab.containerEl.querySelector('input[aria-label="Automatically hide plaintext"]');
  assert.equal(timeout.type, 'text'); assert.equal(timeout.value, '30');
  timeout.value = '45'; timeout.dispatchEvent(new h.window.Event('change'));
  await until(() => !timeout.disabled); assert.equal(JSON.parse(disk).autoHideSeconds, 45);
  for (const invalid of ['', '0', '301', '12.5', 'abc']) {
    const previousSaves = saves;
    timeout.value = invalid; timeout.dispatchEvent(new h.window.Event('change'));
    await until(() => !timeout.disabled);
    assert.equal(timeout.value, '45'); assert.equal(saves, previousSaves);
  }
  const input = tab.containerEl.querySelector('textarea'); assert.ok(input); assert.equal(input.value, '');
  assert.ok(!tab.containerEl.textContent.includes('Add scan folder'));
  const dropdown = tab.containerEl.querySelector('[role="listbox"]');
  const type = (value, caret = value.length) => {
    input.value = value; input.setSelectionRange(caret, caret); input.dispatchEvent(new h.window.Event('input'));
  };
  const key = value => input.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
  type('a'); assert.equal(dropdown.hidden, false);
  assert.deepEqual([...dropdown.children].map(option => option.textContent), ['Accounts', 'Accounts/sub', 'Accounts/sub/third']);
  dropdown.firstChild.click(); assert.equal(input.value, 'Accounts'); assert.equal(dropdown.hidden, true);
  type('Accounts\nacc'); assert.deepEqual([...dropdown.children].map(option => option.textContent), ['Accounts/sub', 'Accounts/sub/third'], 'exclude the selected parent but still offer subfolders');
  type('root'); assert.equal(dropdown.hidden, true, 'do not suggest root files');
  type('note'); assert.equal(dropdown.hidden, true, 'do not suggest nested files');
  type('third'); key('Enter'); assert.equal(input.value, 'Accounts/sub/third', 'complete a deeply nested folder by name');
  type('Accounts/sub/'); assert.deepEqual([...dropdown.children].map(option => option.textContent), ['Accounts/sub', 'Accounts/sub/third']);
  type('e'); assert.deepEqual([...dropdown.children].map(option => option.textContent), ['Empty', 'Other']);
  key('ArrowDown'); key('Enter'); assert.equal(input.value, 'Other');
  type('em'); key('Escape'); assert.equal(dropdown.hidden, true); assert.equal(input.value, 'em');
  type('em'); input.dispatchEvent(new h.window.Event('blur')); assert.equal(dropdown.hidden, true);
  type('ACC\nAccounts/sub', 3); key('Enter');
  assert.equal(input.value, 'Accounts\nAccounts/sub', 'complete only the current line, preserving nested paths');
  type('Accounts\nAccounts/s'); key('Enter');
  assert.equal(input.value, 'Accounts\nAccounts/sub', 'complete a nested path before saving');
  assert.deepEqual(plugin.settings.scanFolders, [], 'completing stages the folder until Save');
  [...tab.containerEl.querySelectorAll('button')].find(b => b.textContent === 'Save scan folders').click();
  await until(() => !plugin.isBusy); assert.deepEqual(plugin.settings.scanFolders, ['Accounts', 'Accounts/sub']);
  assert.equal(pluginReads.length, 0, 'saving scope must not activate the index');
  assert.deepEqual(JSON.parse(disk).scanFolders, ['Accounts', 'Accounts/sub']);
  plugin.activateBlockIndex(); await idle(plugin.blockIndex); assert.deepEqual(pluginReads, ['Accounts/a.md']);
  const beforeFileEvents = pluginListings;
  for (let i = 0; i < 100; i++) plugin.app.vault.emit('modify', notes[0]);
  await idle(plugin.blockIndex); assert.deepEqual(pluginReads, ['Accounts/a.md', 'Accounts/a.md']);
  for (const event of ['create', 'modify', 'delete']) plugin.app.vault.emit(event, { path: 'Accounts/image.png' });
  await idle(plugin.blockIndex); assert.equal(pluginReads.length, 2, 'attachment events must not read notes');
  for (const nextPath of ['Outside/a.md', 'Accounts/a.md', 'Accounts/a.txt', 'Accounts/a.md']) {
    const oldPath = notes[0].path; notes[0].path = nextPath;
    plugin.app.vault.emit('rename', notes[0], oldPath); await idle(plugin.blockIndex);
    assert.equal(plugin.blockIndex.snapshot().notes.length, nextPath === 'Accounts/a.md' ? 1 : 0);
  }
  const created = { path: 'Accounts/new.md', text: wrap(cipher) }; notes.push(created);
  plugin.app.vault.emit('create', created); await idle(plugin.blockIndex); assert.equal(plugin.blockIndex.snapshot().notes.length, 2);
  notes.pop(); plugin.app.vault.emit('delete', created); assert.equal(plugin.blockIndex.snapshot().notes.length, 1);
  assert.equal(pluginListings, beforeFileEvents, 'all single-file vault events must avoid full-vault enumeration');
  const { PasswordBlocksPanel } = load('panel.ts', h.obsidian); const root = h.document.createElement('div');
  const panel = new PasswordBlocksPanel(root, plugin.blockIndex, async () => {}, () => {});
  assert.match(root.textContent, /Scan scope \(including subfolders\): Accounts, Accounts\/sub/);
  const scanned = await plugin.scan({ update: () => {} }, plugin.operationEpoch);
  assert.deepEqual(scanned.map(note => note.path), ['Accounts/a.md', 'Other/b.md'], 'master-password safety scan must remain whole-vault');
  await plugin.setScanFolders(['Other']); await idle(plugin.blockIndex); assert.deepEqual(plugin.blockIndex.snapshot().notes.map(n => n.path), ['Other/b.md']);
  const previous = saves; await assert.rejects(() => plugin.setScanFolders(['/absolute'])); assert.equal(saves, previous);
  // A legitimate external scope update is only adopted on explicit reload.
  disk = JSON.stringify({ ...JSON.parse(disk), scanFolders: ['Accounts'] }); await plugin.onExternalSettingsChange();
  assert.deepEqual(plugin.settings.scanFolders, ['Other']);
  const reload = plugin.reloadConfiguration(); await until(() => h.openModals.length);
  [...h.openModals[0].contentEl.querySelectorAll('button')].find(b => b.textContent === 'Reload configuration').click(); await reload;
  await idle(plugin.blockIndex); assert.deepEqual(plugin.blockIndex.snapshot().notes.map(n => n.path), ['Accounts/a.md']);
  failSave = true; await assert.rejects(() => plugin.setScanFolders(['Other']));
  assert.deepEqual(plugin.settings.scanFolders, ['Accounts']); assert.deepEqual(JSON.parse(disk).scanFolders, ['Accounts']);
  assert.equal(plugin.configurationState, 'recovery'); await assert.rejects(() => plugin.setScanFolders([]));
  panel.dispose(); plugin.onunload(); h.instance.window.close();
  console.log('multi-folder scope normalization, indexing races, settings, reload, and migration safety tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
