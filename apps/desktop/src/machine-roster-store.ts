/**
 * The desktop's machine-roster storage — `docs/proposals/machine-roster-surfaces-v1.md`
 * S3, §1A F3/F4, §1B R3/R4. One desktop-owned file,
 * `~/.motebit/machine-roster.desktop.json` (never the CLI's
 * `machine-roster.json`), holding one replica per motebit_id (F4) and the
 * presentation record per motebit_id (F8):
 *
 *   { "version": 1, "replicas": { <motebit_id>: <replica> }, "presentation": { <motebit_id>: <record> } }
 *
 * The bytes move through two Rust commands (`src-tauri/src/roster_replica.rs`):
 * `roster_replica_read` (bytes + digest) and `roster_replica_write`, a
 * compare-and-swap on the digest under an in-process mutex AND an OS file
 * lock, written atomically (staged → fsync → rename). A desktop is not one
 * process (a runtime-host frontend is a second one, §1A F3), so every save
 * is read → `mergeReplicas` → CAS, retried on a conflict: a retirement
 * another process wrote is never written over unseen.
 *
 * Reads are strict, as on the CLI: one unreadable replica makes the FILE
 * unreadable (read as a smaller file, the next save would drop what it
 * held). An unreadable file is kept aside by Rust BEFORE the name is
 * replaced (R3), and the name is then freed.
 *
 * `exclusive` (the mint decision) is a lease: a Rust-held OS lock with an
 * owner token and a timeout (R4). A crash releases it through the OS; a
 * lease a reloaded webview held is released by its timer (≤ 120 s), and the
 * reloaded webview's act meanwhile gives up after 30 s (LOCKED), failing
 * closed. It is a different lock from the CAS one: the kit saves while
 * holding `exclusive`.
 */
import {
  mergeReplicas,
  parseReplica,
  type MachineRosterReplica,
  type PresentationRecord,
  type ReplicaRead,
} from "@motebit/surface-kit";

export type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** What `roster_replica_read` answers. */
export type ReplicaBytes =
  | { kind: "absent" }
  | { kind: "text"; digest: string; contents: string }
  | { kind: "unreadable"; digest: string };

/** The Rust refusal of a stale compare-and-swap. */
export const CONFLICT = "roster_replica_conflict";
/** A lease outlives any one section (each network call has a 10 s timeout). */
export const LEASE_TTL_MS = 120_000;
const LEASE_WAIT_MS = 30_000;
const CAS_ATTEMPTS = 16;
export const LOCKED = "the machine roster is locked by another desktop window; try again";

/** The four commands, over `invoke` (injectable for tests). */
export interface RosterFileIO {
  read(): Promise<ReplicaBytes>;
  /** Throws `CONFLICT` when the file's digest is no longer `expected`. */
  write(expected: string | null, contents: string, aside: boolean): Promise<void>;
  leaseAcquire(ttlMs: number): Promise<string | null>;
  leaseRelease(token: string): Promise<boolean>;
}

export function tauriRosterIO(invoke: InvokeFn): RosterFileIO {
  return {
    read: () => invoke<ReplicaBytes>("roster_replica_read"),
    write: (expected, contents, aside) =>
      invoke<void>("roster_replica_write", { expected, contents, aside }),
    leaseAcquire: (ttl) => invoke<string | null>("roster_lease_acquire", { ttl }),
    leaseRelease: (token) => invoke<boolean>("roster_lease_release", { token }),
  };
}

interface RosterFile {
  version: 1;
  replicas: Record<string, MachineRosterReplica>;
  presentation: Record<string, PresentationRecord>;
}

type FileRead =
  | { kind: "absent" }
  | { kind: "value"; digest: string; file: RosterFile }
  | { kind: "corrupt"; digest: string };

const emptyFile = (): RosterFile => ({ version: 1, replicas: {}, presentation: {} });

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isPresentation = (v: unknown): v is PresentationRecord =>
  isObj(v) &&
  (v.digest === null || typeof v.digest === "string") &&
  typeof v.taken_at === "number" &&
  typeof v.retry_until === "number";

/** Strict parse: `null` when the text is not exactly a roster file. */
export function parseRosterFile(contents: string): RosterFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return null;
  }
  if (!isObj(parsed) || parsed.version !== 1 || !isObj(parsed.replicas)) return null;
  const replicas: Record<string, MachineRosterReplica> = {};
  for (const [id, value] of Object.entries(parsed.replicas)) {
    const r = parseReplica(value);
    // One unreadable replica makes the FILE unreadable (see the header).
    if (r == null || r.motebit_id !== id) return null;
    replicas[id] = r;
  }
  // The cadence record is a hint, never evidence: a malformed one reads as none.
  const presentation: Record<string, PresentationRecord> = {};
  if (isObj(parsed.presentation)) {
    for (const [id, value] of Object.entries(parsed.presentation)) {
      if (isPresentation(value)) presentation[id] = value;
    }
  }
  return { version: 1, replicas, presentation };
}

