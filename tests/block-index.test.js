const assert = require('node:assert/strict');
const { load, tick, until } = require('./helpers');
const { encryptSecret, rsEncode } = require('../codec.ts');
const { PasswordBlockIndex, inspectNote } = load('block-index.ts');
const { scanPasswordBlocks, findPasswordBlocks } = load('rotation.ts');
const wrap = value => `\`\`\`password\n${value}\n\`\`\`\n`;
const idle = index => until(() => !index.snapshot().busy, 'index idle');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function fixture(notes, debounce = 20) {
  let reads = 0, namesRead = 0, listings = 0;
  const settings = { storageMode: 'secret-storage', keys: { 'test-key': { secretId: 'stored-id' } }, legacyKeyId: '' };
  const host = { paths: () => { listings++; return [...notes.keys()].filter(path => /\.md$/i.test(path)); }, hasFile: path => notes.has(path), read: async path => { reads++; if (!notes.has(path)) throw Error('private error'); return notes.get(path); },
    settings: () => settings, secretNames: () => { namesRead++; return ['stored-id']; },
    getSecret: () => { throw Error('must not read secrets'); }, decrypt: () => { throw Error('must not decrypt'); } };
  const index = new PasswordBlockIndex(host, debounce);
  return { index, host, settings, reads: () => reads, namesRead: () => namesRead, listings: () => listings };
}

