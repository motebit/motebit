#!/usr/bin/env tsx
/**
 * classify-autonomy-tier — the deterministic T0/T1 classifier of the repo
 * autonomy design (docs/proposals/repo-autonomy-v1.md, PR #1163).
 *
 * DENY BY DEFAULT. A diff is T0 (a machine reviewer may approve) only when
 * EVERY changed path
 *   1. is in the closed allowlist of `.motebit/repo-path-policy.json` (and in
 *      none of its exclusions),
 *   2. is a plain added or modified text file — no rename, deletion, mode
 *      change, symlink, submodule or binary content,
 *   3. differs only by case from no excluded path, no tracked path and no
 *      other path of the diff (exclusions also match case-insensitively), and
 *   4. has no owner in `.github/CODEOWNERS` (defence in depth: an allowlisted
 *      path that becomes owned is T1 at once).
 * Anything else is T1 (founder only). The diff itself must parse; an empty or
 * unparseable diff, or the classifier's own error, is T1.
 *
 * T0 starts deliberately narrow — reader-facing docs and bench data. The
 * design's exclusions 1–5 (owned-subject tests, `.github/`, dependencies and
 * toolchain, enforcement code and config, test weakening) are subsumed: none
 * of those paths is on the allowlist, so none can be T0. A denylist of them was
 * tried first and a cold review built 16 T0 diffs that weakened enforcement
 * through paths it did not list. Widening T0 is an edit to
 * `.motebit/repo-path-policy.json`, which CODEOWNERS owns and which is outside
 * its own includes — so every widening is itself a T1 change.
 *
 * PURE core (`classifyDiff`): diff text + CODEOWNERS text + path-policy text +
 * the trusted base's tracked paths in, verdict out.
 * The allowlist is interpreted by `packages/verifier/src/repo-path-policy.ts`
 * (the one interpreter, shared with the repo-change verifier); CODEOWNERS
 * matching is `scripts/lib/codeowners.ts` (`parseCodeowners`, `decidingRule`).
 *
 * CLI:
 *   tsx scripts/classify-autonomy-tier.ts --repo <dir> --base <rev> --head <rev>
 *   tsx scripts/classify-autonomy-tier.ts --diff <file|->
 * CODEOWNERS, the path policy and the tracked paths are read from THIS script's checkout (the trusted base), never
 * from the diff's head. Prints one JSON line, then a one-line summary. Exit 0
 * on any classification (T0 or T1); exit 2 only on a classifier error, after
 * printing a T1 `classifier-error` verdict — callers treat non-zero as T1.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// By relative SOURCE path, never the `@motebit/verifier` specifier: that
// resolves to dist/, which the autonomy-tier workflow never builds. The module
// imports nothing, so tsx loads it as it stands in the trusted checkout.
import {
  REPO_PATH_POLICY_FILE,
  isRepoPathPermitted,
  parseRepoPathPolicy,
  repoPathExclusion,
  type RepoPathPolicy,
} from "../packages/verifier/src/repo-path-policy.js";
import { decidingRule, parseCodeowners } from "./lib/codeowners.js";
import { cleanEnv } from "./lib/differential-tree.js";

// ── The allowlist ────────────────────────────────────────────────────────────

/**
 * The ONLY paths a T0 diff may touch live in `.motebit/repo-path-policy.json`
 * (`motebit/repo-path-policy@1.0`, spec/repo-change-v1.md §7.2) — the path
 * predicate as DATA, interpreted by the one interpreter the repo-change
 * verifier also uses (`packages/verifier/src/repo-path-policy.ts`, loaded by
 * source path: it imports nothing, so no build step is needed). The file is
 * closed and documented: the test suite asserts it is exactly the set below,
 * and it is owned in CODEOWNERS and outside its own includes, so every
 * widening is a visible, T1 diff.
 *
 * What the set is, and why (audited 2026-10-26, listed in the PR):
 *   include — `docs/**` markdown and each bench's `prompts.json`. Every
 *     consumer reads them as inert text or data: markdown under docs/ is only
 *     matched and counted by gates — the one gate that EXECUTES doc content
 *     (check-image-provenance, cosign lines) reads docs/operator/self-host.md,
 *     which is excluded; each bench's prompts.json is `JSON.parse`d as prompts
 *     by a workflow_dispatch-only bench with network-free tools (only that
 *     file: any other JSON there may be tool config — package.json,
 *     tsconfig.json, .eslintrc.json, .prettierrc.json — and
 *     route-c.example.json is a format example nothing parses).
 *     `apps/docs/content` is NOT included: fumadocs-mdx evaluates MDX ESM at
 *     build, and check-docs-quickstart-runs runs a code block from it under
 *     CI env. An include names FILES: never a directory of that name
 *     (`.../prompts.json/x.ts`).
 *   exclude — inside an include, still T1: agent-facing doctrine, the
 *     autonomy design itself, runbooks, designs, the drift inventory,
 *     operator-facing docs (deploy pins and security posture), security docs
 *     (the accepted-CVE ledger), and agent instructions under any name or
 *     depth. Exclusions cover what is beneath them and hold whatever the case
 *     (a case-insensitive filesystem, or a reader that folds case).
 */
