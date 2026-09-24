# Encrypted Password Blocks

Store passwords in Obsidian notes as authenticated ciphertext with error-correction data.

## Usage

1. Open **Settings → Community plugins → Encrypted Password Blocks** and select **Change master password** to configure a master password.
2. Run **Insert encrypted password block** from the command palette.
3. Enter the password you want to store, then accept or change the prefilled block title (**Encrypted password**). The plugin inserts an `EPB2` ciphertext block at the cursor.
4. In Reading view, select **Copy password** to decrypt directly to the clipboard, or **Reveal password** to show the plaintext temporarily. Revealed text is hidden automatically after 30 seconds by default. Copy uses the same master-password and recovery flow as Reveal; it does not display the password. Hiding or locking does not clear an already copied password from the system clipboard.
5. Select **Edit title** on a block to change its title. The dialog starts with the current title; a blank title uses **Encrypted password**. Changing a title preserves the encrypted password.

Titles are plain text stored after `password` on the opening fence (for example, `password Work email`). Use a single line without backticks. Titles are visible in the note source and are not encrypted; use them as labels. Existing blocks without a title keep the default title. Title changes are unavailable while configuration writes are protected or an unfinished migration includes that note.

Choose a storage mode in the settings. Existing users continue to use **SecretStorage** by default. User interface text and documentation are in English; passwords may contain Unicode text.

Only ciphertext is stored in the note:

````markdown
```password
EPB2.32....
```
````

## Master-password storage and upgrades

Obsidian 1.11.4 or later is required. Three storage modes are available:

- **SecretStorage**: persist passwords using Obsidian's secret API. Missing or incorrect stored passwords offer **Recover with master password**. After a successful authenticated decryption, choose **Use once** or **Save recovered password** to bind a fresh reference to that key. No old secret is overwritten.
- **Remember for this session**: cache verified passwords by key identifier in memory. Lock, plugin unload, or app exit clears this cache. New passwords are not written to SecretStorage.
- **Ask every time**: prompt for each operation; do not automatically read stored secrets or cache passwords. During recovery of a migration, its target password is requested once for that operation.

Switching modes preserves key identifiers and existing SecretStorage entries. The plugin's `data.json` holds settings, secret references, key identifiers, encrypted verification records, and the latest migration journal. It never stores a plaintext master password or decrypted block contents. SecretStorage is shared by plugins within Obsidian; it is not a security boundary against malicious plugins or a compromised device.

**Lock and hide all passwords** hides all revealed blocks, invalidates pending password operations, and clears session passwords. In SecretStorage mode, Reveal can retrieve the persistent password again. Window blur or document hiding clears displayed plaintext and invalidates pending reveals, but does not clear the session password cache. Automatic hiding defaults to 30 seconds (configurable from 10 to 300). JavaScript cannot guarantee physical erasure of strings from memory.

When upgrading from version 0.1.0, a master password previously stored in `data.json` is migrated to SecretStorage and removed from the plugin settings. Existing `EPB1` blocks remain readable and are not rewritten automatically.

## Configuration protection and read-only recovery

The settings page shows **Configuration status**. The plugin observes external `data.json` changes and compares content fingerprints before saving settings or performing sensitive writes. Its own saves and JSON whitespace/key-order changes do not cause conflicts. Fingerprints and protection state are memory-only; no new cache or backup file is created.

If a sync service or another program changes the accepted configuration, the plugin shows **Configuration changed externally**, hides displayed passwords, clears session passwords, cancels password prompts, and prevents further configuration, SecretStorage, and note writes. An already-started write may have completed. Do not delete notes or old keys to resolve the warning.

Choose **Reload configuration** in settings and confirm to discard unsaved in-memory settings and accept the current file. The plugin cancels and waits for active operations and queued saves before loading. It never merges key references or migration records and offers no force-overwrite option. If the file is still unreadable or invalid, protection remains active. Restore a valid file first. During the current plugin session, deleting a previously observed configuration file does not reset the plugin; it requires restoration. With no file at initial startup, the plugin cannot distinguish a new installation from a configuration deleted before startup.

