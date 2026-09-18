const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');

function dom() {
  const instance = new JSDOM('<!doctype html><body></body>', { url: 'https://local.test/' });
  const proto = instance.window.HTMLElement.prototype;
  proto.setText = function (value) { this.textContent = value; };
  proto.empty = function () { this.replaceChildren(); };
  proto.addClass = function (name) { this.classList.add(name); };
  proto.createEl = function (tag, options = {}) {
    const el = this.ownerDocument.createElement(tag);
    if (options.type) el.type = options.type;
    if (options.text) el.textContent = options.text;
    if (options.cls) el.className = options.cls;
    for (const [key, val] of Object.entries(options.attr || {})) el.setAttribute(key, val);
    this.append(el); return el;
  };
  const openModals = [];
  class Modal {
    constructor(app) {
      this.app = app;
      this.containerEl = instance.window.document.createElement('section');
      this.titleEl = this.containerEl.createEl('h2'); this.contentEl = this.containerEl.createEl('div');
    }
    open() { instance.window.document.body.append(this.containerEl); openModals.push(this); this.onOpen?.(); }
    close() { this.containerEl.remove(); const i = openModals.indexOf(this); if (i >= 0) openModals.splice(i, 1); this.onClose?.(); }
  }
  class Setting {
    constructor(el) { this.el = el.createEl('div'); }
    setName(value) { this.el.createEl('h4', { text: value }); return this; } setDesc(value) { this.el.createEl('p', { text: value }); return this; }
    addDropdown(fn) {
      const el = this.el.createEl('select');
      const component = { addOptions(values) { for (const [value, text] of Object.entries(values)) el.createEl('option', { text, attr: { value } }); return this; },
        setValue(value) { el.value = value; return this; }, onChange(cb) { el.addEventListener('change', () => cb(el.value)); return this; } };
      fn(component); return this;
    }
    addSlider(fn) {
      const el = this.el.createEl('input', { type: 'range' });
      const component = { setLimits(min, max, step) { Object.assign(el, { min, max, step }); return this; }, setValue(value) { el.value = value; return this; },
        setDynamicTooltip() { return this; }, onChange(cb) { el.addEventListener('change', () => cb(Number(el.value))); return this; } };
      fn(component); return this;
    }
    addTextArea(fn) {
      const inputEl = this.el.createEl('textarea');
      const component = { inputEl, setValue(value) { inputEl.value = value; return this; }, setPlaceholder(value) { inputEl.placeholder = value; return this; },
        onChange(cb) { inputEl.addEventListener('input', () => cb(inputEl.value)); return this; } };
      fn(component); return this;
    }
    addButton(fn) {
      const buttonEl = this.el.createEl('button');
      const component = {
        buttonEl,
        setButtonText(text) { buttonEl.textContent = text; return this; },
        setCta() { return this; }, setDisabled(value) { buttonEl.disabled = value; return this; },
        onClick(cb) { buttonEl.addEventListener('click', cb); return this; },
      };
      fn(component); return this;
    }
  }
  const notices = [];
  const obsidian = { Modal, Setting, Notice: class { constructor(text) { notices.push(text); } },
    normalizePath: path => path.replace(/\\/g, '/').replace(/\/+/g, '/'),
    Plugin: class { constructor() { this.manifest = { id: 'encrypt-password-blocks', dir: '.obsidian/plugins/encrypt-password-blocks' }; } registerMarkdownCodeBlockProcessor() {} addCommand() {} addSettingTab() {} registerView() {} registerEvent() {} },
    ItemView: class { constructor(leaf) { this.leaf = leaf; this.contentEl = instance.window.document.createElement('div'); } },
    PluginSettingTab: class { constructor(app) { this.app = app; this.containerEl = instance.window.document.createElement('div'); } }, MarkdownRenderChild: class {},
  };
  return { instance, window: instance.window, document: instance.window.document, obsidian, openModals, notices };
}
function load(file, obsidian = {}) {
  const js = buildSync({ entryPoints: [file], write: false, bundle: true, platform: 'node', format: 'cjs', external: ['obsidian'] }).outputFiles[0].text;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', js)(name => name === 'obsidian' ? obsidian : require(name), mod, mod.exports);
  return mod.exports;
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(predicate, label = 'condition') {
  const start = Date.now();
  while (!predicate()) { if (Date.now() - start > 10000) throw new Error(`Timed out waiting for ${label}`); await tick(); }
}
module.exports = { dom, load, tick, until };
