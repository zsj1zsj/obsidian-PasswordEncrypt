import type { EventRef, Vault } from "obsidian";

/** A settings-session cache; failed reads are retried after a directory event or reopening. */
export class FolderDirectory {
  private cached?: string[] | null;
  private events: EventRef[] = [];
  private disposed = false;
  constructor(private vault: Vault, changed: () => void) {
    const invalidate = (file: { path: string }) => {
      if (this.disposed || !("children" in file)) return;
      this.cached = undefined;
      changed();
    };
    this.events.push(vault.on("create", invalidate), vault.on("delete", invalidate), vault.on("rename", invalidate));
  }
  paths(): string[] | null {
    if (this.disposed) return null;
    if (this.cached === undefined) {
      try {
        this.cached = this.vault.getAllLoadedFiles()
          .filter(file => "children" in file && file.path && file.path !== "/")
          .map(folder => folder.path).sort((a, b) => a.localeCompare(b));
      } catch { this.cached = null; }
    }
    return this.cached;
  }
  dispose(): void {
    this.disposed = true;
    for (const event of this.events) this.vault.offref(event);
    this.events = []; this.cached = undefined;
  }
}
