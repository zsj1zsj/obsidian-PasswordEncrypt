import { GF_QR_CODE_256, RS_Decoder, RS_Encoder } from "reedsolomon.ts";

const EPB1_MAGIC = new Uint8Array([0x45, 0x50, 0x42, 0x01]);
const EPB2_MAGIC = new Uint8Array([0x45, 0x50, 0x42, 0x02]);
const ALGORITHM_PBKDF2_AES_GCM = 1;
const EPB1_ITERATIONS = 210_000;
const DEFAULT_ITERATIONS = 600_000;
const SALT_SIZE = 16;
const NONCE_SIZE = 12;
const GCM_TAG_SIZE = 16;
const FIXED_V2_HEADER_SIZE = 17;
const MAX_ENCODED_BYTES = 64 * 1024;
const MAX_BASE64_CHARACTERS = Math.ceil(MAX_ENCODED_BYTES * 4 / 3);

export interface EnvelopeInfo {
  version: 1 | 2;
  keyId: string;
  parity: number;
  iterations: number;
}

interface ParsedEnvelope extends EnvelopeInfo {
  salt: Uint8Array;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  additionalData?: Uint8Array;
}

export class CodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodecError";
  }
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const length = arrays.reduce((sum, item) => sum + item.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const item of arrays) {
    output.set(item, offset);
    offset += item.length;
  }
  return output;
}

function writeU32(value: number): Uint8Array {
  const output = new Uint8Array(4);
  new DataView(output.buffer).setUint32(0, value, false);
  return output;
}

function readU32(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, false);
}

function base64UrlEncode(data: Uint8Array): string {
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  if (value.length > MAX_BASE64_CHARACTERS) throw new CodecError("The encrypted payload exceeds the size limit");
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new CodecError("The encrypted payload contains invalid Base64URL characters");
  if (value.length % 4 === 1) throw new CodecError("The encrypted payload has an invalid Base64URL length");
  let padded = value.replace(/-/g, "+").replace(/_/g, "/");
  while (padded.length % 4) padded += "=";
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  } catch {
    throw new CodecError("The encrypted payload could not be decoded as Base64URL");
  }
}

function validateParity(parity: number): void {
  if (!Number.isInteger(parity) || parity < 8 || parity > 64 || parity % 2 !== 0) {
    throw new CodecError("The error-correction parity setting is invalid");
  }
}

const rsField = GF_QR_CODE_256();
const rsEncoder = new RS_Encoder(rsField);
const rsDecoder = new RS_Decoder(rsField);

export function rsEncode(data: Uint8Array, parity: number): Uint8Array {
  validateParity(parity);
  if (data.length === 0 || data.length + parity > 255) throw new CodecError("The Reed-Solomon data block length is invalid");
  const block = new Int32Array(data.length + parity);
  block.set(data);
  rsEncoder.encode(block, parity);
  return Uint8Array.from(block);
}

export function rsDecode(codeword: Uint8Array, dataLength: number, parity: number): Uint8Array {
  validateParity(parity);
  if (dataLength <= 0 || codeword.length !== dataLength + parity || codeword.length > 255) {
    throw new CodecError("The Reed-Solomon codeword length is invalid");
  }
  const block = Int32Array.from(codeword);
  try {
    rsDecoder.decode(block, parity);
  } catch {
    throw new CodecError("The encrypted payload is damaged beyond the configured repair capacity");
  }
  return Uint8Array.from(block.slice(0, dataLength));
}

function fecEncode(raw: Uint8Array, parity: number): Uint8Array {
  validateParity(parity);
  const dataSize = 255 - parity;
  const blocks: Uint8Array[] = [];
  for (let offset = 0; offset < raw.length; offset += dataSize) {
    blocks.push(rsEncode(raw.slice(offset, offset + dataSize), parity));
  }
  return concat(...blocks);
}