let trustedPolicy: RepoPathPolicy | undefined;
/** The trusted base's policy, parsed once (throws when it does not parse: callers fail closed). */
function trustedPathPolicy(): RepoPathPolicy {
  return (trustedPolicy ??= parseRepoPathPolicy(readTrustedPathPolicy()));
}

function allowlisted(policy: RepoPathPolicy, path: string): boolean {
  return isRepoPathPermitted(policy, path);
}

/** Whether `path` is on the T0 allowlist of the trusted base's `.motebit/repo-path-policy.json`. */
export function isAllowlisted(path: string): boolean {
  return allowlisted(trustedPathPolicy(), path);
}

function collision(
  policy: RepoPathPolicy,
  path: string,
  known: ReadonlyMap<string, ReadonlySet<string>>,
): string | null {
  if (repoPathExclusion(policy, path) === "case_folded") {
    return `${path} differs only by case from an excluded path`;
  }
  const parts = path.split("/");
  for (let k = 1; k <= parts.length; k++) {
    const q = parts.slice(0, k).join("/");
    const other = [...(known.get(q.toLowerCase()) ?? [])].find((x) => x !== q);
    if (other !== undefined) return `${q} differs only by case from ${other}`;
  }
  return null;
}

/**
 * Why `path` collides by case, or null: it is excluded only once case is
 * folded (it differs only by case from an exclusion), or it — or one of its
 * directories — differs only by case from a tracked path or another path of
 * the same diff. Judged against the trusted base's policy.
 */
export function caseCollision(
  path: string,
  known: ReadonlyMap<string, ReadonlySet<string>>,
): string | null {
  return collision(trustedPathPolicy(), path, known);
}

/** Lower-cased path and directory → the exact spellings that exist. */
export function caseIndex(paths: Iterable<string>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const p of paths) {
    const parts = p.split("/");
    for (let k = 1; k <= parts.length; k++) {
      const q = parts.slice(0, k).join("/");
      const key = q.toLowerCase();
      let s = out.get(key);
      if (!s) out.set(key, (s = new Set()));
      s.add(q);
    }
  }
  return out;
}

// ── Rules ────────────────────────────────────────────────────────────────────

export type RuleCategory = "allowlist" | "codeowners" | "fail-closed";

/**
 * Every rule that can send a diff to T1. Closed: a firing can only name a key
 * of this table, and the test suite requires a must-T1 fixture for every key.
 */
export const RULES = {
  "not-allowlisted": { category: "allowlist", what: "a changed path outside the T0 allowlist" },
  "codeowners-owned": { category: "codeowners", what: "a changed path has a CODEOWNERS owner" },
  rename: { category: "fail-closed", what: "a renamed or copied path" },
  deletion: { category: "fail-closed", what: "a deleted file" },
  "mode-change": { category: "fail-closed", what: "a file mode other than a plain 100644 file" },
  binary: { category: "fail-closed", what: "binary content" },
  submodule: { category: "fail-closed", what: "a submodule change" },
  symlink: { category: "fail-closed", what: "a symlink change" },
  "case-collision": {
    category: "fail-closed",
    what: "a path that differs only by case from an excluded, tracked, or other changed path",
  },
  "unparseable-diff": {
    category: "fail-closed",
    what: "a diff the classifier cannot fetch or parse",
  },
  "empty-diff": {
    category: "fail-closed",
    what: "an empty diff (nothing to classify, or a failed fetch)",
  },
  "classifier-error": { category: "fail-closed", what: "the classifier's own error" },
} as const satisfies Record<string, { category: RuleCategory; what: string }>;

