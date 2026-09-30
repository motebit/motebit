/**
 * tamper-runner — the one shared, parallel runner for TAMPER files.
 *
 * A tamper is a hand-rolled mutation test: revert one fix (one or more exact
 * edits), run the test named for it, and require that test to go RED. A
 * tamper file keeps its entries as data and hands them to `runTampers`; this
 * module owns everything else (docs/ops/agentic-lanes.md § tamper checks).
 *
 * Isolation. Every tamper runs in a private copy of the caller's tree, never
 * in the caller's tree itself. A copy is a `git worktree` at HEAD with:
 *   - the caller's uncommitted state overlaid (tracked changes vs HEAD and
 *     untracked non-ignored files), so an uncommitted fix is what gets tested;
 *   - the caller's ignored build state copied (`cp -a`): every nested
 *     `node_modules` (pnpm's symlinks are relative, so workspace links resolve
 *     inside the copy), every `dist` and `*.tsbuildinfo`. The root
 *     `node_modules` is a real directory whose entries are copied, except the
 *     2 GB `.pnpm` store, which is a symlink to the caller's (read-only use);
 *   - every tracked file's mtime synced to the caller's, so `tsc -b` sees the
 *     copied `dist` as up to date and a rebuild compiles only what changed.
 * One copy is made per worker slot and REUSED: after each tamper the edited
 * files are restored from git (`git checkout -- <file>`; an overlaid file gets
 * the caller's bytes back), their mtimes are reset, and any build output a
 * rebuild changed is restored from the caller's tree. Measured on a 4-CPU
 * machine (2026-09-30): `cp -a` of the whole repo is 5.3 s / 2.5 GB per copy;
 * `cp -a` minus `.pnpm` is 1.8 s / 375 MB; a worktree plus this overlay is
 * 0.4 s + 1.9 s / 356 MB and carries no untracked junk — the worktree wins.
 *
 * Contract (one line per entry, in entry order whatever the execution order):
 *   RED (ok)         the test failed with the fix reverted — the tamper bites
 *   GREEN            the test passed with the fix reverted — a failure
 *   COULD NOT APPLY  an edit's text is not found exactly once — a failure
 *   BUILD FAILED     a rebuild the test needs failed — a failure
 * then `N/N tampers turned their test red`. The process exits 1 on any
 * failure, and 2 if the runner itself could not keep its guarantees (a copy
 * could not be made or restored, or the caller's tree changed under it).
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
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { availableParallelism, cpus, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

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
  /** pnpm package name the test belongs to; runs `pnpm --filter <pkg> exec vitest run <test>`. */
  pkg?: string;
  /** Test file, relative to the package directory. */
  test?: string;
  /** When set, RED also requires a failed test (`×` line) whose title contains this text. */
  red?: string;
  /** Packages to rebuild (in the copy only) before the test, because the test reads their `dist`. */
  rebuild?: string[];
  /** Escape hatch for non-vitest tests: argv to run instead of the vitest command. */
  command?: string[];
  /** Working directory for `command`, relative to the repo root (default: the root). */
  cwd?: string;
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

export type TamperVerdict = "RED" | "GREEN" | "COULD NOT APPLY" | "BUILD FAILED";

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
  "COULD NOT APPLY": "COULD NOT APPLY",
  "BUILD FAILED": "BUILD FAILED   ",
};

/** Ignored paths never copied into a slot: caches, reports, other agents' trees. */
const SKIP_IGNORED = new Set([".turbo", "coverage", ".next"]);

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

interface Slot {
  index: number;
  dir: string;
  tmp: string;
  /** repo-relative paths whose content in the slot is the caller's dirty bytes, not HEAD's. */
  overlaid: Set<string>;
}

