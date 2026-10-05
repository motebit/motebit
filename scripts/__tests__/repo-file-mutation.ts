/**
 * Gate self-tests that perturb a REAL repo file and run the real gate over the
 * repo — the only honest way to prove a gate still catches what it names —
 * go through here.
 *
 * Rules, each learned from a failure:
 *
 *  1. **The backup never sits in the repo.** `check-spec-routes.test.ts` kept
 *     `<target>.gate-test-backup` beside its target, so a concurrently running
 *     gate's tree walk listed the backup, then `lstat`ed it after it was
 *     deleted (`ENOENT … .gate-test-backup` killed a pre-push gauntlet). The
 *     backup goes to a fresh `mkdtemp` directory outside the tree.
 *  2. **One perturbation of the repo at a time, and no gate run over a
 *     perturbed repo** — a cross-process lock in the OS temp dir, keyed by the
 *     repo root, serializes every perturb → run → restore and every clean run.
 *  3. **Breaking a dead owner's lock is itself exclusive.** The first lock
 *     broke a stale lock by check-then-`rmSync`: a waiter that had judged the
 *     dead owner could delete the lock a faster waiter had just re-taken — up
 *     to 7 holders at once with 8 waiters. And owner = bare pid, so a reused
 *     pid made a dead owner look alive for the whole wait.
 *  4. **Never bless a corrupted file.** A SIGKILL mid-perturbation left
 *     `identity-transparency.ts` 169 lines short; the next run backed up the
 *     corrupted bytes as the "original" and verified its own restore of them.
 *     Now a file must match git HEAD before it is perturbed (else: refuse,
 *     naming `git checkout HEAD -- <file>`), and a durable manifest written
 *     BEFORE the perturbation lets whoever breaks the dead owner's lock put
 *     the file back to the recorded HEAD blob first.
 *  5. **The wait fits the budget the tests actually run with.** `test:gates`
 *     gives each test 30 s; the lock used to wait synchronously for up to ten
 *     minutes, so a queued test blew the vitest timeout (3/4 runs red at 4×
 *     concurrency). Waiting is async, FIFO, and gives up at 25 s with the
 *     holder named.
 *
 * The lock, as it sits in `LOCK` (`<tmp>/motebit-gate-self-test-locks-<hash>`
 * — a new name, not 48f1547's `…-lock-<hash>`: that code reads any directory
 * at its path as a live lock, so a checkout moved back to it would wait out
 * its ten minutes on this layout):
 *
 *  - **Generations.** `g<N>/` is the lock's N-th holding. The holder is the
 *    owner of the HIGHEST generation, unless that generation has `released`.
 *    To acquire — including to break a stale holding — a client builds
 *    `stage-<token>/owner` privately and renames it to `g<N+1>`, where N is
 *    the generation it judged free or stale. `rename` onto an existing
 *    (always non-empty) directory fails, so exactly one client wins each
 *    N+1, and the owner record exists from the first instant (no owner-less
 *    window to misjudge). Nothing ever renames or deletes the highest
 *    generation, so a breaker cannot remove a fresh lock: it can only fail
 *    to create the next one. The winner then lists again and backs off if a
 *    higher generation exists (it acted on a view so old that its N had been
 *    garbage-collected), which makes "highest" unforgeable.
 *  - **Tombstones.** Every generation below the holder's is dead state: the
 *    holder replays its manifest (below), renames it to a unique `dead-*`
 *    tombstone, and deletes that.
 *  - **Owner identity** is `{pid, start, token, since}`; `start` is the
 *    process start time (`/proc/<pid>/stat` field 22 on Linux, `ps -o lstart=`
 *    elsewhere). An owner is dead if the pid is gone or a zombie, or if the
 *    live pid's start time is not the recorded one (PID reuse). A generation
 *    with no readable owner older than `OWNERLESS_STALE_MS` is stale.
 *  - **Tickets.** Each waiter drops `t-<µs>-<token>` and only tries to acquire
 *    when no earlier ticket's owner is still alive — FIFO, so a test does not
 *    starve behind luckier pollers. Exclusivity never depends on tickets.
 *  - **Manifest.** `g<N>/manifest.json` (written temp → fsync → rename) holds
 *    `{rel, backup, blob}` per perturbed file BEFORE the file is touched.
 *    Recovery restores each from its backup, or from `git cat-file blob` when
 *    the backup is gone or wrong, and verifies the git blob hash.
 *
 * Harnesses: `repo-lock.harness.ts` (stale-lock exclusivity, kill -9
 * recovery, PID reuse) and `gate-test-mutation-race.harness.ts` (4
 * concurrent self-test runs at the real `test:gates` timeout).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanEnv } from "../lib/differential-tree.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/**
 * `MOTEBIT_GATE_LOCK_DIR` relocates the lock — only the lock's own tests
 * (`repo-file-mutation.test.ts`) set it, to drive it without contending with
 * the gate self-tests that share this checkout's real lock.
 */