export type RuleId = keyof typeof RULES;

export interface Firing {
  rule: RuleId;
  path: string | null;
  detail: string;
}

export interface Classification {
  tier: "T0" | "T1";
  /** The headline rule (earliest in RULES order among the firings), or null for T0. */
  rule: RuleId | null;
  category: RuleCategory | null;
  /** Every firing, in diff order. */
  firings: Firing[];
  /** Files in the diff. */
  files: number;
  summary: string;
}

// ── Diff parsing ─────────────────────────────────────────────────────────────

export interface FileDiff {
  oldPath: string | null; // null = added
  newPath: string | null; // null = deleted
  renamed: boolean;
  binary: boolean;
  oldMode: string | null;
  newMode: string | null;
  added: string[];
  removed: string[];
}

class DiffParseError extends Error {}

function stripPrefix(p: string, prefix: "a/" | "b/"): string | null {
  if (p === "/dev/null") return null;
  if (p.startsWith('"')) throw new DiffParseError(`quoted path ${p} (unusual characters)`);
  if (!p.startsWith(prefix)) throw new DiffParseError(`path ${p} lacks the ${prefix} prefix`);
  return p.slice(2);
}

/** `---`/`+++` lines may carry a trailing tab + timestamp from some tools. */
function headerPath(line: string, marker: "--- " | "+++ "): string {
  return line.slice(marker.length).replace(/\t.*$/, "");
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse `git diff` / `gh pr diff` output. Throws DiffParseError on anything it does not understand. */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const files: FileDiff[] = [];
  let i = 0;
  while (i < lines.length) {
    const head = lines[i]!;
    if (!head.startsWith("diff --git ")) {
      throw new DiffParseError(
        `line ${i + 1}: expected \`diff --git\`, got ${JSON.stringify(head.slice(0, 80))}`,
      );
    }
    const f: FileDiff = {
      oldPath: null,
      newPath: null,
      renamed: false,
      binary: false,
      oldMode: null,
      newMode: null,
      added: [],
      removed: [],
    };
    let sawOld = false;
    let sawNew = false;
    let renameFrom: string | null = null;
    let renameTo: string | null = null;
    let isNew = false;
    let isDeleted = false;
    i++;
    // Extended header.
    while (
      i < lines.length &&
      !lines[i]!.startsWith("diff --git ") &&
      !lines[i]!.startsWith("@@")
    ) {
      const l = lines[i]!;
      let m: RegExpExecArray | null;
      if ((m = /^new file mode (\d+)$/.exec(l))) {
        isNew = true;
        f.newMode = m[1]!;
      } else if ((m = /^deleted file mode (\d+)$/.exec(l))) {
        isDeleted = true;
        f.oldMode = m[1]!;
      } else if ((m = /^old mode (\d+)$/.exec(l))) f.oldMode = m[1]!;
      else if ((m = /^new mode (\d+)$/.exec(l))) f.newMode = m[1]!;
      else if ((m = /^index [0-9a-f]+\.\.[0-9a-f]+(?: (\d+))?$/.exec(l))) {
        if (m[1]) {
          f.oldMode ??= m[1];
          f.newMode ??= m[1];
        }
      } else if (/^(similarity|dissimilarity) index \d+%$/.test(l)) {
        /* informational */
      } else if ((m = /^rename from (.+)$/.exec(l))) {
        if (m[1]!.startsWith('"')) throw new DiffParseError(`quoted rename path ${m[1]}`);
        renameFrom = m[1]!;
      } else if ((m = /^rename to (.+)$/.exec(l))) {
        if (m[1]!.startsWith('"')) throw new DiffParseError(`quoted rename path ${m[1]}`);
        renameTo = m[1]!;
      } else if ((m = /^copy from (.+)$/.exec(l))) {
        renameFrom = m[1]!; // judged like a rename source (both names)
      } else if ((m = /^copy to (.+)$/.exec(l))) {
        renameTo = m[1]!;
      } else if (/^Binary files .* differ$/.test(l)) {
        f.binary = true;
        const bm = /^Binary files (.+) and (.+) differ$/.exec(l);
        if (bm) {
          f.oldPath ??= stripPrefix(bm[1]!, "a/");
          f.newPath ??= stripPrefix(bm[2]!, "b/");
          sawOld = sawNew = true;
        }
      } else if (l === "GIT binary patch") {
        f.binary = true;
        // Skip the literal/delta payload up to the next file.
        while (i + 1 < lines.length && !lines[i + 1]!.startsWith("diff --git ")) i++;
      } else if (l.startsWith("--- ")) {
        f.oldPath = stripPrefix(headerPath(l, "--- "), "a/");
        sawOld = true;
      } else if (l.startsWith("+++ ")) {
        f.newPath = stripPrefix(headerPath(l, "+++ "), "b/");
        sawNew = true;
      } else {
        throw new DiffParseError(
          `line ${i + 1}: unrecognised extended header ${JSON.stringify(l.slice(0, 80))}`,
        );
      }
      i++;
    }
    if (renameFrom !== null || renameTo !== null) {
      if (renameFrom === null || renameTo === null)
        throw new DiffParseError("half a rename/copy header");
      f.renamed = true;
      f.oldPath = renameFrom;
      f.newPath = renameTo;
      sawOld = sawNew = true;
    }
    if (!sawOld || !sawNew) {
      // No ---/+++ (mode-only change, empty new/deleted file): the
      // `diff --git a/P b/P` line is unambiguous only when both halves agree.
      const rest = head.slice("diff --git ".length);
      if (rest.startsWith('"')) throw new DiffParseError(`quoted path in ${head}`);
      const half = (rest.length - 1) / 2;
      const a = rest.slice(0, half);
      const b = rest.slice(half + 1);
      if (
        !Number.isInteger(half) ||
        rest[half] !== " " ||
        !a.startsWith("a/") ||
        b !== `b/${a.slice(2)}`
      ) {
        throw new DiffParseError(`cannot read the path from ${JSON.stringify(head)}`);
      }
      const p = a.slice(2);
      f.oldPath = isNew ? null : p;
      f.newPath = isDeleted ? null : p;
    }
    if (isNew && f.oldPath !== null)
      throw new DiffParseError(`new file ${f.newPath} has an old path`);
    if (isDeleted && f.newPath !== null)
      throw new DiffParseError(`deleted file ${f.oldPath} has a new path`);
    if (f.oldPath === null && f.newPath === null) throw new DiffParseError(`no path in ${head}`);
    // Hunks.
    while (i < lines.length && lines[i]!.startsWith("@@")) {
      const hm = HUNK.exec(lines[i]!);
      if (!hm) throw new DiffParseError(`line ${i + 1}: malformed hunk header`);
      let oldLeft = hm[2] === undefined ? 1 : Number(hm[2]);
      let newLeft = hm[4] === undefined ? 1 : Number(hm[4]);
      i++;
      while (oldLeft > 0 || newLeft > 0) {
        if (i >= lines.length) throw new DiffParseError("hunk truncated");
        const l = lines[i]!;
        if (l.startsWith("\\")) {
          i++;
          continue;
        }
        const c = l[0];
        if (c === "+") {
          if (newLeft-- <= 0)
            throw new DiffParseError(`line ${i + 1}: hunk has more added lines than its header`);
          f.added.push(l.slice(1));
        } else if (c === "-") {
          if (oldLeft-- <= 0)
            throw new DiffParseError(`line ${i + 1}: hunk has more removed lines than its header`);
          f.removed.push(l.slice(1));
        } else if (c === " " || l === "") {
          if (oldLeft-- <= 0 || newLeft-- <= 0)
            throw new DiffParseError(`line ${i + 1}: hunk context overruns its header`);
        } else {
          throw new DiffParseError(
            `line ${i + 1}: unexpected hunk line ${JSON.stringify(l.slice(0, 80))}`,
          );
        }
        i++;
      }
      while (i < lines.length && lines[i]!.startsWith("\\")) i++;
    }
    if (i < lines.length && !lines[i]!.startsWith("diff --git ")) {
      throw new DiffParseError(`line ${i + 1}: trailing content after ${f.newPath ?? f.oldPath}`);
    }
    files.push(f);
  }
  return files;
}

