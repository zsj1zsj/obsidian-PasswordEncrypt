/** Vault-relative folders only. Empty configuration means the whole vault. */
export function normalizeScanFolders(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(folder => typeof folder !== "string")) throw new Error("Scan folders must be a list of vault-relative folder paths.");
  const folders: string[] = [];
  for (const item of value as string[]) {
    const path = item.trim().replace(/\\/g, "/");
    if (!path) continue;
    if (path.startsWith("/") || /[:\x00-\x1f\x7f]/.test(path) || path.split("/").some(part => part === "." || part === "..")) {
      throw new Error("Use vault-relative folders, one per line. Absolute paths and . or .. segments are not allowed. Leave empty to scan the whole vault.");
    }
    const normalized = path.replace(/\/+/g, "/").replace(/\/$/, "");
    if (!folders.includes(normalized)) folders.push(normalized);
  }
  return folders;
}

export function isInScanFolders(path: string, folders: readonly string[]): boolean {
  return !folders.length || folders.some(folder => path.startsWith(`${folder}/`));
}