Invalid JSON, invalid known settings fields, malformed encrypted checks, invalid migration records, or an unverifiable save enter **Read-only recovery mode** instead of preventing the plugin from loading. The original file is not reset, repaired, or automatically copied. Valid older configurations are supported; missing optional fields receive defaults. Legacy plaintext-master migration is also guarded; if it fails, preserve the original file and any newly created secret entry. The plugin never creates an extra plaintext backup.

In protected mode you can browse the Password Blocks panel, navigate to notes, use **Lock**, and reveal an existing block by entering its original master password. This recovery path does not read SecretStorage passwords, cache entered passwords, or save recovered references. Each reveal requires manual input and hides after 30 seconds, on window blur, or when the document is hidden. The catalog reports **Configuration unavailable**, not an inferred missing secret. Settings changes, inserting blocks, changing master passwords, resuming migrations, and clearing records are disabled. After restoring the file, use **Retry loading configuration** and confirm; successful loading re-enables normal operations.

**Sync limitation:** pre-write comparisons, post-write verification, and migration checkpoints are optimistic checks, not an atomic cross-device lock. Another writer can still race a file write. Do not migrate on multiple devices simultaneously. Prefer pausing sync during a migration and retain independent backups. If a conflict follows a note write but precedes its progress save, the valid original journal can detect the already-written note by its hash when resumed. Restoring the journal and relevant notes may be necessary; the plugin does not automatically reconstruct a lost journal.

## Password Blocks panel

Run **Open Password Blocks** from the command palette, or use the button with the same name in the plugin settings. The read-only panel opens in the right sidebar and reuses an existing panel when available.

### Choosing scan folders

In plugin settings, type a folder name or path in **Password Blocks scan folders** to see matching folders at any depth, including empty folders. Suggestions show full vault-relative paths. Click a suggestion or use the arrow keys and Enter to complete the current line; Escape dismisses the dropdown. Enter one folder per line, then click **Save scan folders**. You can also edit paths manually or remove entries. Leave the list empty to scan the whole vault. For example:

```text
Passwords
Work/Accounts
```