// ── The classifier ───────────────────────────────────────────────────────────

export interface ClassifyInput {
  diff: string;
  /** Text of `.github/CODEOWNERS` (from the trusted base). */
  codeowners: string;
  /** Text of `.motebit/repo-path-policy.json` (from the trusted base). It must parse strictly. */
  pathPolicy: string;
  /** Every path tracked at the trusted base (`git ls-files`), for the case-collision rule. */
  trackedPaths: readonly string[];
}

export function classifyDiff(input: ClassifyInput): Classification {
  const firings: Firing[] = [];
  let files = 0;
  const fire = (rule: RuleId, path: string | null, detail: string): void => {
    firings.push({ rule, path, detail });
  };
  try {
    const { rules, errors } = parseCodeowners(input.codeowners);
    if (errors.length > 0)
      throw new Error(`CODEOWNERS has lines the parser refuses: ${errors.join("; ")}`);
    if (rules.length === 0)
      throw new Error("CODEOWNERS has no rules — refusing to classify against nothing");
    const policy = parseRepoPathPolicy(input.pathPolicy);

    if (input.diff.trim() === "") {
      fire("empty-diff", null, "the diff is empty");
      return finish(firings, 0);
    }
    let parsed: FileDiff[];
    try {
      parsed = parseUnifiedDiff(input.diff);
    } catch (err) {
      if (!(err instanceof DiffParseError)) throw err;
      fire("unparseable-diff", null, err.message);
      return finish(firings, 0);
    }
    files = parsed.length;

    const changedPaths = parsed
      .flatMap((f) => [f.oldPath, f.newPath])
      .filter((x): x is string => x !== null);
    const known = caseIndex([...input.trackedPaths, ...changedPaths]);

    for (const f of parsed) {
      const label = f.newPath ?? f.oldPath!;
      if (f.renamed) fire("rename", label, `renamed or copied ${f.oldPath} → ${f.newPath}`);
      if (f.newPath === null) fire("deletion", f.oldPath, `deleted ${f.oldPath}`);
      if (f.binary) fire("binary", label, "binary content");
      for (const mode of new Set([f.oldMode, f.newMode])) {
        if (mode === null || mode === "100644") continue;
        if (mode === "120000") fire("symlink", label, "symlink (mode 120000)");
        else if (mode === "160000") fire("submodule", label, "submodule (mode 160000)");
        else fire("mode-change", label, `file mode ${mode}`);
      }
      if (f.oldMode !== null && f.newMode !== null && f.oldMode !== f.newMode) {
        fire("mode-change", label, `mode ${f.oldMode} → ${f.newMode}`);
      }
      // Both names of a rename are judged.
      for (const p of new Set([f.oldPath, f.newPath].filter((x): x is string => x !== null))) {
        if (!allowlisted(policy, p)) fire("not-allowlisted", p, `${p} is outside the T0 allowlist`);
        const caseHit = collision(policy, p, known);
        if (caseHit !== null) fire("case-collision", p, caseHit);
        const r = decidingRule(rules, p);
        if (r && r.owners.length > 0) {
          fire(
            "codeowners-owned",
            p,
            `owned by ${r.owners.join(" ")} (CODEOWNERS line ${r.line}: ${r.pattern})`,
          );
        }
      }
    }
    return finish(firings, files);
  } catch (err) {
    fire("classifier-error", null, err instanceof Error ? err.message : String(err));
    return finish(firings, files);
  }
}

