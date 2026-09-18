const assert = require('node:assert/strict');
const { load, tick, until } = require('./helpers');
const { ConfigurationStore, validateConfiguration, defaults } = load('config.ts');
const { encryptSecret } = require('../codec.ts');
const { findPasswordBlocks, hashText, replacePayloads, validateTask } = load('rotation.ts');
const copy = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(initial = '{}') {
  let disk = initial, writes = 0; const events = [];
  const host = { read: async () => disk, write: async value => { writes++; disk = JSON.stringify(value); }, protected: (state, message) => events.push({ state, message }) };
  const store = new ConfigurationStore(host);
  return { store, host, events, disk: () => disk, set: text => { disk = text; }, writes: () => writes };
}
(async () => {
  let f = fixture(null); let loaded = await f.store.load();
  assert.equal(f.store.state, 'ready'); assert.equal(f.writes(), 0);
  await f.store.save(loaded.settings); assert.equal(f.writes(), 1);
  const baseline = f.disk(); f.set(null); await f.store.externalChange(); assert.equal(f.store.state, 'conflict');
  assert.equal(await f.store.load(), undefined); assert.equal(f.store.state, 'recovery');
  f.set(baseline); await f.store.load(); assert.equal(f.store.state, 'ready');
  f.store.dispose(); await assert.rejects(() => f.store.save(defaults()));

  for (const damaged of ['{ PRIVATE BROKEN JSON', 'null', '[]', '{"parity":7}', '{"autoHideSeconds":"30"}', '{"storageMode":"bad"}', '{"keys":[]}', '{"keys":{"a":{"secretId":"b","createdAt":"bad"}}}', '{"keyChecks":{"a":"PRIVATE BAD CHECK"}}', '{"migration":{"notes":[]}}']) {
    f = fixture(damaged); assert.equal(await f.store.load(), undefined); assert.equal(f.store.state, 'recovery');
    assert.equal(f.disk(), damaged); assert.equal(f.writes(), 0); assert.ok(!JSON.stringify(f.events).includes('PRIVATE'));
    await assert.rejects(() => f.store.save(defaults()));
    f.set(null); assert.equal(await f.store.load(), undefined, 'deleting a damaged file must not reset configuration');
    f.set('{}'); loaded = await f.store.load(); assert.equal(f.store.state, 'ready'); f.store.dispose();
  }
  f = fixture(); f.host.read = async () => { throw Error('PRIVATE filesystem error'); };
  await f.store.load(); assert.equal(f.store.state, 'recovery'); assert.ok(!f.store.diagnostic.includes('PRIVATE')); f.store.dispose();

  f = fixture('{"parity":32,"autoHideSeconds":30}'); loaded = await f.store.load();
  f.set('{\n "autoHideSeconds": 30, "parity": 32\n}'); await f.store.externalChange(); assert.equal(f.store.state, 'ready');
  // Own-save notifications are checked only after the in-flight write has settled.
  const write = f.host.write; let ownEvent;
  f.host.write = async value => { await write(value); ownEvent = f.store.externalChange(); };
  await f.store.save(loaded.settings); await ownEvent; assert.equal(f.store.state, 'ready'); assert.equal(f.events.length, 0);
  f.set('{"parity":64}'); await f.store.externalChange(); assert.equal(f.store.state, 'conflict');
  await assert.rejects(() => f.store.save(defaults())); assert.equal(f.writes(), 1); assert.equal(f.disk(), '{"parity":64}');
  loaded = await f.store.load(); assert.equal(loaded.settings.parity, 64); assert.equal(f.store.state, 'ready'); f.store.dispose();

  // External changes between queued saves invalidate the later write, even without a notification.
  f = fixture(); await f.store.load();
  const gate = deferred(); let entered = false;
  f.host.write = async value => { entered = true; await gate.promise; f.set(JSON.stringify(value)); };
  const first = f.store.save(defaults()); const second = f.store.save({ ...defaults(), parity: 64 });
  const results = Promise.allSettled([first, second]); await until(() => entered);
  f.host.read = async () => { f.set('{"parity":48}'); return f.disk(); };
  gate.resolve(); assert.deepEqual((await results).map(r => r.status), ['rejected', 'rejected']);
  assert.equal(f.store.state, 'conflict'); assert.equal(f.disk(), '{"parity":48}'); f.store.dispose();

  f = fixture(); await f.store.load(); f.host.write = async () => { throw Error('PRIVATE disk failure'); };
  await assert.rejects(() => f.store.save(defaults())); assert.equal(f.store.state, 'recovery'); assert.equal(f.disk(), '{}'); f.store.dispose();
  f = fixture(); await f.store.load(); f.host.write = async () => { f.set('{broken'); };
  await assert.rejects(() => f.store.save(defaults())); assert.equal(f.store.state, 'recovery'); f.store.dispose();
  f = fixture(); let reads = 0; f.host.read = async () => ++reads === 1 ? '{}' : '{"parity":64}';
  assert.equal(await f.store.load(), undefined); assert.equal(f.store.state, 'conflict'); f.store.dispose();

  // A request queued before reloading cannot execute against the newly accepted baseline.
  f = fixture(); await f.store.load(); f.store.protect('conflict', 'external');
  const stale = f.store.save(defaults()); const failure = assert.rejects(() => stale); await failure;
  f.set('{"parity":64}'); await f.store.load(); assert.equal(f.writes(), 0); f.store.dispose();

  // Strict migration validation: no untrusted paths, overlaps, partial completion, or wrong target.
  const old = await encryptSecret('synthetic', 'old-master', 32, 'old-key', 100000);
  const replacement = await encryptSecret('synthetic', 'new-master', 32, 'new-key', 100000);
  const text = `\`\`\`password\n${old}\n\`\`\`\n`; const blocks = findPasswordBlocks(text);
  const task = { version: 1, targetKeyId: 'new-key', previousKeyId: 'old-key', state: 'complete', notes: [{ path: 'a.md', beforeHash: await hashText(text), afterHash: await hashText(replacePayloads(text, blocks, [replacement])), blocks, replacements: [replacement], done: true }] };
  assert.equal(validateTask(task).state, 'complete');
  assert.equal(validateConfiguration({ migration: task }).settings.migration.state, 'complete');
  const cases = [
    t => { t.notes[0].path = '../a.md'; }, t => { t.notes[0].path = 'C:/a.md'; }, t => { t.notes[0].path = '/a.md'; },
    t => { t.notes.push(copy(t.notes[0])); }, t => { t.notes[0].done = false; }, t => { t.notes[0].done = 'true'; },
    t => { t.notes[0].blocks[0].line = 0; }, t => { t.notes[0].blocks[0].fragments[0].end = -1; },
    t => { t.notes[0].blocks[0].fragments.push(copy(t.notes[0].blocks[0].fragments[0])); },
    t => { t.notes[0].blocks[0].source = 'PRIVATE invalid'; }, t => { t.notes[0].replacements = [old]; },
    t => { t.notes[0].replacements = []; }, t => { t.state = 'prepared'; }, t => { t.targetKeyId = null; },
  ];
  for (const mutate of cases) { const invalid = copy(task); mutate(invalid); assert.throws(() => validateTask(invalid)); assert.throws(() => validateConfiguration({ migration: invalid }), /migration/); }
  assert.equal(validateConfiguration({ masterPassword: 'legacy' }).legacyMaster, 'legacy');
  await tick(); console.log('configuration fingerprints, conflicts, failures, and strict validation tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