const LOCK =
  process.env.MOTEBIT_GATE_LOCK_DIR ??
  join(
    tmpdir(),
    `motebit-gate-self-test-locks-${createHash("sha256").update(ROOT).digest("hex").slice(0, 12)}`,
  );
/** Strictly below `test:gates`' 30 s per-test budget, so the lock names the holder first. */
const WAIT_MS = ((v) => (Number.isFinite(v) && v > 0 ? v : 25_000))(
  Number(process.env.MOTEBIT_GATE_LOCK_WAIT_MS),
);
/** A generation is born with its owner record; one without it this long is debris. */
const OWNERLESS_STALE_MS = 5_000;
/** Staging dirs and tombstones older than this belong to a dead client. */
const DEBRIS_MS = 60_000;

// ── owner identity ─────────────────────────────────────────────────────────

interface Owner {
  pid: number;
  /** Process start time; null when this platform cannot say. */
  start: string | null;
  token: string;
  since: string;
}

type Probe = { alive: false } | { alive: true; start: string | null };

function probe(pid: number): Probe {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return { alive: false };
  }
  try {
    // Field 2 (comm) may hold spaces and parens: parse after the LAST ')'.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z" || fields[0] === "X") return { alive: false }; // field 3: state
    return { alive: true, start: fields[19] ?? null }; // field 22: starttime
  } catch {
    // no procfs (macOS): ps
  }
  const ps = spawnSync("ps", ["-o", "stat=", "-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
  });
  if (ps.status === 0 && ps.stdout.trim()) {
    const [state, ...start] = ps.stdout.trim().split(/\s+/);
    if (state?.startsWith("Z")) return { alive: false };
    return { alive: true, start: start.join(" ") || null };
  }
  if (ps.status === 1) return { alive: false };
  return { alive: true, start: null }; // cannot tell: never break a lock we cannot judge
}

function isDead(o: Owner): boolean {
  const p = probe(o.pid);
  return !p.alive || (p.start !== null && o.start !== null && p.start !== o.start);
}

const SELF_START = ((): string | null => {
  const p = probe(process.pid);
  return p.alive ? p.start : null;
})();

function newOwner(): Owner {
  return {
    pid: process.pid,
    start: SELF_START,
    token: randomBytes(8).toString("hex"),
    since: new Date().toISOString(),
  };
}

function readOwner(path: string): Owner | null {
  try {
    const o = JSON.parse(readFileSync(path, "utf8")) as Owner;
    return Number.isInteger(o.pid) && typeof o.token === "string" ? o : null;
  } catch {
    return null;
  }
}

// ── durable writes ─────────────────────────────────────────────────────────

function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // not supported on every platform; the rename is still atomic
  }
}

