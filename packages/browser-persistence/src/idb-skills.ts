/**
 * IndexedDB-backed `SkillStorageAdapter` for the web + desktop dev-mode
 * surfaces.
 *
 * Mirrors the existing `IdbConversationStore` / `IdbEventStore` family in
 * shape — single shared `openMotebitDB()` instance, async typed methods,
 * one object store per domain. Fits cleanly next to its siblings; future
 * contributors who understand the established pattern inherit
 * comprehension of this adapter for free.
 *
 * The wire shape persisted to IDB matches `StoredSkill` from
 * `@motebit/skills/storage` byte-for-byte: `{ index, manifest, envelope,
 * body, files }`. The fs adapter on desktop stores the same shape on
 * disk; the only difference is the storage namespace. A skill installed
 * on web is portable to desktop's `~/.motebit/skills/` over relay-mediated
 * sync (when that lands) without re-encoding.
 *
 * Privilege boundary: this adapter runs in the same renderer/browser
 * context as the panel UI. No sidecar isolation analogue exists in
 * browsers. Skill verification (signature check) happens in the same
 * context as the install — `@motebit/crypto` is sandboxed (no I/O), so
 * the trade-off is acceptable, but it is a structurally-weaker isolation
 * boundary than desktop's Tauri sidecar. See
 * `packages/skills/CLAUDE.md` rule 5 for the cross-surface contract.
 */

import type { SkillStorageAdapter, StoredSkill } from "@motebit/skills";
import type { InstalledSkillIndexEntry } from "@motebit/skills";
import { idbRequest } from "./idb.js";

/** Internal IDB row shape. Storing via `keyPath: "name"` means the row
 *  itself carries the key. The body + per-file payloads are kept as
 *  `Uint8Array` instances; structured-clone preserves their byte content
 *  across the IDB read/write boundary without base64-roundtripping. */
interface SkillRow {
  /** IDB key — same as `index.name`. Top-level for `keyPath` indexing. */
  name: string;
  /** Insertion timestamp — used to preserve list ordering. */
  insertedAt: number;
  /** The full `StoredSkill` payload, structured-cloneable. */
  index: InstalledSkillIndexEntry;
  manifest: StoredSkill["manifest"];
  envelope: StoredSkill["envelope"];
  body: Uint8Array;
  files: Record<string, Uint8Array>;
}

export class IdbSkillStorageAdapter implements SkillStorageAdapter {
  constructor(private readonly db: IDBDatabase) {}

  async list(): Promise<InstalledSkillIndexEntry[]> {
    const tx = this.db.transaction("skills", "readonly");
    const rows = (await idbRequest(tx.objectStore("skills").getAll())) as SkillRow[];
    return rows
      .slice()
      .sort((a, b) => a.insertedAt - b.insertedAt)
      .map((r) => ({ ...r.index }));
  }

  async read(name: string): Promise<StoredSkill | null> {
    const tx = this.db.transaction("skills", "readonly");
    const row = (await idbRequest(tx.objectStore("skills").get(name))) as SkillRow | undefined;
    if (!row) return null;
    return {
      index: { ...row.index },
      manifest: structuredClone(row.manifest),
      envelope: structuredClone(row.envelope),
      body: new Uint8Array(row.body),
      files: Object.fromEntries(Object.entries(row.files).map(([k, v]) => [k, new Uint8Array(v)])),
    };
  }

  async write(skill: StoredSkill): Promise<void> {
    const tx = this.db.transaction("skills", "readwrite");
    const store = tx.objectStore("skills");
    // Preserve original insertedAt on overwrite so list ordering is stable
    // when a caller `--force`-reinstalls. The fs adapter has the same
    // semantics — installed.json keeps array position across rewrites.
    const existing = (await idbRequest(store.get(skill.index.name))) as SkillRow | undefined;
    const insertedAt = existing?.insertedAt ?? Date.now();
    const row: SkillRow = {
      name: skill.index.name,
      insertedAt,
      index: { ...skill.index },
      manifest: structuredClone(skill.manifest),
      envelope: structuredClone(skill.envelope),
      body: new Uint8Array(skill.body),
      files: Object.fromEntries(
        Object.entries(skill.files).map(([k, v]) => [k, new Uint8Array(v)]),
      ),
    };
    await idbRequest(store.put(row));
  }

  async remove(name: string): Promise<void> {
    const tx = this.db.transaction("skills", "readwrite");
    await idbRequest(tx.objectStore("skills").delete(name));
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    await this.patchIndex(name, (idx) => ({ ...idx, enabled }));
  }

  async setTrusted(name: string, trusted: boolean): Promise<void> {
    await this.patchIndex(name, (idx) => ({ ...idx, trusted }));
  }

  /** Read-modify-write of just the `index` field — leaves the bytes
   *  (body, envelope, manifest, files) untouched on enable/trust toggles.
   *  Same atomicity story as the fs adapter's `installed.json` rewrite:
   *  one transaction, no partial state. */
  private async patchIndex(
    name: string,
    update: (existing: InstalledSkillIndexEntry) => InstalledSkillIndexEntry,
  ): Promise<void> {
    const tx = this.db.transaction("skills", "readwrite");
    const store = tx.objectStore("skills");
    const row = (await idbRequest(store.get(name))) as SkillRow | undefined;
    if (!row) return;
    const next: SkillRow = { ...row, index: update(row.index) };
    await idbRequest(store.put(next));
  }
}
