const assert = require('node:assert/strict');
const { load } = require('./helpers');
const { DEFAULT_BLOCK_TITLE, normalizeBlockTitle, formatBlockTitle, replaceBlockTitle } = load('block-title.ts');
const { scanPasswordBlocks, findPasswordBlocks, replacePayloads } = load('rotation.ts');

const payload = 'EPB2.32.example';
const wrap = info => `\`\`\`${info}\n${payload}\n\`\`\`\n`;

assert.equal(DEFAULT_BLOCK_TITLE, 'Encrypted password');
assert.equal(normalizeBlockTitle(''), DEFAULT_BLOCK_TITLE);
assert.equal(normalizeBlockTitle('   '), DEFAULT_BLOCK_TITLE);
assert.equal(normalizeBlockTitle('  Personal account  '), 'Personal account');
assert.equal(normalizeBlockTitle('  邮箱 🔐  '), '邮箱 🔐');
assert.equal(formatBlockTitle('  Account  '), ' Account');
for (const title of ['one\ntwo', 'one\rtwo', '\nAccount', 'Account\n', 'a\tb', 'a\0b', 'a\u007fb', 'a\u0085b', 'a\u2028b', 'a\u2029b', 'a`b', '```password']) {
  assert.throws(() => normalizeBlockTitle(title), /single line|backticks/);
  assert.throws(() => formatBlockTitle(title), /single line|backticks/);
}

for (const [info, expected, suffix] of [
  ['password', DEFAULT_BLOCK_TITLE, ''],
  ['password   ', DEFAULT_BLOCK_TITLE, '   '],
  ['password Work account', 'Work account', ' Work account'],
  ['password\t 邮箱 🔐  ', '邮箱 🔐', '\t 邮箱 🔐  '],
  ['  password  password account  ', 'password account', '  password account  '],
]) {
  const text = wrap(info);
  const { blocks, diagnostics } = scanPasswordBlocks(text);
  assert.deepEqual(diagnostics, []);
  assert.equal(blocks.length, 1);
  const block = blocks[0];
  assert.equal(block.title, expected);
  assert.equal(block.source, payload);
  assert.equal(text.slice(block.titleFragment.start, block.titleFragment.end), suffix);
  const renamed = replaceBlockTitle(text, block, '  Updated title  ');
  assert.equal(renamed, text.slice(0, block.titleFragment.start) + ' Updated title' + text.slice(block.titleFragment.end));
  assert.equal(findPasswordBlocks(renamed)[0].title, 'Updated title');
  assert.equal(findPasswordBlocks(renamed)[0].source, payload);
  assert.equal(findPasswordBlocks(replaceBlockTitle(text, block, ' '))[0].title, DEFAULT_BLOCK_TITLE);
}
assert.equal(scanPasswordBlocks(wrap('password-extra Work')).blocks.length, 0);

const containers = [
  ['~~~password Work\r\n' + payload + '\r\n~~~\r\n', ' Work'],
  ['> [!note]\n> ```password Work\n> ' + payload + '\n> ```\n', ' Work'],
  ['- Item\n  ```password Work\n  ' + payload + '\n  ```\n', ' Work'],
  ['1. Item\r\n   > ~~~~ password\tWork  \r\n   > ' + payload + '\r\n   > ~~~~\r\n', '\tWork  '],
  ['> - ```password Work\n>   ' + payload + '\n>   ```\n', ' Work'],
  ['- > ```password Work\n  > ' + payload + '\n  > ```\n', ' Work'],
];
for (const [text, suffix] of containers) {
  const blocks = findPasswordBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].title, 'Work');
  assert.equal(text.slice(blocks[0].titleFragment.start, blocks[0].titleFragment.end), suffix);
  const renamed = replaceBlockTitle(text, blocks[0], '工作账号 🔐');
  assert.equal(renamed, text.replace(suffix, ' 工作账号 🔐'));
  const renamedBlocks = findPasswordBlocks(renamed);
  assert.equal(renamedBlocks[0].title, '工作账号 🔐');
  assert.equal(renamedBlocks[0].source, payload);
  assert.equal(replacePayloads(renamed, renamedBlocks, ['EPB2.32.replaced']), renamed.replace(payload, 'EPB2.32.replaced'));
  assert.equal(replacePayloads(text, blocks, ['EPB2.32.replaced']), text.replace(payload, 'EPB2.32.replaced'));
}

const duplicates = wrap('password First account') + '\n' + wrap('password Second account');
const blocks = findPasswordBlocks(duplicates);
assert.deepEqual(blocks.map(block => block.title), ['First account', 'Second account']);
assert.equal(blocks[0].source, blocks[1].source);
assert.equal(replaceBlockTitle(duplicates, blocks[1], 'Renamed second'), duplicates.replace('Second account', 'Renamed second'));
assert.throws(() => replaceBlockTitle(duplicates, blocks[0], 'new\n```\nInjected'), /single line/);
assert.throws(() => replaceBlockTitle(duplicates, { titleFragment: { start: 0, end: duplicates.length } }, 'Bad range'), /safely locate/);

// Previously supported tilde fence metadata must not prevent payload migration.
const existing = '~~~password Account `code`\n' + payload + '\n~~~\n';
assert.equal(replacePayloads(existing, findPasswordBlocks(existing), ['replacement']), existing.replace(payload, 'replacement'));

console.log('block title parsing, safe renaming, and migration preservation tests passed');
