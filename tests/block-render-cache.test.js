const assert = require('node:assert/strict');
const { load, dom } = require('./helpers');
const { scanPasswordBlocks } = load('rotation.ts');
const { BlockRenderCache } = load('block-render-cache.ts');
const fence = (source, title) => `\`\`\`password ${title}\n${source}\n\`\`\`\n`;
let scans = 0;
const scan = (text, path) => { scans++; return scanPasswordBlocks(text, path); };
const cache = new BlockRenderCache(scan);
const note = Array.from({ length: 600 }, (_, i) => fence(`payload-${i}`, `Account ${i}`)).join('');
for (let i = 0; i < 600; i++) {
  assert.equal(cache.find('accounts.md', note, `payload-${i}`, i * 3, i * 3 + 2).title, `Account ${i}`);
}
assert.equal(scans, 1, 'all block titles in an unchanged note share one Markdown parse');
const changed = note.replace('Account 123', 'Updated title');
assert.equal(cache.find('accounts.md', changed, 'payload-123', 369, 371).title, 'Updated title');
assert.equal(scans, 2, 'changed note content invalidates cached metadata');
assert.equal(cache.find('accounts.md', note, 'payload-123', 369, 371).title, 'Account 123');
assert.equal(scans, 3, 'another view with older content cannot reuse the new snapshot');

const duplicates = fence('same', 'First') + fence('same', 'Second');
assert.equal(cache.find('duplicates.md', duplicates, 'same', 3, 5).title, 'Second');
assert.equal(cache.find('duplicates.md', duplicates, 'same', 0, 5), undefined, 'ambiguous sections never pick a duplicate');
assert.equal(cache.find('duplicates.md', duplicates, 'different', 0, 5), undefined);
cache.clear();
const beforeClear = scans;
cache.find('accounts.md', note, 'payload-0', 0, 2);
assert.equal(scans, beforeClear + 1);

const bounded = new BlockRenderCache(scan, 2, 100);
const small = fence('payload', 'Title');
bounded.find('a.md', small, 'payload', 0, 2);
bounded.find('b.md', small, 'payload', 0, 2);
bounded.find('a.md', small, 'payload', 0, 2);
bounded.find('c.md', small, 'payload', 0, 2);
const beforeEviction = scans;
bounded.find('b.md', small, 'payload', 0, 2);
assert.equal(scans, beforeEviction + 1, 'least-recently-used notes are evicted');
const large = 'x'.repeat(101) + '\n' + small;
bounded.find('large.md', large, 'payload', 1, 3);
const beforeLarge = scans;
bounded.find('large.md', large, 'payload', 1, 3);
assert.equal(scans, beforeLarge + 1, 'oversized notes are not retained');

// Verify the plugin shares the cache across different renderer context objects,
// bypasses it for edits, and releases snapshots when locking.
const h = dom();
const Plugin = load('main.ts', h.obsidian).default;
const plugin = new Plugin();
const el = h.document.createElement('div');
let requests = 0;
plugin.blockRenderCache = new BlockRenderCache((text, path) => { requests++; return scanPasswordBlocks(text, path); });
for (let i = 0; i < 600; i++) {
  const ctx = { sourcePath: 'accounts.md', getSectionInfo: () => ({ text: note, lineStart: i * 3, lineEnd: i * 3 + 2 }) };
  assert.equal(plugin.blockSection(`payload-${i}`, el, ctx).block.title, `Account ${i}`);
}
assert.equal(requests, 1);
plugin.blockRenderCache.find = () => { throw Error('Mutation must not use rendering cache'); };
const ctx = { sourcePath: 'accounts.md', getSectionInfo: () => ({ text: changed, lineStart: 369, lineEnd: 371 }) };
assert.equal(plugin.blockSection('payload-123', el, ctx, true).block.title, 'Updated title');
plugin.lock();
assert.equal(plugin.blockRenderCache.notes.size, 0);
h.instance.window.close();
console.log('bounded title rendering cache and fresh mutation lookup tests passed');