async function readFile(io: RosterFileIO): Promise<FileRead> {
  const got = await io.read();
  if (got.kind === "absent") return { kind: "absent" };
  if (got.kind === "unreadable") return { kind: "corrupt", digest: got.digest };
  const file = parseRosterFile(got.contents);
  return file == null
    ? { kind: "corrupt", digest: got.digest }
    : { kind: "value", digest: got.digest, file };
}

const isConflict = (err: unknown): boolean =>
  (err instanceof Error ? err.message : String(err)).includes(CONFLICT);

/** This webview's writers, one at a time (the CAS alone is correct; this only spares retries). */
let writers: Promise<unknown> = Promise.resolve();

/**
 * Read → change → compare-and-swap, retried on a conflict. `change` gets
 * what is stored NOW (an unreadable file is replaced by an empty one, its
 * bytes kept aside by Rust first). Returns `change`'s result.
 */
function update<T>(
  io: RosterFileIO,
  change: (file: RosterFile) => T,
): Promise<{ result: T; wasCorrupt: boolean }> {
  const run = writers.then(
    () => casLoop(io, change),
    () => casLoop(io, change),
  );
  writers = run.catch(() => undefined);
  return run;
}

async function casLoop<T>(
  io: RosterFileIO,
  change: (file: RosterFile) => T,
): Promise<{ result: T; wasCorrupt: boolean }> {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const read = await readFile(io);
    const file = read.kind === "value" ? read.file : emptyFile();
    const result = change(file);
    const expected = read.kind === "absent" ? null : read.digest;
    try {
      await io.write(expected, JSON.stringify(file, null, 2), read.kind === "corrupt");
      return { result, wasCorrupt: read.kind === "corrupt" };
    } catch (err) {
      if (!isConflict(err)) throw err;
    }
  }
  throw new Error("the machine roster kept changing under this desktop; nothing was written");
}

/**
 * Three-way read (absent / value / corrupt). An unreadable file is moved
 * aside (bytes kept by Rust) and the name freed, under compare-and-swap so
 * a file another process just repaired is never moved.
 */
export async function loadReplica(io: RosterFileIO, motebitId: string): Promise<ReplicaRead> {
  const read = await readFile(io);
  if (read.kind === "absent") return { kind: "absent" };
  if (read.kind === "value") {
    const r = read.file.replicas[motebitId];
    return r ? { kind: "value", replica: r } : { kind: "absent" };
  }
  const { wasCorrupt } = await update(io, () => undefined);
  if (wasCorrupt) return { kind: "corrupt" };
  // Repaired meanwhile by another process: read what it holds.
  return loadReplica(io, motebitId);
}

/** Merge `replica` into what is stored NOW; nothing is ever removed (F3, R3). */
export async function saveReplica(io: RosterFileIO, replica: MachineRosterReplica): Promise<void> {
  await update(io, (file) => {
    const id = replica.motebit_id;
    const existing = file.replicas[id];
    file.replicas[id] = existing ? mergeReplicas(existing, replica) : replica;
  });
}

export async function loadPresentationRecord(
  io: RosterFileIO,
  motebitId: string,
): Promise<PresentationRecord | null> {
  const read = await readFile(io);
  return read.kind === "value" ? (read.file.presentation[motebitId] ?? null) : null;
}

export async function putPresentationRecord(
  io: RosterFileIO,
  motebitId: string,
  record: PresentationRecord,
): Promise<void> {
  await update(io, (file) => {
    file.presentation[motebitId] = record;
  });
}

/** The kit's `exclusive`: hold the lease across `fn`, released however `fn` ends (R4). */
export async function withRosterLease<T>(
  io: RosterFileIO,
  fn: () => Promise<T>,
  opts: { waitMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const waitMs = opts.waitMs ?? LEASE_WAIT_MS;
  let token: string | null = null;
  for (let waited = 0; ; waited += 50) {
    token = await io.leaseAcquire(LEASE_TTL_MS);
    if (token != null) break;
    if (waited >= waitMs) throw new Error(LOCKED);
    await sleep(50);
  }
  try {
    return await fn();
  } finally {
    await io.leaseRelease(token).catch(() => false);
  }
}
