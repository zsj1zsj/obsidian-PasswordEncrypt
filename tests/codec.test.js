const assert = require("node:assert/strict");
const {
  CodecError,
  decryptSecret,
  encryptSecret,
  inspectEnvelope,
  rsDecode,
  rsEncode,
} = require("../codec.ts");

function decodeBase64Url(value) {
  let padded = value.replace(/-/g, "+").replace(/_/g, "/");
  while (padded.length % 4) padded += "=";
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
}

function encodeBase64Url(value) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function concat(...arrays) {
  const output = new Uint8Array(arrays.reduce((sum, array) => sum + array.length, 0));
  let offset = 0;
  for (const array of arrays) {
    output.set(array, offset);
    offset += array.length;
  }
  return output;
}

function fecDecode(encoded, parity) {
  const dataSize = 255 - parity;
  const blocks = [];
  for (let offset = 0; offset < encoded.length; offset += 255) {
    const block = encoded.slice(offset, offset + 255);
    blocks.push(rsDecode(block, block.length === 255 ? dataSize : block.length - parity, parity));
  }
  return concat(...blocks);
}

function fecEncode(raw, parity) {
  const dataSize = 255 - parity;
  const blocks = [];
  for (let offset = 0; offset < raw.length; offset += dataSize) blocks.push(rsEncode(raw.slice(offset, offset + dataSize), parity));
  return concat(...blocks);
}

async function createLegacyEpb1(secret, master, parity = 32) {
  const magic = new Uint8Array([0x45, 0x50, 0x42, 0x01]);
  const salt = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
  const nonce = Uint8Array.from({ length: 12 }, (_, index) => index + 33);
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(master), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 210000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, new TextEncoder().encode(secret)));
  const raw = concat(magic, new Uint8Array([parity, 0, salt.length]), salt, nonce, ciphertext);
  return `EPB1.${parity}.${encodeBase64Url(fecEncode(raw, parity))}`;
}

async function expectCodecError(action) {
  await assert.rejects(action, error => error instanceof CodecError);
}

(async () => {
  const originalAtob = globalThis.atob;
  let decodedOversize = false;
  globalThis.atob = () => { decodedOversize = true; throw new Error('must not decode'); };
  assert.throws(() => inspectEnvelope('EPB2.32.' + 'A'.repeat(100000)), /size limit/);
  assert.equal(decodedOversize, false);
  globalThis.atob = originalAtob;
  const unicode = "密码-abc-123-🔐";
  const encoded = await encryptSecret(unicode, "master-pass", 32, "key-001", 100000);
  assert.equal(await decryptSecret(encoded, "master-pass"), unicode);
  assert.deepEqual(inspectEnvelope(encoded), { version: 2, keyId: "key-001", parity: 32, iterations: 100000 });

  const empty = await encryptSecret("", "master-pass", 8, "", 100000);
  assert.equal(await decryptSecret(empty, "master-pass"), "");
  assert.notEqual(encoded, await encryptSecret(unicode, "master-pass", 32, "key-001", 100000));
  await expectCodecError(() => decryptSecret(encoded, "wrong-password"));

  const longText = "多块数据🔑".repeat(250);
  const multiBlock = await encryptSecret(longText, "master-pass", 32, "key-002", 100000);
  const parts = multiBlock.split(".");
  const damaged = decodeBase64Url(parts[2]);
  for (let blockStart = 0; blockStart < damaged.length; blockStart += 255) {
    const blockLength = Math.min(255, damaged.length - blockStart);
    for (let error = 0; error < 16 && error < blockLength; error++) damaged[blockStart + error * 7 % blockLength] ^= 0x5a;
  }
  assert.equal(await decryptSecret(`${parts[0]}.${parts[1]}.${encodeBase64Url(damaged)}`, "master-pass"), longText);

  const excessive = decodeBase64Url(parts[2]);
  for (let index = 0; index < 17; index++) excessive[index] ^= index + 1;
  await expectCodecError(() => decryptSecret(`${parts[0]}.${parts[1]}.${encodeBase64Url(excessive)}`, "master-pass"));
  await expectCodecError(() => decryptSecret(`${parts[0]}.${parts[1]}.${parts[2].slice(0, -3)}`, "master-pass"));
  await expectCodecError(() => decryptSecret("EPB2.32.%%%", "master-pass"));

  const encodedBytes = decodeBase64Url(parts[2]);
  const raw = fecDecode(encodedBytes, 32);
  raw[17 + 16 + 12] = "j".charCodeAt(0);
  const metadataTampered = `EPB2.32.${encodeBase64Url(fecEncode(raw, 32))}`;
  await expectCodecError(() => decryptSecret(metadataTampered, "master-pass"));

  const legacy = await createLegacyEpb1("旧密码内容", "legacy-master");
  assert.deepEqual(inspectEnvelope(legacy), { version: 1, keyId: "", parity: 32, iterations: 210000 });
  assert.equal(await decryptSecret(legacy, "legacy-master"), "旧密码内容");
  await expectCodecError(() => decryptSecret(legacy, "wrong-password"));

  for (const parity of [8, 32, 64]) {
    const data = Uint8Array.from({ length: 255 - parity }, (_, index) => index & 0xff);
    const codeword = rsEncode(data, parity);
    for (let index = 0; index < parity / 2; index++) codeword[index * 3] ^= 0xa5;
    assert.deepEqual(rsDecode(codeword, data.length, parity), data);
  }

  console.log("codec tests passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
