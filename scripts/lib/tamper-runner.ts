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
 *   - RED only when the test file was found and ran, at least one test that
 *     PASSED in the baseline now FAILS with a test-level failure (an assertion
 *     or error thrown inside the test, a timeout included), there is no
 *     suite-level/collection error and no unhandled error, and vitest exited
 *     non-zero. With `red:` set, the failing test must be the one whose EXACT
 *     full name (describe path + title, space-joined, as vitest's JSON
 *     reporter gives it) is `red` — a describe name or a bare title is not
 *     enough. GREEN only when the file ran, >= 1 test passed, none failed and
 *     vitest exited 0 (with `red:`, when that test passed). Anything else is
 *     INCONCLUSIVE, with the reason — a failure, never a RED;
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
 * Lifecycle. Slots live under `$TMPDIR/motebit-tamper-*` with an `owner.pid`.
 * Exit, SIGINT, SIGTERM and SIGHUP kill the running tests (their whole process
 * group) and remove every slot and its worktree registration. On startup, any
 * `motebit-tamper-*` worktree this repo registered whose directory is gone or
 * whose owner pid is dead is removed (a SIGKILLed run leaves such litter).
 *
 * Concurrency: default max(1, floor(cpus / 2)); `--concurrency=N` / `-j N`
 * on the tamper file's command line, or `TAMPER_CONCURRENCY=N`, overrides.
 *
 * Plain-node loadable: erasable TypeScript only (Node >= 22.18 strips types),
 * node built-ins only, so `node <tamper file>.mjs` keeps working.
 */
import { spawn, execFileSync } from "node:child_process";
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
import { availableParallelism, cpus, tmpdir } from "node:os";
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
 * directory is gone or whose owner pid is dead. Returns the paths removed.
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
    let stale = !existsSync(p);
    if (!stale) {
      try {
        const pid = Number(readFileSync(join(base, "owner.pid"), "utf8").trim());
        stale = Number.isInteger(pid) && pid > 0 && !pidAlive(pid);
      } catch {
        // no owner.pid: not provably ours to reap
      }
    }
    if (!stale) continue;
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
  tmp: string;
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
  return { root, ignored, dirty, untracked, tracked, overlayHash, pkgDirs };
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
  mkdirSync(tmp, { recursive: true });

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
  return { index, dir, tmp, overlaid, pristineStatus, pristineIgnored };
}

// ---------------------------------------------------------------------------
// Processes.