(async () => {
  const cipher = await encryptSecret('NEVER-INDEX-PLAINTEXT', 'NEVER-INDEX-MASTER', 32, 'test-key', 100000);
  // Structurally valid legacy envelope; catalog checks must not try authenticating its fake tag.
  const raw = new Uint8Array(7 + 16 + 12 + 17); raw.set([0x45, 0x50, 0x42, 1, 32, 0, 16]);
  const legacy = `EPB1.32.${Buffer.from(rsEncode(raw, 32)).toString('base64url')}`;
  const derive = crypto.subtle.deriveKey; const decrypt = crypto.subtle.decrypt;
  crypto.subtle.deriveKey = crypto.subtle.decrypt = () => { throw Error('Catalog must not perform password operations'); };
  try {
    const mixed = wrap(cipher) + '\n```password\n```\n\n' + wrap('EPB2.bad') + '\n' + wrap(cipher);
    const scan = scanPasswordBlocks(mixed, 'mixed.md');
    assert.equal(scan.blocks.length, 3); assert.equal(scan.diagnostics.length, 1);
    assert.throws(() => findPasswordBlocks(mixed, 'mixed.md'), /mixed.md:5/);
    const parsed = await inspectNote('mixed.md', mixed);
    assert.deepEqual(parsed.blocks.map(b => b.ordinal), [0, 1, 2, 3]);
    assert.equal(parsed.blocks.filter(b => b.diagnostic).length, 2);
    assert.equal((await inspectNote('legacy.md', wrap(legacy))).blocks[0].version, 1);
    assert.equal(parsed.blocks[0].title, 'Encrypted password');
    assert.equal(parsed.blocks[1].title, undefined, 'parser diagnostics need not have a title');
    assert.equal((await inspectNote('titled.md', wrap(cipher).replace('```password', '```password Work account'))).blocks[0].title, 'Work account');
    const examples = '---\nexample: |\n  ```password\n  ignored\n  ```\n---\n\n<!--\n```password\nignored\n```\n-->\n\n````md\n```password\nignored\n```\n````\n';
    const nested = `- Item\n  > [!note]\n  > \`\`\`password\n  > ${cipher}\n  > \`\`\`\n`;
    assert.equal((await inspectNote('containers.md', examples + nested)).blocks.length, 1);

    const notes = new Map([['mixed.md', mixed], ['legacy.md', wrap(legacy)], ['empty.md', 'PRIVATE-NOTE-TEXT']]);
    let f = fixture(notes); const index = f.index;
    index.changed('mixed.md'); index.changedFile('mixed.md'); index.removeFile('mixed.md'); index.refreshStatuses(); index.refresh();
    assert.equal(f.reads(), 0); assert.equal(f.namesRead(), 0); assert.equal(f.listings(), 0); assert.equal(index.snapshot().active, false);
    index.activate(); await idle(index);
    assert.equal(f.reads(), 3); assert.equal(index.snapshot().notes.length, 2);
    const indexed = JSON.stringify(index.snapshot());
    for (const privateValue of [cipher, 'PRIVATE-NOTE-TEXT', 'NEVER-INDEX-PLAINTEXT', 'NEVER-INDEX-MASTER', 'stored-id']) assert.ok(!indexed.includes(privateValue));
    let block = index.snapshot().notes.find(n => n.path === 'mixed.md').blocks[0];
    assert.equal(index.status(block).label, 'Secret available');
    f.host.secretNames = () => []; index.refreshStatuses(); assert.equal(index.status(block).label, 'Missing secret');
    f.settings.keys = {}; index.refreshStatuses(); assert.equal(index.status(block).label, 'Missing reference');
    f.settings.storageMode = 'session'; index.refreshStatuses(); assert.deepEqual(index.status(block), { label: 'Session mode', attention: false, keyId: 'test-key' });
    f.settings.storageMode = 'prompt'; index.refreshStatuses(); assert.equal(index.status(block).label, 'Password required');
    const legacyBlock = index.snapshot().notes.find(n => n.path === 'legacy.md').blocks[0];
    f.settings.storageMode = 'secret-storage'; index.refreshStatuses(); assert.equal(index.status(legacyBlock).label, 'Password required');
    f.settings.legacyKeyId = 'legacy-key'; assert.equal(index.status(legacyBlock).label, 'Missing reference');
    f.settings.keys['legacy-key'] = { secretId: 'legacy-secret' };
    f.host.secretNames = () => ['legacy-secret']; index.refreshStatuses(); assert.equal(index.status(legacyBlock).label, 'Secret available');
    f.host.secretNames = () => { throw Error('must not leak exception'); }; index.refreshStatuses(); assert.equal(index.status(legacyBlock).label, 'Secret availability unknown');
    // File events must not enumerate the vault, even before their debounce fires.
    const previous = f.reads(), initialListings = f.listings();
    const originalPaths = f.host.paths;
    f.host.paths = () => { throw Error('File events must not list vault paths'); };
    for (let i = 0; i < 100; i++) { notes.set('mixed.md', wrap(cipher)); index.changedFile('mixed.md'); }
    await idle(index); assert.equal(f.reads(), previous + 1); assert.equal(f.listings(), initialListings);
    assert.equal(index.snapshot().error, undefined);
    notes.set('attachment.txt', wrap(cipher)); notes.set('picture.png', wrap(cipher));
    index.changedFile('attachment.txt', undefined, false); index.changedFile('picture.png'); await idle(index);
    assert.equal(f.reads(), previous + 1, 'attachments are never read by file events');
    // Unique payload relocates; duplicates are distinct and require a stable note.
    block = index.snapshot().notes.find(n => n.path === 'mixed.md').blocks[0];
    notes.set('mixed.md', '\n\n' + wrap(cipher));
    assert.deepEqual(await index.resolveJump(block), { path: 'mixed.md', line: 3 });
    notes.set('mixed.md', wrap(cipher) + '\n' + wrap(cipher)); index.changedFile('mixed.md', undefined, false); await idle(index);
    let duplicates = index.snapshot().notes.find(n => n.path === 'mixed.md').blocks;
    assert.equal(duplicates.length, 2); assert.notEqual(duplicates[0].ordinal, duplicates[1].ordinal);
    assert.equal((await index.resolveJump(duplicates[0])).line, 1);
    duplicates = index.snapshot().notes.find(n => n.path === 'mixed.md').blocks;
    assert.equal((await index.resolveJump(duplicates[1])).line, 5);
    duplicates = index.snapshot().notes.find(n => n.path === 'mixed.md').blocks;
    notes.set('mixed.md', '\n' + notes.get('mixed.md'));
    await assert.rejects(() => index.resolveJump(duplicates[0]), /ambiguous/); await idle(index);
    block = index.snapshot().notes.find(n => n.path === 'mixed.md').blocks[0];
    notes.delete('mixed.md'); await assert.rejects(() => index.resolveJump(block)); await idle(index);
    assert.ok(!index.snapshot().notes.some(n => n.path === 'mixed.md'));
    assert.equal(f.listings(), initialListings, 'jump recovery must not list vault paths');
    assert.equal(index.snapshot().error, undefined); f.host.paths = originalPaths;
    index.dispose(); assert.equal(index.snapshot().notes.length, 0);

    // Full refresh and event queues share a two-read limit; stale completions cannot win.
    const raceNotes = new Map([['a.md', wrap(cipher)], ['folder/b.md', wrap(cipher)], ['c.md', wrap(cipher)]]);
    f = fixture(raceNotes); const waits = []; let running = 0, maxRunning = 0;
    f.host.read = path => { const gate = deferred(); running++; maxRunning = Math.max(maxRunning, running); waits.push({ path, gate }); return gate.promise.finally(() => { running--; }); };
    f.index.activate(); assert.equal(waits.length, 2);
    raceNotes.set('a.md', 'changed to no blocks'); f.index.changedFile('a.md', undefined, false);
    raceNotes.set('renamed/b.md', raceNotes.get('folder/b.md')); raceNotes.delete('folder/b.md'); f.index.changed('renamed', 'folder', false);
    raceNotes.delete('c.md'); f.index.removeFile('c.md');
    waits[0].gate.resolve(wrap(cipher)); waits[1].gate.resolve(wrap(cipher));
    await until(() => waits.length === 4);
    assert.deepEqual(waits.slice(2).map(w => w.path).sort(), ['a.md', 'renamed/b.md']);
    waits[2].gate.resolve(raceNotes.get(waits[2].path)); waits[3].gate.resolve(raceNotes.get(waits[3].path)); await idle(f.index);
    assert.equal(maxRunning, 2); assert.deepEqual(f.index.snapshot().notes.map(n => n.path), ['renamed/b.md']);
    // A delete + same-path create gets a fresh ticket, even with an old read in flight.
    f.index.refresh(); const base = waits.length;
    raceNotes.delete('renamed/b.md'); f.index.remove('renamed');
    raceNotes.set('renamed/b.md', 'new empty note'); f.index.changedFile('renamed/b.md', undefined, false);
    for (const wait of waits.slice(4, base)) wait.gate.resolve(wrap(cipher));
    await until(() => waits.length > base); waits[base].gate.resolve('new empty note'); await idle(f.index);
    assert.ok(!f.index.snapshot().notes.some(n => n.path === 'renamed/b.md'));
    // Renaming an in-flight Markdown note to an attachment cancels its stale result.
    raceNotes.set('pending.md', wrap(cipher)); f.index.changedFile('pending.md', undefined, false);
    const pending = waits.at(-1);
    raceNotes.set('pending.txt', raceNotes.get('pending.md')); raceNotes.delete('pending.md');
    f.index.changedFile('pending.txt', 'pending.md', false); pending.gate.resolve(wrap(cipher)); await idle(f.index);
    assert.ok(!f.index.snapshot().notes.some(n => n.path === 'pending.md' || n.path === 'pending.txt'));
    f.index.dispose();

    // Folder deletion, extension transitions, read failures, full-refresh recovery, unload.
    const transitions = new Map([['x/a.md', wrap(cipher)], ['x/sub/b.md', wrap(cipher)]]);
    f = fixture(transitions); f.index.activate(); await idle(f.index);
    const transitionListings = f.listings();
    transitions.set('x/a.txt', transitions.get('x/a.md')); transitions.delete('x/a.md'); f.index.changedFile('x/a.txt', 'x/a.md', false); await idle(f.index);
    assert.equal(f.index.snapshot().notes.length, 1);
    transitions.set('x/a.md', wrap(cipher)); transitions.delete('x/a.txt'); f.index.changedFile('x/a.md', 'x/a.txt', false); await idle(f.index);
    assert.equal(f.index.snapshot().notes.length, 2);
    assert.equal(f.listings(), transitionListings, 'extension transitions must not enumerate paths');
    transitions.clear(); f.index.remove('x'); assert.equal(f.index.snapshot().notes.length, 0);
    transitions.set('error.md', wrap(cipher)); const read = f.host.read;
    f.host.read = async () => { throw Error('SECRET EXCEPTION'); }; f.index.changedFile('error.md', undefined, false); await idle(f.index);
    assert.ok(f.index.snapshot().notes[0].diagnostic); assert.ok(!JSON.stringify(f.index.snapshot()).includes('SECRET EXCEPTION'));
    f.host.read = read; f.index.refresh(); await idle(f.index); assert.equal(f.index.snapshot().notes[0].blocks.length, 1);
    const paths = f.host.paths; f.host.paths = () => { throw Error('private'); }; f.index.refresh(); assert.ok(f.index.snapshot().error);
    f.host.paths = paths; f.index.refresh(); await idle(f.index); assert.equal(f.index.snapshot().error, undefined);
    const gate = deferred(); f.host.read = () => gate.promise; f.index.refresh(); f.index.changedFile('error.md');
    f.index.dispose(); gate.resolve(wrap(cipher)); await tick(); await tick(); assert.equal(f.index.snapshot().notes.length, 0);
  } finally { crypto.subtle.deriveKey = derive; crypto.subtle.decrypt = decrypt; }
  console.log('catalog parsing, privacy, statuses, navigation, debounce, and race tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
