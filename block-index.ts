import { inspectEnvelope } from "./codec";
import { hashText, scanPasswordBlocks } from "./rotation";
import type { PasswordSettings } from "./passwords";
import { isInScanFolders } from "./scan-scope";

export interface BlockRecord {
  path: string;
  line: number;
  endLine: number;
  ordinal: number;
  title?: string;
  digest?: string;
  version?: 1 | 2;
  keyId?: string;
  parity?: number;
  diagnostic?: string;
}
export interface NoteRecord { path: string; hash?: string; blocks: BlockRecord[]; diagnostic?: string }
export interface BlockStatus { label: string; attention: boolean; keyId: string }
export interface IndexSnapshot { notes: NoteRecord[]; busy: boolean; active: boolean; error?: string; updatedAt?: number; configurationUnavailable: boolean; scanFolders: string[] }
export interface IndexHost {
  configurationAvailable?(): boolean;
  scanFolders?(): readonly string[];
  paths(): string[];
  hasFile?(path: string): boolean;
  read(path: string): Promise<string>;
  settings(): Pick<PasswordSettings, "storageMode" | "keys" | "legacyKeyId">;
  // Deliberately no password-value or decryption capability.
  secretNames(): string[];
}

export async function inspectNote(path: string, text: string): Promise<NoteRecord> {
  const scan = scanPasswordBlocks(text, path);
  const blocks: BlockRecord[] = [];
  for (const block of scan.blocks) {
    const record: BlockRecord = { path, line: block.line, endLine: block.endLine, ordinal: block.ordinal, title: block.title, digest: await hashText(block.source) };
    try {
      const info = inspectEnvelope(block.source);
      record.version = info.version; record.keyId = info.keyId; record.parity = info.parity;
    } catch {
      // Never copy parser exception text: third-party errors could include payload data.
      record.diagnostic = "Invalid or unrecoverable encrypted envelope";
    }
    blocks.push(record);
  }
  for (const diagnostic of scan.diagnostics) {
    if (diagnostic.line !== undefined && diagnostic.ordinal !== undefined) {
      blocks.push({ path, line: diagnostic.line, endLine: diagnostic.endLine ?? diagnostic.line, ordinal: diagnostic.ordinal, diagnostic: diagnostic.message });
    }
  }
  return { path, hash: await hashText(text), blocks: blocks.sort((a, b) => a.ordinal - b.ordinal),
    diagnostic: scan.diagnostics.find(d => d.line === undefined)?.message };
}

const inside = (path: string, prefix: string): boolean => path === prefix || path.startsWith(`${prefix}/`);

