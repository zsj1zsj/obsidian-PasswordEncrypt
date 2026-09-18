const assert = require('node:assert/strict');
const { load } = require('./helpers');
const { PasswordManager, CHECK_TEXT } = load('passwords.ts');
const { encryptSecret, decryptSecret } = require('../codec.ts');

function fixture(mode) {
  const secrets = new Map(); const writes = []; const prompts = [];
  const host = { settings: { storageMode: mode, activeKeyId: '', legacyKeyId: '', keys: {}, keyChecks: {} },
    ensureWritable: async () => {}, getSecret: id => secrets.get(id) ?? null, setSecret: (id, value) => secrets.set(id, value),
    save: async () => { writes.push(JSON.parse(JSON.stringify(host.settings))); },
    prompt: async title => { prompts.push(title); return 'correct-master'; }, confirmSave: async () => true };
  return { host, secrets, writes, prompts, manager: new PasswordManager(host) };
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
  console.log('password management tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
