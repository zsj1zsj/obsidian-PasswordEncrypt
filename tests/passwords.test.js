const assert = require('node:assert/strict');
const { load, until } = require('./helpers');
const { PasswordManager, CHECK_TEXT, Cancelled } = load('passwords.ts');
const { encryptSecret, decryptSecret } = require('../codec.ts');

function fixture(mode) {
  const secrets = new Map(); const writes = []; const prompts = []; const blocks = new Map(); const proofs = [];
  const host = { settings: { storageMode: mode, activeKeyId: '', legacyKeyId: '', keys: {}, keyChecks: {} },
    ensureWritable: async () => {}, getSecret: id => secrets.get(id) ?? null, setSecret: (id, value) => secrets.set(id, value),
    save: async () => { writes.push(JSON.parse(JSON.stringify(host.settings))); },
    prompt: async title => { prompts.push(title); return 'correct-master'; }, confirmSave: async () => true,
    verifyExisting: async (keyId, master) => {
      proofs.push(keyId);
      const source = blocks.get(keyId);
      if (!source) throw new Error('No existing block can verify this key. Use Change master password.');
      await decryptSecret(source, master);
    } };
  return { host, secrets, writes, prompts, blocks, proofs, manager: new PasswordManager(host) };
}
async function countDerivations(operation) {
  const original = crypto.subtle.deriveKey;
  let count = 0;
  crypto.subtle.deriveKey = function (...args) { count++; return original.apply(this, args); };
  try { await operation(); return count; }
  finally { crypto.subtle.deriveKey = original; }
}
(async () => {
  const cipher = await encryptSecret('real secret', 'correct-master', 32, 'lost-key', 100000);
  let f = fixture('secret-storage');
  assert.equal(await f.manager.decrypt(cipher), 'real secret');
  assert.ok(f.prompts[0].includes('Recover'));
  assert.equal(f.writes.length, 1);
  assert.ok(!JSON.stringify(f.writes).includes('correct-master'));
  assert.equal(await f.manager.decrypt(cipher), 'real secret'); assert.equal(f.prompts.length, 1);

  f = fixture('secret-storage'); f.host.prompt = async () => 'wrong';
  await assert.rejects(() => f.manager.decrypt(cipher)); assert.equal(f.writes.length, 0); assert.equal(f.secrets.size, 0);

  f = fixture('secret-storage'); f.host.confirmSave = async () => false;
  assert.equal(await f.manager.decrypt(cipher), 'real secret'); assert.equal(f.secrets.size, 0);

  f = fixture('session');
  await f.manager.decrypt(cipher); await f.manager.decrypt(cipher); assert.equal(f.prompts.length, 1); assert.equal(f.secrets.size, 0);
  const second = await encryptSecret('other', 'second-master', 32, 'second-key', 100000);
  f.host.prompt = async () => 'second-master'; assert.equal(await f.manager.decrypt(second), 'other');
  assert.equal(await f.manager.decrypt(cipher), 'real secret', 'cache must be per key');
  f.manager.lock(); f.host.prompt = async () => null; await assert.rejects(() => f.manager.decrypt(cipher));

  f = fixture('prompt'); f.host.getSecret = () => { throw new Error('Must not read persistence'); };
  await f.manager.decrypt(cipher); await f.manager.decrypt(cipher); assert.equal(f.prompts.length, 2);
  await f.manager.install('correct-master', 'target-key'); assert.equal(f.secrets.size, 0);
  assert.equal(await decryptSecret(f.host.settings.keyChecks['target-key'], 'correct-master'), CHECK_TEXT);
  assert.equal(await f.manager.verifyTarget('target-key'), 'correct-master');

  f = fixture('secret-storage');
  f.host.settings.activeKeyId = 'missing-active';
  f.host.settings.keyChecks['missing-active'] = await encryptSecret(CHECK_TEXT, 'correct-master', 32, 'missing-active', 100000);
  assert.equal((await f.manager.active()).master, 'correct-master');
  assert.equal(f.secrets.size, 1, 'verified active password can be rebound after switching back to persistent mode');

  f = fixture('session'); let release;
  f.host.prompt = () => new Promise(resolve => { release = resolve; });
  const pending = f.manager.decrypt(cipher); f.manager.lock(); release('correct-master');
  await assert.rejects(() => pending); assert.equal(f.secrets.size, 0);

  f = fixture('secret-storage'); f.host.save = async () => { throw new Error('save failure'); };
  await assert.rejects(() => f.manager.decrypt(cipher)); assert.equal(f.host.settings.keys['lost-key'], undefined);

  f = fixture('prompt'); f.host.getSecret = () => { throw new Error('Must not read persistence'); };
  const fresh = await f.manager.active();
  assert.equal(fresh.keyId, f.host.settings.activeKeyId);
  assert.equal(await decryptSecret(f.host.settings.keyChecks[fresh.keyId], fresh.master), CHECK_TEXT);
  assert.equal(f.proofs.length, 0, 'a newly created key has no previous password to authenticate');

  // An upgraded key must authenticate a real block before accepting a password or saving a check.
  for (const mode of ['prompt', 'session', 'secret-storage']) {
    f = fixture(mode);
    f.host.settings.activeKeyId = 'lost-key';
    f.blocks.set('lost-key', cipher);
    if (mode !== 'secret-storage') f.host.getSecret = () => { throw new Error('Must not read persistence'); };
    const result = await f.manager.active();
    assert.deepEqual(result, { master: 'correct-master', keyId: 'lost-key' });
    assert.equal(f.proofs.length, 1);
    assert.equal(await decryptSecret(f.host.settings.keyChecks['lost-key'], result.master), CHECK_TEXT);
    assert.ok(f.writes.some(settings => settings.keyChecks['lost-key']), 'backfilled check must be persisted');
    assert.ok(!JSON.stringify(f.writes).includes('correct-master'));
    await f.manager.active();
    assert.equal(f.proofs.length, 1, 'later operations use the persisted check');
    assert.equal(f.prompts.length, mode === 'prompt' ? 2 : 1);
    assert.equal(f.secrets.size, mode === 'secret-storage' ? 1 : 0);
  }

  f = fixture('prompt'); f.host.settings.activeKeyId = 'lost-key'; f.blocks.set('lost-key', cipher);
  f.host.prompt = async () => 'typo';
  await assert.rejects(() => f.manager.active(), /incorrect|integrity/);
  assert.equal(f.host.settings.keyChecks['lost-key'], undefined);
  assert.equal(f.writes.length, 0);

  f = fixture('prompt'); f.host.settings.activeKeyId = 'lost-key';
  await assert.rejects(() => f.manager.active(), /Change master password/);
  assert.equal(f.host.settings.keyChecks['lost-key'], undefined);
  assert.equal(f.writes.length, 0, 'a missing proof must not silently establish a new password');

  f = fixture('secret-storage'); f.host.settings.activeKeyId = 'lost-key'; f.blocks.set('lost-key', cipher);
  f.host.settings.keys['lost-key'] = { secretId: 'old-secret', createdAt: 1 };
  f.secrets.set('old-secret', 'wrong-master');
  assert.equal((await f.manager.active()).master, 'correct-master');
  assert.equal(f.proofs.length, 2, 'the stored and recovery candidates must both authenticate');
  assert.equal(f.prompts.length, 1);
  assert.equal(f.secrets.get(f.host.settings.keys['lost-key'].secretId), 'correct-master');

  f = fixture('session'); f.host.settings.activeKeyId = 'lost-key';
  await f.manager.decrypt(cipher); // A cached password still needs proof before backfilling a missing check.
  await assert.rejects(() => f.manager.active(), /Change master password/);
  assert.equal(f.host.settings.keyChecks['lost-key'], undefined);

  f = fixture('session'); f.host.settings.activeKeyId = 'lost-key'; f.blocks.set('lost-key', cipher);
  f.host.save = async () => { throw new Error('check save failure'); };
  await assert.rejects(() => f.manager.active(), /check save failure/);
  assert.equal(f.host.settings.keyChecks['lost-key'], undefined, 'failed persistence must roll back the new check');
  assert.equal(f.host.settings.activeKeyId, 'lost-key');
  f.host.prompt = async () => null;
  await assert.rejects(() => f.manager.active(), Cancelled);

  f = fixture('session'); f.host.settings.activeKeyId = 'lost-key';
  let releaseProof;
  f.host.verifyExisting = () => new Promise(resolve => { releaseProof = resolve; });
  let pendingActive = f.manager.active();
  await until(() => releaseProof, 'legacy verification');
  f.manager.lock(); releaseProof();
  await assert.rejects(() => pendingActive, Cancelled);
  assert.equal(f.host.settings.keyChecks['lost-key'], undefined);
  assert.equal(f.writes.length, 0);

  f = fixture('session'); f.host.settings.activeKeyId = 'lost-key'; f.blocks.set('lost-key', cipher);
  let writableCalls = 0;
  f.host.ensureWritable = async () => { if (++writableCalls === 2) f.manager.lock(); };
  await assert.rejects(() => f.manager.active(), Cancelled);
  assert.equal(f.host.settings.keyChecks['lost-key'], undefined, 'locking after encryption prevents backfill');
  assert.equal(f.writes.length, 0);

  f = fixture('session'); f.host.settings.activeKeyId = 'lost-key'; f.blocks.set('lost-key', cipher);
  let releaseSave;
  f.host.save = () => new Promise(resolve => { releaseSave = resolve; });
  pendingActive = f.manager.active();
  await until(() => releaseSave, 'check save');
  f.manager.lock(); releaseSave();
  await assert.rejects(() => pendingActive, Cancelled);
  f.host.prompt = async () => null;
  await assert.rejects(() => f.manager.active(), Cancelled, 'a cancelled operation must not repopulate the session cache');

  // A valid stored or cached candidate needs exactly one PBKDF2 operation per validation.
  const keyCheck = await encryptSecret(CHECK_TEXT, 'correct-master', 32, 'lost-key', 100000);
  for (const mode of ['secret-storage', 'session']) {
    f = fixture(mode); f.host.settings.activeKeyId = 'lost-key'; f.host.settings.keyChecks['lost-key'] = keyCheck;
    if (mode === 'secret-storage') {
      f.host.settings.keys['lost-key'] = { secretId: 'current-secret', createdAt: 1 };
      f.secrets.set('current-secret', 'correct-master');
    } else {
      f.host.getSecret = () => { throw new Error('Must not read persistence'); };
      await f.manager.decrypt(cipher);
    }
    for (let i = 0; i < 2; i++) {
      assert.equal(await countDerivations(() => f.manager.active()), 1, `${mode} active validation`);
      assert.equal(await countDerivations(() => f.manager.verifyTarget('lost-key')), 1, `${mode} migration validation`);
    }
  }
  console.log('password management tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
