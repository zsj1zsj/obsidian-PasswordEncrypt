import { App, Editor, MarkdownPostProcessorContext, MarkdownRenderChild, normalizePath, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { decryptSecret, encryptSecret, inspectEnvelope } from "./codec";
import { Cancelled, CHECK_TEXT, PasswordManager, randomKeyId, StorageMode } from "./passwords";
import { findPasswordBlocks, hashText, MigrationTask, replacePayloads, scanPasswordBlocks, ScannedNote, validateTask, writeMigration } from "./rotation";
import { choose, ProgressModal, promptValue, RevealController, ValueOptions } from "./ui";
import { DEFAULT_BLOCK_TITLE, formatBlockTitle, normalizeBlockTitle, replaceBlockTitle } from "./block-title";
import { BlockRenderCache } from "./block-render-cache";
import { BlockRecord, PasswordBlockIndex } from "./block-index";
import { PASSWORD_BLOCKS_VIEW, PasswordBlocksView } from "./panel";
import { ConfigurationStore, ConfigState, defaults, EpbSettings } from "./config";
import { normalizeScanFolders } from "./scan-scope";
import { attachFolderAutocomplete } from "./folder-autocomplete";
import { FolderDirectory } from "./folder-directory";
export type { EpbSettings } from "./config";

function message(error: unknown): string { return error instanceof Error ? error.message : "An unknown error occurred"; }

class EpbSettingTab extends PluginSettingTab {
  private folderDraft?: string;
  private savingFolders = false;
  private visible = false;
  private cleanupFolders?: () => void;
  constructor(app: App, private plugin: EncryptPlugin) { super(app, plugin); }
  hide(): void { this.visible = false; this.cleanupFolders?.(); this.cleanupFolders = undefined; }
  dispose(): void { this.hide(); this.clearFolderDraft(); }
  clearFolderDraft(): void { this.folderDraft = undefined; }
  private redisplay(): void { if (this.visible) this.display(); }
  display(): void {
    this.cleanupFolders?.(); this.cleanupFolders = undefined; this.visible = true;
    const el = this.containerEl; el.empty(); el.createEl("h2", { text: "Encrypted Password Blocks" });
    new Setting(el).setName("Password Blocks")
      .setDesc("Browse a read-only catalog of encrypted blocks, locations, and key references. No passwords are decrypted.")
      .addButton(b => b.setButtonText("Open Password Blocks").onClick(() => { void this.plugin.openPasswordBlocks(); }));
    new Setting(el).setName("Configuration status")
      .setDesc(this.plugin.configurationState === "ready" ? "Configuration is ready. data.json contains settings, secret references, encrypted checks, and the latest migration record; not the catalog or plaintext passwords." : `${this.plugin.configurationState === "conflict" ? "Configuration changed externally" : "Read-only recovery mode"}. ${this.plugin.configurationDiagnostic}`);
    if (this.plugin.configurationState !== "ready") {
      el.createEl("p", { text: "Writing is disabled. You can browse Password Blocks and reveal existing blocks by entering the original master password. No stored passwords are read or saved. Restore data.json before retrying; there is no automatic reset or merge." });
      new Setting(el).addButton(b => b.setButtonText(this.plugin.configurationState === "conflict" ? "Reload configuration" : "Retry loading configuration").onClick(async () => {
        b.setDisabled(true); try { await this.plugin.reloadConfiguration(); } finally { this.redisplay(); }
      }));
      new Setting(el).addButton(b => b.setButtonText("Lock").onClick(() => this.plugin.lock()));
      return;
    }
    const savedFolders = this.plugin.settings.scanFolders.join("\n");
    let folderInput = this.folderDraft ?? savedFolders;
    let folderInputEl!: HTMLTextAreaElement;
    let updateFeedback = () => {};
    let refreshAutocomplete = () => {};
    const directory = new FolderDirectory(this.app.vault, () => { updateFeedback(); refreshAutocomplete(); });
    let disposeAutocomplete = () => {};
    this.cleanupFolders = () => { directory.dispose(); disposeAutocomplete(); };
    new Setting(el).setName("Password Blocks scan folders")
      .setDesc("One vault-relative folder per line, including subfolders. Type to autocomplete any folder or subfolder by name or path; use arrow keys and Enter, or click a suggestion. Leave empty for the whole vault. Paths are case-sensitive; missing folders match nothing. This only limits the catalog. Master-password safety checks and migration still cover the whole vault.")
      .addTextArea(text => {
        text.setPlaceholder("Passwords\nWork/Accounts").setValue(folderInput).onChange(value => {
          folderInput = value; this.folderDraft = value === savedFolders ? undefined : value; updateFeedback();
        });
        folderInputEl = text.inputEl; folderInputEl.disabled = this.savingFolders;
        text.inputEl.rows = 4; text.inputEl.classList.add("epb-scan-folders"); text.inputEl.setAttribute("aria-label", "Password Blocks scan folders");
        const autocomplete = attachFolderAutocomplete(text.inputEl, () => directory.paths());
        disposeAutocomplete = () => autocomplete.dispose(); refreshAutocomplete = () => autocomplete.refresh();
      })
      .addButton(button => button.setButtonText("Save scan folders").setDisabled(this.savingFolders).onClick(async () => {
        if (this.savingFolders) return;
        this.savingFolders = true; button.setDisabled(true); folderInputEl.disabled = true;
        // Preserve the submitted text even if a failed save switches to recovery mode.
        this.folderDraft = folderInput;
        try { await this.plugin.setScanFolders(folderInput.split(/\r?\n/)); this.clearFolderDraft(); new Notice("Scan folders saved. The catalog now uses the updated scope."); }
        catch (error) { new Notice(message(error)); }
        finally { this.savingFolders = false; button.setDisabled(false); folderInputEl.disabled = false; this.redisplay(); }
      }));
    const feedback = el.createEl("div", { cls: "epb-folder-feedback", attr: { "aria-live": "polite" } });
    updateFeedback = () => {
      feedback.empty();
      if (this.folderDraft !== undefined) feedback.createEl("p", { text: "Unsaved changes" });
      const paths = directory.paths();
      const present = paths === null ? null : new Set(paths);
      if (!present) feedback.createEl("p", { text: "Cannot check folders. Reopen settings to retry. You can still save valid paths." });
      folderInput.split(/\r?\n/).forEach((line, index) => {
        try {
          const [path] = normalizeScanFolders([line]);
          if (path && present && !present.has(path)) feedback.createEl("p", { text: `Line ${index + 1}: Folder not found: ${path}. You can still save it.`, cls: "epb-folder-warning" });
        } catch { feedback.createEl("p", { text: `Line ${index + 1}: Invalid vault-relative folder path. Remove absolute paths, control characters, and . or .. segments before saving.`, cls: "epb-error" }); }
      });
    };
    updateFeedback();
    const record = this.plugin.settings.migration;
    new Setting(el).setName("Migration record")
      .setDesc(record ? `Latest record: ${record.state}; ${record.notes.length} notes; ${record.notes.reduce((sum, note) => sum + note.blocks.length, 0)} blocks; target key ${record.targetKeyId}; ${new TextEncoder().encode(JSON.stringify(record)).length} bytes. Only the latest record is retained.` : "No migration record is retained.")
      .addButton(b => b.setButtonText("Clear completed migration record").setDisabled(!record || record.state !== "complete" || record.notes.some(n => !n.done) || this.plugin.isBusy)
        .onClick(async () => { b.setDisabled(true); try { await this.plugin.clearCompletedMigration(); } finally { this.redisplay(); } }));
    new Setting(el).setName("Master password storage")
      .setDesc("Switching modes preserves old secrets. Prompt mode never reads stored passwords automatically. Session mode forgets passwords on Lock or exit.")
      .addDropdown(d => d.addOptions({ "secret-storage": "SecretStorage", session: "Remember for this session", prompt: "Ask every time" })
        .setValue(this.plugin.settings.storageMode).onChange(async mode => {
          try { await this.plugin.setStorageMode(mode as StorageMode); } catch (e) { new Notice(message(e)); } finally { this.redisplay(); }
        }));
    new Setting(el).setName("Master password")
      .setDesc("Scan this vault before changing the password. You can re-encrypt existing blocks or use the new password for new blocks only.")
      .addButton(b => b.setButtonText("Change master password").onClick(async () => {
        b.setDisabled(true); try { await this.plugin.changeMasterPassword(); } finally { b.setDisabled(false); }
      }));
    new Setting(el).setName("Lock")
      .setDesc("Hide all plaintext and clear session passwords. SecretStorage entries are retained; in that mode, Reveal can read them again.")
      .addButton(b => b.setButtonText("Lock").onClick(() => this.plugin.lock()));
    new Setting(el).setName("Migration recovery")
      .setDesc("Resume an interrupted migration with its original target key. Other notes can be edited, but prepared target notes must not change.")
      .addButton(b => b.setButtonText("Resume migration").onClick(async () => {
        b.setDisabled(true); try { await this.plugin.resumeMigration(); } finally { b.setDisabled(false); }
      }));
    new Setting(el).setName("Error-correction parity bytes")
      .setDesc("Default 32: repairs up to 16 byte errors per codeword. Larger values increase ciphertext size.")
      .addSlider(s => s.setLimits(8, 64, 2).setValue(this.plugin.settings.parity).setDynamicTooltip().onChange(async n => {
        try { await this.plugin.setNumericSetting("parity", n); } catch (e) { new Notice(message(e)); }
      }));
    new Setting(el).setName("Automatically hide plaintext")
      .setDesc("Seconds before plaintext is hidden (10–300; default 30). Saved when you leave the field. Losing window focus also hides it without clearing session passwords.")
      .addText(text => {
        text.setPlaceholder("30").setValue(String(this.plugin.settings.autoHideSeconds));
        text.inputEl.setAttribute("inputmode", "numeric");
        text.inputEl.setAttribute("aria-label", "Automatically hide plaintext");
        text.inputEl.addEventListener("change", async () => {
          const value = text.inputEl.value.trim();
          text.inputEl.disabled = true;
          try {
            if (!/^\d+$/.test(value) || Number(value) < 10 || Number(value) > 300) throw new Error("Enter a whole number of seconds from 10 to 300.");
            await this.plugin.setNumericSetting("autoHideSeconds", Number(value));
          } catch (error) { new Notice(message(error)); }
          finally { text.setValue(String(this.plugin.settings.autoHideSeconds)); text.inputEl.disabled = false; }
        });
      });
    el.createEl("p", { text: "Missing a stored secret? Reveal offers recovery with your original master password. Changing secrets directly in Obsidian bypasses this plugin's migration checks. Historical copies still need their original passwords." });
  }
}

export default class EncryptPlugin extends Plugin {
  settings: EpbSettings = defaults();
  passwords!: PasswordManager;
  private rotating = false;
  private stopped = false;
  private operationEpoch = 0;
  private config!: ConfigurationStore;
  private activeOperations = 0;
  private operationWaiters = new Set<() => void>();
  private reloading = false;
  private operationAbort = new AbortController();
  private settingTab?: EpbSettingTab;
  private views = new Set<RevealController>();
  private blockRenderCache = new BlockRenderCache();
  blockIndex!: PasswordBlockIndex;
  private indexEventsRegistered = false;
  private openingPanel?: Promise<void>;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.blockIndex = new PasswordBlockIndex({
      paths: () => this.app.vault.getMarkdownFiles().map(file => file.path),
      read: path => this.app.vault.read(this.file(path)),
      hasFile: path => this.app.vault.getFileByPath(path) != null,
      settings: () => this.settings,
      secretNames: () => this.app.secretStorage.listSecrets(),
      configurationAvailable: () => this.configurationState === "ready",
      scanFolders: () => this.settings.scanFolders,
    });
    this.registerView(PASSWORD_BLOCKS_VIEW, leaf => new PasswordBlocksView(leaf, this.blockIndex,
      () => this.activateBlockIndex(), record => this.openIndexedBlock(record), text => { new Notice(text); }));
    this.createPasswordManager();
    this.registerMarkdownCodeBlockProcessor("password", (source, el, ctx) => this.renderBlock(source, el, ctx));
    this.addCommand({ id: "insert-password-block", name: "Insert encrypted password block", editorCallback: editor => { void this.insertBlock(editor); } });
    this.addCommand({ id: "lock", name: "Lock and hide all passwords", callback: () => this.lock() });
    this.addCommand({ id: "resume-migration", name: "Resume password migration", callback: () => { void this.resumeMigration(); } });
    this.addCommand({ id: "open-password-blocks", name: "Open Password Blocks", callback: () => { void this.openPasswordBlocks(); } });
    this.settingTab = new EpbSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    if (this.settings.migration && this.settings.migration.state !== "complete") new Notice("An unfinished password migration is available. Use Resume migration to continue.", 10000);
  }
  private createPasswordManager(): void {
    this.passwords?.lock();
    this.passwords = new PasswordManager({
      settings: this.settings,
      ensureWritable: () => this.ensureWritable(),
      getSecret: id => { this.assertWritable(); return this.app.secretStorage.getSecret(id); },
      setSecret: (id, value) => { this.assertWritable(); this.app.secretStorage.setSecret(id, value); },
      save: () => this.saveSettings(),
      prompt: title => this.prompt(title),
      verifyExisting: (keyId, master) => this.verifyExistingPassword(keyId, master),
      confirmSave: async () => await this.choose("Password verified", "The original password successfully decrypted this block. Save a new SecretStorage reference for this key? Existing secret entries will not be overwritten.", ["Use once", "Save recovered password"]) === "Save recovered password",
    });
  }
  onunload(): void {
    this.settingTab?.dispose();
    this.stopped = true; this.lock();
    this.config?.dispose();
    this.blockIndex?.dispose();
    this.app.workspace?.detachLeavesOfType(PASSWORD_BLOCKS_VIEW);
    for (const view of this.views) view.dispose();
    this.views.clear();
  }
  private activateBlockIndex(): void {
    if (this.stopped) return;
    if (!this.indexEventsRegistered) {
      this.indexEventsRegistered = true;
      const vault = this.app.vault;
      this.registerEvent(vault.on("create", file => "children" in file ? this.blockIndex.changed(file.path, undefined, false) : this.blockIndex.changedFile(file.path, undefined, false)));
      this.registerEvent(vault.on("modify", file => "children" in file ? this.blockIndex.changed(file.path) : this.blockIndex.changedFile(file.path)));
      this.registerEvent(vault.on("delete", file => "children" in file ? this.blockIndex.remove(file.path) : this.blockIndex.removeFile(file.path)));
      this.registerEvent(vault.on("rename", (file, oldPath) => "children" in file ? this.blockIndex.changed(file.path, oldPath, false) : this.blockIndex.changedFile(file.path, oldPath, false)));
      this.registerEvent(this.app.workspace.on("active-leaf-change", leaf => {
        if (leaf?.view.getViewType() === PASSWORD_BLOCKS_VIEW) this.blockIndex.refreshStatuses(false);
      }));
    }
    this.blockIndex.activate(); this.blockIndex.refreshStatuses();
  }
  async openPasswordBlocks(): Promise<void> {
    if (this.stopped) return;
    if (this.openingPanel) return this.openingPanel;
    this.openingPanel = (async () => {
      try {
        const workspace = this.app.workspace;
        let leaf = workspace.getLeavesOfType(PASSWORD_BLOCKS_VIEW)[0];
        if (!leaf) {
          leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf("tab");
          await leaf.setViewState({ type: PASSWORD_BLOCKS_VIEW, active: true });
        }
        if (!this.stopped) { await workspace.revealLeaf(leaf); this.blockIndex.refreshStatuses(); }
      } catch { new Notice("Cannot open Password Blocks. Try reopening the panel."); }
    })();
    try { await this.openingPanel; } finally { this.openingPanel = undefined; }
  }
  private async openIndexedBlock(record: BlockRecord): Promise<void> {
    const target = await this.blockIndex.resolveJump(record);
    if (this.stopped) return;
    const file = this.file(target.path);
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file, { active: true, eState: { line: target.line - 1 } });
  }
  lock(): void {
    this.operationEpoch++; this.passwords?.lock();
    this.blockRenderCache.clear();
    this.operationAbort.abort(); this.operationAbort = new AbortController();
    for (const view of this.views) view.hide();
  }
  get configurationState(): ConfigState { return this.config?.state ?? "recovery"; }
  get configurationDiagnostic(): string { return this.config?.diagnostic ?? "Configuration is unavailable."; }
  get isBusy(): boolean { return !!(this.activeOperations || this.reloading || this.rotating); }
  private prompt(title: string, options?: ValueOptions): Promise<string | null> { return promptValue(this.app, title, this.operationAbort.signal, options); }
  private choose(title: string, text: string, options: string[]): Promise<string | null> { return choose(this.app, title, text, options, this.operationAbort.signal); }
  private endOperation(): void {
    this.activeOperations--;
    if (!this.activeOperations) { for (const resolve of this.operationWaiters) resolve(); this.operationWaiters.clear(); }
  }
  private assertWritable(): void {
    if (this.stopped || this.reloading) throw new Cancelled();
    this.config.assertReady();
  }
  private async ensureWritable(epoch = this.operationEpoch): Promise<void> {
    this.assertWritable(); await this.config.checkpoint(); this.assertRunning(epoch); this.assertWritable();
  }
  async setStorageMode(mode: StorageMode): Promise<void> {
    this.assertWritable();
    if (this.rotating) throw new Error("Finish or pause the migration before switching storage modes");
    if (!["secret-storage", "session", "prompt"].includes(mode)) throw new Error("Invalid storage mode");
    const previous = this.settings.storageMode;
    this.lock(); this.settings.storageMode = mode;
    this.activeOperations++;
    try { await this.saveSettings(); } catch (e) { this.settings.storageMode = previous; throw e; } finally { this.endOperation(); }
  }
  async setNumericSetting(name: "parity" | "autoHideSeconds", value: number): Promise<void> {
    this.assertWritable();
    if (this.isBusy) throw new Error("Finish the current operation before changing settings.");
    if (!Number.isInteger(value) || (name === "parity" ? value < 8 || value > 64 || value % 2 !== 0 : value < 10 || value > 300)) throw new Error("Invalid setting value.");
    const previous = this.settings[name]; this.settings[name] = value; this.activeOperations++;
    try { await this.saveSettings(); } catch (error) { this.settings[name] = previous; throw error; } finally { this.endOperation(); }
  }
  async setScanFolders(value: unknown): Promise<void> {
    this.assertWritable();
    if (this.isBusy) throw new Error("Finish the current operation before changing scan folders.");
    const folders = normalizeScanFolders(value);
    const epoch = this.operationEpoch; this.activeOperations++;
    try {
      await this.ensureWritable(epoch);
      // Publish the new scope only after the guarded save succeeds.
      await this.config.save({ ...this.settings, scanFolders: folders }); this.assertRunning(epoch);
      this.settings.scanFolders = folders;
      this.blockIndex?.refresh();
    } finally { this.endOperation(); }
  }
  async loadSettings(): Promise<void> {
    if (!this.config) {
      const directory = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
      const path = normalizePath(`${directory}/data.json`);
      this.config = new ConfigurationStore({
        read: async () => await this.app.vault.adapter.exists(path) ? this.app.vault.adapter.read(path) : null,
        write: value => this.saveData(value),
        protected: (_state, diagnostic) => {
          this.lock(); this.blockIndex?.refreshStatuses();
          if (!this.reloading) new Notice(`${diagnostic} Read-only recovery is available.`, 12000);
          this.refreshSettingsView();
        },
      });
    }
    const loaded = await this.config.load();
    if (!loaded) return;
    this.settings = loaded.settings;
    if (loaded.legacyMaster) {
      const epoch = this.operationEpoch;
      try {
        await this.config.checkpoint();
        this.assertRunning(epoch);
        const id = randomKeyId(); const secretId = `encrypt-password-blocks-${id}`;
        const keyId = this.settings.legacyKeyId || id;
        const check = await encryptSecret(CHECK_TEXT, loaded.legacyMaster, 32, keyId);
        await this.config.checkpoint(); this.assertRunning(epoch);
        this.app.secretStorage.setSecret(secretId, loaded.legacyMaster);
        if (this.app.secretStorage.getSecret(secretId) !== loaded.legacyMaster) throw new Error("Legacy migration verification failed");
        this.settings.keys[keyId] = { secretId, createdAt: Date.now() }; this.settings.legacyKeyId = keyId;
        this.settings.keyChecks[keyId] = check;
        if (!this.settings.activeKeyId) this.settings.activeKeyId = keyId;
        await this.config.save(this.settings);
        new Notice("The legacy master password was migrated to SecretStorage.");
      } catch {
        if (this.configurationState === "ready") this.config.protect("recovery", "Legacy password migration could not be verified. Preserve data.json; any newly created secret entry is retained.");
      }
    }
  }
  async saveSettings(): Promise<void> {
    this.assertWritable();
    await this.config.save(this.settings);
    this.blockIndex?.refreshStatuses();
  }
  async onExternalSettingsChange(): Promise<void> { await this.config?.externalChange(); }
  private refreshSettingsView(): void {
    if (!this.stopped && this.settingTab?.containerEl?.isConnected) this.settingTab.display();
  }
  async reloadConfiguration(): Promise<void> {
    if (this.stopped || this.reloading) return;
    if (await this.choose("Reload configuration", "Discard unsaved in-memory settings and load the current data.json? Active password operations will be cancelled. No configuration is merged or overwritten.", ["Reload configuration"]) !== "Reload configuration") return;
    this.reloading = true; this.lock();
    this.config.protect("conflict", "Reloading configuration. Writing is paused.");
    try {
      if (this.activeOperations) await new Promise<void>(resolve => this.operationWaiters.add(resolve));
      await this.config.idle();
      if (this.stopped) return;
      await this.loadSettings();
      if (this.stopped) return;
      this.createPasswordManager(); this.blockIndex?.refresh();
      if (this.configurationState === "ready") { this.settingTab?.clearFolderDraft(); new Notice("Configuration reloaded. Previous password operations remain cancelled."); }
    } finally { this.reloading = false; this.refreshSettingsView(); }
  }
  async clearCompletedMigration(): Promise<void> {
    if (this.isBusy) { new Notice("Finish the current operation before clearing the record."); return; }
    this.activeOperations++;
    const epoch = this.operationEpoch;
    let record: MigrationTask | undefined;
    try {
      await this.ensureWritable(epoch);
      record = validateTask(this.settings.migration);
      if (!record || record.state !== "complete" || record.notes.some(n => !n.done)) throw new Error("Only a valid completed migration record can be cleared.");
      const fingerprint = await hashText(JSON.stringify(record));
      const answer = await this.choose("Clear completed migration record", "Remove only the latest migration record from data.json? Notes, stored passwords, key references, and encrypted checks are retained. This does not erase historical copies in sync services or backups.", ["Clear record"]);
      this.assertRunning(epoch); if (answer !== "Clear record") return;
      await this.ensureWritable(epoch);
      if (this.settings.migration !== record || await hashText(JSON.stringify(record)) !== fingerprint) throw new Error("The migration record changed. Nothing was cleared.");
      validateTask(record);
      this.settings.migration = undefined;
      try { await this.saveSettings(); } catch (error) { this.settings.migration = record; throw error; }
      new Notice("Completed migration record cleared. Notes and keys were retained. Recovery of the removed record requires an existing backup or sync history.");
    } catch (error) { if (!(error instanceof Cancelled)) new Notice(message(error)); }
    finally { this.endOperation(); this.refreshSettingsView(); }
  }
  private assertRunning(epoch: number, progress?: ProgressModal): void {
    if (this.stopped || this.operationEpoch !== epoch || progress?.stopped) throw new Cancelled();
  }
  private file(path: string) {
    const file = this.app.vault.getFileByPath(path);
    if (!file) throw new Error(`${path}: Note missing or renamed`);
    return file;
  }
  private async scan(progress: ProgressModal, epoch: number): Promise<ScannedNote[]> {
    const notes: ScannedNote[] = []; const failures: string[] = [];
    const files = this.app.vault.getMarkdownFiles();
    for (let i = 0; i < files.length; i++) {
      this.assertRunning(epoch, progress);
      const file = files[i]; progress.update(`Scanning ${i + 1}/${files.length}: ${file.path}`);
      try {
        const text = await this.app.vault.read(file); const blocks = findPasswordBlocks(text, file.path);
        for (const block of blocks) {
          try { inspectEnvelope(block.source); } catch (e) { throw new Error(`${file.path}:${block.line}: ${message(e)}`); }
        }
        if (blocks.length) notes.push({ path: file.path, beforeHash: await hashText(text), blocks });
      } catch (e) { failures.push(message(e)); }
    }
    if (failures.length) {
      progress.finish();
      await this.choose("Password blocks need attention", failures.join("\n"), ["Close"]);
      throw new Error(`${failures.length} note(s) need attention before migration`);
    }
    return notes;
  }
  async changeMasterPassword(): Promise<void> {
    if (this.isBusy) return;
    if (this.settings.migration && this.settings.migration.state !== "complete") { new Notice("Resume the unfinished migration before starting a new one."); return; }
    this.rotating = true; const epoch = ++this.operationEpoch;
    this.activeOperations++;
    let progress = new ProgressModal(this.app); progress.open();
    try {
      await this.ensureWritable(epoch);
      const notes = await this.scan(progress, epoch); this.assertRunning(epoch, progress); progress.finish();
      const count = notes.reduce((sum, n) => sum + n.blocks.length, 0);
      const choice = count ? await this.choose("Change master password", `Found ${count} password block(s) in ${notes.length} note(s). Existing blocks need their original passwords unless re-encrypted. Deleting or overwriting old secrets can make them unreadable. Old secrets will be retained.`, ["New blocks only", "Re-encrypt existing blocks"]) : "New blocks only";
      this.assertRunning(epoch); if (!choice) return;
      if (!count) new Notice("No password blocks found. You can set a new master password.");
      const master = await this.prompt("Enter the new master password"); this.assertRunning(epoch);
      if (master === null) return; if (!master) throw new Error("The master password cannot be empty");
      const confirmation = await this.prompt("Confirm the new master password"); this.assertRunning(epoch);
      if (confirmation === null) return; if (confirmation !== master) throw new Error("The master passwords do not match");
      const keyId = randomKeyId();
      progress = new ProgressModal(this.app); progress.open();
      const task: MigrationTask = { version: 1, targetKeyId: keyId, previousKeyId: this.settings.activeKeyId, state: "prepared", notes: [] };
      if (choice === "Re-encrypt existing blocks") {
        let prepared = 0;
        for (const note of notes) {
          const replacements: string[] = [];
          for (const block of note.blocks) {
            this.assertRunning(epoch, progress); progress.update(`Preparing ${++prepared}/${count}: ${note.path}:${block.line}`);
            try {
              const plain = await this.passwords.decrypt(block.source, false); this.assertRunning(epoch, progress);
              const cipher = await encryptSecret(plain, master, inspectEnvelope(block.source).parity, keyId);
              if (await decryptSecret(cipher, master) !== plain) throw new Error("Replacement verification failed");
              replacements.push(cipher);
            } catch (e) { throw new Error(`${note.path}:${block.line}: ${message(e)}`); }
          }
          const text = await this.app.vault.read(this.file(note.path));
          if (await hashText(text) !== note.beforeHash) throw new Error(`${note.path}: Note changed during preparation`);
          task.notes.push({ ...note, replacements, afterHash: await hashText(replacePayloads(text, note.blocks, replacements)), done: false });
        }
      }
      this.assertRunning(epoch, progress);
      // Both the target key and all ciphertext replacements are durable before any note writes.
      await this.passwords.install(master, keyId); this.assertRunning(epoch, progress);
      if (task.notes.length) {
        this.settings.migration = task;
        await this.saveSettings();
        await this.runTask(task, progress, epoch);
      } else {
        const previous = this.settings.activeKeyId; this.settings.activeKeyId = keyId;
        try { await this.saveSettings(); } catch (e) { this.settings.activeKeyId = previous; throw e; }
        new Notice("Master password changed for new blocks only. Old blocks still need their original passwords.");
      }
    } catch (e) { this.reportMigration(e); }
    finally { progress.finish(); this.rotating = false; this.endOperation(); this.refreshSettingsView(); }
  }
  private async runTask(task: MigrationTask, progress: ProgressModal, epoch: number): Promise<void> {
    const complete = await writeMigration(task, {
      checkpoint: () => this.ensureWritable(epoch),
      read: path => this.app.vault.read(this.file(path)),
      process: async (path, fn) => {
        await this.ensureWritable(epoch);
        await this.app.vault.process(this.file(path), current => { this.assertRunning(epoch); this.assertWritable(); return fn(current); });
      },
      save: () => this.saveSettings(),
      pauseRequested: () => this.stopped || epoch !== this.operationEpoch || progress.stopped,
      progress: text => progress.update(text),
    });
    if (!complete) { new Notice("Migration paused. Use Resume migration to continue with the same key."); return; }
    // Do not publish the new active key until every prepared note is accounted for.
    const previous = this.settings.activeKeyId; this.settings.activeKeyId = task.targetKeyId; task.state = "complete";
    try { await this.saveSettings(); } catch (e) { this.settings.activeKeyId = previous; task.state = "paused"; throw e; }
    new Notice(`Migration complete: ${task.notes.length} note(s). Old keys were retained.`);
  }
  async resumeMigration(): Promise<void> {
    if (this.isBusy) return;
    const task = this.settings.migration;
    if (!task || task.state === "complete") { new Notice("No unfinished migration found."); return; }
    this.rotating = true; const epoch = ++this.operationEpoch;
    this.activeOperations++;
    const progress = new ProgressModal(this.app); progress.open();
    try {
      await this.ensureWritable(epoch);
      const master = await this.passwords.verifyTarget(task.targetKeyId); this.assertRunning(epoch, progress);
      // Journal corruption cannot cause unauthenticated payloads to be written.
      for (const note of task.notes) for (const source of note.replacements) {
        this.assertRunning(epoch, progress);
        if (inspectEnvelope(source).keyId !== task.targetKeyId) throw new Error(`${note.path}: Invalid migration target key`);
        await decryptSecret(source, master);
      }
      await this.runTask(task, progress, epoch);
    } catch (e) { this.reportMigration(e); }
    finally { progress.finish(); this.rotating = false; this.endOperation(); this.refreshSettingsView(); }
  }
  private reportMigration(error: unknown): void {
    if (this.configurationState !== "ready") {
      new Notice("Password operation stopped because configuration is unavailable. Some writes may have completed. Preserve notes, data.json, and old keys; reload valid configuration before resuming.", 15000); return;
    }
    const task = this.settings.migration;
    const suffix = task && task.state !== "complete" ? ` ${task.notes.filter(n => n.done).length}/${task.notes.length} note(s) recorded as complete. Keep old keys; use Resume migration.` : " No notes were migrated.";
    new Notice(`Master password change stopped: ${message(error)}${suffix}`, 15000);
  }
  private async insertBlock(editor: Editor): Promise<void> {
    if (this.isBusy) { new Notice("Finish the current operation first."); return; }
    const epoch = this.operationEpoch;
    this.activeOperations++;
    try {
      await this.ensureWritable(epoch);
      const cursor = editor.getCursor(); const snapshot = editor.getValue();
      const secret = await this.prompt("Enter the password to encrypt"); this.assertRunning(epoch);
      if (secret === null) return;
      const title = await this.prompt("Block title", { type: "text", defaultValue: DEFAULT_BLOCK_TITLE }); this.assertRunning(epoch);
      if (title === null) return;
      const titleInfo = formatBlockTitle(title);
      const active = await this.passwords.active(); this.assertRunning(epoch);
      const cipher = await encryptSecret(secret, active.master, this.settings.parity, active.keyId); this.assertRunning(epoch);
      await this.ensureWritable(epoch);
      if (this.rotating || editor.getValue() !== snapshot) throw new Error("The note changed. Please insert the block again.");
      editor.replaceRange(`\n\`\`\`password${titleInfo}\n${cipher}\n\`\`\`\n`, cursor);
      new Notice("Inserted an encrypted password block");
    } catch (e) { if (!(e instanceof Cancelled)) new Notice(message(e)); }
    finally { this.endOperation(); }
  }
  private async revealPassword(source: string): Promise<string> {
    if (this.reloading || this.stopped) throw new Cancelled();
    const epoch = this.operationEpoch; this.activeOperations++;
    try {
      if (this.configurationState === "ready") {
        await this.config.checkpoint(); this.assertRunning(epoch);
        const plain = await this.passwords.decrypt(source); this.assertRunning(epoch); return plain;
      }
      // Recovery is deliberately independent of all configured keys and password caches.
      const master = await this.prompt("Read-only recovery: enter the original master password");
      this.assertRunning(epoch); if (!master) throw new Cancelled();
      const plain = await decryptSecret(source, master); this.assertRunning(epoch); return plain;
    } finally { this.endOperation(); }
  }
  private async verifyExistingPassword(keyId: string, master: string): Promise<void> {
    const epoch = this.operationEpoch;
    await this.ensureWritable(epoch);
    let matched = false;
    let unreadable = false;
    // Key verification is independent of the catalog's folder scope.
    for (const file of this.app.vault.getMarkdownFiles()) {
      this.assertRunning(epoch);
      let text: string;
      try { text = await this.app.vault.read(file); }
      catch { this.assertRunning(epoch); unreadable = true; continue; }
      this.assertRunning(epoch);
      for (const block of scanPasswordBlocks(text, file.path).blocks) {
        let blockKey: string;
        try {
          const info = inspectEnvelope(block.source);
          blockKey = info.keyId || (info.version === 1 ? this.settings.legacyKeyId : "");
        } catch { continue; }
        if (blockKey !== keyId) continue;
        matched = true;
        try { await decryptSecret(block.source, master); }
        catch { this.assertRunning(epoch); continue; }
        this.assertRunning(epoch);
        return;
      }
    }
    throw new Error(matched
      ? "The master password could not decrypt an existing block for this key. Check the original password and try again."
      : unreadable ? "Some notes could not be read, so this older key could not be verified. Restore access and try again."
        : "No existing block is available to verify this older key. Use Change master password before inserting new blocks.");
  }
  private blockSection(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext, fresh = false) {
    const section = ctx.getSectionInfo(el);
    if (!section) return null;
    let block;
    if (fresh) {
      const candidates = scanPasswordBlocks(section.text, ctx.sourcePath).blocks.filter(candidate =>
        candidate.source === source.trim() && candidate.line - 1 >= section.lineStart && candidate.line - 1 <= section.lineEnd);
      block = candidates.length === 1 ? candidates[0] : undefined;
    } else block = this.blockRenderCache.find(ctx.sourcePath, section.text, source, section.lineStart, section.lineEnd);
    return block ? { text: section.text, block } : null;
  }
  private async renameBlock(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<string | null> {
    if (this.isBusy) throw new Error("Finish the current operation first.");
    const epoch = this.operationEpoch;
    this.activeOperations++;
    try {
      await this.ensureWritable(epoch);
      const section = this.blockSection(source, el, ctx, true);
      if (!section) throw new Error("Cannot locate this block safely. Reopen the note and try again.");
      const file = this.file(ctx.sourcePath);
      const path = file.path;
      const migration = this.settings.migration;
      if (migration && migration.state !== "complete" && migration.notes.some(note => note.path === path)) {
        throw new Error("Resume the unfinished migration before editing a title in this note.");
      }
      const snapshot = await this.app.vault.read(file); this.assertRunning(epoch);
      if (snapshot !== section.text) throw new Error("The note changed. Reopen the note and try again.");
      const value = await this.prompt("Edit block title", { type: "text", defaultValue: section.block.title }); this.assertRunning(epoch);
      if (value === null) return null;
      const title = normalizeBlockTitle(value);
      if (title === section.block.title) return title;
      const next = replaceBlockTitle(snapshot, section.block, title);
      await this.ensureWritable(epoch);
      await this.app.vault.process(file, current => {
        this.assertRunning(epoch); this.assertWritable();
        if (file.path !== path || this.file(path) !== file || current !== snapshot) throw new Error("The note changed. Please edit the title again.");
        return next;
      });
      return title;
    } finally { this.endOperation(); }
  }
  private renderBlock(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
    const section = this.blockSection(source, el, ctx);
    const view = new RevealController(el, () => this.revealPassword(source), () => this.configurationState === "ready" ? this.settings.autoHideSeconds : 30, {
      title: section?.block.title ?? DEFAULT_BLOCK_TITLE,
      rename: () => this.renameBlock(source, el, ctx),
    });
    this.views.add(view);
    const views = this.views;
    ctx.addChild(new class extends MarkdownRenderChild {
      onunload(): void { view.dispose(); views.delete(view); }
    }(el));
  }
}
