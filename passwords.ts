import { decryptSecret, encryptSecret, inspectEnvelope } from "./codec";

export type StorageMode = "secret-storage" | "session" | "prompt";
export interface KeyReference { secretId: string; createdAt: number }
export interface PasswordSettings {
  storageMode: StorageMode;
  activeKeyId: string;
  legacyKeyId: string;
  keys: Record<string, KeyReference>;
  // Encrypted known text for verifying an active password after restart.
  keyChecks: Record<string, string>;
}
export const CHECK_TEXT = "Encrypted Password Blocks key verification v1";
export function randomKeyId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
}
export class Cancelled extends Error { constructor() { super("Operation cancelled"); } }

export interface PasswordHost {
  ensureWritable(): Promise<void>;
  settings: PasswordSettings;
  getSecret(id: string): string | null;
  setSecret(id: string, value: string): void;
  save(): Promise<void>;
  prompt(title: string): Promise<string | null>;
  confirmSave(): Promise<boolean>;
}

export class PasswordManager {
  private cache = new Map<string, string>();
  private epoch = 0;
  constructor(private host: PasswordHost) {}
  lock(): void { this.cache.clear(); this.epoch++; }
  private assertCurrent(epoch: number): void { if (this.epoch !== epoch) throw new Cancelled(); }
  private stored(keyId: string): string | null {
    const ref = this.host.settings.keys[keyId];
    return ref ? this.host.getSecret(ref.secretId) : null;
  }
  private candidate(keyId: string): string | null {
    const mode = this.host.settings.storageMode;
    if (mode === "prompt") return null;
    if (mode === "session") return this.cache.get(keyId) ?? null;
    return this.stored(keyId);
  }
  async bind(keyId: string, master: string): Promise<void> {
    const epoch = this.epoch;
    await this.host.ensureWritable(); this.assertCurrent(epoch);
    const settings = this.host.settings;
    const secretId = `encrypt-password-blocks-${randomKeyId()}`;
    this.host.setSecret(secretId, master);
    if (this.host.getSecret(secretId) !== master) throw new Error("SecretStorage verification failed");
    const previous = settings.keys[keyId];
    settings.keys[keyId] = { secretId, createdAt: Date.now() };
    try { await this.host.save(); } catch (error) {
      if (previous) settings.keys[keyId] = previous; else delete settings.keys[keyId];
      throw error;
    }
  }
  async decrypt(source: string, allowRebind = true): Promise<string> {
    const epoch = this.epoch;
    const info = inspectEnvelope(source);
    const keyId = info.keyId || (info.version === 1 ? this.host.settings.legacyKeyId : "");
    // Unidentified blocks can share a candidate only after each authenticates.
    const cacheId = keyId || "unidentified";
    const candidate = this.candidate(cacheId);
    if (candidate) {
      try {
        const plain = await decryptSecret(source, candidate);
        this.assertCurrent(epoch);
        return plain;
      } catch (error) {
        this.assertCurrent(epoch);
        this.cache.delete(cacheId);
      }
    }
    const recovery = this.host.settings.storageMode === "secret-storage" && !!keyId;
    const master = await this.host.prompt(recovery ? "Recover with master password" : "Enter the master password");
    this.assertCurrent(epoch);
    if (!master) throw new Cancelled();
    const plain = await decryptSecret(source, master);
    this.assertCurrent(epoch);
    if (this.host.settings.storageMode === "session") this.cache.set(cacheId, master);
    if (recovery && allowRebind && await this.host.confirmSave()) {
      this.assertCurrent(epoch);
      await this.bind(keyId, master);
    }
    this.assertCurrent(epoch);
    return plain;
  }
  async install(master: string, keyId: string): Promise<void> {
    const epoch = this.epoch;
    await this.host.ensureWritable(); this.assertCurrent(epoch);
    const check = await encryptSecret(CHECK_TEXT, master, 32, keyId);
    this.assertCurrent(epoch);
    const settings = this.host.settings;
    settings.keyChecks[keyId] = check;
    try {
      if (settings.storageMode === "secret-storage") await this.bind(keyId, master);
      else await this.host.save();
    } catch (error) { delete settings.keyChecks[keyId]; throw error; }
    this.assertCurrent(epoch);
    if (settings.storageMode === "session") this.cache.set(keyId, master);
  }
  async active(): Promise<{ master: string; keyId: string }> {
    const settings = this.host.settings;
    const epoch = this.epoch;
    await this.host.ensureWritable(); this.assertCurrent(epoch);
    const keyId = settings.activeKeyId || randomKeyId();
    let master = this.candidate(keyId);
    const check = settings.keyChecks[keyId];
    if (master && check) {
      try { if (await decryptSecret(check, master) !== CHECK_TEXT) master = null; }
      catch { master = null; }
    }
    this.assertCurrent(epoch);
    const prompted = !master;
    if (!master) master = await this.host.prompt("Enter the master password for this operation");
    this.assertCurrent(epoch);
    if (!master) throw new Cancelled();
    if (check && await decryptSecret(check, master) !== CHECK_TEXT) throw new Error("Master password verification failed");
    this.assertCurrent(epoch);
    if (prompted && check && settings.storageMode === "secret-storage" && await this.host.confirmSave()) {
      this.assertCurrent(epoch);
      await this.bind(keyId, master);
      this.assertCurrent(epoch);
    }
    if (!settings.activeKeyId) {
      await this.install(master, keyId);
      this.assertCurrent(epoch);
      settings.activeKeyId = keyId;
      try { await this.host.save(); } catch (error) { settings.activeKeyId = ""; throw error; }
    }
    this.assertCurrent(epoch);
    if (settings.storageMode === "session") this.cache.set(keyId, master);
    return { master, keyId };
  }
  async verifyTarget(keyId: string): Promise<string> {
    const epoch = this.epoch;
    const check = this.host.settings.keyChecks[keyId];
    if (!check) throw new Error("Migration target password verification record is missing");
    let master = this.candidate(keyId);
    if (master) {
      try { if (await decryptSecret(check, master) !== CHECK_TEXT) master = null; } catch { master = null; }
    }
    this.assertCurrent(epoch);
    if (!master) master = await this.host.prompt("Enter the target master password to resume migration");
    this.assertCurrent(epoch);
    if (!master) throw new Cancelled();
    if (await decryptSecret(check, master) !== CHECK_TEXT) throw new Error("Migration target password could not be verified");
    this.assertCurrent(epoch);
    if (this.host.settings.storageMode === "session") this.cache.set(keyId, master);
    return master;
  }
}
