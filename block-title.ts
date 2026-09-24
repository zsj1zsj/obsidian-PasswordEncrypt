import type { IndexedPasswordBlock } from "./rotation";

export const DEFAULT_BLOCK_TITLE = "Encrypted password";

export function normalizeBlockTitle(value: string): string {
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) {
    throw new Error("Block title must be a single line without control characters.");
  }
  if (value.includes("`")) throw new Error("Block title cannot contain backticks.");
  return value.trim() || DEFAULT_BLOCK_TITLE;
}

export function formatBlockTitle(value: string): string {
  return ` ${normalizeBlockTitle(value)}`;
}

export function replaceBlockTitle(text: string, block: Pick<IndexedPasswordBlock, "titleFragment">, title: string): string {
  const value = formatBlockTitle(title);
  const { start, end } = block.titleFragment;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > text.length ||
      /[\r\n]/.test(text.slice(start, end))) throw new Error("Cannot safely locate the block title.");
  return text.slice(0, start) + value + text.slice(end);
}