interface Plan {
  root: string;
  /** Ignored paths (from the caller) to copy into each slot, repo-relative, no trailing slash. */
  ignored: string[];
  /** Build-output roots (dist dirs, tsbuildinfo files) to watch around a rebuild. */
  outputs: string[];
  /** Tracked files that differ from HEAD in the caller (or are deleted there). */
  dirty: string[];
  /** Untracked, non-ignored files in the caller. */
  untracked: string[];
  tracked: string[];
}

function makePlan(root: string): Plan {
  const ignored = nulList(
    git(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]),
  )
    .map((p) => p.replace(/\/$/, ""))
    .filter((p) => {
      if (p === ".git" || p.startsWith(".git/") || p.startsWith(".claude/")) return false;
      if (p.split("/").some((seg) => SKIP_IGNORED.has(seg))) return false;
      return true;
    });
  const outputs = ignored.filter((p) => basename(p) === "dist" || p.endsWith(".tsbuildinfo"));
  const dirty = nulList(git(root, ["diff", "HEAD", "--name-only", "--no-renames", "-z"]));
  const untracked = nulList(git(root, ["ls-files", "--others", "--exclude-standard", "-z"]));
  const tracked = nulList(git(root, ["ls-files", "-z"]));
  return { root, ignored, outputs, dirty, untracked, tracked };
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
      mkdirSync(join(dir, "node_modules"), { recursive: true });
      for (const e of readdirSync(src)) {
        if (e === ".pnpm") symlinkSync(join(src, ".pnpm"), join(dir, "node_modules", ".pnpm"));
        else cpA(join(src, e), join(dir, "node_modules", e));
      }
    } else {
      rmSync(join(dir, p), { recursive: true, force: true });
      cpA(src, join(dir, p));
    }
  }

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
  return { index, dir, tmp, overlaid };
}

interface Stamp {
  mtimeMs: number;
  size: number;
}

function walkOutputs(
  dir: string,
  rels: string[],
  acc = new Map<string, Stamp>(),
): Map<string, Stamp> {
  const visit = (rel: string): void => {
    const abs = join(dir, rel);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const e of readdirSync(abs)) visit(join(rel, e));
    } else {
      acc.set(rel, { mtimeMs: st.mtimeMs, size: st.size });
    }
  };
  for (const r of rels) visit(r);
  return acc;
}

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

class RunnerError extends Error {}

function relEdit(root: string, file: string): string {
  const rel = isAbsolute(file) ? relative(root, file) : file;
  if (rel.startsWith("..")) throw new RunnerError(`tamper-runner: ${file} is outside ${root}`);
  return rel.split("\\").join("/");
}

async function runOne(
  entry: TamperEntry,
  index: number,
  slot: Slot,
  plan: Plan,
  running: Running,
): Promise<TamperResult> {
  const { dir } = slot;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TMPDIR: slot.tmp,
    TMP: slot.tmp,
    TEMP: slot.tmp,
  };
  const originals = new Map<string, { bytes: Buffer; atime: Date; mtime: Date }>();
  const result = (verdict: TamperVerdict, detail?: string): TamperResult => ({
    index,
    name: entry.name,
    verdict,
    slot: slot.index,
    ...(detail != null ? { detail } : {}),
  });

  let outcome: TamperResult | undefined;
  let before: Map<string, Stamp> | undefined;
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
      before = walkOutputs(dir, plan.outputs);
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
      let t: Exec;
      if (entry.command != null) {
        const [cmd, ...args] = entry.command;
        t = await run(running, cmd!, args, join(dir, entry.cwd ?? "."), env);
      } else {
        if (entry.pkg == null || entry.test == null) {
          throw new RunnerError(
            `tamper-runner: entry "${entry.name}" needs pkg + test, or command`,
          );
        }
        const args = ["--filter", entry.pkg, "exec", "vitest", "run", entry.test];
        if (entry.red != null) args.push("--reporter=verbose");
        t = await run(running, "pnpm", args, dir, env);
      }
      if (entry.red != null) {
        const redLine = t.out.split("\n").find((l) => l.includes("×") && l.includes(entry.red!));
        outcome =
          t.code !== 0 && redLine != null
            ? result("RED")
            : result("GREEN", `(no failed test titled "${entry.red}")\n${tail(t.out)}`);
      } else {
        outcome = t.code !== 0 ? result("RED") : result("GREEN");
      }
    }
  } finally {
    restore(slot, plan, originals, before);
  }
  return outcome;
}