interface Running {
  children: Set<ChildProcess>;
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

/** The companion reporter: vitest's `json` reporter drops unhandled errors and the run's end reason. */
const META_REPORTER = `import { writeFileSync } from "node:fs";
export default class TamperRunnerMeta {
  onTestRunEnd(_modules, errors, reason) {
    const unhandled = (errors ?? []).map((e) => String(e?.stack ?? e?.message ?? e));
    writeFileSync(process.env.TAMPER_RUNNER_META, JSON.stringify({ reason, unhandled }));
  }
}
`;

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

async function runVitest(
  running: Running,
  slot: Slot,
  plan: Plan,
  pkg: string | undefined,
  test: string,
  env: NodeJS.ProcessEnv,
): Promise<VitestEvidence> {
  const jsonPath = join(slot.tmp, "vitest-report.json");
  const metaPath = join(slot.tmp, "vitest-meta.json");
  const reporterPath = join(slot.tmp, "tamper-runner-meta-reporter.mjs");
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
  const t = await run(running, "pnpm", args, slot.dir, { ...env, TAMPER_RUNNER_META: metaPath });
  const ev: VitestEvidence = {
    fileRan: false,
    tests: new Map(),
    suiteErrors: [],
    unhandled: [],
    reason: "",
    code: t.code,
    out: t.out,
  };
  let report: { testResults: JsonFile[] };
  let meta: { reason: string; unhandled: string[] };
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
    if (resolve(name) !== resolve(target)) continue;
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

function classifyVitest(
  ev: VitestEvidence,
  baselinePassed: Set<string>,
  red: string | undefined,
): { verdict: TamperVerdict; detail?: string } {
  const bad = unusable(ev);
  if (bad != null) return { verdict: "INCONCLUSIVE", detail: `(${bad})\n${tail(ev.out)}` };
  const failed = [...ev.tests].filter(([, l]) => l.some(isTestFailure)).map(([n]) => n);
  const bites = failed.filter((n) => baselinePassed.has(n));
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
    if (!baselinePassed.has(red)) {
      return { verdict: "INCONCLUSIVE", detail: `("${red}" did not pass in the baseline)` };
    }
    const o = list[0]!;
    if (isTestFailure(o) && ev.code !== 0) return { verdict: "RED" };
    if (o.status === "passed") {
      const others = failed.length > 0 ? `; other tests failed: ${failed.join(", ")}` : "";
      return { verdict: "GREEN", detail: `("${red}" passed${others})` };
    }
    return {
      verdict: "INCONCLUSIVE",
      detail: `("${red}" is ${o.status}, vitest exited ${ev.code})`,
    };
  }
  if (bites.length > 0 && ev.code !== 0) return { verdict: "RED" };
  if (failed.length === 0 && passedNames(ev).size > 0 && ev.code === 0) return { verdict: "GREEN" };
  return {
    verdict: "INCONCLUSIVE",
    detail:
      `(no baseline-passing test failed inside a test: failed=[${failed.join(", ")}], ` +
      `vitest exited ${ev.code})\n${tail(ev.out)}`,
  };
}

// ---------------------------------------------------------------------------
// Groups: every entry that runs the same test, run sequentially in one slot.

interface Group {
  key: string;
  label: string;
  entries: number[];
  /** Names of the tests that passed in the baseline (vitest groups). */
  baselinePassed?: Set<string>;
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
  return { ...process.env, TMPDIR: slot.tmp, TMP: slot.tmp, TEMP: slot.tmp };
}

/** Run a group's test once with no edit; returns the problem, or null when green. */
async function runBaseline(
  group: Group,
  entry: TamperEntry,
  slot: Slot,
  plan: Plan,
  running: Running,
): Promise<string | null> {
  try {
    const env = slotEnv(slot);
    if (entry.command != null) {
      const [cmd, ...args] = entry.command;
      const t = await run(running, cmd!, args, join(slot.dir, entry.cwd ?? "."), env);
      if (t.code !== 0) return `exited ${t.code}\n${tail(t.out)}`;
      if (t.out.includes(entry.redMarker!)) return `printed its red marker "${entry.redMarker}"`;
      return null;
    }
    const ev = await runVitest(running, slot, plan, entry.pkg, entry.test!, env);
    const problem = baselineProblem(ev);
    if (problem != null) return `${problem}\n${tail(ev.out)}`;
    group.baselinePassed = passedNames(ev);
    return null;
  } finally {
    restore(slot, plan, new Map());
  }
}

async function runOne(
  entry: TamperEntry,
  index: number,
  group: Group,
  slot: Slot,
  plan: Plan,
  running: Running,
): Promise<TamperResult> {
  const { dir } = slot;
  const env = slotEnv(slot);
  const originals = new Map<string, { bytes: Buffer; atime: Date; mtime: Date }>();
  const result = (verdict: TamperVerdict, detail?: string): TamperResult => ({
    index,
    name: entry.name,
    verdict,
    slot: slot.index,
    ...(detail != null ? { detail } : {}),
  });

  let outcome: TamperResult | undefined;
  try {
    for (const e of entry.edits) {
      const rel = relEdit(plan.root, e.file);
      const abs = join(dir, rel);
      if (!existsSync(abs)) {
        outcome = result("COULD NOT APPLY", `(${rel}: file not found)`);
        break;
      }
      const current = readFileSync(abs, "utf8");
      if (!originals.has(rel)) {
        const st = statSync(abs);
        originals.set(rel, { bytes: readFileSync(abs), atime: st.atime, mtime: st.mtime });
      }
      const count = current.split(e.from).length - 1;
      if (count !== 1) {
        outcome = result("COULD NOT APPLY", `(${rel}: text found ${count}×)`);
        break;
      }
      writeFileSync(
        abs,
        current.replace(e.from, () => e.to),
      );
    }

    if (outcome == null && entry.rebuild != null && entry.rebuild.length > 0) {
      for (const p of entry.rebuild) {
        const b = await run(running, "pnpm", ["--filter", p, "build"], dir, env);
        if (b.code !== 0) {
          outcome = result(
            "BUILD FAILED",
            `(pnpm --filter ${p} build exited ${b.code})\n${tail(b.out)}`,
          );
          break;
        }
      }
    }

    if (outcome == null) {
      if (entry.command != null) {
        const [cmd, ...args] = entry.command;
        const t = await run(running, cmd!, args, join(dir, entry.cwd ?? "."), env);
        const marked = t.out.includes(entry.redMarker!);
        if (t.code !== 0 && marked) outcome = result("RED");
        else if (t.code === 0 && !marked) outcome = result("GREEN");
        else {
          outcome = result(
            "INCONCLUSIVE",
            `(exited ${t.code}, red marker "${entry.redMarker}" ${marked ? "printed" : "absent"})\n${tail(t.out)}`,
          );
        }
      } else {
        const ev = await runVitest(running, slot, plan, entry.pkg, entry.test!, env);
        const c = classifyVitest(ev, group.baselinePassed ?? new Set(), entry.red);
        outcome = result(c.verdict, c.detail);
      }
    }
  } finally {
    restore(slot, plan, originals);
  }
  return outcome;
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

  const malformed = entries.filter((e) => e.command == null && e.test == null);
  if (malformed.length > 0) {
    for (const e of malformed) {
      log(`tamper-runner: ABORTED — entry "${e.name}" needs test (+ pkg), or command`);
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

  const running: Running = { children: new Set() };
  const base = mkdtempSync(join(tmpdir(), BASE_PREFIX));
  writeFileSync(join(base, "owner.pid"), `${process.pid}\n`);
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
    // until all of them are green.
    await pool(async (slot, g) => {
      const problem = await runBaseline(g, entries[g.entries[0]!]!, slot, plan, running);
      if (problem != null) state.baselineFailed.push({ label: g.label, problem });
    });

    // Phase 2: each group's entries, sequentially, in one slot.
    if (state.fatal == null && state.baselineFailed.length === 0) {
      flush();
      await pool(async (slot, g) => {
        for (const idx of g.entries) {
          if (state.fatal != null) return;
          results[idx] = await runOne(entries[idx]!, idx, g, slot, plan, running);
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
