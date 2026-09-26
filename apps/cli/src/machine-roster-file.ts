/**
 * `~/.motebit/machine-roster.json` — the CLI's machine-roster replica
 * (`docs/proposals/machine-roster-clients-v1.md` C5), with the key-file
 * durability rules (`docs/proposals/key-file-durability-v1.md` R1–R3):
 * owner-only, written atomically under its lock, read three ways (absent /
 * value / corrupt), an unreadable file moved aside with its bytes kept and
 * never overwritten. One file holds one replica per motebit id, so a
 * restore to another identity never inherits — or destroys — the previous
 * identity's. The CLI is its only writer.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  mergeReplicas,
  parseReplica,
  type MachineRosterReplica,
  type ReplicaRead,
} from "@motebit/surface-kit";
import { CONFIG_DIR } from "./config.js";
import {
  isTrulyAbsent,
  mkdirOwnerOnly,
  moveAside,
  narrowOnLoad,
  withFileLock,
  writeFileAtomic,
} from "./durable-file.js";

/**
 * The replica's one spelling — a literal join on `CONFIG_DIR`, because
 * that is the on-disk contract `check-cli-surface` reads.
 */
export const MACHINE_ROSTER_PATH = path.join(CONFIG_DIR, "machine-roster.json");

export function machineRosterPath(dir: string = CONFIG_DIR): string {
  return path.join(dir, path.basename(MACHINE_ROSTER_PATH));
}

/** Infix of a set-aside unreadable replica: `machine-roster.json.corrupt-<time>`. */
export const MACHINE_ROSTER_SET_ASIDE_INFIX = ".corrupt-";

interface RosterFile {
  version: 1;
  replicas: Record<string, MachineRosterReplica>;
}

type FileRead = { kind: "absent" } | { kind: "value"; file: RosterFile } | { kind: "corrupt" };

function readRosterFile(dir: string): FileRead {
  const file = machineRosterPath(dir);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (err) {
    // Only ENOENT of the NAME is absence (a dangling symlink is something there).
    if ((err as NodeJS.ErrnoException).code === "ENOENT" && isTrulyAbsent(file)) {
      return { kind: "absent" };
    }
    return { kind: "corrupt" };
  }
  narrowOnLoad(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "corrupt" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "corrupt" };
  }
  const p = parsed as { version?: unknown; replicas?: unknown };
  if (p.version !== 1 || typeof p.replicas !== "object" || p.replicas === null) {
    return { kind: "corrupt" };
  }
  const replicas: Record<string, MachineRosterReplica> = {};
  for (const [id, value] of Object.entries(p.replicas as Record<string, unknown>)) {
    const r = parseReplica(value);
    // Strict: one unreadable replica makes the FILE unreadable — read as a
    // smaller file, the next save would drop what it held.
    if (r == null || r.motebit_id !== id) return { kind: "corrupt" };
    replicas[id] = r;
  }
  return { kind: "value", file: { version: 1, replicas } };
}

/**
 * Move an unreadable replica out of the name, bytes kept
 * (`machine-roster.json.corrupt-<time>`). Moved, not copied: a copy would
 * leave the unreadable file at the name, and every later start would read
 * it as corrupt again and never mint. Re-read under the lock first, so a
 * file another process just repaired is never moved.
 */
function setAsideIfStillCorrupt(dir: string): void {
  const file = machineRosterPath(dir);
  withFileLock(file, () => {
    if (readRosterFile(dir).kind === "corrupt") moveAside(file, MACHINE_ROSTER_SET_ASIDE_INFIX);
  });
}

export function loadReplica(motebitId: string, dir: string = CONFIG_DIR): ReplicaRead {
  const read = readRosterFile(dir);
  if (read.kind === "corrupt") {
    setAsideIfStillCorrupt(dir);
    return { kind: "corrupt" };
  }
  if (read.kind === "absent") return { kind: "absent" };
  const replica = read.file.replicas[motebitId];
  return replica ? { kind: "value", replica } : { kind: "absent" };
}

/** Merge `replica` into what is stored NOW, under the lock; nothing is ever removed. */
export function saveReplica(replica: MachineRosterReplica, dir: string = CONFIG_DIR): void {
  mkdirOwnerOnly(dir);
  const file = machineRosterPath(dir);
  withFileLock(file, () => {
    const read = readRosterFile(dir);
    if (read.kind === "corrupt") moveAside(file, MACHINE_ROSTER_SET_ASIDE_INFIX);
    const base: RosterFile = read.kind === "value" ? read.file : { version: 1, replicas: {} };
    const existing = base.replicas[replica.motebit_id];
    base.replicas[replica.motebit_id] = existing ? mergeReplicas(existing, replica) : replica;
    writeFileAtomic(file, JSON.stringify(base, null, 2), 0o600);
  });
}