function finish(firings: Firing[], files: number): Classification {
  if (firings.length === 0) {
    return {
      tier: "T0",
      rule: null,
      category: null,
      firings,
      files,
      summary: `T0 — ${files} file(s), every path allowlisted, unowned and a plain text edit`,
    };
  }
  // The headline rule is the earliest in RULES order, not whichever file came first.
  const order = Object.keys(RULES);
  const first = firings.reduce((a, b) => (order.indexOf(b.rule) < order.indexOf(a.rule) ? b : a));
  const others = firings.length - 1;
  return {
    tier: "T1",
    rule: first.rule,
    category: RULES[first.rule].category,
    firings,
    files,
    summary:
      `T1 — ${first.rule} (${RULES[first.rule].category})${first.path ? ` at ${first.path}` : ""}: ${first.detail}` +
      (others > 0 ? ` (+${others} more firing(s))` : ""),
  };
}

// ── I/O (CLI and the verdict script) ─────────────────────────────────────────

const SELF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function readTrustedCodeowners(root: string = SELF_ROOT): string {
  return readFileSync(join(root, ".github/CODEOWNERS"), "utf-8");
}

/** Text of the trusted checkout's `.motebit/repo-path-policy.json` (never the diff's head). */
export function readTrustedPathPolicy(root: string = SELF_ROOT): string {
  return readFileSync(join(root, REPO_PATH_POLICY_FILE), "utf-8");
}

