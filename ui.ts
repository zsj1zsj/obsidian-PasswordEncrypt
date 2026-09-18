import { App, Modal, Setting } from "obsidian";

export class ValueModal extends Modal {
  private settled = false;
  constructor(app: App, private heading: string, private done: (value: string | null) => void) { super(app); }
  onOpen(): void {
    this.titleEl.setText(this.heading);
    const input = this.contentEl.createEl("input", { type: "password", attr: { "aria-label": this.heading, autocomplete: "off" } });
    input.addClass("epb-input");
    input.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); this.finish(input.value); } });
    new Setting(this.contentEl)
      .addButton(b => b.setButtonText("Cancel").onClick(() => this.finish(null)))
      .addButton(b => b.setButtonText("Confirm").setCta().onClick(() => this.finish(input.value)));
    input.focus();
  }
  private finish(value: string | null): void { if (this.settled) return; this.settled = true; this.close(); this.done(value); }
  onClose(): void { this.contentEl.empty(); if (!this.settled) { this.settled = true; this.done(null); } }
}
export function promptValue(app: App, title: string, signal?: AbortSignal): Promise<string | null> {
  return new Promise(resolve => {
    const modal = new ValueModal(app, title, value => { signal?.removeEventListener("abort", cancel); resolve(value); });
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
  private status: HTMLElement;
  private onBlur = () => this.hide();
  private onVisibility = () => { if (this.wrapper.ownerDocument.hidden) this.hide(); };
  constructor(element: HTMLElement, private decrypt: () => Promise<string>, private seconds: () => number) {
    this.win = element.ownerDocument.defaultView!;
    this.wrapper = element.ownerDocument.createElement("div");
    this.wrapper.className = "encrypted-password-block";
    element.append(this.wrapper);
    const title = element.ownerDocument.createElement("div"); title.className = "epb-title"; title.textContent = "🔒 Encrypted password";
    this.button = element.ownerDocument.createElement("button"); this.button.type = "button"; this.button.textContent = "Reveal password";
    this.status = element.ownerDocument.createElement("span"); this.status.className = "epb-status"; this.status.setAttribute("aria-live", "polite");
    this.wrapper.append(title, this.button, this.status);
    this.button.onclick = () => { void this.reveal(); };
    this.win.addEventListener("blur", this.onBlur);
    element.ownerDocument.addEventListener("visibilitychange", this.onVisibility);
  }
  hide(): void {
    this.generation++;
    if (this.timer !== undefined) this.win.clearTimeout(this.timer);
    this.timer = undefined;
    if (this.secret) { this.secret.textContent = ""; this.secret.remove(); this.secret = undefined; }
    this.button.textContent = "Reveal password"; this.button.disabled = false;
    this.status.textContent = ""; this.status.classList.remove("epb-error");
  }
  dispose(): void {
    this.disposed = true; this.hide(); this.button.onclick = null;
    this.win.removeEventListener("blur", this.onBlur);
    this.wrapper.ownerDocument.removeEventListener("visibilitychange", this.onVisibility);
  }
  private async reveal(): Promise<void> {
    if (this.disposed || this.button.disabled) return;
    if (this.secret) { this.hide(); return; }
    const generation = ++this.generation;
    this.button.disabled = true; this.status.textContent = "Decrypting…"; this.status.classList.remove("epb-error");
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
    } finally { if (!this.disposed && generation === this.generation) this.button.disabled = false; }
  }
}
