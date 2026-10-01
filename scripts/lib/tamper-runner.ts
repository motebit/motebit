/**
 * tamper-runner — the one shared, parallel runner for TAMPER files.
 *
 * A tamper is a hand-rolled mutation test: revert one fix (one or more exact
 * edits), run the test named for it, and require that test to go RED. A
 * tamper file keeps its entries as data and hands them to `runTampers`; this
 * module owns everything else (docs/ops/agentic-lanes.md § tamper checks).
 *
 * THE LAW: a RED is REPRODUCED CAUSATION, never a single observation. A
 * non-zero exit, a missing report, a crash, a typo'd path, a port someone
 * else holds, a flaky test, a process a previous run left behind — none of
 * these is evidence that the tamper bit. Concretely:
 *   - vitest runs with a machine-readable reporter (vitest's `json`, written to
 *     a file, plus a two-line companion reporter for the unhandled errors and
 *     error names the `json` reporter drops) and the verdict is decided from
 *     those files, never from the exit code or a grep of the text output;
 *   - BASELINE: before any tamper, every distinct test (pkg + test file, or
 *     command) runs once in a slot with no edit. It must run, report at least
 *     one passing test and no failure, exit 0 and leave no process behind — or
 *     the whole run ABORTS (exit 2, `BASELINE NOT GREEN: <test>`);
 *   - THE SEQUENCE: an entry is RED only when, in ONE slot,
 *       U → E → U → E → U   (U = unedited, E = edited; runs 1..5)
 *     goes green, red, green, red, green: every U green, both E runs red on
 *     the named test (`red:`; without it, on the same set of tests that
 *     passed in the U before), and each such test failing with the same
 *     error CLASS (its errors' names; a vitest timeout is "timeout") in both
 *     E runs, and passing in every U after it. GREEN when both E runs pass
 *     (the U runs green) AND the edit was LOADED (below). Anything else is
 *     INCONCLUSIVE with the reason
 *     (`pre-run not green`, `run 3/5 (unedited, between the edited runs) not
 *     green`, `did not reproduce`, `the edited runs failed differently`,
 *     `post-run not green: slot state leaked`, …). Timeouts get no special
 *     path: they reproduce or they do not. Runs chain: run 5 (or the
 *     baseline, when nothing ran in the slot since) IS the next entry's run
 *     1, so an entry costs four runs of its test;
 *   - THE FLAKE VETO: a test seen failing with NO edit anywhere in the run
 *     (any U after the baseline) voids every RED on it in that run — those
 *     REDs' green U runs were luck, not a property of the test. A group's
 *     verdicts print when the group finishes;
 *   - an edited run is red only when a test that passed in the U before it
 *     fails with a test-level failure (an assertion or error thrown inside
 *     the test), there is no suite-level/collection error, no unhandled
 *     error and no orphan, and vitest exited non-zero. `red:` is the EXACT
 *     full name (describe path + title, space-joined, as vitest's JSON
 *     reporter gives it) — a describe name or a bare title is not enough;
 *   - PROCESS HYGIENE: every process runs in its own process group. When it
 *     exits, the group is SIGKILLed and the runner VERIFIES no process is
 *     left in it and none works in the slot (cwd or an open file under the
 *     slot's tree/TMPDIR/HOME, or the slot's TAMPER_RUNNER_SLOT token in its
 *     environment — Linux reads /proc; elsewhere `ps` + `lsof`, best effort,
 *     no environment check). One found outside the group escaped the kill:
 *     it is killed and the run is INCONCLUSIVE (`orphan: …`). On exit a
 *     final sweep does the same for every slot, and one that survives it
 *     fails the run (exit 2);
 *   - an edit must be VALID CODE BY THE COMPILER: before the first edited
 *     run, the edited files are type-checked with the tree's `typescript`
 *     (nearest tsconfig.json, else strict NodeNext defaults with the hoisted
 *     @types; allowJs + checkJs, so .mjs/.js too; noUnused* off, since a
 *     revert may orphan a helper), before and after the edit, and any
 *     diagnostic the edit adds in an edited file — or an import specifier in
 *     it that no longer resolves — is INCONCLUSIVE (`edit does not
 *     type-check: <file>:<line> TS<code> …`). No `typescript`: .js files get
 *     `node --check`, .ts files are INCONCLUSIVE. JSON must still parse;
 *     other files are not checked;
 *   - a GREEN must rest on an edit the run LOADED, never on a test that never
 *     saw it (one that reads only a `dist` the entry does not rebuild):
 *     when run 2 is green, run 4 carries, appended to each edited JS/TS module
 *     after the type-check, a LOAD SENTINEL — one statement that, when the
 *     module is evaluated (from the source, or from the build output a
 *     rebuild emitted from it, in the test or the rebuild), appends a per-run
 *     token to a runner-owned file. GREEN needs every edited file's token;
 *     an edited file whose token never came, or that cannot carry one (not a
 *     JS/TS module: JSON, text, .d.ts), is INCONCLUSIVE (`edit not loaded:
 *     …; missing rebuild: [pkg]?`, naming the file's package when the entry
 *     does not rebuild it). A RED's runs never carry it. Residual, stated: a
 *     load is not an execution of the edited lines (a loaded module whose
 *     edited function the test never calls still reads GREEN, honestly: the
 *     test did not catch it), a module evaluated where `globalThis.process`
 *     is not Node's (a browser) cannot record, and a bundler that drops the
 *     statement (a `sideEffects: false` package) reads not-loaded;
 *   - an entry that changes nothing (no edits, from === to, or edits that
 *     leave every file as it was) ABORTS the run (exit 2) before anything runs;
 *   - a `command` (non-vitest) entry must declare `redMarker`, the text its
 *     check prints only when it fails. Red = non-zero exit AND the marker;
 *     green = exit 0 and no marker; the sequence applies as above. An entry
 *     without `redMarker` is INCONCLUSIVE without being run.
 * Residual, stated: a test that fails on a schedule matching U/E/U/E/U by
 * itself (e.g. every other run) is indistinguishable from causation by any
 * fixed schedule; a single-entry group on a 50% flaky test still reads RED
 * with probability 1/16 (the veto needs a U to fail); a process that
 * leaves the group, the slot and its environment (chdir away, closes every
 * fd, clears its env) escapes the check; and state outside the slot/TMPDIR/
 * HOME (a hard-coded /tmp path, a fixed port two test files share) is not
 * reset — the interleaving makes such leaks show as a U that is not green,
 * which then vetoes the group, but not provably.
 *
 * Isolation. Every tamper runs in a private copy of the caller's tree, never
 * in the caller's tree itself. A copy (a "slot") is a `git worktree` at HEAD
 * with:
 *   - the caller's uncommitted state overlaid (tracked changes vs HEAD and
 *     untracked non-ignored files), so an uncommitted fix is what gets tested;
 *   - the caller's ignored build state copied (`cp -a`): every nested
 *     `node_modules` (pnpm's symlinks are relative, so workspace links resolve
 *     inside the copy), every `dist`, `*.tsbuildinfo` and other ignored
 *     output. The root `node_modules` is a real directory whose entries are
 *     copied; its 2 GB `.pnpm` store is a real directory too, whose package
 *     entries are symlinks to the caller's (read-only use) EXCEPT
 *     `.pnpm/node_modules` (the hoisted links, where
 *     `.pnpm/node_modules/@motebit/*` point at the workspace packages) and any
 *     entry holding a link back into the workspace: those are copied, so they
 *     resolve to the SLOT's packages. `node_modules/.bin` shims (which bake
 *     the caller's absolute path into `NODE_PATH`) are rewritten to the slot.
 *     Residual, stated: code INSIDE a symlinked external package resolves by
 *     its real path, so a phantom (undeclared) import of a workspace package
 *     from an external package would still reach the caller's copy; no
 *     external package in the store declares a workspace dependency (pnpm
 *     would have linked it inside the entry, which is then copied);
 *   - every tracked file's mtime synced to the caller's, so `tsc -b` sees the
 *     copied `dist` as up to date and a rebuild compiles only what changed.
 * Every run (baseline, unedited, edited) starts with the slot's
 * TMPDIR emptied and a fresh HOME (XDG_CONFIG/CACHE/DATA/STATE_HOME under it)
 * — the runner's own files (reports, reporter) live outside both. Measured
 * cost: about 1.4 s per run on a monorepo vitest file (caches in HOME and
 * TMPDIR start cold).
 * One copy is made per worker slot and REUSED. After every run in a slot the
 * edited files are restored from git (an overlaid file gets the caller's bytes
 * back) with their mtimes, and EVERY ignored path that changed — any output a
 * rebuild or a test wrote, whatever its name — is put back as the slot had it
 * (a new ignored path is deleted, a changed or missing one is re-copied from
 * the caller). Then the slot is VERIFIED: `git status` must equal the slot's
 * pristine status, every overlaid file must hash to the caller's bytes, and
 * the ignored state must equal the pristine snapshot — else the run aborts
 * (exit 2): a slot that did not restore is never reused.
 *
 * Ports and grouping. Slots share the host network. Entries that run the SAME
 * test (same pkg + test file, or the same command) form one group, and a
 * group runs SEQUENTIALLY in ONE slot, so no two copies of one test ever run
 * at once. Two DIFFERENT test files that bind the same fixed port can still
 * collide; that is the test files' problem (give them distinct or ephemeral
 * ports) — and a port held by any process outside the run fails the baseline
 * (abort), never a tamper (false RED).
 *
 * Contract (one line per entry, in entry order whatever the execution order):
 *   RED (ok)         positive evidence the tamper bites (above)
 *   GREEN            the test passed with the fix reverted (and loaded it) — a failure
 *   INCONCLUSIVE     neither: the reason follows — a failure
 *   COULD NOT APPLY  an edit's text is not found exactly once — a failure
 *   BUILD FAILED     a rebuild the test needs failed — a failure
 * then `N/N tampers turned their test red`. The process exits 1 on any
 * failure, and 2 if the runner itself could not keep its guarantees (a
 * baseline not green, a copy that could not be made, restored or verified,
 * the caller's tree changing under it).
 *
 * Lifecycle. Slots live under `$TMPDIR/motebit-tamper-*` with an
 * `owner.json`: the owner's pid, hostname, pid namespace (`/proc/self/ns/pid`)
 * and every process group it started (each test runs detached, in its own).
 * Exit, SIGINT, SIGTERM and SIGHUP kill the running tests (their whole process
 * group) and remove every slot and its worktree registration. A SIGKILLed run
 * can do neither, so on startup, for any `motebit-tamper-*` worktree this repo
 * registered whose owner is a dead pid of THIS host and pid namespace, the
 * recorded groups still working inside the slot (a member's cwd under it,
 * read from /proc) are SIGKILLed first, then the slot is removed. A slot
 * recorded by another host or pid namespace is never touched (its pid means
 * nothing here); one with no owner record is removed only when its directory
 * is already gone.
 *
 * Concurrency: default max(1, floor(cpus / 2)); `--concurrency=N` / `-j N`
 * on the tamper file's command line, or `TAMPER_CONCURRENCY=N`, overrides.
 *
 * Plain-node loadable: erasable TypeScript only (Node >= 22.18 strips types),
 * node built-ins only, so `node <tamper file>.mjs` keeps working.
 */