/** Every path tracked in the trusted checkout. */
export function readTrustedPaths(root: string = SELF_ROOT): string[] {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    env: cleanEnv(),
    encoding: "utf-8",
    maxBuffer: 256 * 1024 * 1024,
  })
    .split("\0")
    .filter((p) => p !== "");
}

/** `git diff --find-renames base...head` (three-dot: the PR's own changes), or `base..head`. */
export function gitDiff(repo: string, baseRev: string, headRev: string, threeDot = true): string {
  return execFileSync(
    "git",
    [
      "diff",
      "--find-renames",
      "--no-color",
      "--no-ext-diff",
      `${baseRev}${threeDot ? "..." : ".."}${headRev}`,
    ],
    { cwd: repo, env: cleanEnv(), encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 },
  );
}

/** Classify `base...head` (or `base..head`) in a local repository, against the trusted CODEOWNERS. */
export function classifyRevisions(
  repo: string,
  baseRev: string,
  headRev: string,
  threeDot = true,
): Classification {
  let diff: string;
  try {
    diff = gitDiff(repo, baseRev, headRev, threeDot);
  } catch (err) {
    return finish(
      [
        {
          rule: "unparseable-diff",
          path: null,
          detail: `could not fetch the diff: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      0,
    );
  }
  let pathPolicy: string;
  try {
    pathPolicy = readTrustedPathPolicy();
  } catch (err) {
    return finish(
      [
        {
          rule: "classifier-error",
          path: null,
          detail: `could not read the trusted path policy: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      0,
    );
  }
  return classifyDiff({
    diff,
    codeowners: readTrustedCodeowners(),
    pathPolicy,
    trackedPaths: readTrustedPaths(),
  });
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function main(argv: readonly string[]): number {
  try {
    const repo = argValue(argv, "--repo");
    const baseRev = argValue(argv, "--base");
    const headRev = argValue(argv, "--head");
    const diffArg = argValue(argv, "--diff");
    let result: Classification;
    if (diffArg !== undefined) {
      const diff = diffArg === "-" ? readFileSync(0, "utf-8") : readFileSync(diffArg, "utf-8");
      result = classifyDiff({
        diff,
        codeowners: readTrustedCodeowners(),
        pathPolicy: readTrustedPathPolicy(),
        trackedPaths: readTrustedPaths(),
      });
    } else if (repo !== undefined && baseRev !== undefined && headRev !== undefined) {
      result = classifyRevisions(repo, baseRev, headRev);
    } else {
      throw new Error(
        "usage: classify-autonomy-tier --repo <dir> --base <rev> --head <rev> | --diff <file|->",
      );
    }
    process.stdout.write(`${JSON.stringify(result)}\n${result.summary}\n`);
    return result.rule === "classifier-error" ? 2 : 0;
  } catch (err) {
    const result = finish(
      [
        {
          rule: "classifier-error",
          path: null,
          detail: err instanceof Error ? err.message : String(err),
        },
      ],
      0,
    );
    process.stdout.write(`${JSON.stringify(result)}\n${result.summary}\n`);
    return 2;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
