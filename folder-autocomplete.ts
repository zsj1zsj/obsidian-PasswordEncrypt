export interface FolderAutocomplete { refresh(): void; dispose(): void }

const normalize = (path: string) => path.trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");

/** Complete the current line without changing the other configured folders. */
export function attachFolderAutocomplete(input: HTMLTextAreaElement, folders: () => string[] | null): FolderAutocomplete {
  const doc = input.ownerDocument;
  const wrapper = doc.createElement("div");
  wrapper.className = "epb-folder-input";
  input.before(wrapper); wrapper.append(input);
  const list = doc.createElement("div");
  const popup = doc.createElement("div"); popup.className = "epb-folder-suggestions";
  list.id = `epb-folder-suggestions-${++nextId}`;
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Matching scan folders");
  wrapper.append(popup); popup.append(list);
  const hint = doc.createElement("div");
  hint.className = "epb-folder-suggestion-hint"; hint.setAttribute("role", "status"); popup.append(hint);
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", list.id);
  let matches: string[] = [], active = 0, explicitSelection = false, exactMatch = false, disposed = false, composing = false;
  const listeners: Array<() => void> = [];
  const on = <K extends keyof HTMLElementEventMap>(name: K, callback: (event: HTMLElementEventMap[K]) => void) => {
    input.addEventListener(name, callback);
    listeners.push(() => input.removeEventListener(name, callback));
  };
  const close = () => {
    popup.hidden = true; list.hidden = true; hint.hidden = true; matches = []; list.replaceChildren();
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  };
  const line = () => {
    const caret = input.selectionStart;
    const start = caret === 0 ? 0 : input.value.lastIndexOf("\n", caret - 1) + 1;
    const newline = input.value.indexOf("\n", caret);
    return { start, end: newline < 0 ? input.value.length : newline };
  };
  const select = (folder: string) => {
    if (disposed || input.disabled) return;
    const { start, end } = line();
    input.setRangeText(folder, start, end, "end");
    // Use the input's own window so pop-out settings also receive a valid event.
    const event = doc.createEvent("Event"); event.initEvent("input", true, false);
    input.dispatchEvent(event);
    close(); input.focus();
  };
  const highlight = () => {
    Array.from(list.children).forEach((option, index) => {
      option.classList.toggle("is-selected", index === active);
      option.setAttribute("aria-selected", String(index === active));
    });
    input.setAttribute("aria-activedescendant", `${list.id}-${active}`);
  };
  const update = () => {
    if (disposed || composing || input.disabled) { close(); return; }
    const { start, end } = line();
    const current = normalize(input.value.slice(start, end));
    const query = current.toLowerCase();
    if (!query || input.selectionEnd > end) { close(); return; }
    const existing = new Set((input.value.slice(0, start) + input.value.slice(end)).split("\n").map(normalize));
    const paths = folders();
    if (!paths) { close(); return; }
    exactMatch = paths.includes(current);
    matches = []; let truncated = false;
    for (const folder of paths) {
      if (existing.has(folder) || !folder.toLowerCase().includes(query)) continue;
      if (matches.length === 50) { truncated = true; break; }
      matches.push(folder);
    }
    list.replaceChildren(); active = 0; explicitSelection = false;
    if (!matches.length) { close(); return; }
    for (const [index, folder] of matches.entries()) {
      const option = doc.createElement("div");
      option.id = `${list.id}-${index}`; option.textContent = folder;
      option.setAttribute("role", "option");
      option.addEventListener("mousedown", event => event.preventDefault());
      option.addEventListener("click", () => select(folder));
      list.append(option);
    }
    hint.textContent = truncated ? "Showing the first 50 folders. Keep typing to narrow the results." : "";
    hint.hidden = !truncated;
    popup.hidden = false; list.hidden = false; input.setAttribute("aria-expanded", "true"); highlight();
  };
  on("input", event => { if (!(event as InputEvent).isComposing) update(); });
  on("compositionstart", () => { composing = true; close(); });
  on("compositionend", () => { composing = false; update(); });
  on("click", update);
  on("blur", close);
  on("keydown", event => {
    if (composing || event.isComposing || !matches.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      explicitSelection = true;
      active = (active + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length;
      highlight(); (list.children[active] as HTMLElement).scrollIntoView?.({ block: "nearest" });
    } else if (event.key === "Enter") {
      if (exactMatch && !explicitSelection) { close(); return; }
      event.preventDefault(); select(matches[active]);
    } else if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); close();
    } else if (event.key === "Tab") close();
  });
  on("keyup", event => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) update();
  });
  close();
  return {
    refresh: () => { if (doc.activeElement === input && !list.hidden) update(); },
    dispose: () => {
      if (disposed) return;
      disposed = true; close();
      for (const remove of listeners) remove();
      input.removeAttribute("aria-autocomplete"); input.removeAttribute("aria-controls"); input.removeAttribute("aria-expanded");
      wrapper.before(input); wrapper.remove();
    },
  };
}

let nextId = 0;