The catalog includes Markdown notes inside any listed folder and its subfolders. An empty list scans the whole vault, including notes at its root. Both `/` and `\` separators are accepted and saved as `/`; duplicate entries are removed. Overlapping parent/child folders do not produce duplicate rows. Paths are case-sensitive and matched at folder boundaries (`Work` does not match `Workshop`). Absolute paths and `.`/`..` segments are rejected. Missing folders match nothing; the plugin never falls back to a whole-vault scan because a configured folder is missing.

Autocomplete accepts either separator, collapses repeated separators, and shows up to 50 matching folders. Keep typing to narrow longer result lists. When the current line already names an existing folder, Enter starts a new line unless you explicitly select a candidate with the arrow keys. Directory listings are cached while settings are open and refreshed after folder creation, deletion, or renaming.

Unsaved folder edits survive settings redraws and closing/reopening settings during the plugin session. Saving disables directory editing until completion; failed saves retain the draft. A successful, explicitly confirmed configuration reload discards it, as does unloading the plugin. Inline messages identify invalid paths and missing directories by line. Missing directories can still be saved for folders awaiting sync; invalid paths cannot. If the directory list cannot be read, the settings show that the check is unavailable rather than reporting directories as missing. Reopen settings to retry.

Saving refreshes an already-active catalog and removes out-of-scope results, including stale background results. It does not start a scan before the panel's first activation. Creating, moving, deleting, or renaming notes updates the catalog according to this scope. Configured paths remain literal when folders are renamed; update the setting if you want to follow a renamed folder. The panel displays its current scope, and its counts/search/filter apply only to that scope. This setting is saved in `data.json`, so configured folder names may be visible in synced configuration.

**Safety boundary:** scan folders restrict only the Password Blocks catalog. Master-password change checks and re-encryption continue to scan the entire vault to avoid overlooking existing passwords outside the selected folders. Revealing or inserting a block in another folder remains supported. Configuration conflict/recovery protections also apply to this setting; failed saves do not publish a new scope.

- Browse blocks grouped by note path, with opening line, envelope version, key identifier, and status. Expand the key identifier to see its full value and parity setting.
- Search note paths or full key IDs, and filter by **All**, **Needs attention**, **EPB1**, or **EPB2**. Totals describe the catalog within the configured scope, not just the current search/filter. Issues count affected blocks plus unreadable/unscannable notes; a block with several problems counts once.
- **Secret available** means that the referenced SecretStorage entry name exists, not that its password is correct. **Missing secret** and **Missing reference** need attention in SecretStorage mode. **Session mode** and **Password required** are expected states, not errors. Legacy EPB1 blocks use the configured legacy key reference, if any; otherwise they require manual password entry.
- Every row is **Not decrypted**. The catalog checks envelope structure and Reed-Solomon recoverability only. It never authenticates AES-GCM, reads secret values, prompts for a password, reveals plaintext, copies passwords, repairs notes, or migrates blocks. An invalid block does not hide other recognized blocks in the same note. Unclosed fences can consume later text according to Markdown parsing rules.
- Select a row's line button to open its note at that block. The plugin rereads and rescans the note before navigating. Unique unchanged payloads can be relocated after line shifts. Identical payloads appear as separate rows; if their note changed and identity is ambiguous, navigation stops and asks you to select again from the refreshed catalog. There are no persistent block IDs and no note content is changed to add them.
- **Refresh** rebuilds the catalog and rechecks secret names. Focusing the panel also rechecks names, so external SecretStorage changes can be reflected. Settings changes refresh statuses automatically. Missing names or references never trigger automatic secret recovery.

The catalog starts scanning only when the panel is first opened (including restoration of an already-open panel). After activation it tracks Markdown note creation, edits, deletion, and file/folder renames, even if you close the panel. Edits are debounced for 500 ms, with at most two background note scans at a time. Generation checks discard stale reads after edits, deletion, or renames. Results update progressively, with 100 visible entries per batch and **Load more** for larger catalogs. A refresh does not write to notes.

Only metadata is retained in the in-memory index: paths, line positions, occurrence numbers, hashes/digests, versions, key identifiers, parity, and diagnostics. Note text and encrypted payloads are read transiently for scanning, but are not retained in the index. The catalog is never written to `data.json` or another cache file. Plugin unload clears the index and cancels queued work. The panel's metadata is visible to anyone able to use the running app; this feature is not an additional security boundary.

Migration continues to use its own fresh, strict scan rather than trusting this catalog. Backups, historical versions, non-Markdown files, and other vaults are outside the catalog. FEC recovery detected during inspection is not written back; keep independent backups.

## Changing the master password

Select **Change master password** in the plugin settings. The plugin scans Markdown notes in this vault before accepting the change. If password blocks exist, choose **Re-encrypt existing blocks**, **New blocks only**, or **Cancel**. If there are no blocks, enter and confirm the new password directly.

Re-encryption covers detected password blocks, including EPB1 and blocks created with different keys. Missing keys offer manual recovery; each candidate password must authenticate each block. The plugin verifies every replacement before writing any notes. Wrong passwords, cancelled prompts, or malformed blocks stop preparation without writing notes.

The Markdown parser recognizes fenced password blocks inside lists, blockquotes, and callouts. Examples inside other code fences, YAML frontmatter, and HTML comments are ignored. Surrounding text, container prefixes, and line endings are preserved. Unclosed, empty, or ambiguously located blocks are reported with file paths and line numbers. The parser covers tested CommonMark containers and callouts; it does not implement every third-party Markdown extension.

Old secrets are always retained. SecretStorage mode creates a fresh entry for the new password; session and prompt modes do not persist the new password. With **New blocks only**, existing blocks still need their original passwords. Do not delete or overwrite the old entries. Changes made directly through Obsidian's shared SecretStorage interface are outside this plugin's confirmation flow.

Scanning, preparation, and writing show progress. **Cancel / pause after this note** cancels preparation or pauses writing at the next file boundary. Closing the progress dialog requests the same stop. Scan snapshots are limited to affected blocks and hashes, rather than full-vault text. Editing unrelated notes does not abort migration.

Writing multiple notes is not atomic. The journal is saved before the first note write and contains only source/replacement ciphertext, positions, hashes, key identifiers, and progress. Old/new password material is never included. If a write or progress save fails, keep `data.json` and the old keys. Use **Resume migration** in settings or the command palette after restart. It uses the same target key and detects already-written notes by their hashes. In session/prompt mode, re-enter the target password, which is checked against its encrypted verification record.

Target-note edits and renames pause migration rather than being overwritten. Restore the prepared version of the conflicting note or its already-migrated version before resuming; conflicts are not merged automatically. The previous active key remains selected until all target notes are accounted for. New notes or password blocks created externally after the scan, historical note versions, and external copies are outside the task and still need their original passwords. Keep those old passwords even after successful migration. No plaintext backup is created. The latest completed journal is retained until the next migration replaces it or you explicitly clear it.

### Managing the latest migration record

**Migration record** in settings shows the latest record's status, note/block counts, target key ID, and compact JSON size in UTF-8 bytes (the formatted on-disk size can differ). It does not display ciphertext and is not a multi-entry history archive.

Use **Clear completed migration record** only after a successful migration. The button is unavailable for incomplete records or while another operation is active. After confirmation, the plugin rechecks the record identity, completion, and configuration fingerprint before removing only `migration` from `data.json`. Notes, SecretStorage entries, old passwords, key references, and encrypted key checks are retained. Cancellation makes no change. A conflict or an unverifiable save is reported as a failure, not successful cleanup; a write may already have completed, so reload to inspect the actual state. Cleanup does not erase earlier copies in sync history or backups. A removed record can only be recovered from an existing historical copy; no automatic backup is made.

## Encryption format

New blocks use this pipeline:

```text
Master password
  ↓ PBKDF2-SHA256 (600,000 iterations by default + a random salt per block)
