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
 *
 * Methods return `Promise<T>` (never `async`) — the interface is async-shaped
 * to admit real-fs / network-backed future adapters, but this in-memory impl
 * is synchronous internally and explicit `Promise.resolve` keeps the body
 * lint-clean against `@typescript-eslint/require-await`.
 */
export class InMemorySkillStorageAdapter implements SkillStorageAdapter {
  private readonly skills = new Map<string, StoredSkill>();

  list(): Promise<InstalledSkillIndexEntry[]> {
    return Promise.resolve(Array.from(this.skills.values()).map((s) => ({ ...s.index })));
  }

  read(name: string): Promise<StoredSkill | null> {
    const entry = this.skills.get(name);
    if (!entry) return Promise.resolve(null);
    return Promise.resolve(cloneStoredSkill(entry));
  }

  write(skill: StoredSkill): Promise<void> {
    this.skills.set(skill.index.name, cloneStoredSkill(skill));
    return Promise.resolve();
  }

  remove(name: string): Promise<void> {
    this.skills.delete(name);
    return Promise.resolve();
  }

  setEnabled(name: string, enabled: boolean): Promise<void> {
    const existing = this.skills.get(name);
    if (existing) existing.index = { ...existing.index, enabled };
    return Promise.resolve();
  }

  setTrusted(name: string, trusted: boolean): Promise<void> {
    const existing = this.skills.get(name);
    if (existing) existing.index = { ...existing.index, trusted };
    return Promise.resolve();
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
