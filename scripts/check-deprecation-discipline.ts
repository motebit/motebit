/**
 * Deprecation discipline gate — enforces the four-field `@deprecated`
 * contract and temporal sanity of `removed in` versions.
 *
 * `docs/doctrine/deprecation-lifecycle.md` mandates that every
 * `@deprecated` annotation carry four fields: `since <version>`,
 * `removed in <version>`, a replacement pointer, and a reason.
 * It also names `check-deprecation-discipline` as the candidate gate
 * that would enforce the contract mechanically. This script is that
 * gate.
 *
 * Scope:
 *   - scans `packages/**`, `apps/**`, `services/**` TypeScript source
 *     (excludes `node_modules`, `dist/`, `coverage/`, `.d.ts`, `__tests__/`)
 *   - reads the comment block preceding every `@deprecated` token and
 *     validates the four-field shape
 *   - reads the current version of the containing package from its
 *     `package.json` and fails the gate if any `removed in` version is
 *     ≤ current (past-due sunset shipped unremoved = broken promise)
 *
 * Exemption: the string literal `/** @deprecated since 0.0.0` is
 * reserved for compile-time-only stubs (none at motebit today). No
 * exemption path is wired — if one becomes necessary, add it with a
 * reason, don't bypass silently.
 *
 * Companion checks:
 *   - `check-changeset-discipline` enforces that `major` changesets
 *     carry a `## Migration` section.
 *   - `check-api-surface` enforces that public-API changes are
 *     accompanied by a pending changeset.
 *
 * Together the three form the deprecation pipeline: a deprecation lands
 * with the four-field marker (this gate), graduates to a `major`
 * changeset with a migration guide (check-changeset-discipline), and
 * the removal PR touches api-extractor baselines that check-api-surface
 * watches.
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

interface DeprecationSite {
  file: string; // repo-relative
  line: number;
  annotation: string; // the `@deprecated …` line
  block: string; // the full preceding comment block (preserves the context around the @deprecated line)
  pkgDir: string; // absolute package root (where package.json lives)
  pkgVersion: string; // version from package.json
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
 * Extract the full comment block that surrounds a `@deprecated` annotation.
 * Walks backward to the nearest block-comment opener (`/**` / `/*`) or
 * the start of a `//` run, then walks forward from the annotation line
 * to the matching closer (`*​/`) or the end of the `//` run. Typical
 * motebit shape places `Reason:` lines AFTER the annotation, so a
 * backward-only walk would miss them.
 */
function commentBlockAround(lines: string[], lineIdx: number): string {
  const block: string[] = [];
  let start = lineIdx;
  let isJsDoc = false;

  // Walk backward to find the block opener
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
      // empty line continues only if we're still inside a // run
      if (start < lineIdx && lines[start]!.trim().startsWith("//")) continue;
      break;
    }
    // Non-comment, non-empty line — stop
    break;
  }

  // Walk forward from lineIdx to find the block closer
  let end = lineIdx;
  if (isJsDoc) {
    for (let i = lineIdx; i < lines.length; i++) {
      end = i;
      if (lines[i]!.includes("*/")) break;
    }
  } else {
    // // run: extend forward while we see // or blank
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
      pkgVersion: pkgVersion(pkgDir),
    });
  }
  return sites;
}

// ── Field checks ──────────────────────────────────────────────────────────

const SINCE_RE = /since\s+([0-9]+\.[0-9]+\.[0-9]+)/;
const REMOVED_RE = /removed in\s+([0-9]+\.[0-9]+\.[0-9]+)/;
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

function compareSemver(a: string, b: string): number {
  const [aMa, aMi, aPa] = a.split(".").map(Number);
  const [bMa, bMi, bPa] = b.split(".").map(Number);
  if (aMa !== bMa) return (aMa ?? 0) - (bMa ?? 0);
  if (aMi !== bMi) return (aMi ?? 0) - (bMi ?? 0);
  return (aPa ?? 0) - (bPa ?? 0);
}

function validate(site: DeprecationSite): Defect[] {
  const defects: Defect[] = [];
  const ann = site.annotation;
  const block = site.block;

  // Rule 1: `since <semver>` present on the @deprecated line
  if (!SINCE_RE.test(ann)) {
    defects.push({ site, reason: "`@deprecated` line missing `since <X.Y.Z>` version" });
  }

  // Rule 2: `removed in <semver>` present on the @deprecated line
  const rmMatch = ann.match(REMOVED_RE);
  if (!rmMatch) {
    defects.push({
      site,
      reason: "`@deprecated` line missing `removed in <X.Y.Z>` version",
    });
  } else {
    // Rule 3: removed-in must be > current package version
    const removedIn = rmMatch[1]!;
    const cmp = compareSemver(removedIn, site.pkgVersion);
    if (cmp <= 0) {
      defects.push({
        site,
        reason: `\`removed in ${removedIn}\` is past-due (package is at ${site.pkgVersion}; the sunset was promised and the symbol still exists)`,
      });
    }
  }

  // Rule 4: replacement pointer present on the @deprecated line
  const hasReplacement = REPLACEMENT_HINTS.some((re) => re.test(ann));
  if (!hasReplacement) {
    defects.push({
      site,
      reason:
        "`@deprecated` line missing replacement pointer (expected `Use {@link X}` / `` Use `X` instead `` / `Pass a configured …` / `no replacement; rework the caller`)",
    });
  }

  // Rule 5: reason field in the surrounding comment block
  if (!/\bReason:/i.test(block)) {
    defects.push({
      site,
      reason:
        "surrounding comment block missing `Reason:` line (the WHY behind the deprecation — required by `docs/doctrine/deprecation-lifecycle.md`)",
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
      `\nerror: ${defects.length} \`@deprecated\` discipline violation(s) across ${new Set(defects.map((d) => d.site.file)).size} file(s):\n\n`,
    );
    for (const d of defects) {
      process.stderr.write(`  ${d.site.file}:${d.site.line}\n`);
      process.stderr.write(
        `    ${d.site.annotation.slice(0, 120)}${d.site.annotation.length > 120 ? "…" : ""}\n`,
      );
      process.stderr.write(`    ✗ ${d.reason}\n\n`);
    }
    process.stderr.write(
      "See `docs/doctrine/deprecation-lifecycle.md` — every `@deprecated` annotation\n" +
        "must carry: `since <X.Y.Z>`, `removed in <X.Y.Z>`, a replacement pointer, and\n" +
        "a `Reason:` block. Past-due `removed in` versions are broken promises and\n" +
        "must be either removed or their target version bumped.\n",
    );
    process.exit(1);
  }

  process.stderr.write(
    `  ✓ ${sites.length} \`@deprecated\` site(s) across ${files.length} source files — four-field contract + temporal sanity enforced\n`,
  );
}

main();
