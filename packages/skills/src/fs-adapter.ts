/**
 * Node filesystem-backed `SkillStorageAdapter`.
 *
 * Layout (the reference convention from spec §12):
 *
 *   <root>/
 *     installed.json                  # registry index — array of InstalledSkillIndexEntry
 *     <skill-name>/
 *       SKILL.md                      # frontmatter + body (LF-normalized at write)
 *       skill-envelope.json           # signed envelope
 *       scripts/, references/, templates/, assets/   (optional, walked recursively)
 *
 * The adapter holds the index file in memory; reads/writes flush atomically
 * via temp-file + rename. The skill subdirectory is the source of truth for
 * everything except the index entry's `enabled`/`trusted` flags.
 *
 * Mobile/web platforms get their own adapters (phase 4) — this is the Node-
 * only one used by the CLI runtime and any other Node consumer.
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import type { SkillEnvelope } from "@motebit/protocol";

import { parseSkillFile, serializeSkillFile, SkillParseError } from "./parse.js";
import type { SkillStorageAdapter, StoredSkill } from "./storage.js";
import type { InstalledSkillIndexEntry } from "./types.js";

const INSTALLED_JSON = "installed.json";
const SKILL_MD = "SKILL.md";
const SKILL_ENVELOPE_JSON = "skill-envelope.json";
const AUX_DIRS = ["scripts", "references", "templates", "assets"] as const;

export interface NodeFsSkillStorageAdapterOptions {
  /** Root directory holding `installed.json` and per-skill subdirs. */
  root: string;
}

export class NodeFsSkillStorageAdapter implements SkillStorageAdapter {
  private readonly root: string;

  constructor(opts: NodeFsSkillStorageAdapterOptions) {
    this.root = opts.root;
    mkdirSync(this.root, { recursive: true });
    if (!existsFile(join(this.root, INSTALLED_JSON))) {
      atomicWriteFile(join(this.root, INSTALLED_JSON), "[]\n");
    }
  }

  async list(): Promise<InstalledSkillIndexEntry[]> {
    return this.readIndex();
  }

  async read(name: string): Promise<StoredSkill | null> {
    const index = this.readIndex();
    const entry = index.find((e) => e.name === name);
    if (!entry) return null;

    const dir = this.skillDir(name);
    const skillMdPath = join(dir, SKILL_MD);
    const envPath = join(dir, SKILL_ENVELOPE_JSON);
    if (!existsFile(skillMdPath) || !existsFile(envPath)) return null;

    let parsed: ReturnType<typeof parseSkillFile>;
    try {
      parsed = parseSkillFile(readFileSync(skillMdPath, "utf-8"));
    } catch (err: unknown) {
      throw new Error(
        `Failed to parse installed SKILL.md for "${name}": ${err instanceof Error ? err.message : String(err)}`,
        { cause: err instanceof Error ? err : undefined },
      );
    }

    let envelope: SkillEnvelope;
    try {
      envelope = JSON.parse(readFileSync(envPath, "utf-8")) as SkillEnvelope;
    } catch (err: unknown) {
      throw new Error(
        `Failed to read skill-envelope.json for "${name}": ${err instanceof Error ? err.message : String(err)}`,
        { cause: err instanceof Error ? err : undefined },
      );
    }

    const files = collectAuxFiles(dir);

    return {
      index: entry,
      manifest: parsed.manifest,
      envelope,
      body: parsed.body,
      files,
    };
  }

  async write(skill: StoredSkill): Promise<void> {
    const dir = this.skillDir(skill.index.name);
    mkdirSync(dir, { recursive: true });

    // Write SKILL.md (frontmatter + body), atomic per-file via temp+rename
    const skillMdContent = serializeSkillFile(skill.manifest, skill.body);
    atomicWriteFile(join(dir, SKILL_MD), skillMdContent);

    // Write skill-envelope.json
    atomicWriteFile(join(dir, SKILL_ENVELOPE_JSON), JSON.stringify(skill.envelope, null, 2) + "\n");

    // Write aux files. Use a fresh tree: clear previous aux subdirs first
    // so removed files don't linger across reinstall.
    for (const subdir of AUX_DIRS) {
      const subdirPath = join(dir, subdir);
      if (existsFile(subdirPath)) {
        rmSync(subdirPath, { recursive: true, force: true });
      }
    }
    for (const [relPath, bytes] of Object.entries(skill.files)) {
      const safe = ensureSafeRelativePath(relPath);
      const out = join(dir, safe);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, bytes);
    }