import { spawn, spawnSync, execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { availableParallelism, cpus, hostname, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** One exact edit that reverts (part of) a fix. `file` is repo-relative. */
export interface TamperEdit {
  file: string;
  from: string;
  to: string;
}

export interface TamperEntry {
  /** One-line label printed with the verdict. */
  name: string;
  /** The edits that remove the fix; each `from` must occur exactly once. */
  edits: TamperEdit[];
  /**
   * pnpm package name the test belongs to; runs `pnpm --filter <pkg> exec vitest run <test>`.
   * Omitted: the test is run from the repo root (`pnpm exec vitest run <test>`).
   */
  pkg?: string;
  /** Test file, relative to the package directory (or the repo root without `pkg`). */
  test?: string;
  /**
   * The EXACT full name (describe path + title, space-joined, as vitest's JSON
   * reporter gives it) of the test that must be the one to fail. A describe
   * name or a bare title is not a match.
   */
  red?: string;
  /**
   * Run ONLY the `red` test (vitest `-t`, anchored to its exact full name) in
   * the entry's pre-run, edited run(s) and post-run; the group's baseline
   * still runs the whole file. For a file whose tests do not depend on each
   * other and are slow to run all at once. Needs `red`.
   */
  only?: boolean;
  /** Packages to rebuild (in the copy only) before the test, because the test reads their `dist`. */
  rebuild?: string[];
  /** Escape hatch for non-vitest tests: argv to run instead of the vitest command. Needs `redMarker`. */
  command?: string[];
  /** Working directory for `command`, relative to the repo root (default: the root). */
  cwd?: string;
  /** For `command`: text the check prints (stdout or stderr) when, and only when, it fails. */
  redMarker?: string;
}

export interface RunTampersOptions {
  /** Repo root (any path inside the caller's git tree works; the top level is used). */
  root: string;
  /** Worker slots. Default: argv/env override, else max(1, floor(cpus / 2)). */
  concurrency?: number;
  /** Where the lines go. Default: stdout. */
  log?: (line: string) => void;
  /** Exit the process with the verdict (default true). */
  exit?: boolean;
  /** Command-line args to read `--concurrency` from. Default: process.argv.slice(2). */
  argv?: string[];
}

export type TamperVerdict = "RED" | "GREEN" | "INCONCLUSIVE" | "COULD NOT APPLY" | "BUILD FAILED";

export interface TamperResult {
  index: number;
  name: string;
  verdict: TamperVerdict;
  detail?: string;
  slot: number;
}

export interface RunTampersSummary {
  ok: boolean;
  results: TamperResult[];
  concurrency: number;
  exitCode: number;
}

const LABEL: Record<TamperVerdict, string> = {
  RED: "RED (ok)       ",
  GREEN: "GREEN          ",
  INCONCLUSIVE: "INCONCLUSIVE   ",
  "COULD NOT APPLY": "COULD NOT APPLY",
  "BUILD FAILED": "BUILD FAILED   ",
};

/** Ignored paths never copied into a slot: caches, reports, other agents' trees. */
const SKIP_IGNORED = new Set([".turbo", "coverage", ".next"]);

/** Base-directory prefix of every slot directory (under the OS temp dir). */
const BASE_PREFIX = "motebit-tamper-";

export function resolveConcurrency(opts: {
  concurrency?: number;
  argv?: string[];
  env?: Record<string, string | undefined>;
}): number {
  const argv = opts.argv ?? [];
  let raw: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--concurrency=")) raw = a.slice("--concurrency=".length);
    else if (a === "--concurrency" || a === "-j") raw = argv[i + 1];
    else if (/^-j\d+$/.test(a)) raw = a.slice(2);
  }
  raw ??= opts.env?.TAMPER_CONCURRENCY;
  if (raw != null) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) throw new Error(`tamper-runner: bad concurrency "${raw}"`);
    return n;
  }
  if (opts.concurrency != null) return Math.max(1, Math.floor(opts.concurrency));
  const n = typeof availableParallelism === "function" ? availableParallelism() : cpus().length;
  return Math.max(1, Math.floor(n / 2));
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

function nulList(out: string): string[] {
  return out.split("\0").filter((s) => s.length > 0);
}

