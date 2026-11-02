/**
 * The repository path policy — `motebit/repo-path-policy@1.0`
 * (spec/repo-change-v1.md §7.2).
 *
 * ONE INTERPRETER. The path predicate is data, not code: a repository keeps
 * it in `.motebit/repo-path-policy.json`, and every judge of a path reads it
 * through this module — the milestone-A autonomy-tier classifier
 * (`scripts/classify-autonomy-tier.ts`, against the trusted base) and the
 * repo-change verifier's caller (`VerifyRepoChangeInput.isPathPermitted`, at
 * the judged commit). A second interpreter drifts; this is the only one.
 *
 * DEPENDENCY-FREE: this module imports nothing, not even `@motebit/*`, so the
 * classifier can load it by relative source path under tsx with no build step
 * (its workflow runs from a checkout where no `dist/` exists). Keep it so.
 *
 * Strict and fail-closed: the file parses only in its one shape, every
 * pattern must be in the closed grammar below, and anything else throws.
 *
 * The grammar (a pattern is `/`-separated segments, matched from the root):
 *
 *     pattern = segment *( "/" segment )
 *     segment = "**" / glob
 *     glob    = 1*( char / "*" )  ; no two "*" in a row; not "." or ".."
 *     char    = A-Z / a-z / 0-9 / "." / "_" / "-"
 *
 * with no two `**` segments in a row and no pattern that is only `**`.
 *   - `*` matches any run of characters other than `/`, possibly empty;
 *   - a `**` segment that is not the last matches zero or more whole
 *     segments (a leading `**` segment means "at any depth");
 *   - a last `**` segment matches one or more whole segments (`d/**` is
 *     "everything under d").
 *
 * An include names FILES: it matches the path itself, never what is beneath
 * it. An exclude also matches every path that begins with a path it matches
 * followed by `/` and at least one more character (descent), and it matches
 * with ASCII letters folded to one case. A path is permitted iff some include
 * matches it, no exclude matches it, and it contains no line terminator.
 */

/** The `spec` value of a repository path policy file. */
export const REPO_PATH_POLICY_SPEC = "motebit/repo-path-policy@1.0";

/** Where a repository keeps its path policy, repo-relative. */
export const REPO_PATH_POLICY_FILE = ".motebit/repo-path-policy.json";

/** A strictly parsed repository path policy (spec/repo-change-v1.md §7.2). */
export interface RepoPathPolicy {
  readonly spec: typeof REPO_PATH_POLICY_SPEC;
  /** Patterns naming the files a change may touch (no descent, exact case). */
  readonly include: readonly string[];
  /** Patterns that remove paths from the includes (descent, ASCII case folded). */
  readonly exclude: readonly string[];
}

/**
 * How an exclude matches a path: `"exact"` with the path's own case, or
 * `"case_folded"` only once ASCII case is folded (the path differs only by
 * case from an excluded one).
 */
export type RepoPathExclusion = "exact" | "case_folded";

type Segment = { readonly kind: "globstar" } | { readonly kind: "glob"; readonly text: string };

interface Compiled {
  readonly include: readonly (readonly Segment[])[];
  readonly exclude: readonly (readonly Segment[])[];
}

const POLICY_KEYS = ["spec", "include", "exclude"] as const;
const GLOB = /^[A-Za-z0-9._*-]+$/;
/** ECMAScript's line terminators (LF, CR, U+2028, U+2029): a path containing one is never permitted. */
const LINE_TERMINATORS: readonly string[] = [
  "\n",
  "\r",
  String.fromCharCode(0x2028),
  String.fromCharCode(0x2029),
];

const compiledCache = new WeakMap<RepoPathPolicy, Compiled>();

function fail(detail: string): never {
  throw new Error(`repo path policy: ${detail}`);
}

/** One pattern in the closed grammar, as segments; throws on anything outside it. */
function compilePattern(pattern: unknown, where: string): Segment[] {
  if (typeof pattern !== "string") fail(`${where} is not a string`);
  if (pattern === "") fail(`${where} is empty`);
  const out: Segment[] = [];
  for (const seg of pattern.split("/")) {
    if (seg === "**") {
      if (out.length > 0 && out[out.length - 1]!.kind === "globstar") {
        fail(`${where} ${JSON.stringify(pattern)} has two \`**\` segments in a row`);
      }
      out.push({ kind: "globstar" });
      continue;
    }
    if (seg === "") fail(`${where} ${JSON.stringify(pattern)} has an empty segment`);
    if (!GLOB.test(seg)) {
      fail(
        `${where} ${JSON.stringify(pattern)}: segment ${JSON.stringify(seg)} is outside the grammar`,
      );
    }
    if (seg.includes("**")) {
      fail(`${where} ${JSON.stringify(pattern)}: \`**\` must be a whole segment`);
    }
    if (seg === "." || seg === "..") {
      fail(`${where} ${JSON.stringify(pattern)}: segment ${JSON.stringify(seg)} is not allowed`);
    }
    out.push({ kind: "glob", text: seg });
  }
  if (out.length === 1 && out[0]!.kind === "globstar") {
    fail(`${where} is only \`**\``);
  }
  return out;
}

function compileList(list: unknown, key: string): Segment[][] {
  if (!Array.isArray(list)) fail(`\`${key}\` is not an array`);
  const seen = new Set<string>();
  return list.map((p: unknown, i) => {
    const segs = compilePattern(p, `${key}[${i}]`);
    if (seen.has(p as string)) fail(`${key}[${i}] ${JSON.stringify(p)} is a duplicate`);
    seen.add(p as string);
    return segs;
  });
}

