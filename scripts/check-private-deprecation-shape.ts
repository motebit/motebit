/**
 * Private-package `@deprecated` shape gate.
 *
 * Sibling to `check-deprecation-discipline`, scoping in the opposite
 * direction. Where the four-field contract (`since`, `removed in`,
 * replacement, reason) is correct discipline for *published* packages —
 * a promise to npm consumers across a versioning boundary — it's theater
 * inside a private package: no consumer, no boundary, no addressee for
 * the contract.
 *
 * Why this gate exists
 * ────────────────────
 *
 * The 2026-04-23 four-field-classification pass (commit `bce38b7a`)
 * landed `@deprecated since X.Y.Z, removed in X.Y.Z` markers across the
 * workspace when most internal packages were still being treated as
 * published-shape (versions like `0.1.x`, `0.2.0`). The very next day,
 * commit `fa5fdfeb` flipped 51 internal packages to the sentinel
 * `0.0.0-private` — they bundle into the `motebit` CLI/runtime, never
 * publish independently. The four-field markers on those packages
 * became promises to nobody: there is no v1.0.0 to be `since`, no
 * v1.1.0 to be `removed in`, no consumer across a boundary.
 *
 * The 2026-04-28 cleanup stripped the residue (9 markers across 4
 * private packages) and this gate codifies the new doctrine:
 *
 *   - `0.0.0-private` packages MAY annotate `@deprecated`, but MUST NOT
 *     carry `since X.Y.Z` or `removed in X.Y.Z` semver fields. The
 *     "promise" form has no addressee.
 *   - The replacement pointer (`Use X` / `rework the caller` / `no
 *     replacement`) and the `Reason:` block are still required — the
 *     internal docs serve workspace callers (us) even without a
 *     consumer-facing contract.
 *
 * Scope:
 *   - scans `packages/**`, `apps/**`, `services/**` TypeScript source
 *     (same skip rules as the sibling gate)
 *   - ONLY looks at files inside packages whose `package.json` reads
 *     `"version": "0.0.0-private"` — published packages are governed
 *     by `check-deprecation-discipline`
 *   - reads the comment block surrounding every `@deprecated` token and
 *     validates the no-semver shape
 *
 * Companion checks: see `check-deprecation-discipline`'s header for
 * the full deprecation pipeline.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, resolve, relative, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const SCAN_ROOTS = ["packages", "apps", "services"];
const SKIP_DIR_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "coverage",
  "__tests__",
  ".turbo",
  "build",
  "generated",
]);
const SKIP_FILE_SUFFIXES = [".d.ts", ".d.ts.map", ".js.map", ".generated.ts"];

const PRIVATE_SENTINEL = "0.0.0-private";

interface DeprecationSite {
  file: string;
  line: number;
  annotation: string;
  block: string;
  pkgDir: string;
}

// ── Walking ───────────────────────────────────────────────────────────────

function walk(dir: string, out: string[]): void {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    if (SKIP_DIR_SEGMENTS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
    if (SKIP_FILE_SUFFIXES.some((s) => entry.endsWith(s))) continue;
    out.push(full);
  }
}

// ── Per-file parsing ──────────────────────────────────────────────────────

function findPackageDir(file: string): string | null {
  let dir = dirname(file);
  while (dir.startsWith(ROOT) && dir !== ROOT) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const pkgVersionCache = new Map<string, string>();
function pkgVersion(pkgDir: string): string {
  const cached = pkgVersionCache.get(pkgDir);
  if (cached !== undefined) return cached;
  try {
    const parsed = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8")) as {
      version?: string;
    };
    const v = parsed.version ?? "0.0.0";
    pkgVersionCache.set(pkgDir, v);
    return v;
  } catch {
    pkgVersionCache.set(pkgDir, "0.0.0");
    return "0.0.0";
  }
}

/**
 * Mirrors `check-deprecation-discipline.commentBlockAround` — same parser
 * shape so the two gates stay aligned. Walks backward to the comment
 * opener and forward to the closer.
 */
function commentBlockAround(lines: string[], lineIdx: number): string {
  const block: string[] = [];
  let start = lineIdx;
  let isJsDoc = false;

  for (let i = lineIdx; i >= 0; i--) {
    const trimmed = lines[i]!.trim();
    if (trimmed.startsWith("/**") || trimmed.startsWith("/*")) {
      start = i;
      isJsDoc = true;
      break;
    }
    if (trimmed.startsWith("*") || trimmed.startsWith("//")) {
      start = i;
      continue;
    }
    if (trimmed === "") {
      if (start < lineIdx && lines[start]!.trim().startsWith("//")) continue;
      break;
    }
    break;
  }

  let end = lineIdx;
  if (isJsDoc) {
    for (let i = lineIdx; i < lines.length; i++) {
      end = i;
      if (lines[i]!.includes("*/")) break;
    }
  } else {
    for (let i = lineIdx; i < lines.length; i++) {
      const trimmed = lines[i]!.trim();
      if (trimmed.startsWith("//")) {
        end = i;
        continue;
      }
      break;
    }
  }

  for (let i = start; i <= end; i++) block.push(lines[i]!);
  return block.join("\n");
}

