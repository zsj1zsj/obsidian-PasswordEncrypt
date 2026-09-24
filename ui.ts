import { App, Modal, Setting } from "obsidian";

export interface ValueOptions { defaultValue?: string; type?: "text" | "password" }

export class ValueModal extends Modal {
  private settled = false;
  constructor(app: App, private heading: string, private done: (value: string | null) => void, private options: ValueOptions = {}) { super(app); }
  onOpen(): void {
    this.titleEl.setText(this.heading);
    const input = this.contentEl.createEl("input", { type: this.options.type ?? "password", attr: { "aria-label": this.heading, autocomplete: "off" } });
    input.value = this.options.defaultValue ?? "";
    input.addClass("epb-input");
    input.addEventListener("keydown", event => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); this.finish(input.value); } });
    new Setting(this.contentEl)
      .addButton(b => b.setButtonText("Cancel").onClick(() => this.finish(null)))
      .addButton(b => b.setButtonText("Confirm").setCta().onClick(() => this.finish(input.value)));
    input.focus();
    if (this.options.defaultValue !== undefined) input.select();
  }
  private finish(value: string | null): void { if (this.settled) return; this.settled = true; this.close(); this.done(value); }
  onClose(): void { this.contentEl.empty(); if (!this.settled) { this.settled = true; this.done(null); } }
}
export function promptValue(app: App, title: string, signal?: AbortSignal, options: ValueOptions = {}): Promise<string | null> {
  return new Promise(resolve => {
    const modal = new ValueModal(app, title, value => { signal?.removeEventListener("abort", cancel); resolve(value); }, options);
    const cancel = (): void => modal.close();
    if (signal?.aborted) { resolve(null); return; }
    signal?.addEventListener("abort", cancel, { once: true }); modal.open();
  });
}
export class ChoiceModal extends Modal {
  private settled = false;
  constructor(app: App, private heading: string, private message: string, private options: string[], private done: (value: string | null) => void) { super(app); }
  onOpen(): void {
    this.titleEl.setText(this.heading);
    this.contentEl.createEl("p", { text: this.message });
    const setting = new Setting(this.contentEl);
    setting.addButton(b => b.setButtonText("Cancel").onClick(() => this.finish(null)));
    for (const label of this.options) setting.addButton(b => b.setButtonText(label).onClick(() => this.finish(label)));
  }
  private finish(value: string | null): void { if (this.settled) return; this.settled = true; this.close(); this.done(value); }
  onClose(): void { this.contentEl.empty(); if (!this.settled) { this.settled = true; this.done(null); } }
}
export function choose(app: App, title: string, message: string, options: string[], signal?: AbortSignal): Promise<string | null> {
  return new Promise(resolve => {
    const modal = new ChoiceModal(app, title, message, options, value => { signal?.removeEventListener("abort", cancel); resolve(value); });
    const cancel = (): void => modal.close();
    if (signal?.aborted) { resolve(null); return; }
    signal?.addEventListener("abort", cancel, { once: true }); modal.open();
  });
}

export class ProgressModal extends Modal {
  stopped = false;
  private finished = false;
  private status?: HTMLElement;
  private lastMessage = "Scanning vault…";
  onOpen(): void {
    this.titleEl.setText("Master password migration");
    this.status = this.contentEl.createEl("p", { text: this.lastMessage, attr: { "aria-live": "polite" } });
    new Setting(this.contentEl).addButton(b => b.setButtonText("Cancel / pause after this note").onClick(() => { this.stopped = true; this.update("Stopping after the current operation…"); }));
  }
  update(message: string): void { this.lastMessage = message; this.status?.setText(message); }
  finish(): void { this.finished = true; this.close(); }
  onClose(): void { if (!this.finished) this.stopped = true; this.contentEl.empty(); }
}