    // Update index file
    const index = this.readIndex();
    const idx = index.findIndex((e) => e.name === skill.index.name);
    if (idx >= 0) {
      index[idx] = skill.index;
    } else {
      index.push(skill.index);
    }
    this.writeIndex(index);
  }

  async remove(name: string): Promise<void> {
    const dir = this.skillDir(name);
    if (existsFile(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
    const index = this.readIndex().filter((e) => e.name !== name);
    this.writeIndex(index);
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const index = this.readIndex();
    const entry = index.find((e) => e.name === name);
    if (!entry) return;
    entry.enabled = enabled;
    this.writeIndex(index);
  }

  async setTrusted(name: string, trusted: boolean): Promise<void> {
    const index = this.readIndex();
    const entry = index.find((e) => e.name === name);
    if (!entry) return;
    entry.trusted = trusted;
    this.writeIndex(index);
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  private skillDir(name: string): string {
    // Skill names are slug-form `[a-z0-9-]+` per spec §3.1; safe as a path
    // segment. The schema validation in `parseSkillFile` enforces this on
    // every install, so we do not re-validate at the storage layer.
    return join(this.root, name);
  }

  private readIndex(): InstalledSkillIndexEntry[] {
    const path = join(this.root, INSTALLED_JSON);
    if (!existsFile(path)) return [];
    const raw = readFileSync(path, "utf-8");
    if (raw.trim() === "") return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed as InstalledSkillIndexEntry[];
    } catch (err: unknown) {
      throw new Error(
        `Failed to parse skills index at ${path}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err instanceof Error ? err : undefined },
      );
    }
  }

  private writeIndex(index: InstalledSkillIndexEntry[]): void {
    atomicWriteFile(join(this.root, INSTALLED_JSON), JSON.stringify(index, null, 2) + "\n");
  }
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

function existsFile(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Atomically write a file: write to a temp sibling, fsync, rename. Avoids
 * partially-written files surviving crashes. (No effort beyond rename for
 * directory durability — the index file is the only crash-sensitive piece
 * and a rename + fsync is sufficient on POSIX-ish hosts.)
 */
function atomicWriteFile(path: string, content: string): void {
  const tempPath = `${path}.tmp.${process.pid}`;
  const fd = openSync(tempPath, "w");
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tempPath, path);
}

/**
 * Walk the four conventional aux directories under `dir` and produce a flat
 * map of relative paths → bytes. Preserves directory structure beneath the
 * named dirs.
 */
function collectAuxFiles(dir: string): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  for (const subdir of AUX_DIRS) {
    const root = join(dir, subdir);
    if (!existsFile(root)) continue;
    walkInto(root, dir, out);
  }
  return out;
}

function walkInto(current: string, base: string, out: Record<string, Uint8Array>): void {
  const entries = readdirSync(current, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) {
      walkInto(fullPath, base, out);
    } else if (entry.isFile()) {
      const relPath = relative(base, fullPath).split(sep).join("/");
      out[relPath] = readFileSync(fullPath);
    }
  }
}

/**
 * Reject path-traversal in install bytes. Skill envelopes ship with
 * `files[].path` strings; we never let those write outside the skill
 * directory. Forward slashes only; no `..` segments; no absolute paths.
 */
function ensureSafeRelativePath(relPath: string): string {
  if (relPath.startsWith("/") || relPath.startsWith("\\")) {
    throw new Error(`Skill file path is absolute: ${relPath}`);
  }
  const segments = relPath.split(/[\\/]+/);
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error(`Skill file path contains an unsafe segment: ${relPath}`);
    }
  }
  return segments.join("/");
}

// ---------------------------------------------------------------------------
// Source resolver — directory → in_memory install source
// ---------------------------------------------------------------------------

import type { SkillInstallSource } from "./types.js";

/**
 * Resolve a directory containing SKILL.md + skill-envelope.json + optional
 * aux subdirs into an `in_memory` install source the registry can consume.
 *
 * Used by the CLI install handler to bridge "user said `motebit skills install
 * /path/to/skill`" → registry.install.
 */
export function resolveDirectorySkillSource(path: string): SkillInstallSource {
  const skillMdPath = join(path, SKILL_MD);
  const envPath = join(path, SKILL_ENVELOPE_JSON);
  if (!existsFile(skillMdPath)) {
    throw new SkillParseError(`No SKILL.md at ${skillMdPath}`);
  }
  if (!existsFile(envPath)) {
    throw new Error(`No skill-envelope.json at ${envPath}`);
  }

  const parsed = parseSkillFile(readFileSync(skillMdPath, "utf-8"));
  const envelope = JSON.parse(readFileSync(envPath, "utf-8")) as SkillEnvelope;
  const files = collectAuxFiles(path);

  return {
    kind: "in_memory",
    manifest: parsed.manifest,
    envelope,
    body: parsed.body,
    files,
  };
}