/** Memory-only, lazy catalog. Generation tickets invalidate all stale asynchronous reads. */
export class PasswordBlockIndex {
  private notes = new Map<string, NoteRecord>();
  private generations = new Map<string, number>();
  private pending = new Map<string, number>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private listeners = new Set<() => void>();
  private names = new Set<string>();
  private namesUnavailable = false;
  private serial = 0;
  private running = 0;
  private active = false;
  private disposed = false;
  private error?: string;
  private updatedAt?: number;
  constructor(private host: IndexHost, private debounceMs = 500) {}

  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit(): void { if (!this.disposed) for (const listener of this.listeners) listener(); }
  snapshot(): IndexSnapshot {
    return { notes: [...this.notes.values()].filter(n => n.blocks.length || n.diagnostic).sort((a, b) => a.path.localeCompare(b.path)),
      busy: !!(this.running || this.pending.size || this.timers.size), active: this.active, error: this.error, updatedAt: this.updatedAt, configurationUnavailable: this.host.configurationAvailable?.() === false, scanFolders: [...(this.host.scanFolders?.() ?? [])] };
  }
  private paths(): string[] { return this.host.paths().filter(path => isInScanFolders(path, this.host.scanFolders?.() ?? [])); }
  activate(): void { if (!this.active && !this.disposed) { this.active = true; this.refresh(); } }
  refreshStatuses(force = true): void {
    if (!this.active || this.disposed) return;
    const previousNames = this.names;
    const previousUnavailable = this.namesUnavailable;
    this.names = new Set(); this.namesUnavailable = false;
    // Prompt/session modes do not need to access SecretStorage at all.
    if (this.host.configurationAvailable?.() !== false && this.host.settings().storageMode === "secret-storage") {
      try { this.names = new Set(this.host.secretNames()); } catch { this.namesUnavailable = true; }
    }
    if (force || previousUnavailable !== this.namesUnavailable || previousNames.size !== this.names.size || [...previousNames].some(name => !this.names.has(name))) this.emit();
  }
  status(record: BlockRecord): BlockStatus {
    const settings = this.host.settings();
    const keyId = record.version === 1 ? settings.legacyKeyId : record.keyId ?? "";
    const state = (label: string, attention = false): BlockStatus => ({ label, attention, keyId });
    if (record.diagnostic) return state("Invalid block", true);
    if (this.host.configurationAvailable?.() === false) return state("Configuration unavailable", true);
    if (settings.storageMode === "session") return state("Session mode");
    if (settings.storageMode === "prompt" || !keyId && record.version === 1) return state("Password required");
    const ref = settings.keys[keyId];
    if (!ref) return state("Missing reference", true);
    if (this.namesUnavailable) return state("Secret availability unknown", true);
    return this.names.has(ref.secretId) ? state("Secret available") : state("Missing secret", true);
  }
  refresh(): void {
    if (!this.active || this.disposed) return;
    // Scope changes invalidate old work even if enumerating vault files then fails.
    for (const path of this.generations.keys()) if (!isInScanFolders(path, this.host.scanFolders?.() ?? [])) this.forget(path);
    this.refreshStatuses();
    let paths: string[];
    try { paths = this.paths(); this.error = undefined; }
    catch { this.error = "Cannot list vault notes. Try Refresh."; this.emit(); return; }
    const present = new Set(paths);
    for (const path of this.generations.keys()) if (!present.has(path)) this.forget(path);
    for (const path of paths) this.queue(path, false);
    this.pump(); this.emit();
  }
  /** Pass a file or folder path after create/modify, or new and old paths after rename. */
  changed(path: string, oldPath?: string, debounce = true): void {
    if (!this.active || this.disposed) return;
    if (oldPath !== undefined) this.remove(oldPath);
    let paths: string[];
    try { paths = this.paths().filter(p => inside(p, path)); }
    catch { this.error = "Cannot list changed notes. Try Refresh."; this.emit(); return; }
    const present = new Set(paths);
    for (const known of this.generations.keys()) if (inside(known, path) && !present.has(known)) this.forget(known);
    for (const current of paths) this.queue(current, debounce);
    this.pump(); this.emit();
  }
  /** File events already identify their target; avoid listing the vault or walking the catalog. */
  changedFile(path: string, oldPath?: string, debounce = true): void {
    if (!this.active || this.disposed) return;
    let removed = oldPath !== undefined && this.forget(oldPath);
    if (!/\.md$/i.test(path) || !isInScanFolders(path, this.host.scanFolders?.() ?? []) || this.host.hasFile?.(path) === false) {
      removed = this.forget(path) || removed;
      if (removed) this.emit();
      return;
    }
    this.queue(path, debounce);
    this.pump(); this.emit();
  }
  removeFile(path: string): void {
    if (!this.active || this.disposed) return;
    if (this.forget(path)) this.emit();
  }
  remove(prefix: string): void {
    if (!this.active || this.disposed) return;
    for (const path of this.generations.keys()) if (inside(path, prefix)) this.forget(path);
    this.emit();
  }
  private forget(path: string): boolean {
    const known = this.generations.has(path);
    clearTimeout(this.timers.get(path)); this.timers.delete(path); this.pending.delete(path);
    this.generations.delete(path); this.notes.delete(path);
    return known;
  }
  private queue(path: string, debounce: boolean): void {
    const ticket = ++this.serial;
    this.generations.set(path, ticket); this.pending.delete(path);
    clearTimeout(this.timers.get(path)); this.timers.delete(path);
    if (debounce) this.timers.set(path, setTimeout(() => {
      this.timers.delete(path);
      if (!this.disposed && this.generations.get(path) === ticket) { this.pending.set(path, ticket); this.pump(); this.emit(); }
    }, this.debounceMs));
    else this.pending.set(path, ticket);
  }
  private pump(): void {
    if (this.disposed) return;
    while (this.running < 2 && this.pending.size) {
      const [path, ticket] = this.pending.entries().next().value!;
      this.pending.delete(path); this.running++;
      void this.readOne(path, ticket);
    }
  }
  private async readOne(path: string, ticket: number): Promise<void> {
    let note: NoteRecord;
    try { note = await inspectNote(path, await this.host.read(path)); }
    catch { note = { path, blocks: [], diagnostic: "Cannot read or scan this note. Try Refresh." }; }
    if (!this.disposed && this.generations.get(path) === ticket) { this.notes.set(path, note); this.updatedAt = Date.now(); }
    this.running--; this.pump(); this.emit();
  }
  async resolveJump(record: BlockRecord): Promise<{ path: string; line: number }> {
    const before = this.notes.get(record.path);
    const ticket = this.generations.get(record.path);
    const fail = (): never => { this.changedFile(record.path, undefined, false); throw new Error("This block moved, changed, or is ambiguous. The catalog was refreshed; select the block again."); };
    if (this.disposed || !before || !before.blocks.includes(record) || ticket === undefined) return fail();
    let current: NoteRecord;
    try { current = await inspectNote(record.path, await this.host.read(record.path)); } catch { return fail(); }
    if (this.disposed || this.generations.get(record.path) !== ticket) return fail();
    const candidates = current.blocks.filter(b => record.digest ? b.digest === record.digest : b.ordinal === record.ordinal && b.line === record.line && b.diagnostic === record.diagnostic);
    const originalCandidates = before.blocks.filter(b => b.digest === record.digest);
    const sameNote = before.hash === current.hash;
    // Duplicate payloads have no persistent identity. Only an unchanged note is unambiguous.
    if (!sameNote && (!record.digest || candidates.length !== 1 || originalCandidates.length !== 1)) return fail();
    const found = sameNote ? candidates.find(b => b.ordinal === record.ordinal && b.line === record.line) : candidates[0];
    if (!found) return fail();
    this.notes.set(record.path, current); this.emit();
    return { path: record.path, line: found.line };
  }
  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear(); this.pending.clear(); this.generations.clear(); this.notes.clear(); this.names.clear(); this.listeners.clear();
  }
}