function compilePolicy(value: unknown): Compiled {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("the policy is not a JSON object");
  }
  const o = value as Record<string, unknown>;
  for (const k of POLICY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(o, k)) fail(`missing key \`${k}\``);
  }
  for (const k of Object.keys(o)) {
    if (!(POLICY_KEYS as readonly string[]).includes(k)) fail(`unknown key \`${k}\``);
  }
  if (o.spec !== REPO_PATH_POLICY_SPEC) {
    fail(`\`spec\` is ${JSON.stringify(o.spec)}, not ${JSON.stringify(REPO_PATH_POLICY_SPEC)}`);
  }
  return { include: compileList(o.include, "include"), exclude: compileList(o.exclude, "exclude") };
}

/**
 * Parse `.motebit/repo-path-policy.json` strictly. Throws on invalid JSON, a
 * missing or unknown key, a `spec` other than `motebit/repo-path-policy@1.0`,
 * a list that is not an array of strings, a duplicate pattern, or any pattern
 * outside the grammar.
 */
export function parseRepoPathPolicy(text: string): RepoPathPolicy {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new Error("repo path policy: not valid JSON", { cause: err });
  }
  const compiled = compilePolicy(value);
  const o = value as { include: string[]; exclude: string[] };
  const policy: RepoPathPolicy = Object.freeze({
    spec: REPO_PATH_POLICY_SPEC,
    include: Object.freeze([...o.include]),
    exclude: Object.freeze([...o.exclude]),
  });
  compiledCache.set(policy, compiled);
  return policy;
}

/** The compiled form; a policy built by hand is checked as strictly as a parsed one. */
function compiledOf(policy: RepoPathPolicy): Compiled {
  let c = compiledCache.get(policy);
  if (c === undefined) {
    c = compilePolicy(policy);
    compiledCache.set(policy, c);
  }
  return c;
}

/** ASCII letters to lower case; every other character is left as it is. */
function foldAscii(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** `*` matches any run (possibly empty) of `seg`'s characters; everything else is literal. */
function globMatch(glob: string, seg: string, fold: boolean): boolean {
  const g = fold ? foldAscii(glob) : glob;
  const s = fold ? foldAscii(seg) : seg;
  let gi = 0;
  let si = 0;
  let star = -1;
  let mark = 0;
  while (si < s.length) {
    if (gi < g.length && g[gi] !== "*" && g[gi] === s[si]) {
      gi++;
      si++;
    } else if (gi < g.length && g[gi] === "*") {
      star = gi++;
      mark = si;
    } else if (star >= 0) {
      gi = star + 1;
      si = ++mark;
    } else {
      return false;
    }
  }
  while (gi < g.length && g[gi] === "*") gi++;
  return gi === g.length;
}

/** Do the pattern segments `pat[i..]` match the path segments `segs[j..]` exactly? */
function matchFrom(
  pat: readonly Segment[],
  i: number,
  segs: readonly string[],
  j: number,
  fold: boolean,
): boolean {
  if (i === pat.length) return j === segs.length;
  const p = pat[i]!;
  if (p.kind === "globstar") {
    // A last `**` covers one or more segments; any other covers zero or more.
    if (i === pat.length - 1) return segs.length - j >= 1;
    for (let k = j; k <= segs.length; k++) if (matchFrom(pat, i + 1, segs, k, fold)) return true;
    return false;
  }
  return (
    j < segs.length && globMatch(p.text, segs[j]!, fold) && matchFrom(pat, i + 1, segs, j + 1, fold)
  );
}

/** Exactly the path (an include: files only, no descent). */
function matchesFile(pat: readonly Segment[], path: string): boolean {
  return matchFrom(pat, 0, path.split("/"), 0, false);
}

/** The path, or a path it lies beneath followed by `/` and one more character (an exclude). */
function matchesWithDescent(pat: readonly Segment[], path: string, fold: boolean): boolean {
  const segs = path.split("/");
  if (matchFrom(pat, 0, segs, 0, fold)) return true;
  for (let k = 1; k < segs.length; k++) {
    if (segs.slice(k).join("/") === "") continue;
    if (matchFrom(pat, 0, segs.slice(0, k), 0, fold)) return true;
  }
  return false;
}

/** Some include matches `path` itself, in its own case. */
export function isRepoPathIncluded(policy: RepoPathPolicy, path: string): boolean {
  return compiledOf(policy).include.some((pat) => matchesFile(pat, path));
}

/**
 * Whether an exclude matches `path`: `"exact"` in the path's own case,
 * `"case_folded"` only once ASCII case is folded, `null` when none does.
 */
export function repoPathExclusion(policy: RepoPathPolicy, path: string): RepoPathExclusion | null {
  const ex = compiledOf(policy).exclude;
  if (ex.some((pat) => matchesWithDescent(pat, path, false))) return "exact";
  if (ex.some((pat) => matchesWithDescent(pat, path, true))) return "case_folded";
  return null;
}

/**
 * The path predicate: `path` is permitted iff it has no line terminator, an
 * include matches it, and no exclude matches it in any ASCII case.
 */
export function isRepoPathPermitted(policy: RepoPathPolicy, path: string): boolean {
  if (LINE_TERMINATORS.some((t) => path.includes(t))) return false;
  return isRepoPathIncluded(policy, path) && repoPathExclusion(policy, path) === null;
}