export class RevealController {
  private generation = 0;
  private disposed = false;
  private timer?: number;
  private secret?: HTMLElement;
  private win: Window;
  private wrapper: HTMLElement;
  private button: HTMLButtonElement;
  private copyButton: HTMLButtonElement;
  private renameButton?: HTMLButtonElement;
  private title: HTMLElement;
  private status: HTMLElement;
  private onBlur = () => this.hide();
  private onVisibility = () => { if (this.wrapper.ownerDocument.hidden) this.hide(); };
  constructor(element: HTMLElement, private decrypt: () => Promise<string>, private seconds: () => number, private options: { title?: string; rename?: () => Promise<string | null> } = {}) {
    this.win = element.ownerDocument.defaultView!;
    this.wrapper = element.ownerDocument.createElement("div");
    this.wrapper.className = "encrypted-password-block";
    element.append(this.wrapper);
    this.title = element.ownerDocument.createElement("div"); this.title.className = "epb-title"; this.setTitle(options.title);
    const actions = element.ownerDocument.createElement("div"); actions.className = "epb-actions";
    this.button = element.ownerDocument.createElement("button"); this.button.type = "button"; this.button.textContent = "Reveal password";
    this.copyButton = element.ownerDocument.createElement("button"); this.copyButton.type = "button"; this.copyButton.textContent = "Copy password";
    this.status = element.ownerDocument.createElement("span"); this.status.className = "epb-status"; this.status.setAttribute("aria-live", "polite");
    actions.append(this.button, this.copyButton);
    if (options.rename) {
      this.renameButton = element.ownerDocument.createElement("button"); this.renameButton.type = "button"; this.renameButton.textContent = "Edit title";
      this.renameButton.onclick = () => { void this.rename(); };
      actions.append(this.renameButton);
    }
    actions.append(this.status);
    this.wrapper.append(this.title, actions);
    this.button.onclick = () => { void this.reveal(); };
    this.copyButton.onclick = () => { void this.copy(); };
    this.win.addEventListener("blur", this.onBlur);
    element.ownerDocument.addEventListener("visibilitychange", this.onVisibility);
  }
  hide(): void {
    this.generation++;
    if (this.timer !== undefined) this.win.clearTimeout(this.timer);
    this.timer = undefined;
    if (this.secret) { this.secret.textContent = ""; this.secret.remove(); this.secret = undefined; }
    this.button.textContent = "Reveal password"; this.setBusy(false);
    this.status.textContent = ""; this.status.classList.remove("epb-error");
  }
  dispose(): void {
    this.disposed = true; this.hide(); this.button.onclick = null; this.copyButton.onclick = null;
    if (this.renameButton) this.renameButton.onclick = null;
    this.win.removeEventListener("blur", this.onBlur);
    this.wrapper.ownerDocument.removeEventListener("visibilitychange", this.onVisibility);
  }
  private setTitle(title?: string): void { this.title.textContent = `🔒 ${title || "Encrypted password"}`; }
  private setBusy(busy: boolean): void {
    this.button.disabled = busy; this.copyButton.disabled = busy;
    if (this.renameButton) this.renameButton.disabled = busy;
  }
  private async copy(): Promise<void> {
    if (this.disposed || this.copyButton.disabled) return;
    const generation = ++this.generation;
    this.setBusy(true); this.status.textContent = "Copying…"; this.status.classList.remove("epb-error");
    let writingClipboard = false;
    let acceptingPayload = true;
    let decryptionFailed = false;
    let decryptionError: unknown;
    const cancelled = (): boolean => !acceptingPayload || this.disposed || generation !== this.generation;
    try {
      const win = this.wrapper.ownerDocument.defaultView!;
      const clipboard = win.navigator.clipboard;
      if (typeof win.ClipboardItem === "function" && typeof clipboard?.write === "function") {
        writingClipboard = true;
        // WebKit requires write() during the click. Supply the asynchronously
        // decrypted text as a promise while retaining cancellation checks.
        const payload = Promise.resolve().then(async () => {
          if (cancelled()) throw new Error("Password copy cancelled");
          let plain: string;
          try { plain = this.secret ? this.secret.textContent ?? "" : await this.decrypt(); }
          catch (error) { decryptionFailed = true; decryptionError = error; throw error; }
          if (cancelled()) throw new Error("Password copy cancelled");
          return new win.Blob([plain], { type: "text/plain" });
        });
        // A constructor or clipboard rejection can leave the browser ignoring
        // this promise. Consume its rejection even in that early-failure case.
        void payload.catch(() => {});
        await clipboard.write([new win.ClipboardItem({ "text/plain": payload })]);
      } else {
        const plain = this.secret ? this.secret.textContent ?? "" : await this.decrypt();
        if (cancelled()) return;
        writingClipboard = true;
        await clipboard.writeText(plain);
      }
      if (this.disposed || generation !== this.generation) return;
      this.status.textContent = "Password copied";
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      const failure = decryptionFailed ? decryptionError : error;
      this.status.textContent = writingClipboard && !decryptionFailed ? "Could not copy password to the clipboard. Try again." : failure instanceof Error ? failure.message : "Decryption failed";
      this.status.classList.add("epb-error");
    } finally { acceptingPayload = false; if (!this.disposed && generation === this.generation) this.setBusy(false); }
  }
  private async rename(): Promise<void> {
    if (this.disposed || this.renameButton?.disabled || !this.options.rename) return;
    const generation = ++this.generation;
    this.setBusy(true); this.status.textContent = ""; this.status.classList.remove("epb-error");
    try {
      const title = await this.options.rename();
      if (this.disposed || generation !== this.generation || title === null) return;
      this.setTitle(title);
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      this.status.textContent = error instanceof Error ? error.message : "Could not update the block title";
      this.status.classList.add("epb-error");
    } finally { if (!this.disposed && generation === this.generation) this.setBusy(false); }
  }
  private async reveal(): Promise<void> {
    if (this.disposed || this.button.disabled) return;
    if (this.secret) { this.hide(); return; }
    const generation = ++this.generation;
    this.setBusy(true); this.status.textContent = "Decrypting…"; this.status.classList.remove("epb-error");
    try {
      const plain = await this.decrypt();
      if (this.disposed || generation !== this.generation) return;
      this.secret = this.wrapper.ownerDocument.createElement("div"); this.secret.className = "epb-secret"; this.secret.textContent = plain;
      this.wrapper.append(this.secret); this.button.textContent = "Hide password";
      const seconds = this.seconds(); this.status.textContent = `Automatically hides in ${seconds} seconds`;
      this.timer = this.win.setTimeout(() => this.hide(), seconds * 1000);
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      this.status.textContent = error instanceof Error ? error.message : "Decryption failed";
      this.status.classList.add("epb-error");
    } finally { if (!this.disposed && generation === this.generation) this.setBusy(false); }
  }
}
