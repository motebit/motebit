/**
 * Storage adapter for the skills registry. The registry binds to this
 * interface; `InMemorySkillStorageAdapter` implements it for tests, the fs
 * adapter (in apps/cli/src/runtime-factory or a dedicated module) for
 * runtime persistence.
 *
 * Per @motebit/skills/CLAUDE.md rule 4: registry never touches the
 * filesystem directly.
 */

import type { SkillEnvelope, SkillManifest } from "@motebit/protocol";
import type { InstalledSkillIndexEntry } from "./types.js";

export interface StoredSkill {
  index: InstalledSkillIndexEntry;
  manifest: SkillManifest;
  envelope: SkillEnvelope;
  body: Uint8Array;
  files: Record<string, Uint8Array>;
}

export interface SkillStorageAdapter {
  /** List all installed skills, in insertion order. */
  list(): Promise<InstalledSkillIndexEntry[]>;
  /** Read one stored skill, or `null` if not present. */
  read(name: string): Promise<StoredSkill | null>;
  /** Write a stored skill. Overwrites existing entry with the same `name` (caller enforces `--force`). */
  write(skill: StoredSkill): Promise<void>;
  /** Remove a stored skill. No-op if not present (idempotent). */
  remove(name: string): Promise<void>;
  /** Update the `enabled` flag in the index without touching the rest of the record. */
  setEnabled(name: string, enabled: boolean): Promise<void>;
  /** Update the `trusted` flag in the index. */
  setTrusted(name: string, trusted: boolean): Promise<void>;
}

/**
 * In-memory adapter — the registry's reference test target. Pure, no I/O.
 * Preserves insertion order for `list()` to match the fs adapter's
 * `installed.json` array semantics.
 */
export class InMemorySkillStorageAdapter implements SkillStorageAdapter {
  private readonly skills = new Map<string, StoredSkill>();

  async list(): Promise<InstalledSkillIndexEntry[]> {
    return Array.from(this.skills.values()).map((s) => ({ ...s.index }));
  }

  async read(name: string): Promise<StoredSkill | null> {
    const entry = this.skills.get(name);
    if (!entry) return null;
    return cloneStoredSkill(entry);
  }

  async write(skill: StoredSkill): Promise<void> {
    this.skills.set(skill.index.name, cloneStoredSkill(skill));
  }

  async remove(name: string): Promise<void> {
    this.skills.delete(name);
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const existing = this.skills.get(name);
    if (!existing) return;
    existing.index = { ...existing.index, enabled };
  }

  async setTrusted(name: string, trusted: boolean): Promise<void> {
    const existing = this.skills.get(name);
    if (!existing) return;
    existing.index = { ...existing.index, trusted };
  }
}

function cloneStoredSkill(s: StoredSkill): StoredSkill {
  return {
    index: { ...s.index },
    manifest: structuredClone(s.manifest),
    envelope: structuredClone(s.envelope),
    body: new Uint8Array(s.body),
    files: Object.fromEntries(Object.entries(s.files).map(([k, v]) => [k, new Uint8Array(v)])),
  };
}
