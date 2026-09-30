/**
 * tamper-runner — the one shared, parallel runner for TAMPER files.
 *
 * A tamper is a hand-rolled mutation test: revert one fix (one or more exact
 * edits), run the test named for it, and require that test to go RED. A
 * tamper file keeps its entries as data and hands them to `runTampers`; this
 * module owns everything else (docs/ops/agentic-lanes.md § tamper checks).
 *
 * THE LAW: a RED is POSITIVE EVIDENCE, never the absence of a pass. A
 * non-zero exit, a missing report, a crash, a typo'd path, a port someone
 * else holds — none of these is evidence that the tamper bit. Concretely:
 *   - vitest runs with a machine-readable reporter (vitest's `json`, written to
 *     a file, plus a two-line companion reporter for the unhandled errors the
 *     `json` reporter drops) and the verdict is decided from those files,
 *     never from the exit code or a grep of the text output;
 *   - BASELINE: before any tamper, every distinct test (pkg + test file, or
 *     command) runs once in a slot with no edit. It must run, report at least
 *     one passing test and no failure, and exit 0 — or the whole run ABORTS
 *     (exit 2, `BASELINE NOT GREEN: <test>` with the failing tests). A port held
 *     by an outside process fails the baseline loudly instead of faking a RED;
 *   - THE SANDWICH: an entry is RED only when, in the SAME slot, its test is
 *     GREEN immediately before the edit (the pre-run), RED with the edit, and
 *     GREEN again after the edit is reverted (the post-run), with the slot
 *     reset between runs. Any other sequence is INCONCLUSIVE with the reason
 *     (`pre-run not green: …`, `post-run not green: slot state leaked …`), so
 *     state a previous run left behind — wherever it lives — can never pass
 *     for the tamper's effect, and a flaky test shows as a pre/post-run that
 *     is not green. Runs chain: a green post-run (or the baseline, when
 *     nothing ran in the slot since) IS the next entry's pre-run, so an entry
 *     costs two runs, not three;
 *   - the edited run is RED only when the test file was found and ran, at
 *     least one test that PASSED in the pre-run now FAILS with a test-level
 *     failure (an assertion or error thrown inside the test), there is no
 *     suite-level/collection error and no unhandled error, and vitest exited
 *     non-zero. With `red:` set, the failing test must be the one whose EXACT
 *     full name (describe path + title, space-joined, as vitest's JSON
 *     reporter gives it) is `red` — a describe name or a bare title is not
 *     enough. GREEN only when the file ran, >= 1 test passed, none failed and
 *     vitest exited 0 (with `red:`, when that test passed). Anything else is
 *     INCONCLUSIVE, with the reason — a failure, never a RED;
 *   - an edit that is not valid code is not evidence: after the edits are
 *     applied every edited file that parsed before must still parse (`node
 *     --check`; the tree's `typescript`, syntax only; JSON), and a failure
 *     whose error is a SyntaxError / ReferenceError / "is not defined" /
 *     "Cannot find module" naming an edited file is INCONCLUSIVE (`edit is not
 *     valid code`), however the test imports it;
 *   - a RED that rests only on timeouts (a load spike is not evidence) must
 *     time out again on an immediate re-run with the edit, and its post-run
 *     must be green;
 *   - a `command` (non-vitest) entry must declare `redMarker`, the text its
 *     check prints only when it fails. RED = non-zero exit AND the marker;
 *     GREEN = exit 0 and no marker; anything else INCONCLUSIVE. An entry
 *     without `redMarker` is INCONCLUSIVE without being run.
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
 * Every run (baseline, pre-run, edited run, post-run) starts with the slot's
 * TMPDIR emptied and a fresh HOME (XDG_CONFIG/CACHE/DATA/STATE_HOME under it)
 * — the runner's own files (reports, reporter) live outside both. Measured
 * cost: about 1.4 s per run on a monorepo vitest file (caches in HOME and
 * TMPDIR start cold), on top of the third run the sandwich adds per group.
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
 *   GREEN            the test passed with the fix reverted — a failure
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
import { createHash } from "node:crypto";
import * as nodeModule from "node:module";
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
  /** Edited file -> did it parse BEFORE any edit (null), not (the reason), or no parser (undefined). */
  parsesBefore: Map<string, string | null | undefined>;
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
    parsesBefore: new Map(),
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
  const slot: Slot = { index, dir, tmp, home, run, overlaid, pristineStatus, pristineIgnored };
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
}

