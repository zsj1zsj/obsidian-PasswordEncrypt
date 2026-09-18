import { inspectEnvelope } from "./codec";
import { hashText, MigrationTask, validateTask } from "./rotation";
import type { PasswordSettings } from "./passwords";
import { normalizeScanFolders } from "./scan-scope";

export interface EpbSettings extends PasswordSettings { parity: number; autoHideSeconds: number; scanFolders: string[]; migration?: MigrationTask }
export const defaults = (): EpbSettings => ({ parity: 32, autoHideSeconds: 30, scanFolders: [], storageMode: "secret-storage", activeKeyId: "", legacyKeyId: "", keys: {}, keyChecks: {} });
export type ConfigState = "ready" | "conflict" | "recovery";
export class ConfigurationError extends Error {}
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const key = (value: unknown, empty = false): value is string => typeof value === "string" && (empty && value === "" || /^[a-z0-9-]{1,64}$/.test(value));

export function validateConfiguration(raw: unknown): { settings: EpbSettings; legacyMaster?: string } {
  const fail = (field: string): never => { throw new ConfigurationError(`Invalid configuration field: ${field}. Preserve data.json and restore a valid copy.`); };
  if (!object(raw)) return fail("root");
  const settings = defaults();
  if ("scanFolders" in raw) {
    try { settings.scanFolders = normalizeScanFolders(raw.scanFolders); } catch { fail("scanFolders"); }
  }
  if ("parity" in raw) {
    if (!Number.isInteger(raw.parity) || raw.parity < 8 || raw.parity > 64 || raw.parity % 2) fail("parity");
    settings.parity = raw.parity;
  }
  if ("autoHideSeconds" in raw) {
    if (!Number.isInteger(raw.autoHideSeconds) || raw.autoHideSeconds < 10 || raw.autoHideSeconds > 300) fail("autoHideSeconds");
    settings.autoHideSeconds = raw.autoHideSeconds;
  }
  if ("storageMode" in raw) {
    if (!["secret-storage", "session", "prompt"].includes(raw.storageMode)) fail("storageMode");
    settings.storageMode = raw.storageMode;
  }
  for (const name of ["activeKeyId", "legacyKeyId"] as const) if (name in raw) {
    if (!key(raw[name], true)) fail(name);
    settings[name] = raw[name];
  }
  for (const name of ["keys", "keyChecks"] as const) if (name in raw && !object(raw[name])) fail(name);
  for (const [id, ref] of Object.entries(raw.keys ?? {}) as [string, any][]) {
    if (!key(id) || !object(ref) || typeof ref.secretId !== "string" || !/^[a-z0-9-]+$/.test(ref.secretId) ||
      typeof ref.createdAt !== "number" || !Number.isFinite(ref.createdAt) || ref.createdAt < 0) fail("keys");
    settings.keys[id] = { secretId: ref.secretId, createdAt: ref.createdAt };
  }
  for (const [id, check] of Object.entries(raw.keyChecks ?? {})) {
    try {
      if (!key(id) || typeof check !== "string" || inspectEnvelope(check).keyId !== id) fail("keyChecks");
      settings.keyChecks[id] = check as string;
    } catch { fail("keyChecks"); }
  }
  try { settings.migration = validateTask(raw.migration); } catch { fail("migration"); }
  if ("masterPassword" in raw && typeof raw.masterPassword !== "string") fail("masterPassword");
  return { settings, legacyMaster: raw.masterPassword || undefined };
}

// Canonical JSON fingerprints ignore whitespace/key order but include unknown fields.
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
export interface ConfigHost {
  read(): Promise<string | null>;
  write(value: EpbSettings): Promise<void>;
  protected(state: ConfigState, diagnostic: string): void;
}

