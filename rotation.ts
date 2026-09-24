import MarkdownIt from "markdown-it";
import { inspectEnvelope } from "./codec";
import { DEFAULT_BLOCK_TITLE } from "./block-title";

export interface Fragment { start: number; end: number }
export interface PasswordBlock { fragments: Fragment[]; source: string; line: number }
export interface IndexedPasswordBlock extends PasswordBlock { endLine: number; ordinal: number; title: string; titleFragment: Fragment }
export interface BlockDiagnostic { line?: number; endLine?: number; ordinal?: number; message: string }
export interface ScannedNote { path: string; beforeHash: string; blocks: PasswordBlock[] }
export interface MigrationNote extends ScannedNote { afterHash: string; replacements: string[]; done: boolean }
export interface MigrationTask {
  version: 1;
  targetKeyId: string;
  previousKeyId: string;
  state: "prepared" | "writing" | "paused" | "complete";
  notes: MigrationNote[];
}

const markdown = new MarkdownIt({ html: true });
export function scanPasswordBlocks(text: string, path = "Note"): { blocks: IndexedPasswordBlock[]; diagnostics: BlockDiagnostic[] } {
  const lines = Array.from(text.matchAll(/[^\n]*(?:\n|$)/g)).filter(m => m[0].length);
  // YAML frontmatter is not Markdown. Keep line numbers unchanged.
  const normalized = text.replace(/\r\n/g, "\n");
  const parseText = normalized.replace(/^---\n[\s\S]*?\n(?:---|\.\.\.)\s*(?:\n|$)/, front => front.replace(/[^\n]/g, " "));
  const blocks: IndexedPasswordBlock[] = [];
  const diagnostics: BlockDiagnostic[] = [];
  let ordinal = 0;
  for (const token of markdown.parse(parseText, {})) {
    if (token.type !== "fence" || token.info.trim().split(/\s+/)[0] !== "password" || !token.map) continue;
    const [first, end] = token.map;
    const currentOrdinal = ordinal++;
    try {
      const fail = (message: string): never => { throw new Error(`${path}:${first + 1}: ${message}`); };
      const opening = lines[first];
      const openingText = opening?.[0].replace(/\r?\n$/, "") ?? "";
      const language = /^\s*password(?=\s|$)/.exec(token.info);
      // The token's info is the complete suffix after the opening fence, even in
      // lists and blockquotes. Locate it from the end so titles can repeat words
      // or fence-like text without making the source range ambiguous.
      if (!opening || !language || !openingText.replace(/\0/g, "\ufffd").endsWith(token.markup + token.info)) fail("Cannot safely locate the block title");
      const titleFragment = {
        start: opening.index! + openingText.length - token.info.length + language![0].length,
        end: opening.index! + openingText.length,
      };
      const title = token.info.slice(language![0].length).trim() || DEFAULT_BLOCK_TITLE;
      const contentLines = token.content.replace(/\n$/, "").split("\n");
      // An explicit closing fence must occupy a separate final source line.
      const close = lines[end - 1]?.[0].replace(/\r?\n$/, "") ?? "";
      const strippedClose = close.replace(/^[\s>]*/, "");
      if (!new RegExp(`^${token.markup[0]}{${token.markup.length},}\\s*$`).test(strippedClose) || end - first < 2) fail("Unclosed password block");
      const source = token.content.trim();
      if (!source) fail("Empty password block");
      const fragments: Fragment[] = [];
      for (let i = 0; i < contentLines.length; i++) {
        const content = contentLines[i].trim();
        if (!content) continue;
        const original = lines[first + 1 + i];
        if (!original || first + 1 + i >= end - 1) fail("Cannot safely locate the password payload");
        const value = original[0].replace(/\r?\n$/, "");
        const offset = value.lastIndexOf(content);
        if (offset < 0 || !/^[\s>]*$/.test(value.slice(0, offset)) || value.slice(offset + content.length).trim()) fail("Ambiguous password payload location");
        fragments.push({ start: original.index! + offset, end: original.index! + offset + content.length });
      }
      if (!fragments.length) fail("Empty password payload");
      blocks.push({ source, fragments, line: first + 1, endLine: end, ordinal: currentOrdinal, title, titleFragment });
    } catch (error) {
      diagnostics.push({ line: first + 1, endLine: end, ordinal: currentOrdinal, message: error instanceof Error ? error.message : `${path}:${first + 1}: Cannot scan password block` });
    }
  }
  return { blocks, diagnostics };
}