function writeDurable(path: string, data: string | Buffer): void {
  const fd = openSync(path, "w");
  try {
    writeSync(fd, typeof data === "string" ? Buffer.from(data) : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Temp file in the same directory → fsync → rename → fsync the directory. */
function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeDurable(tmp, data);
  renameSync(tmp, path);
  fsyncDir(dirname(path));
}

// ── git ────────────────────────────────────────────────────────────────────

function blobHash(bytes: Buffer): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function headBlob(rel: string): string {
  const r = spawnSync("git", ["rev-parse", `HEAD:${rel}`], {
    cwd: ROOT,
    encoding: "utf8",
    env: cleanEnv(),
  });
  if (r.status !== 0) {
    throw new Error(`gate self-test: ${rel} is not in git HEAD (${r.stderr.trim()})`);
  }
  return r.stdout.trim();
}

// ── manifest + recovery ────────────────────────────────────────────────────

interface Entry {
  rel: string;
  backup: string;
  blob: string;
  /**
   * Blob hash of the bytes the perturbation writes. Recovery restores only a
   * file that still holds exactly these bytes (or already the HEAD bytes):
   * anything else is an edit made since the crash, never overwritten.
   * Absent in a manifest written before this field existed.
   */
  perturbed?: string;
}

function readManifest(gen: string): Entry[] {
  try {
    return (JSON.parse(readFileSync(join(gen, "manifest.json"), "utf8")) as { entries: Entry[] })
      .entries;
  } catch {
    return [];
  }
}

function writeManifest(gen: string, entries: Entry[]): void {
  writeAtomic(join(gen, "manifest.json"), JSON.stringify({ entries }));
}

/**
 * Put `e.rel` back to its recorded HEAD blob — from the backup, else from git
 * — and verify. `afterCrash`: the perturbing process died, so time has passed;
 * a file that holds neither the perturbed bytes nor the HEAD bytes was edited
 * since, and is refused loudly rather than overwritten.
 */
function restoreEntry(e: Entry, afterCrash = false): void {
  const abs = resolve(ROOT, e.rel);
  if (afterCrash && e.perturbed !== undefined) {
    let onDisk: string | null;
    try {
      onDisk = blobHash(readFileSync(abs));
    } catch {
      onDisk = null;
    }
    if (onDisk !== e.perturbed && onDisk !== e.blob) {
      throw new Error(
        `gate self-test recovery refused to restore ${e.rel}: a self-test that perturbed it ` +
          `died, but the file no longer holds the perturbed bytes (${onDisk === null ? "missing" : `blob ${onDisk}`}) ` +
          `— it was edited since. Keep your edit and drop the crashed state ` +
          `(rm -rf ${LOCK}), or restore HEAD with: git checkout HEAD -- ${e.rel}`,
      );
    }
  }
  let bytes: Buffer | null = null;
  try {
    bytes = readFileSync(e.backup);
  } catch {
    bytes = null;
  }
  if (bytes === null || blobHash(bytes) !== e.blob) {
    const r = spawnSync("git", ["cat-file", "blob", e.blob], { cwd: ROOT, env: cleanEnv() });
    bytes = r.status === 0 ? (r.stdout as Buffer) : null;
  }
  if (bytes === null || blobHash(bytes) !== e.blob) {
    throw new Error(
      `gate self-test could not restore ${e.rel} (blob ${e.blob}) after a perturbation — ` +
        `restore with: git checkout HEAD -- ${e.rel}`,
    );
  }
  let current: Buffer | null;
  try {
    current = readFileSync(abs);
  } catch {
    current = null;
  }
  if (current === null || !current.equals(bytes)) writeDurable(abs, bytes);
  if (blobHash(readFileSync(abs)) !== e.blob) {
    throw new Error(
      `gate self-test restored ${e.rel} but it does not match blob ${e.blob} — ` +
        `restore with: git checkout HEAD -- ${e.rel}`,
    );
  }
  rmSync(dirname(e.backup), { recursive: true, force: true });
}

function age(path: string): number {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function tombstone(path: string): void {
  const dead = join(LOCK, `dead-${randomBytes(8).toString("hex")}`);
  try {
    renameSync(path, dead);
  } catch {
    return; // already gone
  }
  rmSync(dead, { recursive: true, force: true });
}

/**
 * Run by the holder right after it wins, before `fn`: every other generation
 * is dead state. Replay the manifest of each one that was never released (its
 * owner died mid-perturbation), then tombstone it; clear crash debris.
 */
function recover(own: number): void {
  for (const e of readdirSync(LOCK)) {
    const path = join(LOCK, e);
    const g = /^g(\d+)$/.exec(e);
    if (g && Number(g[1]) !== own) {
      for (const entry of readManifest(path)) restoreEntry(entry, true);
      tombstone(path);
    } else if ((/^(stage|dead)-/.test(e) || isStagedTemp(e)) && age(path) > DEBRIS_MS) {
      rmSync(path, { recursive: true, force: true });
    }
  }
}

// ── the lock ───────────────────────────────────────────────────────────────

function generations(): number[] {
  return readdirSync(LOCK)
    .map((e) => /^g(\d+)$/.exec(e)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}

type View = { top: number } & (
  { state: "free" } | { state: "stale" } | { state: "held"; owner: Owner | null }
);

function look(): View {
  const top = generations().at(-1) ?? 0;
  if (top === 0) return { top, state: "free" };
  const gen = join(LOCK, `g${top}`);
  try {
    statSync(join(gen, "released"));
    return { top, state: "free" };
  } catch {
    // not released
  }
  const owner = readOwner(join(gen, "owner"));
  if (owner === null) {
    return age(gen) > OWNERLESS_STALE_MS ? { top, state: "stale" } : { top, state: "held", owner };
  }
  return isDead(owner) ? { top, state: "stale" } : { top, state: "held", owner };
}

/**
 * A `writeAtomic` temp (`<name>.<hex>.tmp`) — never a ticket: a waiter
 * killed mid-write leaves an empty one, and treating it as a ticket made it
 * the queue's head for `DEBRIS_MS`, starving every acquirer.
 */
function isStagedTemp(name: string): boolean {
  return name.endsWith(".tmp");
}

/** The earliest ticket whose owner is alive, clearing dead owners' tickets on the way. */
function headTicket(): { name: string; owner: Owner | null } | null {
  for (const name of readdirSync(LOCK)
    .filter((e) => e.startsWith("t-") && !isStagedTemp(e))
    .sort()) {
    const owner = readOwner(join(LOCK, name));
    if (owner !== null && isDead(owner)) {
      rmSync(join(LOCK, name), { force: true });
      continue;
    }
    if (owner === null && age(join(LOCK, name)) > DEBRIS_MS) {
      rmSync(join(LOCK, name), { force: true });
      continue;
    }
    return { name, owner };
  }
  return null;
}

/** Try to become generation `n`. True = this process holds the lock. */
function tryTake(n: number, me: Owner): boolean {
  const stage = join(LOCK, `stage-${me.token}`);
  mkdirSync(stage);
  writeDurable(join(stage, "owner"), JSON.stringify(me));
  fsyncDir(stage);
  try {
    renameSync(stage, join(LOCK, `g${n}`));
  } catch (err) {
    rmSync(stage, { recursive: true, force: true });
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOTEMPTY" || code === "EPERM") return false;
    throw err;
  }
  fsyncDir(LOCK);
  // Acted on a view so old that generation n had been collected: a higher
  // generation exists and outranks us. Back off (never having touched the
  // repo) and tombstone our dir; the next `look()` sees the real top.
  if ((generations().at(-1) ?? 0) > n) {
    tombstone(join(LOCK, `g${n}`));
    return false;
  }
  return true;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Held {
  gen: string;
}
const held = new AsyncLocalStorage<Held>();

async function acquire(): Promise<{ n: number; gen: string }> {
  mkdirSync(LOCK, { recursive: true });
  const me = newOwner();
  const micros = Math.round((performance.timeOrigin + performance.now()) * 1000);
  const ticket = `t-${String(micros).padStart(17, "0")}-${me.token}`;
  writeAtomic(join(LOCK, ticket), JSON.stringify(me));
  const deadline = Date.now() + WAIT_MS;
  try {
    for (;;) {
      const view = look();
      const head = headTicket();
      const myTurn = head === null || head.name === ticket;
      if (view.state !== "held" && myTurn && tryTake(view.top + 1, me)) {
        const n = view.top + 1;
        return { n, gen: join(LOCK, `g${n}`) };
      }
      if (Date.now() > deadline) {
        const o = view.state === "held" ? view.owner : null;
        const holder = o
          ? `held by pid ${o.pid} (started ${o.start ?? "?"}) since ${o.since}`
          : `queued behind ${head?.owner ? `pid ${head.owner.pid}'s ticket` : "an ownerless generation"}`;
        throw new Error(
          `gate self-test lock ${LOCK} ${holder} — waited ${WAIT_MS / 1000}s ` +
            `(MOTEBIT_GATE_LOCK_WAIT_MS). Another gate self-test is perturbing this repo; ` +
            `run them one at a time. If none is running, rm -rf ${LOCK} and re-run ` +
            `(a lock whose owner died is broken, and its perturbations restored, automatically).`,
        );
      }
      await sleep(15 + Math.random() * 25);
    }
  } finally {
    rmSync(join(LOCK, ticket), { force: true });
  }
}

/**
 * Run `fn` holding the repo-perturbation lock. Re-entrant within one async
 * call chain: a nested call runs `fn` directly under the outer holding.
 */
export async function withRepoLock<T>(fn: () => T | Promise<T>): Promise<T> {
  if (held.getStore()) return await fn();
  const { n, gen } = await acquire();
  try {
    recover(n);
    return await held.run({ gen }, fn);
  } finally {
    writeAtomic(join(gen, "released"), new Date().toISOString());
  }
}

/**
 * Run `fn` with the repo file at `absPath` replaced by `next` (a string, or a
 * function of the original), under the lock. The file must match git HEAD
 * first; it is restored byte-for-byte from a backup kept OUTSIDE the repo,
 * and a manifest entry makes the restore survive this process being killed.
 */
export async function withRepoFileReplaced<T>(
  absPath: string,
  next: string | ((original: string) => string),
  fn: () => T | Promise<T>,
): Promise<T> {
  return withRepoLock(async () => {
    const { gen } = held.getStore()!;
    const rel = relative(ROOT, absPath).split(sep).join("/");
    const blob = headBlob(rel);
    const original = readFileSync(absPath);
    if (blobHash(original) !== blob) {
      throw new Error(
        `gate self-test refused to perturb ${rel}: it differs from git HEAD, so its ` +
          `"original" cannot be trusted (an earlier self-test killed mid-perturbation, or an ` +
          `uncommitted edit). Restore with: git checkout HEAD -- ${rel}`,
      );
    }
    const perturbedText = typeof next === "string" ? next : next(original.toString("utf8"));
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "motebit-gate-self-test-")));
    const entry: Entry = {
      rel,
      backup: join(dir, basename(absPath)),
      blob,
      perturbed: blobHash(Buffer.from(perturbedText)),
    };
    writeDurable(entry.backup, original);
    writeManifest(gen, [...readManifest(gen), entry]);
    try {
      writeFileSync(absPath, perturbedText);
      return await fn();
    } finally {
      // Guard the guard, still under the lock: restored and verified against
      // the HEAD blob, THEN the manifest forgets it.
      restoreEntry(entry);
      writeManifest(
        gen,
        readManifest(gen).filter((e) => e.backup !== entry.backup),
      );
    }
  });
}