function findDeprecationSites(file: string): DeprecationSite[] {
  const content = readFileSync(file, "utf-8");
  const lines = content.split("\n");
  const sites: DeprecationSite[] = [];

  const pkgDir = findPackageDir(file);
  if (!pkgDir) return sites;
  if (pkgVersion(pkgDir) !== PRIVATE_SENTINEL) return sites;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.includes("@deprecated")) continue;
    const annotation = line.trim();
    const block = commentBlockAround(lines, i);
    sites.push({
      file: relative(ROOT, file),
      line: i + 1,
      annotation,
      block,
      pkgDir,
    });
  }
  return sites;
}

// ── Field checks ──────────────────────────────────────────────────────────

const SINCE_RE = /\bsince\s+\d+\.\d+\.\d+/i;
const REMOVED_RE = /\bremoved\s+in\s+\d+\.\d+\.\d+/i;
const REPLACEMENT_HINTS = [
  /\bUse\s+\{?@?link\b/i,
  /\bUse\s+`/i,
  /\bPass\s+a\s+configured/i,
  /\bno replacement\b/i,
  /\brework\s+the\s+caller\b/i,
];

interface Defect {
  site: DeprecationSite;
  reason: string;
}

function validate(site: DeprecationSite): Defect[] {
  const defects: Defect[] = [];
  const block = site.block;

  // Rule 1: no `since X.Y.Z` semver field — there's no version axis to be since-of
  if (SINCE_RE.test(block)) {
    defects.push({
      site,
      reason:
        "private package carries `since X.Y.Z` semver field — drop it; the `0.0.0-private` sentinel means there is no version axis to be `since`-of",
    });
  }

  // Rule 2: no `removed in X.Y.Z` semver field — there's no consumer to make the promise to
  if (REMOVED_RE.test(block)) {
    defects.push({
      site,
      reason:
        "private package carries `removed in X.Y.Z` semver field — drop it; the `0.0.0-private` sentinel means there is no consumer across a versioning boundary the promise can be made to",
    });
  }

  // Rule 3: replacement pointer (workspace callers still need to know where to go)
  const hasReplacement = REPLACEMENT_HINTS.some((re) => re.test(block));
  if (!hasReplacement) {
    defects.push({
      site,
      reason:
        "comment block missing replacement pointer (`Use {@link X}` / `` Use `X` instead `` / `Pass a configured …` / `no replacement; rework the caller`)",
    });
  }

  // Rule 4: reason field — the WHY survives the boundary
  if (!/\bReason:/i.test(block)) {
    defects.push({
      site,
      reason: "comment block missing `Reason:` line (the WHY behind the deprecation)",
    });
  }

  return defects;
}

// ── Main ──────────────────────────────────────────────────────────────────

function main(): void {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    const abs = resolve(ROOT, root);
    if (existsSync(abs)) walk(abs, files);
  }

  const sites: DeprecationSite[] = [];
  for (const f of files) {
    sites.push(...findDeprecationSites(f));
  }

  const defects: Defect[] = [];
  for (const s of sites) defects.push(...validate(s));

  if (defects.length > 0) {
    process.stderr.write(
      `\nerror: ${defects.length} private-package \`@deprecated\` shape violation(s) across ${new Set(defects.map((d) => d.site.file)).size} file(s):\n\n`,
    );
    for (const d of defects) {
      process.stderr.write(`  ${d.site.file}:${d.site.line}\n`);
      process.stderr.write(
        `    ${d.site.annotation.slice(0, 120)}${d.site.annotation.length > 120 ? "…" : ""}\n`,
      );
      process.stderr.write(`    ✗ ${d.reason}\n\n`);
    }
    process.stderr.write(
      "See `docs/doctrine/deprecation-lifecycle.md` § Private packages.\n" +
        "Inside a `0.0.0-private` package the four-field semver contract has no\n" +
        "addressee — keep the `@deprecated` tag, the replacement pointer, and the\n" +
        "`Reason:` block; drop `since X.Y.Z` and `removed in X.Y.Z`.\n",
    );
    process.exit(1);
  }

  process.stderr.write(
    `  ✓ ${sites.length} private-package \`@deprecated\` site(s) across ${files.length} source files — no-semver shape + replacement pointer + Reason enforced\n`,
  );
}

main();