// Migration remains strict: never migrate a partial scan of a damaged note.
export function findPasswordBlocks(text: string, path = "Note"): PasswordBlock[] {
  const result = scanPasswordBlocks(text, path);
  if (result.diagnostics.length) throw new Error(result.diagnostics[0].message);
  return result.blocks;
}

export async function hashText(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}

export function replacePayloads(text: string, blocks: PasswordBlock[], replacements: string[]): string {
  if (blocks.length !== replacements.length) throw new Error("Invalid replacement count");
  const edits = blocks.flatMap((block, i) => block.fragments.map((fragment, j) => ({ ...fragment, value: j === 0 ? replacements[i] : "" })));
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
  return text;
}

export interface MigrationHost {
  checkpoint?(): Promise<void>;
  read(path: string): Promise<string>;
  process(path: string, transform: (current: string) => string): Promise<void>;
  save(): Promise<void>;
  pauseRequested(): boolean;
  progress(message: string): void;
}

// Write-ahead state plus before/after hashes makes a write/progress-save crash recoverable.
export async function writeMigration(task: MigrationTask, host: MigrationHost): Promise<boolean> {
  task.state = "writing";
  await host.save();
  for (let i = 0; i < task.notes.length; i++) {
    if (host.pauseRequested()) { task.state = "paused"; await host.save(); return false; }
    const note = task.notes[i];
    host.progress(`Writing ${i + 1}/${task.notes.length}: ${note.path}`);
    const current = await host.read(note.path);
    const hash = await hashText(current);
    if (hash !== note.afterHash) {
      if (hash !== note.beforeHash) throw new Error(`${note.path}: Note changed. Restore its prepared version before resuming.`);
      const next = replacePayloads(current, note.blocks, note.replacements);
      if (await hashText(next) !== note.afterHash) throw new Error(`${note.path}: Migration journal verification failed`);
      await host.checkpoint?.();
      await host.process(note.path, latest => {
        if (latest !== current) throw new Error(`${note.path}: Concurrent edit detected. The note was not overwritten.`);
        return next;
      });
    }
    note.done = true;
    await host.save();
  }
  return true;
}

export function validateTask(value: unknown): MigrationTask | undefined {
  if (value == null) return undefined;
  const fail = (): never => { throw new Error("Invalid migration record. Preserve data.json for recovery."); };
  const obj = (v: any): boolean => !!v && typeof v === "object" && !Array.isArray(v);
  const key = (v: any, empty = false): boolean => typeof v === "string" && (empty && v === "" || /^[a-z0-9-]{1,64}$/.test(v));
  const hash = (v: any): boolean => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
  const position = (v: any): boolean => Number.isSafeInteger(v) && v >= 0;
  const task = value as MigrationTask;
  if (!obj(task) || task.version !== 1 || !key(task.targetKeyId) || !key(task.previousKeyId, true) ||
      !["prepared", "writing", "paused", "complete"].includes(task.state) || !Array.isArray(task.notes)) fail();
  const paths = new Set<string>();
  for (const note of task.notes) {
    if (!obj(note) || typeof note.path !== "string" || !note.path.toLowerCase().endsWith(".md") || /[\\:\x00-\x1f]/.test(note.path) ||
      note.path.split("/").some(p => !p || p === "." || p === "..") || paths.has(note.path) || !hash(note.beforeHash) || !hash(note.afterHash) ||
      typeof note.done !== "boolean" || task.state === "complete" && !note.done || task.state === "prepared" && note.done ||
      !Array.isArray(note.blocks) || !note.blocks.length || !Array.isArray(note.replacements) || note.blocks.length !== note.replacements.length) fail();
    paths.add(note.path);
    let previousEnd = -1; let previousLine = 0;
    for (const block of note.blocks) {
      if (!obj(block) || typeof block.source !== "string" || !position(block.line) || block.line <= previousLine || !Array.isArray(block.fragments) || !block.fragments.length) fail();
      previousLine = block.line;
      for (const fragment of block.fragments) {
        if (!obj(fragment) || !position(fragment.start) || !position(fragment.end) || fragment.end <= fragment.start || fragment.start < previousEnd) fail();
        previousEnd = fragment.end;
      }
      try { inspectEnvelope(block.source); } catch { fail(); }
    }
    for (const source of note.replacements) {
      try {
        if (typeof source !== "string") fail();
        const info = inspectEnvelope(source);
        if (info.version !== 2 || info.keyId !== task.targetKeyId) fail();
      }
      catch { fail(); }
    }
  }
  return task;
}
