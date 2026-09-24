import { IndexedPasswordBlock, scanPasswordBlocks } from "./rotation";

interface CachedNote { text: string; bySource: Map<string, IndexedPasswordBlock[]> }

/** Bounded rendering cache; independent of the metadata-only catalog and never persisted. */
export class BlockRenderCache {
  private notes = new Map<string, CachedNote>();
  private characters = 0;
  constructor(private scan = scanPasswordBlocks, private maxNotes = 4, private maxCharacters = 2 * 1024 * 1024) {}

  find(path: string, text: string, source: string, lineStart: number, lineEnd: number): IndexedPasswordBlock | undefined {
    let note = this.notes.get(path);
    if (note) {
      this.notes.delete(path); this.characters -= note.text.length;
      if (note.text !== text) note = undefined;
    }
    if (!note) {
      const bySource = new Map<string, IndexedPasswordBlock[]>();
      for (const block of this.scan(text, path).blocks) {
        const matching = bySource.get(block.source);
        if (matching) matching.push(block); else bySource.set(block.source, [block]);
      }
      note = { text, bySource };
    }
    if (text.length <= this.maxCharacters && this.maxNotes > 0) {
      while (this.notes.size && (this.notes.size >= this.maxNotes || this.characters + text.length > this.maxCharacters)) {
        const oldest = this.notes.entries().next().value!;
        this.characters -= oldest[1].text.length; this.notes.delete(oldest[0]);
      }
      this.notes.set(path, note); this.characters += text.length;
    }
    const candidates = (note.bySource.get(source.trim()) ?? []).filter(block => block.line - 1 >= lineStart && block.line - 1 <= lineEnd);
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  clear(): void { this.notes.clear(); this.characters = 0; }
}
