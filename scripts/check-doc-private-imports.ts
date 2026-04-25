#!/usr/bin/env tsx
/**
 * check-doc-private-imports — drift defense for the public-surface
 * doctrine in the docs site.
 *
 * The sentinel commit (fa5fdfeb, 2026-04-24) made the version
 * doctrine explicit in code: only the eleven published packages
 * make stability promises; private packages are pinned to
 * `0.0.0-private` and exist for source organization. The
 * changeset config locks that doctrine for versioning by
 * `ignore`-listing every private package name.
 *
 * This gate is the docs-side sibling. It catches the inverse
 * drift: a developer doc page showing
 *   `import { ... } from "@motebit/<X>"`
 * where X is `"private": true`. Such a snippet implies the package
 * is consumable by external developers — but the package isn't on
 * npm, has no version surface, and its API can refactor freely.
 *
 * Allowed pattern: any `from "@motebit/<private>"` import that
 * appears inside an explicit `<ReferenceExample>` JSX block. The
 * wrapper component frames the snippet as reference-implementation
 * internal code and links to source on GitHub. See
 * `apps/docs/src/components/reference-example.tsx`.
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — one or more violations
 *
 * Usage:
 *   pnpm check-doc-private-imports
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const DOCS_CONTENT_DIR = join(REPO_ROOT, "apps", "docs", "content", "docs");
const PACKAGES_DIR = join(REPO_ROOT, "packages");

// ── Build the private-package set from package.json ────────────────────

/**
 * Walk `packages/*` and return every `@motebit/<name>` whose
 * package.json declares `"private": true`. The set is the
 * authoritative list of names that may NOT appear in a docs
 * import outside a `<ReferenceExample>` wrapper.
 */
function collectPrivatePackages(): Set<string> {
  const privates = new Set<string>();
  let entries: string[];
  try {
    entries = readdirSync(PACKAGES_DIR);
  } catch {
    return privates;
  }
  for (const entry of entries) {
    const pkgJsonPath = join(PACKAGES_DIR, entry, "package.json");
    let raw: string;
    try {
      raw = readFileSync(pkgJsonPath, "utf-8");
    } catch {
      continue;
    }
    let pkg: { name?: string; private?: boolean };
    try {
      pkg = JSON.parse(raw);
    } catch {
      continue;
    }
    if (pkg.private === true && typeof pkg.name === "string") {
      privates.add(pkg.name);
    }
  }
  return privates;
}

// ── Walk MDX files ─────────────────────────────────────────────────────

function walkMdx(root: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  for (const entry of entries) {
    const full = join(root, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      out.push(...walkMdx(full));
    } else if (stat.isFile() && entry.endsWith(".mdx")) {
      out.push(full);
    }
  }
  return out;
}

// ── ReferenceExample-region detection ──────────────────────────────────

/**
 * Return an array of `[startIndex, endIndex)` half-open spans
 * covering every `<ReferenceExample ...>...</ReferenceExample>`
 * block in `content`. The start is the byte offset of the `<`
 * opening the tag; the end is one past the `>` closing the
 * </ReferenceExample> tag.
 *
 * Used to determine whether a given import-line offset is
 * "inside a wrapper." Nested ReferenceExample is not a real
 * pattern; the simple linear scan is sufficient.
 */
function referenceExampleSpans(content: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const openRe = /<ReferenceExample\b/g;
  const closeRe = /<\/ReferenceExample\s*>/g;
  let openMatch: RegExpExecArray | null;
  let lastCloseEnd = 0;
  while ((openMatch = openRe.exec(content)) !== null) {
    const openStart = openMatch.index;
    if (openStart < lastCloseEnd) continue; // already inside a span
    closeRe.lastIndex = openRe.lastIndex;
    const closeMatch = closeRe.exec(content);
    if (!closeMatch) break;
    const closeEnd = closeMatch.index + closeMatch[0].length;
    spans.push([openStart, closeEnd]);
    lastCloseEnd = closeEnd;
    openRe.lastIndex = closeEnd;
  }
  return spans;
}

function isInsideReferenceExample(offset: number, spans: Array<[number, number]>): boolean {
  for (const [start, end] of spans) {
    if (offset >= start && offset < end) return true;
  }
  return false;
}

// ── Import-statement detection ─────────────────────────────────────────

interface ImportSite {
  readonly file: string;
  readonly line: number;
  readonly pkg: string;
  readonly insideWrapper: boolean;
}

/**
 * Find every `from "@motebit/X"` token in the file (whether the
 * import is single- or multi-line; the `from` clause is the
 * canonical anchor and uniquely identifies the source package).
 *
 * Each finding is paired with its byte offset so the wrapper-span
 * test can determine whether it sits inside a `<ReferenceExample>`.
 */
function findImports(file: string, content: string, privates: Set<string>): ImportSite[] {
  const sites: ImportSite[] = [];
  const fromRe = /from\s+["']@motebit\/([a-zA-Z0-9_-]+)["']/g;
  const spans = referenceExampleSpans(content);
  let match: RegExpExecArray | null;
  while ((match = fromRe.exec(content)) !== null) {
    const pkgName = `@motebit/${match[1]}`;
    if (!privates.has(pkgName)) continue;
    const line = content.slice(0, match.index).split("\n").length;
    sites.push({
      file,
      line,
      pkg: pkgName,
      insideWrapper: isInsideReferenceExample(match.index, spans),
    });
  }
  return sites;
}

// ── Main ───────────────────────────────────────────────────────────────

function main(): void {
  const privates = collectPrivatePackages();
  if (privates.size === 0) {
    console.warn(
      "check-doc-private-imports: no private packages found under packages/ — gate is a no-op",
    );
    return;
  }

  const mdxFiles = walkMdx(DOCS_CONTENT_DIR);
  const violations: ImportSite[] = [];
  let totalImports = 0;
  let wrappedImports = 0;

  for (const file of mdxFiles) {
    const content = readFileSync(file, "utf-8");
    const sites = findImports(file, content, privates);
    for (const site of sites) {
      totalImports++;
      if (site.insideWrapper) {
        wrappedImports++;
      } else {
        violations.push(site);
      }
    }
  }

  console.log("check-doc-private-imports:");
  console.log(`  ${mdxFiles.length} MDX files scanned`);
  console.log(`  ${privates.size} private packages tracked`);
  console.log(`  ${totalImports} imports found across docs`);
  console.log(`  ${wrappedImports} wrapped in <ReferenceExample>`);

  if (violations.length === 0) {
    console.log("✓ all private-package imports are inside <ReferenceExample> wrappers");
    return;
  }

  console.error(`\n✗ ${violations.length} unwrapped private-package import(s):`);
  for (const v of violations) {
    console.error(
      `  - ${relative(REPO_ROOT, v.file)}:${v.line}: ` +
        `from "${v.pkg}" — private package, must be inside <ReferenceExample>`,
    );
  }
  console.error(
    '\nWrap the import block in <ReferenceExample pkg="@motebit/X" source="packages/X/src/...">...</ReferenceExample>\n' +
      "or rewrite the example to use a published-package import (@motebit/protocol, @motebit/sdk, @motebit/crypto, ...).\n" +
      "See `/docs/concepts/public-surface` and `docs/drift-defenses.md` invariant #50.",
  );
  process.exit(1);
}

main();
