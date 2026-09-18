const assert = require('node:assert/strict');
const { load } = require('./helpers');
const { findPasswordBlocks, hashText, replacePayloads, writeMigration, validateTask } = load('rotation.ts');
const { encryptSecret } = require('../codec.ts');

(async () => {
  const payload = 'EPB2.32.example';
  const samples = [
    `# Title\r\n\r\n~~~password\r\n${payload}\r\n~~~\r\nEnd`,
    `> [!note]\n> \`\`\`password\n> ${payload}\n> \`\`\`\n`,
    `- Item\n  \`\`\`password\n  ${payload}\n  \`\`\`\n`,
    `1. Item\n   > \`\`\`password\n   > ${payload}\n   > \`\`\`\n`,
  ];
  for (const text of samples) {
    const blocks = findPasswordBlocks(text); assert.equal(blocks.length, 1);
    assert.equal(blocks[0].source, payload);
    assert.equal(replacePayloads(text, blocks, ['EPB2.32.replaced']), text.replace(payload, 'EPB2.32.replaced'));
  }
  assert.deepEqual(findPasswordBlocks('````md\n```password\nexample\n```\n````\n'), []);
  assert.deepEqual(findPasswordBlocks('<!--\n```password\nexample\n```\n-->\n'), []);
  assert.deepEqual(findPasswordBlocks('---\nexample: |\n  ```password\n  example\n  ```\n---\n'), []);
  assert.throws(() => findPasswordBlocks('```password\nexample', 'broken.md'), /broken.md:1/);
  assert.throws(() => findPasswordBlocks('```password\n```', 'empty.md'), /empty.md:1/);

  const text = samples[0]; const blocks = findPasswordBlocks(text); const next = replacePayloads(text, blocks, ['EPB2.32.replaced']);
  const note = { path: 'target.md', beforeHash: await hashText(text), afterHash: await hashText(next), blocks, replacements: ['EPB2.32.replaced'], done: false };
  const makeTask = () => ({ version: 1, targetKeyId: 'new-key', previousKeyId: 'old-key', state: 'prepared', notes: [JSON.parse(JSON.stringify(note))] });
  let task = makeTask(); let current = text; let saves = 0; let writes = 0;
  const host = { read: async () => current, process: async (path, fn) => { current = fn(current); writes++; },
    save: async () => { saves++; if (saves === 2) throw new Error('progress save failure'); }, pauseRequested: () => false, progress: () => {} };
  await assert.rejects(() => writeMigration(task, host)); assert.equal(current, next); assert.equal(writes, 1);
  // Simulate a restart from the last durable journal (before the write was acknowledged).
  task = makeTask(); host.save = async () => {};
  assert.equal(await writeMigration(task, host), true); assert.equal(writes, 1); assert.equal(task.notes[0].done, true);
  task = makeTask(); current = text + 'external edit'; await assert.rejects(() => writeMigration(task, host), /changed/); assert.equal(writes, 1);
  task = makeTask(); current = text; host.pauseRequested = () => true;
  assert.equal(await writeMigration(task, host), false); assert.equal(task.state, 'paused'); assert.equal(current, text);
  host.pauseRequested = () => false; host.process = async (path, fn) => { current += 'concurrent edit'; current = fn(current); };
  await assert.rejects(() => writeMigration(makeTask(), host), /Concurrent/); assert.ok(current.endsWith('concurrent edit'));
  const valid = makeTask(); valid.notes[0].blocks[0].source = await encryptSecret('test', 'master', 32, 'old-key', 100000);
  valid.notes[0].replacements = [await encryptSecret('test', 'master', 32, 'new-key', 100000)];
  assert.equal(validateTask(valid).targetKeyId, 'new-key'); assert.throws(() => validateTask({ version: 999 }));
  assert.ok(!JSON.stringify(makeTask()).includes('# Title'), 'journal must not store full notes');
  console.log('nested Markdown and resumable migration tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
