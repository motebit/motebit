/**
 * The history half of check-api-surface: what did this branch change in a
 * tracked package's committed API baseline, and does a pending changeset
 * declare a bump that covers it?
 *
 * The extractor half of the gate compares the built surface against the
 * committed baseline. That alone cannot see a break whose author ran
 * `api:extract` and committed the regenerated baseline: surface and baseline
 * then agree again. This module closes that hole by comparing each baseline as
 * checked out against the same file at the merge-base with the base branch
 * (`git merge-base HEAD origin/main`), classifying the difference, and
 * requiring the matching pending changeset for THAT package:
 *
 *   - breaking (any declaration line removed or changed) → `major`
 *   - additive (declaration lines only added)            → `minor` or `major`
 *   - unchanged (identical, or comment/blank-only edits, or pure reordering)
 *     → nothing required
 *   - new (no baseline at the merge-base: the package just became tracked)
 *     → nothing required; the extractor half pins it from here on
 *
 * The classification is line-level, not a type checker. A line is keyed by
 * the chain of enclosing `{`-opening lines above it, so moving a member from
 * one interface to another is a removal, while reordering lines inside one
 * declaration (or reordering whole declarations) is not. An added line is
 * treated as additive even when it would break an implementer (a new
 * REQUIRED interface member); a changed declaration header (e.g. adding
 * `extends`) is treated as breaking. Both err toward naming the change, and
 * a reviewer still sees the baseline diff.
 *
 * Every git child process runs with EVERY `GIT_*` variable removed and
 * `cwd` = the repository root, and only read-only subcommands, so a hook's
 * GIT_DIR / GIT_INDEX_FILE can never redirect it at another repository.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

export type Bump = "patch" | "minor" | "major";

const BUMP_RANK: Record<Bump, number> = { patch: 0, minor: 1, major: 2 };

export interface BaselineChange {
  kind: "unchanged" | "additive" | "breaking" | "new";
  /** Declaration lines present at the merge-base and gone (or changed) now. */
  removed: string[];
  /** Declaration lines present now and absent at the merge-base. */
  added: string[];
}

/** Lines that carry no declaration: blanks, comments, the report's markdown wrapper. */
function isNonDeclaration(raw: string, trimmed: string): boolean {
  return (
    trimmed === "" ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*") ||
    trimmed === "*" ||
    trimmed.startsWith("* ") ||
    trimmed.startsWith("*/") ||
    trimmed.startsWith("```") ||
    raw.startsWith("## ") ||
    raw.startsWith("> ")
  );
}

/** Declaration lines keyed by their enclosing `{` openers (display text kept alongside). */
function declarationKeys(report: string): Map<string, { count: number; text: string }> {
  const keys = new Map<string, { count: number; text: string }>();
  const stack: Array<{ indent: number; line: string }> = [];
  for (const raw of report.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = raw.trim();
    if (isNonDeclaration(raw, trimmed)) continue;
    const indent = raw.length - raw.trimStart().length;
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const path = stack.map((s) => s.line).join(" › ");
    const key = `${path}\u0000${trimmed}`;
    const text = path === "" ? trimmed : `${path} › ${trimmed}`;
    const entry = keys.get(key);
    if (entry) entry.count += 1;
    else keys.set(key, { count: 1, text });
    if (trimmed.endsWith("{")) stack.push({ indent, line: trimmed });
  }
  return keys;
}

/** Lines of `from` not matched (with multiplicity) in `to`. */
function missingFrom(
  from: Map<string, { count: number; text: string }>,
  to: Map<string, { count: number; text: string }>,
): string[] {
  const out: string[] = [];
  for (const [key, { count, text }] of from) {
    const left = count - (to.get(key)?.count ?? 0);
    for (let i = 0; i < left; i++) out.push(text);
  }
  return out;
}

/** Classify the change from the merge-base baseline (`null` = absent) to the current one. */
export function classifyBaselineChange(base: string | null, head: string): BaselineChange {
  if (base === null) return { kind: "new", removed: [], added: [] };
  const baseKeys = declarationKeys(base);
  const headKeys = declarationKeys(head);
  const removed = missingFrom(baseKeys, headKeys);
  const added = missingFrom(headKeys, baseKeys);
  const kind = removed.length > 0 ? "breaking" : added.length > 0 ? "additive" : "unchanged";
  return { kind, removed, added };
}

/** The bump a change requires, or null when it requires none. */
export function requiredBump(change: BaselineChange): Bump | null {
  if (change.kind === "breaking") return "major";
  if (change.kind === "additive") return "minor";
  return null;
}

export function bumpCovers(declared: Bump | undefined, required: Bump | null): boolean {
  if (required === null) return true;
  return declared !== undefined && BUMP_RANK[declared] >= BUMP_RANK[required];
}

/**
 * The highest bump each package is given across all pending changesets in
 * `changesetDir` (`.changeset/*.md`, README excluded).
 */
