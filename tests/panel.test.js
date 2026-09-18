const assert = require('node:assert/strict');
const { dom, load, until, tick } = require('./helpers');
const { encryptSecret, rsEncode } = require('../codec.ts');
const { PasswordBlockIndex } = load('block-index.ts');
const wrap = value => `\`\`\`password\n${value}\n\`\`\`\n`;

(async () => {
  const cipher = await encryptSecret('synthetic-private-value', 'synthetic-master', 32, 'long-test-key-id', 100000);
  const raw = new Uint8Array(52); raw.set([0x45, 0x50, 0x42, 1, 32, 0, 16]);
  const legacy = `EPB1.32.${Buffer.from(rsEncode(raw, 32)).toString('base64url')}`;
  const h = dom(); const { PasswordBlocksPanel } = load('panel.ts', h.obsidian);
  const root = h.document.createElement('div'); h.document.body.append(root);
  const notes = new Map([['folder/a.md', wrap(cipher) + wrap(cipher)], ['legacy.md', wrap(legacy)], ['broken.md', wrap('bad')], ['unreadable.md', null]]);
  const settings = { storageMode: 'secret-storage', keys: { 'long-test-key-id': { secretId: 'secret-id' } }, legacyKeyId: '' };
  let names = ['secret-id'], nameReads = 0;
  const index = new PasswordBlockIndex({ paths: () => [...notes.keys()],
    read: async path => { const text = notes.get(path); if (text == null) throw Error('read failed'); return text; },
    settings: () => settings, secretNames: () => { nameReads++; return names; } }, 10);
  const jumps = [], notices = [];
  const panel = new PasswordBlocksPanel(root, index, async block => { jumps.push(await index.resolveJump(block)); }, text => notices.push(text));
  assert.match(root.textContent, /Waiting for initial scan/);
  index.activate(); panel.render(); assert.match(root.textContent, /Scanning/);
  await until(() => !index.snapshot().busy); panel.render();
  assert.match(root.textContent, /4 blocks · 4 notes · 2 issues/);
  assert.equal(root.querySelectorAll('.epb-catalog-note').length, 4);
  assert.equal(root.querySelectorAll('.epb-catalog-block').length, 4);
  assert.match(root.textContent, /Not decrypted/); assert.match(root.textContent, /Secret available/);
  assert.match(root.textContent, /Password required/); assert.match(root.textContent, /Cannot read or scan/);
  assert.match(root.querySelector('summary').textContent, /long-test-ke…/);
  assert.equal(root.querySelector('details code').textContent, 'long-test-key-id');
  for (const value of [cipher, 'synthetic-private-value', 'synthetic-master', 'secret-id']) assert.ok(!root.innerHTML.includes(value));
  const buttons = [...root.querySelectorAll('.epb-catalog-block button')];
  buttons.find(b => b.textContent === 'Line 4 · EPB2').click(); await until(() => jumps.length === 1);
  assert.deepEqual(jumps[0], { path: 'folder/a.md', line: 4 }); panel.render();
  const search = root.querySelector('input'); const filter = root.querySelector('select');
  const query = value => { search.value = value; search.dispatchEvent(new h.window.Event('input')); };
  const select = value => { filter.value = value; filter.dispatchEvent(new h.window.Event('change')); };
  query('FOLDER'); assert.equal(root.querySelectorAll('.epb-catalog-block').length, 2);
  query('LONG-TEST-KEY'); assert.equal(root.querySelectorAll('.epb-catalog-block').length, 2);
  query('<script>'); assert.match(root.textContent, /No matching/); assert.equal(root.querySelector('script'), null);
  query(''); select('Needs attention'); assert.equal(root.querySelectorAll('.epb-catalog-note').length, 2);
  select('EPB1'); assert.equal(root.querySelectorAll('.epb-catalog-block').length, 1);
  select('EPB2'); assert.equal(root.querySelectorAll('.epb-catalog-block').length, 2);
  names = []; root.dispatchEvent(new h.window.FocusEvent('focusin')); panel.render(); assert.match(root.textContent, /Missing secret/);
  settings.storageMode = 'session'; index.refreshStatuses(); panel.render(); assert.match(root.textContent, /Session mode/);
  select('Needs attention'); assert.equal(root.querySelectorAll('.epb-catalog-note').length, 2, 'session mode is not a missing-secret issue');
  settings.storageMode = 'secret-storage'; settings.keys = {}; index.refreshStatuses(); select('All'); assert.match(root.textContent, /Missing reference/);
  // Failed jump reports a safe warning, and the refreshed list removes the old rows.
  notes.set('folder/a.md', 'removed');
  [...root.querySelectorAll('.epb-catalog-block button')].find(b => b.textContent.endsWith('EPB2')).click();
  await until(() => notices.length === 1); await until(() => !index.snapshot().busy); panel.render();
  assert.match(notices[0], /refreshed/);
  notes.clear(); [...root.querySelectorAll('button')].find(b => b.textContent === 'Refresh').click();
  await until(() => !index.snapshot().busy); panel.render(); assert.match(root.textContent, /No password blocks found/);
  // Large catalogs render in bounded batches.
  notes.set('many.md', wrap(cipher).repeat(105)); index.refresh(); await until(() => !index.snapshot().busy); panel.render();
  assert.equal(root.querySelectorAll('.epb-catalog-block').length, 100);
  [...root.querySelectorAll('button')].find(b => b.textContent.startsWith('Load more')).click();
  assert.equal(root.querySelectorAll('.epb-catalog-block').length, 105);
  panel.dispose(); const before = nameReads; root.dispatchEvent(new h.window.FocusEvent('focusin')); h.window.dispatchEvent(new h.window.Event('focus'));
  assert.equal(nameReads, before); assert.equal(root.childElementCount, 0);
  index.dispose(); h.instance.window.close();

  // Real plugin wiring: lazy activation, command/view reuse, events, settings, navigation, unload.
  const appDom = dom(); const Plugin = load('main.ts', appDom.obsidian).default;
  const plugin = new Plugin(); const viewFactories = new Map(), commands = new Map(), events = new Map();
  const registeredEvents = []; const leaves = []; const opened = []; let reads = 0, namesReads = 0, saved = 0;
  const files = [{ path: 'a.md', text: wrap(cipher) }];
  plugin.loadData = async () => ({ storageMode: 'secret-storage', keys: { 'long-test-key-id': { secretId: 's', createdAt: 1 } } });
  let disk = await plugin.loadData();
  plugin.saveData = async value => { saved++; disk = JSON.parse(JSON.stringify(value)); };
  plugin.registerView = (type, factory) => viewFactories.set(type, factory);
  plugin.addCommand = command => commands.set(command.id, command);
  plugin.registerEvent = ref => registeredEvents.push(ref);
  const on = (name, callback) => { events.set(name, callback); return name; };
  const makeLeaf = () => {
    const leaf = { view: null,
      async setViewState(state) { leaf.view = viewFactories.get(state.type)(leaf); await leaf.view.onOpen(); },
      async openFile(file, state) { opened.push({ path: file.path, state }); },
    }; leaves.push(leaf); return leaf;
  };
  const workspace = { on, getLeavesOfType: type => leaves.filter(leaf => leaf.view?.getViewType() === type), getRightLeaf: () => makeLeaf(),
    getLeaf: () => ({ openFile: async (file, state) => opened.push({ path: file.path, state }) }), revealLeaf: async () => {},
    detachLeavesOfType: type => { for (const leaf of workspace.getLeavesOfType(type)) { void leaf.view.onClose(); leaf.view = null; } } };
  plugin.app = { workspace, vault: { adapter: { exists: async () => true, read: async () => JSON.stringify(disk) }, on, getMarkdownFiles: () => files, getFileByPath: path => files.find(file => file.path === path), read: async file => { reads++; return file.text; } },
    secretStorage: { listSecrets: () => { namesReads++; return ['s']; }, getSecret: () => { throw Error('Panel read a secret'); }, setSecret: () => { throw Error('Panel wrote a secret'); } } };
  await plugin.onload(); assert.equal(reads, 0); assert.equal(namesReads, 0); assert.equal(registeredEvents.length, 0);
  commands.get('open-password-blocks').callback(); await plugin.openPasswordBlocks();
  await until(() => !plugin.blockIndex.snapshot().busy);
  assert.equal(leaves.length, 1); assert.equal(registeredEvents.length, 5);
  await plugin.openPasswordBlocks(); assert.equal(leaves.length, 1);
  const view = leaves[0].view; view.panel.render();
  view.contentEl.querySelector('.epb-catalog-block button').click(); await until(() => opened.length === 1);
  assert.equal(opened[0].state.eState.line, 0); assert.equal(opened[0].path, 'a.md'); assert.equal(saved, 0);
  const statusReads = namesReads; await plugin.saveSettings(); assert.ok(namesReads > statusReads);
  const focusReads = namesReads; events.get('active-leaf-change')(leaves[0]); assert.ok(namesReads > focusReads);
  // Closing the view must not stop the active memory index.
  await view.onClose(); files.push({ path: 'b.md', text: wrap(cipher) }); events.get('create')(files[1]);
  await until(() => !plugin.blockIndex.snapshot().busy); assert.equal(plugin.blockIndex.snapshot().notes.length, 2);
  files[1].text = 'no block'; events.get('modify')(files[1]); await until(() => !plugin.blockIndex.snapshot().busy);
  assert.equal(plugin.blockIndex.snapshot().notes.length, 1);
  files[0].path = 'renamed.md'; events.get('rename')(files[0], 'a.md'); await until(() => !plugin.blockIndex.snapshot().busy);
  assert.equal(plugin.blockIndex.snapshot().notes[0].path, 'renamed.md');
  const removed = files.shift(); events.get('delete')(removed); assert.equal(plugin.blockIndex.snapshot().notes.length, 0);
  plugin.onunload(); assert.equal(leaves[0].view, null); assert.equal(plugin.blockIndex.snapshot().notes.length, 0);
  appDom.instance.window.close(); await tick();
  console.log('Password Blocks DOM and plugin wiring tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