function run(
  running: Running,
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
    const done = (code: number | null): void => {
      running.children.delete(child);
      resolveRun({ code, out: Buffer.concat(chunks).toString("utf8") });
    };
    child.on("error", (err) => {
      chunks.push(Buffer.from(String(err)));
      done(127);
    });
    child.on("close", (code) => done(code));
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
  const t = await run(running, "pnpm", args, slot.dir, { ...env, TAMPER_RUNNER_META: metaPath });
  const ev: VitestEvidence = {
    fileRan: false,
    tests: new Map(),
    errors: new Map(),
    suiteErrors: [],
    unhandled: [],
    reason: "",
    code: t.code,
    out: t.out,
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

/** Why a run is not clean evidence of anything (collection error, unhandled error, …), or null. */
function unusable(ev: VitestEvidence): string | null {
  if (ev.unreadable != null) return ev.unreadable;
  if (!ev.fileRan) return "the test file was not found or did not run";
  if (ev.suiteErrors.length > 0) return `suite-level error: ${ev.suiteErrors.join("; ")}`;
  if (ev.unhandled.length > 0) return `unhandled error: ${ev.unhandled[0]!.split("\n")[0]}`;
  if (ev.reason !== "passed" && ev.reason !== "failed") return `the run ended "${ev.reason}"`;
  return null;
}

/** A baseline is green: clean, >= 1 test passed, none failed, exit 0. Returns the problem or null. */
function baselineProblem(ev: VitestEvidence): string | null {
  const bad = unusable(ev);
  if (bad != null) return bad;
  const failed = [...ev.tests].filter(([, l]) => l.some((o) => o.status === "failed"));
  if (failed.length > 0) return `failing: ${failed.map(([n]) => `"${n}"`).join(", ")}`;
  if (passedNames(ev).size === 0) return "no test passed";
  if (ev.code !== 0) return `vitest exited ${ev.code} with every test passing`;
  return null;
}

/** A file an entry edits: repo-relative, and relative to the test's package dir. */
interface EditedFile {
  rel: string;
  pkgRel: string;
}

/** The error is the edit's own code failing to load or run as code, not the test's verdict. */
const CODE_ERROR_NAME = /^(SyntaxError|ReferenceError|RolldownError|ParseError)$/;
const CODE_ERROR_MESSAGE =
  /is not defined|Cannot find module|Failed to (load|resolve)|does not provide an export named|Parse fail/;

/**
 * Why a failed test in the target file failed on the EDIT's invalid code — a
 * SyntaxError / ReferenceError / "is not defined" / "Cannot find module" whose
 * message or stack names an edited file — or null.
 */
function invalidCode(ev: VitestEvidence, failed: string[], edited: EditedFile[]): string | null {
  for (const n of failed) {
    for (const e of ev.errors.get(n) ?? []) {
      if (!CODE_ERROR_NAME.test(e.name) && !CODE_ERROR_MESSAGE.test(e.message)) continue;
      const text = `${e.message}\n${e.stack}`;
      const hit = edited.find(
        (f) =>
          text.includes(f.rel) || (!f.pkgRel.startsWith("..") && text.includes(`/${f.pkgRel}`)),
      );
      if (hit != null) return `${e.name}: ${e.message.split("\n")[0]} (in ${hit.rel})`;
    }
  }
  return null;
}

const TIMEOUT = /^(Test|Hook) timed out in \d+ms/;

/** Every failure of these tests is a timeout (and there is at least one). */
function onlyTimeouts(ev: VitestEvidence, names: string[]): boolean {
  return (
    names.length > 0 &&
    names.every((n) => {
      const errs = ev.errors.get(n) ?? [];
      return errs.length > 0 && errs.every((e) => TIMEOUT.test(e.message));
    })
  );
}

interface Classified {
  verdict: TamperVerdict;
  detail?: string;
  /** The tests the RED rests on: each must pass again in the post-run. */
  bites?: string[];
  /** A RED whose every relevant failure is a timeout: it must reproduce. */
  timeoutOnly?: boolean;
}

function classifyVitest(
  ev: VitestEvidence,
  prePassed: Set<string>,
  red: string | undefined,
  edited: EditedFile[],
): Classified {
  const bad = unusable(ev);
  if (bad != null) return { verdict: "INCONCLUSIVE", detail: `(${bad})\n${tail(ev.out)}` };
  const failed = [...ev.tests].filter(([, l]) => l.some(isTestFailure)).map(([n]) => n);
  const invalid = invalidCode(ev, failed, edited);
  if (invalid != null) {
    return { verdict: "INCONCLUSIVE", detail: `(edit is not valid code: ${invalid})` };
  }
  const bites = failed.filter((n) => prePassed.has(n));
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
    if (isTestFailure(o) && ev.code !== 0) {
      return { verdict: "RED", bites: [red], timeoutOnly: onlyTimeouts(ev, [red]) };
    }
    if (o.status === "passed") {
      const others = failed.length > 0 ? `; other tests failed: ${failed.join(", ")}` : "";
      return { verdict: "GREEN", detail: `("${red}" passed${others})` };
    }
    return {
      verdict: "INCONCLUSIVE",
      detail: `("${red}" is ${o.status}, vitest exited ${ev.code})`,
    };
  }
  if (bites.length > 0 && ev.code !== 0) {
    return { verdict: "RED", bites, timeoutOnly: onlyTimeouts(ev, bites) };
  }
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
// Is the edit valid code? (A botched revert is not evidence.)

interface TsLike {
  transpileModule(
    text: string,
    o: { fileName: string; reportDiagnostics: boolean; compilerOptions: Record<string, unknown> },
  ): { diagnostics?: { messageText: unknown; start?: number }[] };
  flattenDiagnosticMessageText(m: unknown, nl: string): string;
}

const tsCache = new Map<string, TsLike | null>();

function typescriptFor(root: string): TsLike | null {
  if (!tsCache.has(root)) {
    try {
      tsCache.set(root, nodeModule.createRequire(join(root, "package.json"))("typescript"));
    } catch {
      tsCache.set(root, null);
    }
  }
  return tsCache.get(root)!;
}

/**
 * Why the file at `abs` does not parse, null when it does, undefined when there
 * is no parser for it. JS: `node --check`. TS: the tree's own `typescript`
 * (syntax only), else node's type stripper. JSON: JSON.parse.
 */
function parseProblem(root: string, abs: string): string | null | undefined {
  const ext = abs.slice(abs.lastIndexOf(".")).toLowerCase();
  if ([".js", ".mjs", ".cjs"].includes(ext)) {
    const r = spawnSync(process.execPath, ["--check", abs], { encoding: "utf8" });
    if (r.status === 0) return null;
    const lines = `${r.stderr}`.split("\n").filter((l) => l.trim() !== "");
    return lines.find((l) => /Error/.test(l)) ?? lines[0] ?? `node --check exited ${r.status}`;
  }
  const text = readFileSync(abs, "utf8");
  if ([".ts", ".mts", ".cts", ".tsx"].includes(ext)) {
    const ts = typescriptFor(root);
    if (ts != null) {
      const out = ts.transpileModule(text, {
        fileName: abs,
        reportDiagnostics: true,
        compilerOptions: { jsx: 1 },
      });
      const d = out.diagnostics?.[0];
      if (d == null) return null;
      const line = d.start != null ? text.slice(0, d.start).split("\n").length : "?";
      return `line ${line}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
    }
    const strip = (
      nodeModule as unknown as {
        stripTypeScriptTypes?: (code: string, o: { mode: string }) => string;
      }
    ).stripTypeScriptTypes;
    if (strip == null || ext === ".tsx") return undefined;
    try {
      strip(text, { mode: "transform" });
      return null;
    } catch (err) {
      return (err instanceof Error ? err.message : String(err)).split("\n")[0]!;
    }
  }
  if (ext === ".json") {
    try {
      JSON.parse(text);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// One run: unedited (a pre- or post-run) or with the entry's edits.

/** Run the group's test with NO edit (a baseline, pre- or post-run); null problem = green. */
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
      const t = await run(running, cmd!, args, join(slot.dir, entry.cwd ?? "."), env);
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
}

async function editedRun(
  entry: TamperEntry,
  slot: Slot,
  plan: Plan,
  running: Running,
): Promise<EditedRun> {
  const { dir } = slot;
  resetRunState(slot);
  const env = slotEnv(slot);
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
        if (!plan.parsesBefore.has(rel)) plan.parsesBefore.set(rel, parseProblem(plan.root, abs));
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

    // A file that parsed before the edit and does not after: the edit is not
    // valid code, and nothing it makes fail is evidence.
    for (const rel of originals.keys()) {
      if (plan.parsesBefore.get(rel) !== null) continue;
      const problem = parseProblem(plan.root, join(dir, rel));
      if (problem != null) {
        return {
          ran: false,
          final: {
            verdict: "INCONCLUSIVE",
            detail: `(edit is not valid code: ${rel} does not parse: ${problem})`,
          },
        };
      }
    }

    for (const p of entry.rebuild ?? []) {
      const b = await run(running, "pnpm", ["--filter", p, "build"], dir, env);
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
      return { ran: true, cmd: await run(running, cmd!, args, join(dir, entry.cwd ?? "."), env) };
    }
    const only = entry.only === true ? entry.red : undefined;
    return {
      ran: true,
      ev: await runVitest(running, slot, plan, entry.pkg, entry.test!, env, only),
    };
  } finally {
    restore(slot, plan, originals);
  }
}

function classifyEdited(
  entry: TamperEntry,
  r: EditedRun,
  prePassed: Set<string>,
  edited: EditedFile[],
): Classified {
  if (r.final != null) return r.final;
  if (r.cmd != null) {
    const t = r.cmd;
    const marked = t.out.includes(entry.redMarker!);
    if (t.code !== 0 && marked) return { verdict: "RED", bites: [] };
    if (t.code === 0 && !marked) return { verdict: "GREEN" };
    return {
      verdict: "INCONCLUSIVE",
      detail: `(exited ${t.code}, red marker "${entry.redMarker}" ${marked ? "printed" : "absent"})\n${tail(t.out)}`,
    };
  }
  return classifyVitest(r.ev!, prePassed, entry.red, edited);
}

function firstLine(text: string | undefined): string {
  return (text ?? "").split("\n")[0]!;
}

/**
 * One entry under THE SANDWICH: in this slot, the test is green immediately
 * before the edit (the pre-run — or the previous entry's green post-run, or
 * the baseline, when nothing ran since), red with it, and green again after
 * it is reverted (the post-run). Anything else is INCONCLUSIVE, with the
 * reason. A RED that rests only on timeouts must reproduce on an immediate
 * re-run with the edit.
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

  const key = chainKey(group, entry);
  if (slot.chain?.key !== key) {
    const pre = await uneditedRun(entry, slot, plan, running, true);
    if (pre.problem != null) {
      slot.chain = undefined;
      return result({
        verdict: "INCONCLUSIVE",
        detail: `(pre-run not green: with no edit, just before it, in this slot: ${pre.problem})`,
      });
    }
    slot.chain = { key, passed: pre.passed };
  }
  const prePassed = slot.chain.passed;

  const pkgDir = entry.pkg != null ? (plan.pkgDirs.get(entry.pkg) ?? ".") : ".";
  const edited: EditedFile[] = entry.edits.map((e) => {
    const rel = relEdit(plan.root, e.file);
    return { rel, pkgRel: relative(pkgDir, rel).split("\\").join("/") };
  });

  const first = await editedRun(entry, slot, plan, running);
  if (!first.ran) return result(first.final!); // nothing ran: the chain still holds
  slot.chain = undefined;
  let c = classifyEdited(entry, first, prePassed, edited);

  if (c.verdict === "RED" && c.timeoutOnly === true) {
    const again = classifyEdited(
      entry,
      await editedRun(entry, slot, plan, running),
      prePassed,
      edited,
    );
    if (again.verdict !== "RED") {
      c = {
        verdict: "INCONCLUSIVE",
        detail:
          `(a timeout that did not reproduce: on an immediate re-run with the edit the test was ` +
          `${again.verdict} ${firstLine(again.detail)})`,
      };
    }
  }

  // The post-run: also the next entry's pre-run. Skipped only where nothing
  // rests on it (a non-RED last entry of its group).
  if (c.verdict === "RED" || !last) {
    const post = await uneditedRun(entry, slot, plan, running, true);
    if (post.problem != null) {
      if (c.verdict === "RED") {
        c = {
          verdict: "INCONCLUSIVE",
          detail: `(post-run not green: slot state leaked — with the edit reverted the test fails: ${post.problem})`,
        };
      }
    } else {
      slot.chain = { key, passed: post.passed };
      const back = (c.bites ?? []).filter((n) => !post.passed.has(n));
      if (c.verdict === "RED" && back.length > 0) {
        c = {
          verdict: "INCONCLUSIVE",
          detail: `(post-run: ${back.map((n) => `"${n}"`).join(", ")} did not pass with the edit reverted)`,
        };
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

  const malformed = entries.filter(
    (e) => (e.command == null && e.test == null) || (e.only === true && e.red == null),
  );
  if (malformed.length > 0) {
    for (const e of malformed) {
      log(
        e.only === true && e.red == null
          ? `tamper-runner: ABORTED — entry "${e.name}" sets only without red`
          : `tamper-runner: ABORTED — entry "${e.name}" needs test (+ pkg), or command`,
      );
    }
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
  // Holders, not `let`s: workers assign them from callbacks TS cannot see.
  const state: { fatal?: unknown; baselineFailed: { label: string; problem: string }[] } = {
    baselineFailed: [],
  };
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
    // the sandwich (runOne).
    if (state.fatal == null && state.baselineFailed.length === 0) {
      flush();
      await pool(async (slot, g) => {
        for (const [k, idx] of g.entries.entries()) {
          if (state.fatal != null) return;
          const last = k === g.entries.length - 1;
          results[idx] = await runOne(entries[idx]!, idx, g, slot, plan, running, last);
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
