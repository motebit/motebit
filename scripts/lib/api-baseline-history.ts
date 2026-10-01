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
 *   - breaking (an existing top-level declaration removed, or ANY change
 *     inside one)                                          → `major`
 *   - additive (only entirely new top-level declarations)  → `minor` or `major`
 *   - unchanged (identical, comment/blank-only edits, or reordering whole
 *     top-level declarations)                              → nothing required
 *   - new (no baseline at the merge-base: the package just became tracked)
 *     → nothing required; the extractor half pins it from here on
 *
 * The classification is deliberately not precise: it is SOUND by
 * over-approximation. The report is split into top-level declarations (each
 * starts with a column-0 identifier line after its `// @public` comment;
 * indented lines and column-0 continuations like `} | {` belong to it) keyed
 * by declaration name. A change is additive ONLY when every difference is a
 * declaration whose name did not exist at the merge-base and no existing
 * declaration's text changed. Any textual change inside an existing
 * declaration — an added, removed, changed or reordered line, in a member list
 * or a union variant, optional or required — is breaking, after ignoring
 * comment-only and blank lines. So an added optional field is breaking by this
 * rule even though it is source-compatible for most callers; the escape is a
 * `major` changeset. A precise type-compatibility check is a post-freeze
 * follow-up; a heuristic that tried to be precise line by line was bypassable
 * (a swap between union variants read as a reorder).
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
  /** First lines of top-level declarations present at the merge-base and gone now. */
  removed: string[];
  /** First lines (as at the merge-base) of existing declarations whose text changed. */
  changed: string[];
  /** First lines of top-level declarations whose name did not exist at the merge-base. */
  added: string[];
}

/** Comment-only lines, which carry no declaration text. */
function isCommentLine(trimmed: string): boolean {
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*") ||
    trimmed === "*" ||
    trimmed.startsWith("* ") ||
    trimmed.startsWith("*/")
  );
}

/**
 * The report's code body: the lines inside its ```` ``` ```` fences, or every
 * line when there is no fence (the markdown wrapper is never declaration text).
 */
function reportBody(report: string): string[] {
  const lines = report.replace(/\r\n/g, "\n").split("\n");
  if (!lines.some((l) => l.startsWith("```"))) return lines;
  const body: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (line.startsWith("```")) inFence = !inFence;
    else if (inFence) body.push(line);
  }
  return body;
}

const DECLARATION_NAME =
  /^(?:(?:export|declare|default|abstract|async)\s+)*(?:const\s+enum|interface|type|class|enum|namespace|module|function\*?|const|let|var)\s+([A-Za-z_$][\w$]*)/;

/** Net `{ ( [` minus `} ) ]` on a line, ignoring string and template literals. */
function bracketDelta(line: string): number {
  let delta = 0;
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote !== null) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{" || c === "(" || c === "[") delta++;
    else if (c === "}" || c === ")" || c === "]") delta--;
  }
  return delta;
}

/**
 * Top-level declarations grouped by name: each value is the sorted list of
 * the texts declared under that name (overloads and merged declarations
 * share a name), so reordering whole declarations compares equal.
 */
function topLevelDeclarations(report: string): Map<string, { texts: string[]; header: string }> {
  const decls: Array<{ header: string; lines: string[] }> = [];
  // Open `{ ( [` of the current declaration (outside string literals): a
  // column-0 line while any is open is a continuation, never a new declaration,
  // so an added line can never split off and pass as a new export.
  let depth = 0;
  for (const raw of reportBody(report)) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (trimmed === "" || isCommentLine(trimmed)) continue;
    // The report's own `import` header is not surface: a changed import only
    // matters through a declaration that uses it, and that declaration changes.
    if (depth <= 0 && /^import\s/.test(line)) continue;
    const current = decls[decls.length - 1];
    const startsDeclaration =
      current === undefined ||
      (depth <= 0 &&
        /^[A-Za-z_$]/.test(line) &&
        (DECLARATION_NAME.test(line) || /^(?:export|declare)\b/.test(line)));
    if (startsDeclaration) {
      decls.push({ header: trimmed, lines: [line] });
      depth = 0;
    } else current.lines.push(line);
    depth += bracketDelta(line);
  }
  const byName = new Map<string, { texts: string[]; header: string }>();
  for (const d of decls) {
    const name = d.header.match(DECLARATION_NAME)?.[1] ?? d.header;
    const entry = byName.get(name);
    if (entry) entry.texts.push(d.lines.join("\n"));
    else byName.set(name, { texts: [d.lines.join("\n")], header: d.header });
  }
  for (const entry of byName.values()) entry.texts.sort();
  return byName;
}

/** Classify the change from the merge-base baseline (`null` = absent) to the current one. */
export function classifyBaselineChange(base: string | null, head: string): BaselineChange {
  if (base === null) return { kind: "new", removed: [], changed: [], added: [] };
  const baseDecls = topLevelDeclarations(base);
  const headDecls = topLevelDeclarations(head);
  const removed: string[] = [];
  const changed: string[] = [];
  const added: string[] = [];
  for (const [name, b] of baseDecls) {
    const h = headDecls.get(name);
    if (h === undefined) removed.push(b.header);
    else if (h.texts.length !== b.texts.length || h.texts.some((t, i) => t !== b.texts[i])) {
      changed.push(b.header);
    }
  }
  for (const [name, h] of headDecls) if (!baseDecls.has(name)) added.push(h.header);
  const kind =
    removed.length > 0 || changed.length > 0
      ? "breaking"
      : added.length > 0
        ? "additive"
        : "unchanged";
  return { kind, removed, changed, added };
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