export function pendingBumps(changesetDir: string): Map<string, Bump> {
  const bumps = new Map<string, Bump>();
  if (!existsSync(changesetDir)) return bumps;
  const files = readdirSync(changesetDir).filter(
    (f) => f.endsWith(".md") && f !== "README.md" && f !== "CHANGELOG.md",
  );
  for (const file of files) {
    const content = readFileSync(resolve(changesetDir, file), "utf-8").replace(/\r\n/g, "\n");
    const front = content.match(/^---\n([\s\S]*?)\n---/)?.[1];
    if (!front) continue;
    for (const line of front.split("\n")) {
      const entry = line.match(/^["']?([^"':]+)["']?:\s*(patch|minor|major)\s*$/);
      if (!entry) continue;
      const name = entry[1]!;
      const bump = entry[2] as Bump;
      const prior = bumps.get(name);
      if (prior === undefined || BUMP_RANK[bump] > BUMP_RANK[prior]) bumps.set(name, bump);
    }
  }
  return bumps;
}

/** `env` with every `GIT_*` variable removed. */
export function scrubGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("GIT_")));
}

const READ_ONLY_GIT = new Set(["merge-base", "rev-parse", "ls-tree", "show"]);

function git(
  root: string,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  const sub = args[0] ?? "";
  if (!READ_ONLY_GIT.has(sub)) {
    throw new Error(
      `api-baseline-history: only read-only git subcommands are allowed, not \`${sub}\``,
    );
  }
  const r = spawnSync("git", args, {
    cwd: root,
    env: scrubGitEnv(process.env),
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) return { status: null, stdout: "", stderr: r.error.message };
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export type MergeBase = { ok: true; sha: string } | { ok: false; error: string; repair: string };

/** `git merge-base HEAD <baseRef>`, failing closed with a repair instruction. */
export function resolveMergeBase(root: string, baseRef: string): MergeBase {
  const ref = git(root, ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]);
  const branch = baseRef.replace(/^origin\//, "");
  if (ref.status !== 0) {
    return {
      ok: false,
      error: `base ref \`${baseRef}\` is not available in this checkout`,
      repair:
        `run \`git fetch origin ${branch}\` so ${baseRef} exists (in CI, check out with ` +
        "`fetch-depth: 0`), then re-run `pnpm check-api-surface`.",
    };
  }
  const mb = git(root, ["merge-base", "HEAD", baseRef]);
  const sha = mb.stdout.trim();
  if (mb.status !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) {
    const shallow = git(root, ["rev-parse", "--is-shallow-repository"]).stdout.trim() === "true";
    return {
      ok: false,
      error:
        `no merge-base between HEAD and \`${baseRef}\`` +
        (shallow ? " (this is a shallow clone, so the shared history is missing)" : "") +
        (mb.stderr.trim() ? `: ${mb.stderr.trim()}` : ""),
      repair: shallow
        ? `run \`git fetch --unshallow origin\` (or \`git fetch --deepen=<n> origin ${branch}\`; in CI, ` +
          "check out with `fetch-depth: 0`), then re-run `pnpm check-api-surface`."
        : `fetch the shared history with \`git fetch origin ${branch}\`, then re-run \`pnpm check-api-surface\`.`,
    };
  }
  return { ok: true, sha };
}

/** The file at `relPath` in commit `sha`, or null when it does not exist there. */
export function fileAtCommit(root: string, sha: string, relPath: string): string | null {
  const listed = git(root, ["ls-tree", "--name-only", sha, "--", relPath]);
  if (listed.status !== 0) {
    throw new Error(`git ls-tree ${sha} -- ${relPath} failed: ${listed.stderr.trim()}`);
  }
  if (listed.stdout.trim() === "") return null;
  const shown = git(root, ["show", `${sha}:${relPath}`]);
  if (shown.status !== 0) {
    throw new Error(`git show ${sha}:${relPath} failed: ${shown.stderr.trim()}`);
  }
  return shown.stdout;
}

export interface HistoryPackage {
  /** npm name, as changesets key it. */
  name: string;
  /** Baseline path relative to the repository root. */
  baselinePath: string;
}

export interface HistoryVerdict {
  pkg: HistoryPackage;
  change: BaselineChange;
  required: Bump | null;
  declared: Bump | undefined;
  ok: boolean;
}

export type HistoryResult =
  | { ok: true; mergeBase: string; verdicts: HistoryVerdict[] }
  | { ok: false; error: string; repair: string };

/**
 * Compare each package's baseline (as checked out under `root`) with the same
 * file at the merge-base of HEAD and `baseRef`, against the bumps pending in
 * `root/.changeset`.
 */
export function checkBaselineHistory(opts: {
  root: string;
  packages: ReadonlyArray<HistoryPackage>;
  baseRef: string;
}): HistoryResult {
  const mb = resolveMergeBase(opts.root, opts.baseRef);
  if (!mb.ok) return mb;
  const bumps = pendingBumps(resolve(opts.root, ".changeset"));
  const verdicts: HistoryVerdict[] = [];
  for (const pkg of opts.packages) {
    const headPath = resolve(opts.root, pkg.baselinePath);
    const head = existsSync(headPath) ? readFileSync(headPath, "utf-8") : "";
    const base = fileAtCommit(opts.root, mb.sha, pkg.baselinePath);
    const change = classifyBaselineChange(base, head);
    const required = requiredBump(change);
    const declared = bumps.get(pkg.name);
    verdicts.push({ pkg, change, required, declared, ok: bumpCovers(declared, required) });
  }
  return { ok: true, mergeBase: mb.sha, verdicts };
}