/** Optimistic file protection, NOT an atomic lock against a sync service. */
export class ConfigurationStore {
  state: ConfigState = "recovery";
  diagnostic = "Configuration has not been loaded.";
  private baseline?: string;
  private generation = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private observedFile = false;
  constructor(private host: ConfigHost) {}
  private async read(): Promise<{ value: unknown; fingerprint: string; missing: boolean }> {
    let text: string | null;
    try { text = await this.host.read(); } catch { throw new ConfigurationError("Cannot read data.json. Restore access and retry loading."); }
    if (text === null) return { value: {}, fingerprint: "missing", missing: true };
    this.observedFile = true;
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new ConfigurationError("Invalid JSON in data.json. Preserve the file and restore a valid copy."); }
    return { value, fingerprint: await hashText(canonical(value)), missing: false };
  }
  protect(state: "conflict" | "recovery", diagnostic: string): void {
    if (this.disposed) return;
    const changed = this.state !== state || this.diagnostic !== diagnostic;
    this.state = state; this.diagnostic = diagnostic; this.generation++;
    if (changed) this.host.protected(state, diagnostic);
  }
  assertReady(): void {
    if (this.disposed || this.state !== "ready") throw new ConfigurationError(this.diagnostic || "Configuration is unavailable. Reload it in settings.");
  }
  async load(): Promise<ReturnType<typeof validateConfiguration> | undefined> {
    await this.queue.catch(() => {});
    if (this.disposed) return undefined;
    const ticket = ++this.generation;
    try {
      const read = await this.read();
      // A vanished established configuration must never become a fresh empty setup.
      if (read.missing && this.observedFile) throw new ConfigurationError("data.json is missing. Restore the configuration file before retrying.");
      const loaded = validateConfiguration(read.value);
      const current = await this.read();
      if (ticket !== this.generation || this.disposed) return undefined;
      if (current.fingerprint !== read.fingerprint) {
        this.protect("conflict", "Configuration changed while loading. Retry loading configuration."); return undefined;
      }
      this.baseline = read.fingerprint; this.state = "ready"; this.diagnostic = "";
      return loaded;
    } catch (error) {
      if (ticket === this.generation) this.protect("recovery", error instanceof ConfigurationError ? error.message : "Cannot validate configuration. Preserve data.json.");
      return undefined;
    }
  }
  private async check(): Promise<void> {
    this.assertReady();
    const ticket = this.generation;
    try {
      const current = await this.read();
      if (ticket !== this.generation) { this.assertReady(); throw new ConfigurationError("Configuration operation expired."); }
      this.assertReady();
      if (current.fingerprint !== this.baseline) {
        this.protect("conflict", "Configuration changed externally. Confirm Reload configuration before writing.");
        this.assertReady();
      }
    } catch (error) {
      if (this.state === "ready") this.protect("recovery", error instanceof ConfigurationError ? error.message : "Cannot verify configuration.");
      throw error;
    }
  }
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => {}).then(action); this.queue = next; return next;
  }
  checkpoint(): Promise<void> {
    const ticket = this.generation;
    return this.serialize(async () => {
      if (ticket !== this.generation) throw new ConfigurationError("Configuration operation expired.");
      await this.check();
    });
  }
  save(value: EpbSettings): Promise<void> {
    const snapshot = JSON.parse(JSON.stringify(value)) as EpbSettings;
    const ticket = this.generation;
    return this.serialize(async () => {
      if (ticket !== this.generation) throw new ConfigurationError("Configuration operation expired.");
      const expected = await hashText(canonical(snapshot));
      await this.check();
      try {
        this.assertReady();
        await this.host.write(snapshot);
        const actual = await this.read();
        if (ticket !== this.generation || this.disposed) throw new ConfigurationError("Configuration operation expired.");
        if (actual.fingerprint !== expected) {
          this.protect("conflict", "Configuration changed during saving. Some writes may have completed; preserve data.json and reload.");
          this.assertReady();
        }
        this.baseline = actual.fingerprint;
      } catch (error) {
        if (this.state === "ready") this.protect("recovery", "Configuration save could not be verified. Preserve data.json and retry loading.");
        throw new ConfigurationError(this.diagnostic || "Configuration save could not be verified.");
      }
    });
  }
  async externalChange(): Promise<void> {
    if (this.disposed || this.state !== "ready") return;
    try { await this.checkpoint(); } catch { /* State and safe diagnostics are surfaced by protect(). */ }
  }
  async idle(): Promise<void> { await this.queue.catch(() => {}); }
  dispose(): void { this.disposed = true; this.generation++; }
}
