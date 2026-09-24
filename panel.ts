import { ItemView, WorkspaceLeaf } from "obsidian";
import { BlockRecord, PasswordBlockIndex } from "./block-index";
import { DEFAULT_BLOCK_TITLE } from "./block-title";

export const PASSWORD_BLOCKS_VIEW = "encrypt-password-blocks-catalog";
type Filter = "All" | "Needs attention" | "EPB1" | "EPB2";

/** DOM-only catalog, shared by the Obsidian view and integration tests. */
export class PasswordBlocksPanel {
  private query = "";
  private filter: Filter = "All";
  private limit = 100;
  private expanded = new Set<string>();
  private rows = new Map<string, HTMLElement>();
  private navigating = new Set<string>();
  private unsubscribe: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private summary: HTMLElement;
  private scopeEl: HTMLElement;
  private statusEl: HTMLElement;
  private list: HTMLElement;
  private refreshButton: HTMLButtonElement;
  private search: HTMLInputElement;
  private moreButton?: HTMLButtonElement;
  private focus = (): void => { this.index.refreshStatuses(false); };
  constructor(private root: HTMLElement, private index: PasswordBlockIndex, private navigate: (record: BlockRecord) => Promise<void>, private notify: (message: string) => void) {
    root.replaceChildren(); root.classList.add("epb-catalog");
    this.element(root, "h2", "Password Blocks");
    const toolbar = this.element(root, "div"); toolbar.className = "epb-catalog-toolbar";
    const search = this.search = this.element(toolbar, "input"); search.type = "search"; search.placeholder = "Search titles, notes or key IDs"; search.setAttribute("aria-label", "Search titles, notes or key IDs");
    search.addEventListener("input", () => { this.query = search.value.toLowerCase().trim(); this.limit = 100; this.render(); });
    const filter = this.element(toolbar, "select"); filter.setAttribute("aria-label", "Filter password blocks");
    for (const label of ["All", "Needs attention", "EPB1", "EPB2"]) this.element(filter, "option", label).value = label;
    filter.addEventListener("change", () => { this.filter = filter.value as Filter; this.limit = 100; this.render(); });
    this.refreshButton = this.element(toolbar, "button", "Refresh");
    this.refreshButton.addEventListener("click", () => { this.index.refresh(); });
    this.summary = this.element(root, "p"); this.summary.className = "epb-catalog-summary";
    this.scopeEl = this.element(root, "p"); this.scopeEl.className = "epb-catalog-hint";
    this.statusEl = this.element(root, "p"); this.statusEl.setAttribute("role", "status");
    this.element(root, "p", "Read-only catalog. Not decrypted: format checks and secret availability do not verify the password.").className = "epb-catalog-hint";
    this.list = this.element(root, "div"); this.list.className = "epb-catalog-list";
    this.unsubscribe = index.subscribe(() => {
      if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; if (!this.disposed) this.render(); }, 100);
    });
    root.addEventListener("focusin", this.focus);
    root.ownerDocument.defaultView?.addEventListener("focus", this.focus);
    this.render();
  }
  private element<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, text?: string): HTMLElementTagNameMap[K] {
    const el = this.root.ownerDocument.createElement(tag);
    if (text !== undefined) el.textContent = text;
    parent.append(el); return el;
  }
  private identity(block: BlockRecord): string { return JSON.stringify([block.path, block.ordinal, block.digest ?? null]); }
  render(): void {
    if (this.disposed) return;
    const snapshot = this.index.snapshot();
    this.scopeEl.textContent = snapshot.scanFolders.length ? `Scan scope (including subfolders): ${snapshot.scanFolders.join(", ")}` : "Scan scope: entire vault";
    const all = snapshot.notes.flatMap(n => n.blocks);
    const identities = new Set(all.map(block => this.identity(block)));
    const previousRows = [...this.rows];
    const active = this.root.ownerDocument.activeElement;
    const focusedIndex = previousRows.findIndex(([, row]) => row.contains(active));
    const focusedIdentity = previousRows[focusedIndex]?.[0];
    const focusedSummary = active?.tagName === "SUMMARY";
    const moreFocused = active === this.moreButton;
    const rootScroll = this.root.scrollTop, listScroll = this.list.scrollTop;
    // Read the current DOM state: a native details toggle event may still be queued.
    for (const [identity, row] of previousRows) {
      if (row.querySelector("details")?.open) this.expanded.add(identity);
      else this.expanded.delete(identity);
    }
    for (const identity of this.expanded) if (!identities.has(identity)) this.expanded.delete(identity);
    const issues = all.filter(b => this.index.status(b).attention).length + snapshot.notes.filter(n => n.diagnostic).length;
    this.summary.textContent = `${all.length} blocks · ${snapshot.notes.length} notes · ${issues} issues`;
    this.statusEl.textContent = (snapshot.configurationUnavailable ? "Read-only recovery mode. Configuration unavailable. " : "") + (snapshot.error ?? (snapshot.busy ? "Scanning / updating…" : snapshot.active ? "Up to date" : "Waiting for initial scan…"));
    this.statusEl.className = snapshot.error || snapshot.configurationUnavailable ? "epb-error" : "";
    this.refreshButton.disabled = snapshot.busy;
    this.list.replaceChildren();
    this.rows.clear(); this.moreButton = undefined;
    let matched = 0; let shown = 0;
    for (const note of snapshot.notes) {
      const pathMatches = note.path.toLowerCase().includes(this.query);
      const records = note.blocks.filter(block => {
        const status = this.index.status(block);
        return (pathMatches || (block.title ?? DEFAULT_BLOCK_TITLE).toLowerCase().includes(this.query) || status.keyId.toLowerCase().includes(this.query)) &&
          (this.filter === "All" || this.filter === "Needs attention" && status.attention || this.filter === `EPB${block.version}`);
      });
      const showDiagnostic = note.diagnostic && pathMatches && (this.filter === "All" || this.filter === "Needs attention");
      if (!records.length && !showDiagnostic) continue;
      matched += records.length + (showDiagnostic ? 1 : 0);
      if (shown >= this.limit) continue;
      const group = this.element(this.list, "section"); group.className = "epb-catalog-note";
      this.element(group, "h3", note.path);
      if (showDiagnostic) { this.element(group, "p", note.diagnostic).className = "epb-error"; shown++; }
      for (const block of records) {
        if (shown >= this.limit) break;
        shown++;
        const status = this.index.status(block);
        const identity = this.identity(block);
        const row = this.element(group, "article"); row.className = "epb-catalog-block";
        this.rows.set(identity, row);
        this.element(row, "h4", block.title ?? DEFAULT_BLOCK_TITLE);
        const button = this.element(row, "button", `Line ${block.line} · ${block.version ? `EPB${block.version}` : "Unknown format"}`);
        button.setAttribute("aria-label", `Open ${block.title ?? DEFAULT_BLOCK_TITLE} in ${note.path} at line ${block.line}`);
        button.disabled = this.navigating.has(identity);
        button.addEventListener("click", async () => {
          if (this.navigating.has(identity)) return;
          this.navigating.add(identity);
          button.disabled = true;
          try { await this.navigate(block); }
          catch (error) { if (!this.disposed) this.notify(error instanceof Error ? error.message : "Cannot open this block"); }
          finally {
            this.navigating.delete(identity);
            if (!this.disposed) {
              const current = this.rows.get(identity)?.querySelector("button");
              if (current) current.disabled = false;
            }
          }
        });
        this.element(row, "p", `${status.label} · Not decrypted`).className = status.attention ? "epb-error" : "epb-catalog-hint";
        if (block.diagnostic) this.element(row, "p", block.diagnostic).className = "epb-error";
        if (status.keyId) {
          const details = this.element(row, "details");
          details.open = this.expanded.has(identity);
          this.element(details, "summary", `Key: ${status.keyId.length > 12 ? `${status.keyId.slice(0, 12)}…` : status.keyId}`);
          this.element(details, "code", status.keyId);
          if (block.parity !== undefined) this.element(details, "p", `Parity bytes: ${block.parity}`);
          details.addEventListener("toggle", () => {
            if (this.rows.get(identity) !== row) return;
            if (details.open) this.expanded.add(identity); else this.expanded.delete(identity);
          });
        } else this.element(row, "p", "No key ID").className = "epb-catalog-hint";
      }
    }
    if (!matched) this.element(this.list, "p", snapshot.busy ? "Scanning notes…" : snapshot.notes.length ? "No matching password blocks." : "No password blocks found in Markdown notes within the scan scope.");
    if (matched > shown) {
      const more = this.element(this.list, "button", `Load more (${shown}/${matched})`);
      this.moreButton = more;
      more.addEventListener("click", () => { this.limit += 100; this.render(); });
    }
    // Restore only focus removed by this render. Search, outside controls, and
    // navigation already in flight retain ownership of keyboard focus.
    const document = this.root.ownerDocument;
    if ((focusedIdentity !== undefined || moreFocused) &&
        (document.activeElement === document.body || document.activeElement === active)) {
      const currentRows = [...this.rows.values()];
      const row = focusedIdentity === undefined ? undefined : this.rows.get(focusedIdentity) ?? currentRows[Math.min(focusedIndex, currentRows.length - 1)];
      if (focusedIdentity === undefined || focusedSummary || !this.navigating.has(focusedIdentity)) {
        const target = moreFocused ? this.moreButton ?? currentRows[currentRows.length - 1]?.querySelector("button:enabled") :
          (focusedSummary ? row?.querySelector("summary") : undefined) ?? row?.querySelector("button:enabled");
        ((target as HTMLElement | undefined) ?? this.search).focus({ preventScroll: true });
      }
    }
    this.root.scrollTop = rootScroll; this.list.scrollTop = listScroll;
  }
  dispose(): void {
    this.disposed = true; clearTimeout(this.timer); this.unsubscribe(); this.expanded.clear(); this.rows.clear(); this.navigating.clear();
    this.root.removeEventListener("focusin", this.focus);
    this.root.ownerDocument.defaultView?.removeEventListener("focus", this.focus);
    this.root.replaceChildren();
  }
}

export class PasswordBlocksView extends ItemView {
  private panel?: PasswordBlocksPanel;
  constructor(leaf: WorkspaceLeaf, private index: PasswordBlockIndex, private activate: () => void,
    private navigate: (record: BlockRecord) => Promise<void>, private notify: (message: string) => void) { super(leaf); }
  getViewType(): string { return PASSWORD_BLOCKS_VIEW; }
  getDisplayText(): string { return "Password Blocks"; }
  getIcon(): string { return "key-round"; }
  async onOpen(): Promise<void> {
    this.panel?.dispose();
    this.activate();
    this.panel = new PasswordBlocksPanel(this.contentEl, this.index, this.navigate, this.notify);
  }
  async onClose(): Promise<void> { this.panel?.dispose(); this.panel = undefined; }
}