AES-256-GCM key
  ↓ random nonce + authenticated EPB2 metadata
Ciphertext
  ↓ chunked Reed-Solomon error correction
Base64URL payload
```

`EPB2` records the algorithm, PBKDF2 iteration count, salt, nonce, key identifier, data length, and error-correction parameters. This allows future parameter changes without breaking older blocks. Random salt and nonce values ensure that encrypting the same plaintext with the same master password normally produces different ciphertext each time.

The default Reed-Solomon setting adds 32 parity bytes per block and can repair up to about 16 random byte errors in each block. AES-GCM rejects an incorrect master password, authenticated metadata changes, and damage that cannot be repaired correctly.

Character insertion or deletion shifts subsequent data positions and is outside the current automatic-recovery guarantee.

## Development

Use Node.js 22.23.2 or a compatible newer release (tests use TypeScript source loading and jsdom).

```bash
npm install
npm run build
npm test
```

Copy `main.js`, `manifest.json`, and `styles.css` into `.obsidian/plugins/encrypt-password-blocks/` in the vault, then reload Obsidian.

Tests cover encryption and size limits, nested Markdown, password recovery/modes, DOM button and timer behavior, legacy settings migration, persistence failures, migration restart recovery, lazy indexing, debounce and stale-read races, folder/extension changes, metadata-only storage, secret-name-only inspection, safe duplicate navigation, and catalog search/filter/grouping and plugin wiring. Configuration tests simulate invalid JSON/fields, external edits/deletion, own-save notifications, queued and in-flight conflicts, guarded reload, manual-only recovery, migration checkpoints, and completed-record cleanup. DOM tests emulate Obsidian's modal/setting/view shell; they do not replace manual validation in the real desktop/mobile app or actual OneDrive concurrency tests.

### 0.7.0

Adds multiple vault-relative scan folders for the Password Blocks catalog, immediate scope refresh, and folder-scope validation and regression tests. Empty configuration retains whole-vault catalog scanning. Master-password safety scans and migrations remain whole-vault. Minimum Obsidian version and ciphertext formats are unchanged.

### 0.6.0

Adds guarded configuration loading/saving, explicit external-change reload, read-only recovery, stricter migration-record validation, and confirmed cleanup of completed migration records. The minimum Obsidian version remains 1.11.4; EPB1/EPB2 formats are unchanged.

### 0.5.0

Adds the English Password Blocks sidebar, lazy memory-only catalog, incremental vault tracking, safe note navigation, diagnostic collection, and catalog regression tests. The minimum Obsidian version remains 1.11.4; the encryption format is unchanged.