function fecDecode(encoded: Uint8Array, parity: number): Uint8Array {
  validateParity(parity);
  if (encoded.length === 0 || encoded.length > MAX_ENCODED_BYTES) throw new CodecError("The encrypted payload is empty or exceeds the size limit");
  const dataSize = 255 - parity;
  const blocks: Uint8Array[] = [];
  for (let offset = 0; offset < encoded.length; offset += 255) {
    const block = encoded.slice(offset, offset + 255);
    if (block.length <= parity) throw new CodecError("An encrypted data block is truncated");
    const dataLength = block.length === 255 ? dataSize : block.length - parity;
    blocks.push(rsDecode(block, dataLength, parity));
  }
  return concat(...blocks);
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const passwordBytes = new TextEncoder().encode(password);
  const material = await crypto.subtle.importKey("raw", passwordBytes as BufferSource, "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function parseOuter(value: string): { version: 1 | 2; parity: number; encoded: Uint8Array } {
  // Bound work before trim/split, regex matching, or Base64 allocation.
  if (value.length > MAX_BASE64_CHARACTERS + 128) throw new CodecError("The encrypted block exceeds the size limit");
  const parts = value.trim().split(".");
  if (parts.length !== 3 || (parts[0] !== "EPB1" && parts[0] !== "EPB2")) throw new CodecError("This is not a valid encrypted password block");
  const parity = Number(parts[1]);
  validateParity(parity);
  return { version: parts[0] === "EPB1" ? 1 : 2, parity, encoded: base64UrlDecode(parts[2]) };
}

function hasMagic(raw: Uint8Array, magic: Uint8Array): boolean {
  return raw.length >= magic.length && magic.every((byte, index) => raw[index] === byte);
}

function parseEpb1(raw: Uint8Array, parity: number): ParsedEnvelope {
  const minimumLength = 4 + 1 + 2 + SALT_SIZE + NONCE_SIZE + GCM_TAG_SIZE;
  if (raw.length < minimumLength || !hasMagic(raw, EPB1_MAGIC)) throw new CodecError("The EPB1 header is damaged");
  if (raw[4] !== parity) throw new CodecError("The EPB1 parity values do not match");
  const saltLength = (raw[5] << 8) | raw[6];
  if (saltLength !== SALT_SIZE) throw new CodecError("The EPB1 salt length is invalid");
  const saltEnd = 7 + saltLength;
  const nonceEnd = saltEnd + NONCE_SIZE;
  if (raw.length < nonceEnd + GCM_TAG_SIZE) throw new CodecError("The EPB1 payload is truncated");
  return {
    version: 1,
    keyId: "",
    parity,
    iterations: EPB1_ITERATIONS,
    salt: raw.slice(7, saltEnd),
    nonce: raw.slice(saltEnd, nonceEnd),
    ciphertext: raw.slice(nonceEnd),
  };
}

function parseEpb2(raw: Uint8Array, parity: number): ParsedEnvelope {
  if (raw.length < FIXED_V2_HEADER_SIZE + SALT_SIZE + NONCE_SIZE + GCM_TAG_SIZE || !hasMagic(raw, EPB2_MAGIC)) {
    throw new CodecError("The EPB2 header is damaged or truncated");
  }
  const algorithm = raw[4];
  const innerParity = raw[5];
  const iterations = readU32(raw, 6);
  const saltLength = raw[10];
  const nonceLength = raw[11];
  const keyIdLength = raw[12];
  const cipherLength = readU32(raw, 13);
  if (algorithm !== ALGORITHM_PBKDF2_AES_GCM) throw new CodecError("This encryption algorithm is not supported");
  if (innerParity !== parity) throw new CodecError("The EPB2 parity values do not match");
  if (iterations < 100_000 || iterations > 5_000_000) throw new CodecError("The PBKDF2 iteration count is outside the allowed range");
  if (saltLength !== SALT_SIZE || nonceLength !== NONCE_SIZE || keyIdLength > 64 || cipherLength < GCM_TAG_SIZE) {
    throw new CodecError("The EPB2 metadata is invalid");
  }
  const metadataLength = FIXED_V2_HEADER_SIZE + saltLength + nonceLength + keyIdLength;
  if (raw.length !== metadataLength + cipherLength) throw new CodecError("The EPB2 data length does not match its metadata");
  const saltStart = FIXED_V2_HEADER_SIZE;
  const nonceStart = saltStart + saltLength;
  const keyIdStart = nonceStart + nonceLength;
  let keyId: string;
  try {
    keyId = new TextDecoder("utf-8", { fatal: true }).decode(raw.slice(keyIdStart, metadataLength));
  } catch {
    throw new CodecError("The EPB2 key identifier is not valid UTF-8");
  }
  if (keyId && !/^[a-z0-9-]+$/.test(keyId)) throw new CodecError("The EPB2 key identifier is invalid");
  return {
    version: 2,
    keyId,
    parity,
    iterations,
    salt: raw.slice(saltStart, nonceStart),
    nonce: raw.slice(nonceStart, keyIdStart),
    ciphertext: raw.slice(metadataLength),
    additionalData: raw.slice(0, metadataLength),
  };
}

function parseEnvelope(value: string): ParsedEnvelope {
  const outer = parseOuter(value);
  const raw = fecDecode(outer.encoded, outer.parity);
  return outer.version === 1 ? parseEpb1(raw, outer.parity) : parseEpb2(raw, outer.parity);
}

export function inspectEnvelope(value: string): EnvelopeInfo {
  const parsed = parseEnvelope(value);
  return { version: parsed.version, keyId: parsed.keyId, parity: parsed.parity, iterations: parsed.iterations };
}

export async function encryptSecret(
  secret: string,
  masterPassword: string,
  parity: number,
  keyId = "",
  iterations = DEFAULT_ITERATIONS,
): Promise<string> {
  validateParity(parity);
  if (!masterPassword) throw new CodecError("The master password cannot be empty");
  if (keyId && (!/^[a-z0-9-]+$/.test(keyId) || keyId.length > 64)) throw new CodecError("The key identifier is invalid");
  if (!Number.isInteger(iterations) || iterations < 100_000 || iterations > 5_000_000) throw new CodecError("The PBKDF2 parameters are invalid");
  const plaintext = new TextEncoder().encode(secret);
  if (plaintext.length > 32 * 1024) throw new CodecError("The plaintext exceeds the 32 KiB size limit");
  const salt = crypto.getRandomValues(new Uint8Array(SALT_SIZE));
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_SIZE));
  const keyIdBytes = new TextEncoder().encode(keyId);
  const ciphertextLength = plaintext.length + GCM_TAG_SIZE;
  const fixedHeader = concat(
    EPB2_MAGIC,
    new Uint8Array([ALGORITHM_PBKDF2_AES_GCM, parity]),
    writeU32(iterations),
    new Uint8Array([salt.length, nonce.length, keyIdBytes.length]),
    writeU32(ciphertextLength),
  );
  const additionalData = concat(fixedHeader, salt, nonce, keyIdBytes);
  const key = await deriveKey(masterPassword, salt, iterations);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce as BufferSource, additionalData: additionalData as BufferSource },
    key,
    plaintext as BufferSource,
  ));
  return `EPB2.${parity}.${base64UrlEncode(fecEncode(concat(additionalData, ciphertext), parity))}`;
}

export async function decryptSecret(value: string, masterPassword: string): Promise<string> {
  if (!masterPassword) throw new CodecError("The master password cannot be empty");
  const envelope = parseEnvelope(value);
  const key = await deriveKey(masterPassword, envelope.salt, envelope.iterations);
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: envelope.nonce as BufferSource,
        ...(envelope.additionalData ? { additionalData: envelope.additionalData as BufferSource } : {}),
      },
      key,
      envelope.ciphertext as BufferSource,
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  } catch {
    throw new CodecError("The master password is incorrect, or the encrypted payload failed integrity verification");
  }
}