function sha(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** A fingerprint of the caller's working tree: status, the full diff vs HEAD, untracked bytes. */
function treeFingerprint(root: string): string {
  const h = createHash("sha256");
  h.update(git(root, ["rev-parse", "HEAD"]));
  h.update(git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
  h.update(git(root, ["diff", "HEAD", "--binary", "--no-renames"]));
  for (const f of nulList(git(root, ["ls-files", "--others", "--exclude-standard", "-z"]))) {
    h.update(f);
    try {
      h.update(readFileSync(join(root, f)));
    } catch {
      h.update("<unreadable>");
    }
  }
  return h.digest("hex");
}

/** `cp -a` preserves symlinks (pnpm's relative links) and mtimes. */
function cpA(src: string, dst: string): void {
  mkdirSync(dirname(dst), { recursive: true });
  execFileSync("cp", ["-a", src, dst]);
}

class RunnerError extends Error {}

// ---------------------------------------------------------------------------
// Stale-slot pruning (a SIGKILLed or crashed run leaves registered worktrees).

/** What a slot base's `owner.json` records: who may reap it, and what to kill first. */
interface OwnerRecord {
  pid: number;
  host: string;
  /** `/proc/self/ns/pid` of the owner (null where there is no /proc). */
  pidns: string | null;
  /** Every process group the owner started (each test/build runs in its own). */
  pgids: number[];
}

function pidNamespace(): string | null {
  try {
    return readlinkSync("/proc/self/ns/pid");
  } catch {
    return null;
  }
}

function readOwner(base: string): OwnerRecord | null {
  try {
    const o = JSON.parse(readFileSync(join(base, "owner.json"), "utf8")) as OwnerRecord;
    if (!Number.isInteger(o.pid) || typeof o.host !== "string" || !Array.isArray(o.pgids)) {
      return null;
    }
    return o;
  } catch {
    return null;
  }
}

/**
 * SIGKILL every recorded process group that still has a member working inside
 * `base` (its cwd under it: proof the group is this slot's, not a later
 * process that reused the id). Needs /proc; without it nothing is killed.
 */
function killLeftoverGroups(base: string, pgids: number[]): void {
  let baseReal: string;
  let procs: string[];
  try {
    baseReal = realpathSync(base);
    procs = readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch {
    return;
  }
  const wanted = new Set(pgids);
  const proven = new Set<number>();
  for (const n of procs) {
    try {
      const stat = readFileSync(`/proc/${n}/stat`, "utf8");
      const pgrp = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
      if (!wanted.has(pgrp)) continue;
      const cwd = readlinkSync(`/proc/${n}/cwd`);
      if (`${cwd}${sep}`.startsWith(`${baseReal}${sep}`)) proven.add(pgrp);
    } catch {
      // exited meanwhile, or not ours to read
    }
  }
  for (const g of proven) {
    try {
      process.kill(-g, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Remove every `motebit-tamper-*` worktree registered in this repo whose
 * owner (`owner.json`) is provably a dead process of THIS host and pid
 * namespace — after killing the process groups it left running — or, with no
 * owner record, whose directory is gone. A slot recorded by another host or
 * pid namespace is never touched: its pid means nothing here. Returns the
 * paths removed.
 */
function pruneStaleSlots(root: string): string[] {
  const removed: string[] = [];
  const list = git(root, ["worktree", "list", "--porcelain"]);
  const paths = list
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length));
  for (const p of paths) {
    const base = dirname(p);
    if (!basename(base).startsWith(BASE_PREFIX) || !/^slot-\d+$/.test(basename(p))) continue;
    const owner = readOwner(base);
    if (owner != null) {
      if (owner.host !== hostname() || owner.pidns !== pidNamespace()) continue;
      if (owner.pid <= 0 || pidAlive(owner.pid)) continue;
      killLeftoverGroups(base, owner.pgids);
    } else if (existsSync(p)) {
      // no owner record: not provably ours to reap (a missing directory is
      // only a stale registration)
      continue;
    }
    try {
      execFileSync("git", ["worktree", "remove", "--force", p], { cwd: root, stdio: "ignore" });
    } catch {
      // directory already gone: `worktree prune` below drops the registration
    }
    rmSync(base, { recursive: true, force: true });
    removed.push(p);
  }
  if (removed.length > 0) {
    execFileSync("git", ["worktree", "prune"], { cwd: root, stdio: "ignore" });
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Slots.

interface Slot {
  index: number;
  dir: string;
  /** The tests' TMPDIR: emptied before every run. */
  tmp: string;
  /** The tests' HOME (and XDG dirs under it): recreated before every run. */
  home: string;
  /** The runner's own files (reports, reporter): never visible to a test. */
  run: string;
  /**
   * The last run in this slot was an UNEDITED green run of group `key` (and
   * nothing ran since): the pre-run the next entry of that group stands on.
   */
  chain?: { key: string; passed: Set<string> };
  /** repo-relative paths whose content in the slot is the caller's dirty bytes, not HEAD's. */
  overlaid: Set<string>;
  /** `git status` of the slot as created. */
  pristineStatus: string;
  /** Ignored state of the slot as created (see ignoredState). */
  pristineIgnored: Map<string, string>;
  /** What marks a process as this slot's (every run is swept with it). */
  hygiene: Hygiene;
}

interface Plan {
  root: string;
  /** Ignored paths (from the caller) to copy into each slot, repo-relative, no trailing slash. */
  ignored: string[];
  /** Tracked files that differ from HEAD in the caller (or are deleted there). */
  dirty: string[];
  /** Untracked, non-ignored files in the caller. */
  untracked: string[];
  tracked: string[];
  /** sha256 of each overlaid file's caller bytes ("" = deleted in the caller). */
  overlayHash: Map<string, string>;
  /** pnpm package name -> package dir, repo-relative ("." for the root). */
  pkgDirs: Map<string, string>;
}

function makePlan(root: string, pkgs: string[]): Plan {
  const ignored = nulList(
    git(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]),
  )
    .map((p) => p.replace(/\/$/, ""))
    .filter((p) => {
      if (p === ".git" || p.startsWith(".git/") || p.startsWith(".claude/")) return false;
      if (p.split("/").some((seg) => SKIP_IGNORED.has(seg))) return false;
      return true;
    });
  const dirty = nulList(git(root, ["diff", "HEAD", "--name-only", "--no-renames", "-z"]));
  const untracked = nulList(git(root, ["ls-files", "--others", "--exclude-standard", "-z"]));
  const tracked = nulList(git(root, ["ls-files", "-z"]));
  const overlayHash = new Map<string, string>();
  for (const f of [...dirty, ...untracked]) {
    const abs = join(root, f);
    overlayHash.set(f, existsSync(abs) ? sha(readFileSync(abs)) : "");
  }
  const pkgDirs = new Map<string, string>();
  for (const pkg of pkgs) {
    let out: string;
    try {
      out = execFileSync("pnpm", ["--filter", pkg, "exec", "pwd"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      throw new RunnerError(`tamper-runner: package ${pkg} not found in the workspace`, {
        cause: err,
      });
    }
    const lines = out.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length !== 1) {
      throw new RunnerError(`tamper-runner: package filter ${pkg} matched ${lines.length} dirs`);
    }
    pkgDirs.set(pkg, relative(realpathSync(root), realpathSync(lines[0]!.trim())) || ".");
  }
  return {
    root,
    ignored,
    dirty,
    untracked,
    tracked,
    overlayHash,
    pkgDirs,
  };
}

/** Does any link under `.pnpm/<entry>/node_modules` point outside the store (into the workspace)? */
function linksOutOfStore(store: string, entry: string): boolean {
  const nm = join(store, entry, "node_modules");
  let names: string[];
  try {
    names = readdirSync(nm);
  } catch {
    return false;
  }
  const check = (p: string): boolean => {
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return false;
    }
    if (!st.isSymbolicLink()) return false;
    const target = resolve(dirname(p), readlinkSync(p));
    return !(target + sep).startsWith(store + sep);
  };
  for (const n of names) {
    const p = join(nm, n);
    if (n.startsWith("@")) {
      let scoped: string[] = [];
      try {
        scoped = readdirSync(p);
      } catch {
        // not a scope dir
      }
      if (scoped.some((s) => check(join(p, s)))) return true;
    } else if (check(p)) return true;
  }
  return false;
}

/** Copy the root node_modules into the slot: real dirs, a real `.pnpm` of symlinked entries. */
function copyRootNodeModules(root: string, dir: string): void {
  const src = join(root, "node_modules");
  const dst = join(dir, "node_modules");
  mkdirSync(dst, { recursive: true });
  for (const e of readdirSync(src)) {
    if (e !== ".pnpm") {
      cpA(join(src, e), join(dst, e));
      continue;
    }
    const store = join(src, ".pnpm");
    const slotStore = join(dst, ".pnpm");
    mkdirSync(slotStore);
    for (const s of readdirSync(store)) {
      // The hoisted links (`.pnpm/node_modules/@motebit/* -> ../../../../packages/*`)
      // and any entry linking back into the workspace are copied, so their
      // relative links land in the SLOT's packages.
      if (s === "node_modules" || linksOutOfStore(store, s))
        cpA(join(store, s), join(slotStore, s));
      else symlinkSync(join(store, s), join(slotStore, s));
    }
  }
}

/** pnpm `.bin` shims bake the caller's absolute path into NODE_PATH; point them at the slot. */
function rewriteBinShims(root: string, dir: string, ignored: string[]): void {
  const rootAbs = realpathSync(root);
  const visitBin = (bin: string): void => {
    let names: string[];
    try {
      names = readdirSync(bin);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(bin, n);
      const st = lstatSync(p);
      if (!st.isFile() || st.size > 64 * 1024) continue;
      const text = readFileSync(p, "utf8");
      if (!text.includes(rootAbs)) continue;
      writeFileSync(p, text.split(`${rootAbs}/`).join(`${dir}/`));
      utimesSync(p, st.atime, st.mtime);
    }
  };
  for (const p of ignored) {
    if (basename(p) !== "node_modules") continue;
    visitBin(join(dir, p, ".bin"));
  }
}

/**
 * Every ignored path in the slot, as `rel -> stamp`: a file's size + mtime, a
 * link's target, a dir's type. `node_modules/.pnpm` (the store, symlinks to
 * the caller's) is excluded; nothing in a run writes it.
 */
function ignoredState(dir: string): Map<string, string> {
  const acc = new Map<string, string>();
  const roots = nulList(
    git(dir, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]),
  ).map((p) => p.replace(/\/$/, ""));
  const visit = (rel: string): void => {
    if (rel === "node_modules/.pnpm") return;
    let st;
    try {
      st = lstatSync(join(dir, rel));
    } catch {
      return;
    }
    if (st.isSymbolicLink()) {
      acc.set(rel, `link:${readlinkSync(join(dir, rel))}`);
    } else if (st.isDirectory()) {
      acc.set(rel, "dir");
      for (const e of readdirSync(join(dir, rel))) visit(`${rel}/${e}`);
    } else {
      acc.set(rel, `file:${st.size}:${st.mtimeMs}`);
    }
  };
  for (const r of roots) visit(r);
  return acc;
}

function createSlot(plan: Plan, base: string, index: number): Slot {
  const { root } = plan;
  const dir = join(base, `slot-${index}`);
  git(root, ["worktree", "add", "--detach", "--quiet", dir, "HEAD"]);
  const tmp = join(base, `tmp-${index}`);
  const home = join(base, `home-${index}`);
  const run = join(base, `run-${index}`);
  mkdirSync(run, { recursive: true });

  // Ignored build state.
  for (const p of plan.ignored) {
    const src = join(root, p);
    if (!existsSync(src)) continue;
    if (p === "node_modules") {
      copyRootNodeModules(root, dir);
    } else {
      rmSync(join(dir, p), { recursive: true, force: true });
      cpA(src, join(dir, p));
    }
  }
  rewriteBinShims(root, dir, plan.ignored);

  // The caller's uncommitted state.
  const overlaid = new Set<string>();
  for (const f of [...plan.dirty, ...plan.untracked]) {
    const src = join(root, f);
    const dst = join(dir, f);
    if (existsSync(src)) cpA(src, dst);
    else rmSync(dst, { force: true });
    overlaid.add(f);
  }

  // mtimes, so `tsc -b` treats the copied outputs as current.
  for (const f of plan.tracked) {
    if (overlaid.has(f)) continue;
    try {
      const st = lstatSync(join(root, f));
      if (st.isSymbolicLink()) continue;
      utimesSync(join(dir, f), st.atime, st.mtime);
    } catch {
      // deleted in the caller: handled by the overlay
    }
  }
  const pristineStatus = git(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const pristineIgnored = ignoredState(dir);
  const real = realpathSync(base);
  const hygiene: Hygiene = {
    dirs: [join(real, `slot-${index}`), join(real, `tmp-${index}`), join(real, `home-${index}`)],
    token: `${randomBytes(12).toString("hex")}-${index}`,
  };
  const slot: Slot = {
    index,
    dir,
    tmp,
    home,
    run,
    overlaid,
    pristineStatus,
    pristineIgnored,
    hygiene,
  };
  resetRunState(slot);
  return slot;
}

// ---------------------------------------------------------------------------
// Processes.

interface Running {
  children: Set<ChildProcess>;
  /** Called with each new child's process group id (= its pid: it is detached). */
  onSpawn?: (pgid: number) => void;
}

interface Exec {
  code: number | null;
  out: string;
  /**
   * Processes that outlived the run: after it closed and its process group
   * was SIGKILLed, still alive (in the group) or found elsewhere working in
   * the slot (cwd, an open file, or the slot's token in its environment).
   * Each was then killed. Non-empty = the run is not evidence of anything.
   */
  orphans: string[];
}

/** What marks a process as this slot's: its group, its dirs, its token. */
interface Hygiene {
  /** The slot's tree, TMPDIR and HOME. */
  dirs: string[];
  /** A value only this slot's runs carry in their environment (TAMPER_RUNNER_SLOT). */
  token: string;
}

interface Proc {
  pid: number;
  pgid: number;
  why: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function under(p: string, dirs: string[]): boolean {
  return dirs.some((d) => p === d || p.startsWith(`${d}${sep}`));
}

/**
 * Every live (non-zombie) process, other than this one, that is in one of
 * `pgids` or works inside `h.dirs` (cwd or an open file) or carries `h.token`
 * in its environment. Linux: /proc. Elsewhere: `ps` (groups) and `lsof`
 * (cwd and open files), best effort; no environment check.
 */
function scanProcesses(pgids: Set<number>, hs: Hygiene[]): Proc[] {
  const found: Proc[] = [];
  const dirs = hs.flatMap((h) => h.dirs);
  if (existsSync("/proc/self/stat")) {
    let pids: string[];
    try {
      pids = readdirSync("/proc").filter((n) => /^\d+$/.test(n));
    } catch {
      return found;
    }
    for (const n of pids) {
      const pid = Number(n);
      if (pid === process.pid) continue;
      try {
        const stat = readFileSync(`/proc/${n}/stat`, "utf8");
        const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (f[0] === "Z" || f[0] === "X") continue;
        const pgid = Number(f[2]);
        if (pgids.has(pgid)) {
          found.push({ pid, pgid, why: `in the run's process group ${pgid}` });
          continue;
        }
        let why: string | null = null;
        try {
          const cwd = readlinkSync(`/proc/${n}/cwd`);
          if (under(cwd, dirs)) why = `cwd ${cwd}`;
        } catch {
          // not readable
        }
        if (why == null) {
          try {
            const env = readFileSync(`/proc/${n}/environ`, "utf8").split("\0");
            const t = hs.find((h) => env.includes(`TAMPER_RUNNER_SLOT=${h.token}`));
            if (t != null) why = "the slot's token in its environment";
          } catch {
            // not readable
          }
        }
        if (why == null) {
          try {
            for (const fd of readdirSync(`/proc/${n}/fd`)) {
              let target: string;
              try {
                target = readlinkSync(`/proc/${n}/fd/${fd}`);
              } catch {
                continue;
              }
              if (under(target, dirs)) {
                why = `open file ${target}`;
                break;
              }
            }
          } catch {
            // not readable
          }
        }
        if (why != null) found.push({ pid, pgid, why });
      } catch {
        // exited meanwhile
      }
    }
    return found;
  }
  // No /proc (macOS): groups from ps, cwd and open files from lsof.
  const seen = new Set<number>();
  try {
    const ps = spawnSync("ps", ["-axo", "pid=,pgid=,stat="], { encoding: "utf8" });
    for (const line of `${ps.stdout}`.split("\n")) {
      const [pid, pgid, st] = line.trim().split(/\s+/);
      if (pid == null || pgid == null || (st ?? "").startsWith("Z")) continue;
      if (Number(pid) === process.pid || !pgids.has(Number(pgid))) continue;
      seen.add(Number(pid));
      found.push({
        pid: Number(pid),
        pgid: Number(pgid),
        why: `in the run's process group ${pgid}`,
      });
    }
    const lsof = spawnSync("lsof", ["-nP", "-Fpn"], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    let cur = 0;
    for (const line of `${lsof.stdout}`.split("\n")) {
      if (line.startsWith("p")) cur = Number(line.slice(1));
      else if (
        line.startsWith("n") &&
        cur !== process.pid &&
        !seen.has(cur) &&
        under(line.slice(1), dirs)
      ) {
        seen.add(cur);
        found.push({ pid: cur, pgid: -1, why: `open file ${line.slice(1)}` });
      }
    }
  } catch {
    // best effort
  }
  return found;
}

function killQuietly(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

/**
 * After a run closed: SIGKILL its whole process group, then VERIFY that no
 * process of the group is left and none works inside the slot. Anything
 * found outside the group escaped the kill (a new session, a double fork):
 * it is killed too and reported, as is a group member still alive after 3 s.
 * Returns the reports (empty = clean).
 */
async function sweep(pgid: number, h: Hygiene): Promise<string[]> {
  const orphans = new Map<number, string>();
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // no member left
    }
    const found = scanProcesses(new Set([pgid]), [h]);
    for (const p of found) {
      if (p.pgid === pgid) continue;
      if (!orphans.has(p.pid)) orphans.set(p.pid, `pid ${p.pid} (${cmdline(p.pid)}): ${p.why}`);
      killQuietly(p.pid);
    }
    if (found.length === 0) break;
    if (Date.now() > deadline) {
      for (const p of found) {
        if (!orphans.has(p.pid)) {
          orphans.set(p.pid, `pid ${p.pid} (${cmdline(p.pid)}): survived SIGKILL, ${p.why}`);
        }
      }
      break;
    }
    await sleep(25);
  }
  return [...orphans.values()];
}

/**
 * Synchronous (it runs from an `exit` handler): SIGKILL every process in one
 * of `pgids` or working in a slot, then wait up to 3 s for them to die.
 * Returns the ones still alive.
 */
function finalSweep(pgids: Set<number>, hs: Hygiene[]): string[] {
  if (hs.length === 0 && pgids.size === 0) return [];
  const wait = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 3000;
  for (;;) {
    for (const g of pgids) {
      try {
        process.kill(-g, "SIGKILL");
      } catch {
        // no member left
      }
    }
    const found = scanProcesses(pgids, hs);
    for (const p of found) killQuietly(p.pid);
    if (found.length === 0) return [];
    if (Date.now() > deadline)
      return found.map((p) => `pid ${p.pid} (${cmdline(p.pid)}): ${p.why}`);
    Atomics.wait(wait, 0, 0, 25);
  }
}

function cmdline(pid: number): string {
  try {
    const c = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim();
    return c.length > 80 ? `${c.slice(0, 77)}...` : c;
  } catch {
    return "?";
  }
}

function run(
  running: Running,
  h: Hygiene,
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<Exec> {
  return new Promise((resolveRun) => {
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    running.children.add(child);
    if (child.pid != null) running.onSpawn?.(child.pid);
    const chunks: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => chunks.push(d));
    const closed = new Promise<void>((r) => child.on("close", () => r()));
    let settled = false;
    const finish = (code: number | null, orphans: string[]): void => {
      if (settled) return;
      settled = true;
      running.children.delete(child);
      resolveRun({ code, out: Buffer.concat(chunks).toString("utf8"), orphans });
    };
    child.on("error", (err) => {
      chunks.push(Buffer.from(String(err)));
      finish(127, []);
    });
    // On EXIT, not close: a process left holding the output pipe would keep
    // `close` from ever firing. Sweep, then give the pipes a moment to drain.
    child.on("exit", (code) => {
      void (async () => {
        const orphans =
          child.pid == null
            ? []
            : await sweep(child.pid, h).catch((err: unknown) => [`sweep failed: ${String(err)}`]);
        const drained = await Promise.race([
          closed.then(() => true),
          sleep(5000).then(() => false),
        ]);
        if (!drained) {
          child.stdout.destroy();
          child.stderr.destroy();
          orphans.push("its output pipe stayed open after every process was killed");
        }
        finish(code, orphans);
      })();
    });
  });
}

function tail(text: string, lines = 30): string {
  return text
    .trimEnd()
    .split("\n")
    .slice(-lines)
    .map((l) => `      | ${l}`)
    .join("\n");
}

function relEdit(root: string, file: string): string {
  const rel = isAbsolute(file) ? relative(root, file) : file;
  if (rel.startsWith("..")) throw new RunnerError(`tamper-runner: ${file} is outside ${root}`);
  return rel.split("\\").join("/");
}

// ---------------------------------------------------------------------------
// Evidence.

/**
 * The companion reporter: vitest's `json` reporter drops unhandled errors, the
 * run's end reason, and each failed test's error NAME and message (a timeout's
 * message included: its failureMessages carry only a placeholder stack).
 */
const META_REPORTER = `import { writeFileSync } from "node:fs";
export default class TamperRunnerMeta {
  onTestRunEnd(modules, errors, reason) {
    const unhandled = (errors ?? []).map((e) => String(e?.stack ?? e?.message ?? e));
    const failed = [];
    for (const m of modules ?? []) {
      for (const t of m.children.allTests()) {
        const r = t.result();
        if (r.state !== "failed") continue;
        const names = [];
        for (let p = t.parent; p != null && p.type === "suite"; p = p.parent) names.unshift(p.name);
        failed.push({
          file: m.moduleId,
          name: [...names, t.name].join(" "),
          errors: (r.errors ?? []).map((e) => ({
            name: String(e?.name ?? ""),
            message: String(e?.message ?? ""),
            stack: String(e?.stack ?? ""),
          })),
        });
      }
    }
    writeFileSync(process.env.TAMPER_RUNNER_META, JSON.stringify({ reason, unhandled, failed }));
  }
}
`;

interface TestError {
  name: string;
  message: string;
  stack: string;
}

interface TestOutcome {
  status: string;
  failureMessages: string[];
}

/** What one vitest run proves, read from its reporter files. */
interface VitestEvidence {
  /** Why no evidence could be read (no report, unparsable); set means nothing else is meaningful. */
  unreadable?: string;
  /** The target file was among the files vitest ran. */
  fileRan: boolean;
  /** Full test name -> every test with that name, in the target file. */
  tests: Map<string, TestOutcome[]>;
  /** Full test name -> the errors of its failed instances, in the target file. */
  errors: Map<string, TestError[]>;
  /** Suite-level / collection errors (any file). */
  suiteErrors: string[];
  unhandled: string[];
  reason: string;
  code: number | null;
  out: string;
  /** Processes that outlived the run (see Exec.orphans). */
  orphans: string[];
}

interface JsonAssertion {
  fullName: string;
  status: string;
  failureMessages?: string[];
}
interface JsonFile {
  name: string;
  status: string;
  message?: string;
  assertionResults: JsonAssertion[];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function runVitest(
  running: Running,
  slot: Slot,
  plan: Plan,
  pkg: string | undefined,
  test: string,
  env: NodeJS.ProcessEnv,
  only?: string,
): Promise<VitestEvidence> {
  const jsonPath = join(slot.run, "vitest-report.json");
  const metaPath = join(slot.run, "vitest-meta.json");
  const reporterPath = join(slot.run, "tamper-runner-meta-reporter.mjs");
  rmSync(jsonPath, { force: true });
  rmSync(metaPath, { force: true });
  writeFileSync(reporterPath, META_REPORTER);
  const args = pkg != null ? ["--filter", pkg, "exec"] : ["exec"];
  args.push(
    "vitest",
    "run",
    test,
    "--reporter=json",
    `--outputFile.json=${jsonPath}`,
    `--reporter=${reporterPath}`,
  );
  if (only != null) args.push("-t", `^${escapeRegExp(only)}$`);
  const t = await run(running, slot.hygiene, "pnpm", args, slot.dir, {
    ...env,
    TAMPER_RUNNER_META: metaPath,
  });
  const ev: VitestEvidence = {
    fileRan: false,
    tests: new Map(),
    errors: new Map(),
    suiteErrors: [],
    unhandled: [],
    reason: "",
    code: t.code,
    out: t.out,
    orphans: t.orphans,
  };
  let report: { testResults: JsonFile[] };
  let meta: {
    reason: string;
    unhandled: string[];
    failed?: { file: string; name: string; errors: TestError[] }[];
  };
  try {
    report = JSON.parse(readFileSync(jsonPath, "utf8"));
  } catch {
    ev.unreadable = `vitest wrote no JSON report (exit ${t.code})`;
    return ev;
  }
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8"));
  } catch {
    ev.unreadable = `vitest wrote no run-end record (exit ${t.code})`;
    return ev;
  }
  ev.reason = meta.reason;
  ev.unhandled = meta.unhandled;
  const pkgDir = pkg != null ? plan.pkgDirs.get(pkg)! : ".";
  const target = realpathSync(slot.dir) + sep + join(pkgDir, test);
  const isTarget = (file: string): boolean => {
    let name = file;
    try {
      name = realpathSync(file);
    } catch {
      // keep as reported
    }
    return resolve(name) === resolve(target);
  };
  for (const f of meta.failed ?? []) {
    if (!isTarget(f.file)) continue;
    ev.errors.set(f.name, [...(ev.errors.get(f.name) ?? []), ...f.errors]);
  }
  for (const f of report.testResults) {
    let name = f.name;
    try {
      name = realpathSync(f.name);
    } catch {
      // keep as reported
    }
    const failedTests = f.assertionResults.some((a) => a.status === "failed");
    if ((f.message ?? "") !== "" || (f.status === "failed" && !failedTests)) {
      ev.suiteErrors.push(`${relative(slot.dir, name)}: ${f.message || "failed outside any test"}`);
    }
    if (!isTarget(name)) continue;
    ev.fileRan = true;
    for (const a of f.assertionResults) {
      const list = ev.tests.get(a.fullName) ?? [];
      list.push({ status: a.status, failureMessages: a.failureMessages ?? [] });
      ev.tests.set(a.fullName, list);
    }
  }
  return ev;
}

function isTestFailure(o: TestOutcome): boolean {
  return o.status === "failed" && o.failureMessages.length > 0;
}

/** Names of the tests that passed (every instance) in a run. */
function passedNames(ev: VitestEvidence): Set<string> {
  const s = new Set<string>();
  for (const [n, list] of ev.tests) if (list.every((o) => o.status === "passed")) s.add(n);
  return s;
}

function orphanProblem(orphans: string[]): string | null {
  return orphans.length > 0 ? `orphan: ${orphans.join("; ")} — killed` : null;
}

/** Why a run is not clean evidence of anything (an orphan, a collection error, …), or null. */
function unusable(ev: VitestEvidence): string | null {
  const orphan = orphanProblem(ev.orphans);
  if (orphan != null) return orphan;
  if (ev.unreadable != null) return ev.unreadable;
  if (!ev.fileRan) return "the test file was not found or did not run";
  if (ev.suiteErrors.length > 0) return `suite-level error: ${ev.suiteErrors.join("; ")}`;
  if (ev.unhandled.length > 0) return `unhandled error: ${ev.unhandled[0]!.split("\n")[0]}`;
  if (ev.reason !== "passed" && ev.reason !== "failed") return `the run ended "${ev.reason}"`;
  return null;
}

/** An unedited run is green: clean, >= 1 test passed, none failed, exit 0. Returns the problem or null. */
function baselineProblem(ev: VitestEvidence): string | null {
  const bad = unusable(ev);
  if (bad != null) return bad;
  const failed = [...ev.tests].filter(([, l]) => l.some((o) => o.status === "failed"));
  if (failed.length > 0) return `failing: ${failed.map(([n]) => `"${n}"`).join(", ")}`;
  if (passedNames(ev).size === 0) return "no test passed";
  if (ev.code !== 0) return `vitest exited ${ev.code} with every test passing`;
  return null;
}

const TIMEOUT = /^(Test|Hook) timed out in \d+ms/;

/**
 * The error class of a failed test in a run: its errors' names (a vitest
 * timeout is "timeout"), sorted, deduplicated. Two edited runs are the same
 * failure only when each failing test has the same class in both.
 */
function errorClass(ev: VitestEvidence, name: string): string {
  const errs = ev.errors.get(name) ?? [];
  const names = errs.map((e) => (TIMEOUT.test(e.message) ? "timeout" : e.name || "Error"));
  return [...new Set(names)].sort().join("+") || "unknown";
}

interface Classified {
  verdict: TamperVerdict;
  detail?: string;
  /**
   * For a RED: each test the RED rests on -> its error class. Both edited
   * runs must give the same map, and each test must pass in the unedited
   * runs around them.
   */
  bites?: Map<string, string>;
}

function classifyVitest(
  ev: VitestEvidence,
  prePassed: Set<string>,
  red: string | undefined,
): Classified {
  const bad = unusable(ev);
  if (bad != null) return { verdict: "INCONCLUSIVE", detail: `(${bad})\n${tail(ev.out)}` };
  const failed = [...ev.tests].filter(([, l]) => l.some(isTestFailure)).map(([n]) => n);
  const bite = (names: string[]): Map<string, string> =>
    new Map(names.map((n) => [n, errorClass(ev, n)]));
  if (red != null) {
    const list = ev.tests.get(red);
    if (list == null) {
      const all = [...ev.tests.keys()];
      const near = all.filter((n) => n.includes(red));
      const names = (near.length > 0 ? near : all.slice(0, 10)).map((n) => `"${n}"`).join(", ");
      return {
        verdict: "INCONCLUSIVE",
        detail:
          `(no test has the exact full name "${red}"; ` +
          `${near.length > 0 ? "names containing it" : "the file's tests include"}: ${names})`,
      };
    }
    if (list.length !== 1) {
      return { verdict: "INCONCLUSIVE", detail: `(${list.length} tests are named "${red}")` };
    }
    if (!prePassed.has(red)) {
      return { verdict: "INCONCLUSIVE", detail: `("${red}" did not pass in the pre-run)` };
    }
    const o = list[0]!;
    if (isTestFailure(o) && ev.code !== 0) return { verdict: "RED", bites: bite([red]) };
    if (o.status === "passed") {
      const others = failed.length > 0 ? `; other tests failed: ${failed.join(", ")}` : "";
      return { verdict: "GREEN", detail: `("${red}" passed${others})` };
    }
    return {
      verdict: "INCONCLUSIVE",
      detail: `("${red}" is ${o.status}, vitest exited ${ev.code})`,
    };
  }
  const bites = failed.filter((n) => prePassed.has(n));
  if (bites.length > 0 && ev.code !== 0) return { verdict: "RED", bites: bite(bites) };
  if (failed.length === 0 && passedNames(ev).size > 0 && ev.code === 0) return { verdict: "GREEN" };
  return {
    verdict: "INCONCLUSIVE",
    detail:
      `(no test that passed in the pre-run failed inside a test: failed=[${failed.join(", ")}], ` +
      `vitest exited ${ev.code})\n${tail(ev.out)}`,
  };
}

// ---------------------------------------------------------------------------
// Groups: every entry that runs the same test, run sequentially in one slot.

interface Group {
  key: string;
  label: string;
  entries: number[];
  /** The first unedited run of this test (after the baseline) that was not green. */
  uneditedFailure?: string;
}

function groupKey(e: TamperEntry): { key: string; label: string } {
  if (e.command != null) {
    const cwd = e.cwd ?? ".";
    return {
      key: `cmd\0${cwd}\0${e.command.join("\0")}`,
      label: `${e.command.join(" ")} (in ${cwd})`,
    };
  }
  const pkg = e.pkg ?? ".";
  return { key: `vitest\0${pkg}\0${e.test}`, label: `${pkg} ${e.test}` };
}

function slotEnv(slot: Slot): NodeJS.ProcessEnv {
  const { tmp, home } = slot;
  return {
    ...process.env,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    TAMPER_RUNNER_SLOT: slot.hygiene.token,
  };
}

/** What a green unedited run proves green: the group's test, narrowed to `red` under `only`. */
function chainKey(group: Group, entry: TamperEntry): string {
  return entry.only === true ? `${group.key}\0-t\0${entry.red}` : group.key;
}

/** Before EVERY run: an empty TMPDIR and a fresh HOME, so no run sees another's files there. */
function resetRunState(slot: Slot): void {
  for (const d of [slot.tmp, slot.home]) {
    rmSync(d, { recursive: true, force: true });
    mkdirSync(d, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Is the edit valid code? (A botched revert is not evidence.) Decided by the
// compiler, never by the error a test happens to throw.

/**
 * The type-check child (CommonJS; the tree's own `typescript`). Input: a JSON
 * file `{ root, files: [{ abs, rel, before }], types }` where `before` holds
 * the file's bytes before the edit, and the tree holds them after. For each
 * group of edited .ts/.js files sharing a nearest tsconfig.json (or none: the
 * defaults below), one program with the edited files as roots is built twice,
 * before and after, and the edited files' syntactic + semantic diagnostics
 * compared as multisets of `TS<code> <message>`: any diagnostic the edit adds
 * is a problem. JS is checked too (allowJs + checkJs). Every import specifier
 * of an edited file must resolve after the edit if it did before (or is new).
 * noUnusedLocals / noUnusedParameters are off: a revert may orphan a helper.
 * Prints `TAMPER_TYPECHECK {"problems":[...]}`.
 */
const TYPECHECK_SCRIPT = String.raw`"use strict";
const fs = require("node:fs");
const path = require("node:path");
const nodeModule = require("node:module");
const input = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const problems = [];
const done = () => {
  process.stdout.write("\nTAMPER_TYPECHECK " + JSON.stringify({ problems }) + "\n");
  process.exit(0);
};
const CODE = /\.(m|c)?(j|t)sx?$/i;
const TSX = /\.(m|c)?tsx?$/i;
const norm = (p) => path.resolve(p);
const lineOf = (text, pos) => text.slice(0, pos).split("\n").length;
const before = new Map();
for (const f of input.files) before.set(norm(f.abs), fs.readFileSync(f.before, "utf8"));
const after = (f) => fs.readFileSync(f.abs, "utf8");

for (const f of input.files) {
  if (!/\.json$/i.test(f.abs)) continue;
  let was = true;
  try { JSON.parse(before.get(norm(f.abs))); } catch { was = false; }
  try { JSON.parse(after(f)); } catch (err) {
    if (was) problems.push(f.rel + ": " + String(err && err.message));
  }
}
const code = input.files.filter((f) => CODE.test(f.abs));
if (code.length === 0) done();

let ts = null;
try {
  ts = nodeModule.createRequire(path.join(input.root, "package.json"))("typescript");
} catch {}
if (ts == null) {
  for (const f of code) {
    if (TSX.test(f.abs)) {
      problems.push(f.rel + ": no typescript in the tree to type-check it with");
      continue;
    }
    const r = require("node:child_process").spawnSync(process.execPath, ["--check", f.abs], { encoding: "utf8" });
    if (r.status !== 0) {
      const lines = String(r.stderr).split("\n").filter((l) => l.trim() !== "");
      problems.push(f.rel + ": does not parse: " + (lines.find((l) => /Error/.test(l)) || lines[0] || "node --check failed"));
    }
  }
  done();
}

const nearestConfig = (abs) => {
  for (let d = path.dirname(abs); ; d = path.dirname(d)) {
    const c = path.join(d, "tsconfig.json");
    if (fs.existsSync(c)) return c;
    if (norm(d) === norm(input.root) || path.dirname(d) === d) return null;
  }
};
const groups = new Map();
for (const f of code) {
  const c = nearestConfig(f.abs) || "";
  if (!groups.has(c)) groups.set(c, []);
  groups.get(c).push(f);
}
const flat = (m) => ts.flattenDiagnosticMessageText(m, " ");
for (const [cfg, files] of groups) {
  let options;
  if (cfg !== "") {
    const parsed = ts.getParsedCommandLineOfConfigFile(cfg, {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => {},
    });
    options = parsed ? parsed.options : {};
  } else {
    options = ts.convertCompilerOptionsFromJson({
      target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true,
      skipLibCheck: true, types: input.types ? ["node"] : [],
    }, input.root).options;
    if (input.types) options.typeRoots = [input.types];
  }
  Object.assign(options, {
    noEmit: true, allowJs: true, checkJs: true, noUnusedLocals: false, noUnusedParameters: false,
    composite: false, incremental: false, declaration: false, declarationMap: false,
    emitDeclarationOnly: false, sourceMap: false, allowImportingTsExtensions: true,
  });
  delete options.rootDir;
  delete options.tsBuildInfoFile;
  delete options.outDir;
  const roots = files.map((f) => f.abs);
  const edited = new Set(roots.map(norm));
  const diagsOf = (program, f) => {
    const sf = program.getSourceFile(f.abs);
    if (sf == null) return [];
    return [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)].map((d) => ({
      key: "TS" + d.code + " " + flat(d.messageText),
      line: d.start != null ? lineOf(sf.text, d.start) : "?",
    }));
  };
  try {
    const host1 = ts.createCompilerHost(options, true);
    const get1 = host1.getSourceFile.bind(host1);
    host1.getSourceFile = (fileName, lang, onError, create) => {
      const t = before.get(norm(fileName));
      return t != null ? ts.createSourceFile(fileName, t, lang, true) : get1(fileName, lang, onError, create);
    };
    const read1 = host1.readFile.bind(host1);
    host1.readFile = (fileName) => {
      const t = before.get(norm(fileName));
      return t != null ? t : read1(fileName);
    };
    const p1 = ts.createProgram(roots, options, host1);
    const host2 = ts.createCompilerHost(options, true);
    const get2 = host2.getSourceFile.bind(host2);
    host2.getSourceFile = (fileName, lang, onError, create) =>
      (!edited.has(norm(fileName)) && p1.getSourceFile(fileName)) || get2(fileName, lang, onError, create);
    const p2 = ts.createProgram(roots, options, host2);
    for (const f of files) {
      const was = new Map();
      for (const d of diagsOf(p1, f)) was.set(d.key, (was.get(d.key) || 0) + 1);
      for (const d of diagsOf(p2, f)) {
        const n = was.get(d.key) || 0;
        if (n > 0) was.set(d.key, n - 1);
        else problems.push(f.rel + ":" + d.line + " " + d.key);
      }
      // Every import specifier resolves after the edit unless it did not before.
      const specs = (text) =>
        ts.preProcessFile(text, true, true).importedFiles.map((i) => ({ spec: i.fileName, line: lineOf(text, i.pos) }));
      const resolves = (spec) =>
        nodeModule.isBuiltin(spec) ||
        ts.resolveModuleName(spec, f.abs, options, ts.sys).resolvedModule != null;
      const unresolvedBefore = new Set(specs(before.get(norm(f.abs))).filter((i) => !resolves(i.spec)).map((i) => i.spec));
      for (const i of specs(after(f))) {
        if (!unresolvedBefore.has(i.spec) && !resolves(i.spec)) {
          problems.push(f.rel + ":" + i.line + ' import "' + i.spec + '" does not resolve');
        }
      }
    }
  } catch (err) {
    problems.push("the type-check itself failed: " + String(err && err.stack || err).split("\n")[0]);
  }
}
done();
`;

/**
 * Type-check the entry's edits in the slot (edited): null when the edit is
 * valid code by the compiler, else the first problem. Run like any other
 * process of the slot (its own group, swept).
 */
async function checkEdit(
  slot: Slot,
  plan: Plan,
  running: Running,
  originals: Map<string, { bytes: Buffer }>,
): Promise<string | null> {
  const script = join(slot.run, "tamper-runner-typecheck.cjs");
  writeFileSync(script, TYPECHECK_SCRIPT);
  const files = [...originals].map(([rel, o], i) => {
    const before = join(slot.run, `before-${i}`);
    writeFileSync(before, o.bytes);
    return { abs: join(slot.dir, rel), rel, before };
  });
  const hoisted = join(slot.dir, "node_modules", ".pnpm", "node_modules", "@types");
  const input = join(slot.run, "typecheck-input.json");
  writeFileSync(
    input,
    JSON.stringify({
      root: slot.dir,
      files,
      types: existsSync(join(hoisted, "node")) ? hoisted : null,
    }),
  );
  const t = await run(
    running,
    slot.hygiene,
    process.execPath,
    [script, input],
    slot.dir,
    slotEnv(slot),
  );
  const orphan = orphanProblem(t.orphans);
  if (orphan != null) return `the type-check left a process running: ${orphan}`;
  const line = t.out.split("\n").find((l) => l.startsWith("TAMPER_TYPECHECK "));
  if (line == null) return `the type-check printed no result (exit ${t.code})\n${tail(t.out)}`;
  const { problems } = JSON.parse(line.slice("TAMPER_TYPECHECK ".length)) as { problems: string[] };
  if (problems.length === 0) return null;
  const more = problems.length > 1 ? ` (+${problems.length - 1} more)` : "";
  return `${problems[0]}${more}`;
}

// ---------------------------------------------------------------------------
// One run: unedited (a pre-, middle or post-run) or with the entry's edits.

/** Run the group's test with NO edit (a baseline, pre-, middle or post-run); null problem = green. */
async function uneditedRun(
  entry: TamperEntry,
  slot: Slot,
  plan: Plan,
  running: Running,
  narrow: boolean,
): Promise<{ problem: string | null; passed: Set<string> }> {
  resetRunState(slot);
  try {
    const env = slotEnv(slot);
    if (entry.command != null) {
      const [cmd, ...args] = entry.command;
      const t = await run(running, slot.hygiene, cmd!, args, join(slot.dir, entry.cwd ?? "."), env);
      const orphan = orphanProblem(t.orphans);
      if (orphan != null) return { problem: orphan, passed: new Set() };
      if (t.code !== 0) return { problem: `exited ${t.code}\n${tail(t.out)}`, passed: new Set() };
      if (t.out.includes(entry.redMarker!)) {
        return { problem: `printed its red marker "${entry.redMarker}"`, passed: new Set() };
      }
      return { problem: null, passed: new Set() };
    }
    const only = narrow && entry.only === true ? entry.red : undefined;
    const ev = await runVitest(running, slot, plan, entry.pkg, entry.test!, env, only);
    const problem = baselineProblem(ev);
    return {
      problem: problem != null ? `${problem}\n${tail(ev.out)}` : null,
      passed: passedNames(ev),
    };
  } finally {
    restore(slot, plan, new Map());
  }
}

/** The outcome of one run with the edits applied. */
interface EditedRun {
  /** Did any process (a rebuild or the test) run with the edit? */
  ran: boolean;
  /** Set when the edit settles the entry without a test verdict. */
  final?: Classified;
  ev?: VitestEvidence;
  cmd?: Exec;
  /** With `proveLoad`: the edited files no process of the run was proven to load. */
  unloaded?: { file: string; why: "not-loaded" | "unprovable" }[];
}

/** A file a load sentinel can be appended to: a JS/TS module some process evaluates. */
const SENTINEL_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/**
 * The load sentinel appended (after the type-check) to an edited module: one
 * statement that, when the module is EVALUATED — from the source, or from a
 * build output a rebuild emitted from it — appends `token` to `log` (the
 * runner's own file, outside the slot). `process.getBuiltinModule` reaches
 * the real `fs` whatever the test mocks, and needs no import; the path is
 * baked in, so a test that clears its children's environment still records.
 */
function loadSentinel(log: string, token: string): string {
  return (
    "\n// @ts-ignore -- tamper-runner load sentinel (removed with the edit)\n" +
    `;try { globalThis.process.getBuiltinModule("node:fs").appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(`${token}\n`)}); } catch {}\n`
  );
}

/** The workspace package (nearest package.json's name) a repo-relative file belongs to. */
function ownerPackage(root: string, rel: string): string | null {
  for (let d = dirname(rel); ; d = dirname(d)) {
    try {
      const name = (
        JSON.parse(readFileSync(join(root, d, "package.json"), "utf8")) as {
          name?: unknown;
        }
      ).name;
      if (typeof name === "string") return name;
    } catch {
      // no (readable) package.json here
    }
    if (d === "." || d === "") return null;
  }
}

/**
 * Why a GREEN is not evidence: an edited file no process of the edited run
 * was proven to load — the test never saw the edit (it reads a build output
 * the entry does not rebuild, or never imports the file). Null when every
 * edited file was loaded.
 */
function notLoaded(entry: TamperEntry, r: EditedRun, root: string): string | null {
  const list = r.unloaded ?? [];
  if (list.length === 0) return null;
  const unprovable = list.filter((u) => u.why === "unprovable").map((u) => u.file);
  const missing = list.filter((u) => u.why === "not-loaded").map((u) => u.file);
  const parts: string[] = [];
  if (missing.length > 0) {
    const pkgs = [...new Set(missing.map((f) => ownerPackage(root, f)))].filter(
      (p): p is string => p != null && !(entry.rebuild ?? []).includes(p),
    );
    parts.push(
      `no process of edited run 2 loaded ${missing.join(", ")}` +
        (pkgs.length > 0 ? `; missing rebuild: [${pkgs.join(", ")}]?` : ""),
    );
  }
  if (unprovable.length > 0) {
    parts.push(
      `a load of ${unprovable.join(", ")} cannot be proven (only a JS/TS module carries a load sentinel)`,
    );
  }
  return `edit not loaded: ${parts.join("; ")}`;
}

/** The entry's type-check verdict, computed on its first edited run and kept. */
interface Validity {
  checked: boolean;
  problem: string | null;
}

async function editedRun(
  entry: TamperEntry,
  slot: Slot,
  plan: Plan,
  running: Running,
  validity: Validity,
  proveLoad = false,
): Promise<EditedRun> {
  const { dir } = slot;
  resetRunState(slot);
  const env = slotEnv(slot);
  const loadLog = join(slot.run, "loaded.log");
  rmSync(loadLog, { force: true });
  const sentinels = new Map<string, string>();
  const originals = new Map<string, { bytes: Buffer; atime: Date; mtime: Date }>();
  try {
    for (const e of entry.edits) {
      const rel = relEdit(plan.root, e.file);
      const abs = join(dir, rel);
      if (!existsSync(abs)) {
        return {
          ran: false,
          final: { verdict: "COULD NOT APPLY", detail: `(${rel}: file not found)` },
        };
      }
      const current = readFileSync(abs, "utf8");
      if (!originals.has(rel)) {
        const st = statSync(abs);
        originals.set(rel, { bytes: readFileSync(abs), atime: st.atime, mtime: st.mtime });
      }
      const count = current.split(e.from).length - 1;
      if (count !== 1) {
        return {
          ran: false,
          final: { verdict: "COULD NOT APPLY", detail: `(${rel}: text found ${count}×)` },
        };
      }
      writeFileSync(
        abs,
        current.replace(e.from, () => e.to),
      );
    }

    // The edit must be valid code by the compiler: a new diagnostic in an
    // edited file, or an import that no longer resolves, and nothing the edit
    // makes fail is evidence.
    if (!validity.checked) {
      validity.problem = await checkEdit(slot, plan, running, originals);
      validity.checked = true;
    }
    if (validity.problem != null) {
      return {
        ran: false,
        final: {
          verdict: "INCONCLUSIVE",
          detail: `(edit does not type-check: ${validity.problem})`,
        },
      };
    }

    // GREEN must rest on an edit some process LOADED: mark each edited module
    // (after the type-check, so the check sees only the edit).
    if (proveLoad) {
      const nonce = randomBytes(8).toString("hex");
      for (const rel of originals.keys()) {
        if (!SENTINEL_FILE.test(rel) || /\.d\.[cm]?ts$/.test(rel)) continue;
        const token = `${nonce}:${sentinels.size}`;
        sentinels.set(rel, token);
        const abs = join(dir, rel);
        writeFileSync(abs, readFileSync(abs, "utf8") + loadSentinel(loadLog, token));
      }
    }
    const proof = (r: EditedRun): EditedRun => {
      if (!proveLoad) return r;
      let seen = new Set<string>();
      try {
        seen = new Set(readFileSync(loadLog, "utf8").split("\n"));
      } catch {
        // nothing loaded
      }
      r.unloaded = [...originals.keys()].flatMap((file) => {
        const token = sentinels.get(file);
        if (token == null) return [{ file, why: "unprovable" as const }];
        return seen.has(token) ? [] : [{ file, why: "not-loaded" as const }];
      });
      return r;
    };

    for (const p of entry.rebuild ?? []) {
      const b = await run(running, slot.hygiene, "pnpm", ["--filter", p, "build"], dir, env);
      const orphan = orphanProblem(b.orphans);
      if (orphan != null) {
        return {
          ran: true,
          final: { verdict: "INCONCLUSIVE", detail: `(the rebuild of ${p}: ${orphan})` },
        };
      }
      if (b.code !== 0) {
        return {
          ran: true,
          final: {
            verdict: "BUILD FAILED",
            detail: `(pnpm --filter ${p} build exited ${b.code})\n${tail(b.out)}`,
          },
        };
      }
    }

    if (entry.command != null) {
      const [cmd, ...args] = entry.command;
      const t = await run(running, slot.hygiene, cmd!, args, join(dir, entry.cwd ?? "."), env);
      return proof({ ran: true, cmd: t });
    }
    const only = entry.only === true ? entry.red : undefined;
    return proof({
      ran: true,
      ev: await runVitest(running, slot, plan, entry.pkg, entry.test!, env, only),
    });
  } finally {
    restore(slot, plan, originals);
  }
}

function classifyEdited(entry: TamperEntry, r: EditedRun, prePassed: Set<string>): Classified {
  if (r.final != null) return r.final;
  if (r.cmd != null) {
    const t = r.cmd;
    const orphan = orphanProblem(t.orphans);
    if (orphan != null) return { verdict: "INCONCLUSIVE", detail: `(${orphan})` };
    const marked = t.out.includes(entry.redMarker!);
    if (t.code !== 0 && marked) return { verdict: "RED", bites: new Map() };
    if (t.code === 0 && !marked) return { verdict: "GREEN" };
    return {
      verdict: "INCONCLUSIVE",
      detail: `(exited ${t.code}, red marker "${entry.redMarker}" ${marked ? "printed" : "absent"})\n${tail(t.out)}`,
    };
  }
  return classifyVitest(r.ev!, prePassed, entry.red);
}

function firstLine(text: string | undefined): string {
  return (text ?? "").split("\n")[0]!;
}

/** `"name" (Class), …` — what an edited run's RED rests on. */
function describeBites(b: Map<string, string> | undefined): string {
  const list = [...(b ?? new Map<string, string>())].map(([n, c]) => `"${n}" (${c})`);
  return list.length > 0 ? list.join(", ") : "its red marker";
}

function sameBites(
  a: Map<string, string> | undefined,
  b: Map<string, string> | undefined,
): boolean {
  const x = a ?? new Map<string, string>();
  const y = b ?? new Map<string, string>();
  return x.size === y.size && [...x].every(([n, c]) => y.get(n) === c);
}

/**
 * One entry under THE LAW: in this slot, the sequence
 *   U (run 1, the pre-run) → E (run 2) → U (run 3) → E (run 4) → U (run 5, the post-run)
 * with U = unedited and E = edited must go green, red, green, red, green:
 * every U green, both E runs red on the same test(s) with the same error
 * class. Both E green (every U green) is GREEN; anything else INCONCLUSIVE,
 * with the reason. Run 1 is the previous entry's post-run (or the baseline)
 * when nothing ran in the slot since; run 5 is skipped only where nothing
 * rests on it (a non-RED last entry of its group). A failing U also marks the
 * group (see runTampers: no RED on a test seen failing with no edit counts).
 */
async function runOne(
  entry: TamperEntry,
  index: number,
  group: Group,
  slot: Slot,
  plan: Plan,
  running: Running,
  last: boolean,
): Promise<TamperResult> {
  const result = (c: Classified): TamperResult => ({
    index,
    name: entry.name,
    verdict: c.verdict,
    slot: slot.index,
    ...(c.detail != null ? { detail: c.detail } : {}),
  });
  const inconclusive = (detail: string): TamperResult =>
    result({ verdict: "INCONCLUSIVE", detail: `(${detail})` });

  const key = chainKey(group, entry);
  const unedited = async (
    label: string,
  ): Promise<{ problem: string | null; passed: Set<string> }> => {
    const u = await uneditedRun(entry, slot, plan, running, true);
    if (u.problem != null) {
      slot.chain = undefined;
      group.uneditedFailure ??= `"${entry.name}", ${label}: ${firstLine(u.problem)}`;
    } else slot.chain = { key, passed: u.passed };
    return u;
  };

  if (slot.chain?.key !== key) {
    const pre = await unedited("run 1/5");
    if (pre.problem != null) {
      return inconclusive(
        `pre-run not green: with no edit, just before it, in this slot: ${pre.problem}`,
      );
    }
  }
  const prePassed = slot.chain!.passed;
  const validity: Validity = { checked: false, problem: null };

  const first = await editedRun(entry, slot, plan, running, validity);
  if (!first.ran) return result(first.final!); // nothing ran: the chain still holds
  slot.chain = undefined;
  const c1 = classifyEdited(entry, first, prePassed);
  if (c1.verdict !== "RED" && c1.verdict !== "GREEN") return result(c1);

  const mid = await unedited("run 3/5");
  if (mid.problem != null) {
    return inconclusive(`run 3/5 (unedited, between the edited runs) not green: ${mid.problem}`);
  }
  const midBack = [...(c1.bites?.keys() ?? [])].filter((n) => !mid.passed.has(n));
  if (midBack.length > 0) {
    return inconclusive(
      `run 3/5: ${midBack.map((n) => `"${n}"`).join(", ")} did not pass with the edit reverted`,
    );
  }

  // Only a GREEN needs the load proof, so only then does run 4 carry the
  // sentinel: a RED's edited runs are the edit and nothing else.
  const second = await editedRun(entry, slot, plan, running, validity, c1.verdict === "GREEN");
  slot.chain = undefined;
  const c2 = classifyEdited(entry, second, mid.passed);
  if (c2.verdict !== c1.verdict) {
    return inconclusive(
      `did not reproduce: edited run 1 ${c1.verdict}, edited run 2 ${c2.verdict} ${firstLine(c2.detail)}`.trimEnd(),
    );
  }
  if (c1.verdict === "RED" && !sameBites(c1.bites, c2.bites)) {
    return inconclusive(
      `the edited runs failed differently: run 2 failed ${describeBites(c1.bites)}; ` +
        `run 4 failed ${describeBites(c2.bites)}`,
    );
  }

  let c: Classified = c2;
  const unseen = c.verdict === "GREEN" ? notLoaded(entry, second, plan.root) : null;
  if (unseen != null) c = { verdict: "INCONCLUSIVE", detail: `(${unseen})` };
  if (c.verdict === "RED" || !last) {
    const post = await unedited("run 5/5");
    if (c.verdict === "RED") {
      if (post.problem != null) {
        c = {
          verdict: "INCONCLUSIVE",
          detail: `(post-run not green: slot state leaked — with the edit reverted the test fails: ${post.problem})`,
        };
      } else {
        const back = [...(c.bites?.keys() ?? [])].filter((n) => !post.passed.has(n));
        if (back.length > 0) {
          c = {
            verdict: "INCONCLUSIVE",
            detail: `(post-run: ${back.map((n) => `"${n}"`).join(", ")} did not pass with the edit reverted)`,
          };
        }
      }
    }
  }
  return result(c);
}

/**
 * Put the slot back exactly as it was created, then VERIFY it: the edited
 * files, every ignored path (a rebuild's or a test's output, whatever its
 * name), the git status and the overlay bytes. Throws when it cannot be.
 */
function restore(
  slot: Slot,
  plan: Plan,
  originals: Map<string, { bytes: Buffer; atime: Date; mtime: Date }>,
): void {
  const { dir } = slot;
  for (const [rel, orig] of originals) {
    const abs = join(dir, rel);
    if (slot.overlaid.has(rel)) writeFileSync(abs, orig.bytes);
    else git(dir, ["checkout", "--", rel]);
    if (sha(readFileSync(abs)) !== sha(orig.bytes)) {
      throw new RunnerError(`tamper-runner: slot ${slot.index}: ${rel} did not restore`);
    }
    utimesSync(abs, orig.atime, orig.mtime);
  }

  // Every ignored path that changed goes back to the slot's pristine state.
  const now = ignoredState(dir);
  const changed = [...now.keys()].filter((rel) => now.get(rel) !== slot.pristineIgnored.get(rel));
  const missing = [...slot.pristineIgnored.keys()].filter((rel) => !now.has(rel));
  for (const rel of changed) {
    if (slot.pristineIgnored.get(rel) === "dir" && now.get(rel) === "dir") continue;
    rmSync(join(dir, rel), { recursive: true, force: true });
  }
  for (const rel of [...changed, ...missing].sort()) {
    if (!slot.pristineIgnored.has(rel) || existsSync(join(dir, rel))) continue;
    cpA(join(plan.root, rel), join(dir, rel));
  }

  verifySlot(slot, plan);
}

function verifySlot(slot: Slot, plan: Plan): void {
  const { dir } = slot;
  const status = git(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (status !== slot.pristineStatus) {
    const now = new Set(nulList(status));
    const was = new Set(nulList(slot.pristineStatus));
    const diff = [...[...now].filter((l) => !was.has(l)), ...[...was].filter((l) => !now.has(l))];
    throw new RunnerError(
      `tamper-runner: slot ${slot.index} did not restore (git status differs: ${diff.join(", ")})`,
    );
  }
  for (const rel of slot.overlaid) {
    const abs = join(dir, rel);
    const h = existsSync(abs) ? sha(readFileSync(abs)) : "";
    if (h !== plan.overlayHash.get(rel)) {
      throw new RunnerError(`tamper-runner: slot ${slot.index}: overlaid ${rel} did not restore`);
    }
  }
  const ign = ignoredState(dir);
  const bad = [
    ...[...ign.keys()].filter((r) => ign.get(r) !== slot.pristineIgnored.get(r)),
    ...[...slot.pristineIgnored.keys()].filter((r) => !ign.has(r)),
  ];
  if (bad.length > 0) {
    throw new RunnerError(
      `tamper-runner: slot ${slot.index}: ignored state did not restore (${bad.slice(0, 5).join(", ")})`,
    );
  }
}

// ---------------------------------------------------------------------------

/**
 * Why an entry is a no-op — no edits, an edit whose `from` equals its `to`,
 * or edits that leave every file they touch as it was (read from the
 * caller's tree) — or null. A no-op entry proves nothing about any fix, and
 * against a flaky test it could still print RED: the run aborts on it.
 */
function noopReason(root: string, e: TamperEntry): string | null {
  if (e.edits.length === 0) return "it has no edits";
  const same = e.edits.findIndex((x) => x.from === x.to);
  if (same >= 0) return `edit ${same + 1} replaces its text with itself (from === to)`;
  const was = new Map<string, string>();
  const now = new Map<string, string>();
  for (const x of e.edits) {
    let rel: string;
    try {
      rel = relEdit(root, x.file);
    } catch {
      return null;
    }
    if (!now.has(rel)) {
      try {
        const text = readFileSync(join(root, rel), "utf8");
        was.set(rel, text);
        now.set(rel, text);
      } catch {
        return null; // COULD NOT APPLY decides it
      }
    }
    const text = now.get(rel)!;
    if (text.split(x.from).length - 1 !== 1) return null; // COULD NOT APPLY decides it
    now.set(
      rel,
      text.replace(x.from, () => x.to),
    );
  }
  return [...now].every(([rel, text]) => text === was.get(rel))
    ? "its edits leave every file they touch as it was"
    : null;
}

/**
 * Run every tamper, `concurrency` at a time, each in an isolated copy, after a
 * green baseline of every distinct test. Resolves with the summary (and, by
 * default, exits the process with it).
 */
export async function runTampers(
  entries: TamperEntry[],
  opts: RunTampersOptions,
): Promise<RunTampersSummary> {
  const log = opts.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const root = git(resolve(opts.root), ["rev-parse", "--show-toplevel"]).trim();

  const malformed = entries
    .map((e) => {
      if (e.command == null && e.test == null)
        return `entry "${e.name}" needs test (+ pkg), or command`;
      if (e.only === true && e.red == null) return `entry "${e.name}" sets only without red`;
      const noop = noopReason(root, e);
      return noop != null ? `entry "${e.name}" changes nothing: ${noop}` : null;
    })
    .filter((m): m is string => m != null);
  if (malformed.length > 0) {
    for (const m of malformed) log(`tamper-runner: ABORTED — ${m}`);
    if (opts.exit !== false) process.exit(2);
    return { ok: false, results: [], concurrency: 0, exitCode: 2 };
  }
  const results: (TamperResult | undefined)[] = entries.map(() => undefined);
  const groups = new Map<string, Group>();
  entries.forEach((e, i) => {
    if (e.command != null && (e.redMarker == null || e.redMarker === "")) {
      results[i] = {
        index: i,
        name: e.name,
        verdict: "INCONCLUSIVE",
        slot: -1,
        detail: "(a command entry must declare redMarker, how its own failure is recognised)",
      };
      return;
    }
    const { key, label } = groupKey(e);
    const g = groups.get(key) ?? { key, label, entries: [] };
    g.entries.push(i);
    groups.set(key, g);
  });
  // Longest groups first, so the sequential ones do not finish last.
  const queue = [...groups.values()].sort((a, b) => b.entries.length - a.entries.length);

  const concurrency = Math.min(
    resolveConcurrency({
      ...(opts.concurrency != null ? { concurrency: opts.concurrency } : {}),
      argv: opts.argv ?? process.argv.slice(2),
      env: process.env,
    }),
    Math.max(1, queue.length),
  );

  for (const p of pruneStaleSlots(root)) log(`tamper-runner: removed a stale slot ${p}`);

  const base = mkdtempSync(join(tmpdir(), BASE_PREFIX));
  // Who may reap this base, and every process group to kill first if this
  // process dies without cleaning up (SIGKILL): the tests run detached.
  const owner: OwnerRecord = {
    pid: process.pid,
    host: hostname(),
    pidns: pidNamespace(),
    pgids: [],
  };
  const writeOwner = (): void => {
    try {
      writeFileSync(join(base, "owner.json"), JSON.stringify(owner));
    } catch {
      // the base is gone (cleanup ran): nothing left to record
    }
  };
  writeOwner();
  const running: Running = {
    children: new Set(),
    onSpawn: (pgid) => {
      owner.pgids.push(pgid);
      writeOwner();
    },
  };
  // Holders, not `let`s: workers assign them from callbacks TS cannot see.
  const state: {
    fatal?: unknown;
    baselineFailed: { label: string; problem: string }[];
    survivors: string[];
  } = {
    baselineFailed: [],
    survivors: [],
  };
  const slots: Slot[] = [];
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    for (const c of running.children) {
      try {
        if (c.pid != null) process.kill(-c.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    // The final sweep: nothing this run started may outlive it — any process
    // still in a group it started or working in a slot is killed, and one
    // that survives that is reported (exit 2).
    const live = [...running.children].map((c) => c.pid).filter((p): p is number => p != null);
    const left = finalSweep(
      new Set(live),
      slots.map((s) => s.hygiene),
    );
    if (left.length > 0) {
      state.survivors.push(...left);
    }
    for (const s of slots) {
      try {
        execFileSync("git", ["worktree", "remove", "--force", s.dir], {
          cwd: root,
          stdio: "ignore",
        });
      } catch {
        // removed below
      }
    }
    rmSync(base, { recursive: true, force: true });
    try {
      execFileSync("git", ["worktree", "prune"], { cwd: root, stdio: "ignore" });
    } catch {
      // best effort
    }
  };
  const SIGNAL_CODE: Record<string, number> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
  const onSignal = (sig: NodeJS.Signals): void => {
    log(`tamper-runner: ${sig} — cleaning up`);
    cleanup();
    process.exit(SIGNAL_CODE[sig] ?? 1);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);
  process.on("exit", cleanup);

  const start = treeFingerprint(root);
  let printed = 0;
  const flush = (): void => {
    while (printed < entries.length && results[printed] != null) {
      const r = results[printed]!;
      log(`${LABEL[r.verdict]}  ${r.name}${r.detail != null ? `  ${r.detail}` : ""}`);
      printed++;
    }
  };

  let exitCode = 0;
  try {
    const pkgs = [
      ...new Set(entries.filter((e) => e.command == null && e.pkg != null).map((e) => e.pkg!)),
    ];
    const plan = makePlan(root, pkgs);
    const slotFor = new Map<number, Slot>();
    const getSlot = (i: number): Slot => {
      let s = slotFor.get(i);
      if (s == null) {
        s = createSlot(plan, base, i);
        slots.push(s);
        slotFor.set(i, s);
      }
      return s;
    };
    const pool = async (work: (slot: Slot, g: Group) => Promise<void>): Promise<void> => {
      let next = 0;
      await Promise.all(
        Array.from({ length: concurrency }, async (_, i) => {
          try {
            while (state.fatal == null) {
              const g = queue[next++];
              if (g == null) return;
              await work(getSlot(i), g);
            }
          } catch (err: unknown) {
            state.fatal ??= err;
          }
        }),
      );
    };

    // Phase 1: every distinct test, once, with no edit. Nothing is tampered
    // until all of them are green. A green baseline is the first entry's
    // pre-run when it was the last run in the slot that runs the group.
    await pool(async (slot, g) => {
      const r = await uneditedRun(entries[g.entries[0]!]!, slot, plan, running, false);
      if (r.problem != null) {
        slot.chain = undefined;
        state.baselineFailed.push({ label: g.label, problem: r.problem });
      } else slot.chain = { key: g.key, passed: r.passed };
    });

    // Phase 2: each group's entries, sequentially, in one slot, each under
    // the law (runOne). A group's verdicts are published when it finishes: a
    // test seen failing with NO edit anywhere in the group (a flaky test, a
    // leak) voids every RED on it — each RED's green unedited runs were then
    // luck, not a property of the test.
    if (state.fatal == null && state.baselineFailed.length === 0) {
      flush();
      await pool(async (slot, g) => {
        const mine: TamperResult[] = [];
        try {
          for (const [k, idx] of g.entries.entries()) {
            if (state.fatal != null) return;
            const last = k === g.entries.length - 1;
            mine.push(await runOne(entries[idx]!, idx, g, slot, plan, running, last));
          }
        } finally {
          for (const r of mine) {
            if (r.verdict === "RED" && g.uneditedFailure != null) {
              r.verdict = "INCONCLUSIVE";
              r.detail =
                `(the test failed with no edit in this run — ${g.uneditedFailure} — ` +
                "so no RED on it is reproducible causation)";
            }
            results[r.index] = r;
          }
          flush();
        }
      });
    }
  } catch (err: unknown) {
    state.fatal ??= err;
  } finally {
    cleanup();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
    process.off("exit", cleanup);
  }

  const done = results.filter((r): r is TamperResult => r != null);
  for (const b of state.baselineFailed) {
    log(`BASELINE NOT GREEN: ${b.label}  (${b.problem})`);
  }
  if (state.baselineFailed.length > 0) {
    log(
      "tamper-runner: ABORTED — a test must pass with no edit before a tamper's failure can mean anything",
    );
    exitCode = 2;
  }
  if (state.fatal != null) {
    const f = state.fatal;
    log(`tamper-runner: ABORTED — ${f instanceof Error ? f.message : JSON.stringify(f)}`);
    exitCode = 2;
  }
  if (state.survivors.length > 0) {
    log(`tamper-runner: a process survived the final sweep: ${state.survivors.join("; ")}`);
    exitCode = 2;
  }
  if (treeFingerprint(root) !== start) {
    log("tamper-runner: the caller's working tree CHANGED during the run — this is a runner bug");
    exitCode = 2;
  }
  const red = done.filter((r) => r.verdict === "RED").length;
  log(`${red}/${entries.length} tampers turned their test red (concurrency ${concurrency})`);
  if (exitCode === 0 && red !== entries.length) exitCode = 1;
  const summary: RunTampersSummary = {
    ok: exitCode === 0,
    results: done,
    concurrency,
    exitCode,
  };
  if (opts.exit !== false) process.exit(exitCode);
  return summary;
}