/** Put the slot back exactly as it was before the tamper; fail loudly if it cannot be. */
function restore(
  slot: Slot,
  plan: Plan,
  originals: Map<string, { bytes: Buffer; atime: Date; mtime: Date }>,
  before: Map<string, Stamp> | undefined,
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
  if (before == null) return;
  // A rebuild may have rewritten any package's outputs (tsc -b builds references
  // too). Bring back every output that changed, from the caller's tree.
  const after = walkOutputs(dir, plan.outputs);
  for (const [rel, st] of after) {
    const prev = before.get(rel);
    if (prev != null && prev.mtimeMs === st.mtimeMs && prev.size === st.size) continue;
    const src = join(plan.root, rel);
    if (existsSync(src)) {
      copyFileSync(src, join(dir, rel));
      const s = statSync(src);
      utimesSync(join(dir, rel), s.atime, s.mtime);
    } else {
      unlinkSync(join(dir, rel));
    }
  }
  for (const rel of before.keys()) {
    if (after.has(rel)) continue;
    const src = join(plan.root, rel);
    if (!existsSync(src)) continue;
    cpA(src, join(dir, rel));
  }
}

/**
 * Run every tamper, `concurrency` at a time, each in an isolated copy.
 * Resolves with the summary (and, by default, exits the process with it).
 */
export async function runTampers(
  entries: TamperEntry[],
  opts: RunTampersOptions,
): Promise<RunTampersSummary> {
  const log = opts.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const root = git(resolve(opts.root), ["rev-parse", "--show-toplevel"]).trim();
  const concurrency = Math.min(
    resolveConcurrency({
      ...(opts.concurrency != null ? { concurrency: opts.concurrency } : {}),
      argv: opts.argv ?? process.argv.slice(2),
      env: process.env,
    }),
    Math.max(1, entries.length),
  );

  const running: Running = { children: new Set() };
  const base = mkdtempSync(join(tmpdir(), "motebit-tamper-"));
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
  const onSignal = (sig: NodeJS.Signals): void => {
    log(`tamper-runner: ${sig} — cleaning up`);
    cleanup();
    process.exit(sig === "SIGINT" ? 130 : 143);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("exit", cleanup);

  const start = treeFingerprint(root);
  const results: (TamperResult | undefined)[] = entries.map(() => undefined);
  let printed = 0;
  const flush = (): void => {
    while (printed < entries.length && results[printed] != null) {
      const r = results[printed]!;
      log(`${LABEL[r.verdict]}  ${r.name}${r.detail != null ? `  ${r.detail}` : ""}`);
      printed++;
    }
  };

  let exitCode = 0;
  // A holder, not a `let`: workers assign it from callbacks TS cannot see.
  const state: { fatal?: unknown } = {};
  try {
    const plan = makePlan(root);
    let next = 0;
    const worker = async (i: number): Promise<void> => {
      const slot = createSlot(plan, base, i);
      slots.push(slot);
      while (state.fatal == null) {
        const idx = next++;
        if (idx >= entries.length) return;
        results[idx] = await runOne(entries[idx]!, idx, slot, plan, running);
        flush();
      }
    };
    await Promise.all(
      Array.from({ length: concurrency }, (_, i) =>
        worker(i).catch((err: unknown) => {
          state.fatal ??= err;
        }),
      ),
    );
  } finally {
    cleanup();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("exit", cleanup);
  }

  const done = results.filter((r): r is TamperResult => r != null);
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
