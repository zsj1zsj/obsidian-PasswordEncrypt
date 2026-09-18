const assert = require('node:assert/strict');
const { dom, load, until, vaultEvents } = require('./helpers');
const { attachFolderAutocomplete } = load('folder-autocomplete.ts');
const { FolderDirectory } = load('folder-directory.ts');

(async () => {
  const h = dom();
  const input = h.document.createElement('textarea'); h.document.body.append(input);
  let paths = ['Work/Accounts', 'Work/Accounts/sub', '工作/账号'];
  const autocomplete = attachFolderAutocomplete(input, () => paths);
  const list = h.document.querySelector('[role="listbox"]');
  const type = (text, caret = text.length) => {
    input.value = text; input.setSelectionRange(caret, caret); input.dispatchEvent(new h.window.Event('input'));
  };
  const key = (value, extra = {}) => {
    const event = new h.window.KeyboardEvent('keydown', { key: value, cancelable: true, ...extra });
    input.dispatchEvent(event); return event.defaultPrevented;
  };
  type('Work/Accounts'); assert.equal(key('Enter'), false, 'complete paths must allow normal newline');
  assert.equal(list.hidden, true);
  type('Work/Accounts'); key('ArrowDown'); assert.equal(key('Enter'), true);
  assert.equal(input.value, 'Work/Accounts/sub', 'explicit selection overrides the exact match');
  type('Work\\Acc'); assert.equal(key('Enter'), true); assert.equal(input.value, 'Work/Accounts');
  type('work//acc'); key('Enter'); assert.equal(input.value, 'Work/Accounts');
  type('Work\\Accounts/\nwork//acc');
  assert.deepEqual([...list.children].map(el => el.textContent), ['Work/Accounts/sub'], 'normalize existing lines for duplicate exclusion');
  type('Missing\nwork\\acc\nOther', 16); key('Enter');
  assert.equal(input.value, 'Missing\nWork/Accounts\nOther');
  input.dispatchEvent(new h.window.CompositionEvent('compositionstart'));
  type('工'); assert.equal(list.hidden, true); assert.equal(key('Enter', { isComposing: true }), false);
  input.dispatchEvent(new h.window.CompositionEvent('compositionend'));
  assert.equal(list.hidden, false); key('Enter'); assert.equal(input.value, '工作/账号');
  paths = Array.from({ length: 1001 }, (_, i) => `Work/${String(i).padStart(4, '0')}`);
  type('Work'); assert.equal(list.children.length, 50);
  assert.match(h.document.querySelector('.epb-folder-suggestion-hint').textContent, /first 50/);
  type('Work/1000'); assert.equal(list.children.length, 1); assert.equal(key('Enter'), false);
  paths = null; type('Work'); assert.equal(list.hidden, true);
  autocomplete.dispose(); autocomplete.dispose();
  type('Work'); assert.equal(h.document.querySelector('[role="listbox"]'), null); assert.equal(key('Enter'), false);
  assert.equal(input.parentElement, h.document.body);
  h.instance.window.close();

  const events = vaultEvents(); let reads = 0, changes = 0, failListing = false;
  let files = [{ path: 'A', children: [] }, { path: 'A/B', children: [] }, { path: 'note.md' }, { path: '/', children: [] }];
  const directory = new FolderDirectory({ ...events, getAllLoadedFiles: () => { reads++; if (failListing) throw Error('offline'); return files; } }, () => { changes++; });
  assert.deepEqual(directory.paths(), ['A', 'A/B']);
  for (let i = 0; i < 20; i++) directory.paths(); assert.equal(reads, 1);
  events.emit('modify', { path: 'note.md' }); events.emit('create', { path: 'new.md' });
  directory.paths(); assert.equal(reads, 1); assert.equal(changes, 0);
  for (const name of ['create', 'delete', 'rename']) {
    events.emit(name, { path: 'A/B', children: [] }, 'Old'); directory.paths();
  }
  assert.equal(reads, 4); assert.equal(changes, 3);
  failListing = true; events.emit('create', { path: 'C', children: [] });
  assert.equal(directory.paths(), null); directory.paths(); assert.equal(reads, 5);
  failListing = false; events.emit('rename', { path: 'C', children: [] }, 'D'); assert.deepEqual(directory.paths(), ['A', 'A/B']);
  directory.dispose(); assert.equal(events.listenerCount(), 0);

  // Real settings wiring: drafts, cache lifecycle, diagnostics, save and reload failures.
  const ui = dom(); const Plugin = load('main.ts', ui.obsidian).default; const plugin = new Plugin();
  let tab, disk = '{}', saveFailure = false, listingFailure = false, releaseSave, listReads = 0;
  let folders = [{ path: 'Work', children: [] }, { path: 'Work/Accounts', children: [] }];
  const vault = { ...vaultEvents(), getAllLoadedFiles: () => { listReads++; if (listingFailure) throw Error('unavailable'); return folders; },
    getMarkdownFiles: () => [], adapter: { exists: async () => true, read: async () => disk } };
  plugin.app = { vault, secretStorage: { listSecrets: () => [], getSecret: () => null } };
  plugin.addSettingTab = value => { tab = value; };
  plugin.saveData = async value => {
    if (saveFailure) throw Error('disk failed');
    if (releaseSave === null) await new Promise(resolve => { releaseSave = resolve; });
    disk = JSON.stringify(value);
  };
  await plugin.onload(); tab.display(); ui.document.body.append(tab.containerEl);
  const field = () => tab.containerEl.querySelector('textarea');
  const feedback = () => tab.containerEl.querySelector('.epb-folder-feedback').textContent;
  const edit = value => { field().value = value; field().dispatchEvent(new ui.window.Event('input')); };
  const save = () => [...tab.containerEl.querySelectorAll('button')].find(b => b.textContent === 'Save scan folders').click();
  edit('Missing'); assert.match(feedback(), /Unsaved changes/); assert.match(feedback(), /Line 1: Folder not found: Missing/);
  edit('Mi'); edit('Missing'); assert.equal(listReads, 1, 'typing uses a cached directory list');
  tab.display(); assert.equal(field().value, 'Missing'); assert.equal(vault.listenerCount(), 3, 'redisplay must not accumulate listeners');
  const mode = tab.containerEl.querySelector('select'); mode.value = 'prompt'; mode.dispatchEvent(new ui.window.Event('change'));
  await until(() => plugin.settings.storageMode === 'prompt' && !plugin.isBusy);
  assert.equal(field().value, 'Missing', 'storage-mode changes preserve the draft');
  tab.hide(); assert.equal(vault.listenerCount(), 0); tab.display(); assert.equal(field().value, 'Missing');
  folders.push({ path: 'Missing', children: [] }); vault.emit('create', folders.at(-1));
  assert.ok(!feedback().includes('Folder not found'));
  folders = folders.filter(folder => folder.path !== 'Missing'); vault.emit('delete', { path: 'Missing', children: [] });
  assert.match(feedback(), /Folder not found/);
  edit('../bad'); assert.match(feedback(), /Line 1: Invalid/); const beforeInvalidSave = disk;
  save(); await until(() => !tab.savingFolders); assert.equal(disk, beforeInvalidSave); assert.equal(field().value, '../bad');
  edit('Missing'); releaseSave = null; save(); await until(() => typeof releaseSave === 'function');
  assert.equal(field().disabled, true); releaseSave(); await until(() => !tab.savingFolders);
  assert.deepEqual(JSON.parse(disk).scanFolders, ['Missing']); assert.ok(!feedback().includes('Unsaved changes'));
  assert.match(feedback(), /Folder not found/, 'missing paths are allowed to save');
  listingFailure = true; tab.hide(); tab.display();
  assert.match(feedback(), /Cannot check folders/); assert.ok(!feedback().includes('Folder not found'));
  edit('Work'); save(); await until(() => !tab.savingFolders); assert.deepEqual(JSON.parse(disk).scanFolders, ['Work']);
  listingFailure = false; tab.hide(); tab.display();
  edit('Unsaved'); saveFailure = true; save(); await until(() => !tab.savingFolders);
  assert.equal(plugin.configurationState, 'recovery'); assert.equal(tab.folderDraft, 'Unsaved', 'failed save keeps the draft in recovery mode');
  const reload = async () => {
    const operation = plugin.reloadConfiguration(); await until(() => ui.openModals.length);
    [...ui.openModals[0].contentEl.querySelectorAll('button')].find(b => b.textContent === 'Reload configuration').click();
    await operation;
  };
  const goodDisk = disk; disk = '{broken'; await reload(); assert.equal(tab.folderDraft, 'Unsaved');
  disk = goodDisk; saveFailure = false; await reload();
  assert.equal(plugin.configurationState, 'ready'); assert.equal(field().value, 'Work'); assert.equal(tab.folderDraft, undefined);
  edit('Discard on unload'); plugin.onunload(); assert.equal(vault.listenerCount(), 0); assert.equal(tab.folderDraft, undefined);
  ui.instance.window.close();
  console.log('folder completion, directory cache, settings drafts, warnings, and lifecycle tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
