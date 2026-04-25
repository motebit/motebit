#!/usr/bin/env tsx
/**
 * audit-doc-imports-vs-sdk — one-shot audit, not a CI gate.
 *
 * For every `from "@motebit/<X>"` import in apps/docs/content/docs (recursively walked for .mdx)
 * where X is a workspace-private package, ask: is the imported symbol
 * also exported from `@motebit/sdk` (the developer-contract Apache-2.0
 * surface, which transitively re-exports `@motebit/protocol`)?
 *
 * Why it exists:
 *
 *   `check-doc-private-imports` (gate #50) requires that any
 *   private-package import in MDX sit inside a `<ReferenceExample>`
 *   wrapper. That gate is the FALLBACK — it ensures the boundary is
 *   honored when an import truly cannot move to the public surface.
 *
 *   The UPSTREAM check is the question this script answers: should
 *   the import even be from a private package? If the symbol is
 *   already re-exported through `@motebit/sdk`, the example should
 *   just import it from there — no wrapper needed, no doctrine
 *   ambiguity, no false signal that the consumer has to dive into
 *   private code.
 *
 * Usage (one-shot, not in `pnpm check`):
 *
 *   pnpm tsx scripts/audit-doc-imports-vs-sdk.ts
 *
 * Output: per-symbol verdict — "✓ already public via @motebit/sdk;
 * swap the import" vs "✗ truly private; wrap in <ReferenceExample>".
 *
 * History: ran 2026-04-26 against the 13 wrapped imports across
 * developer/budget-settlement, developer/semiring-routing, and
 * developer/delegation. Result: 0 / 19 unique symbols swappable —
 * every reference is genuinely BSL judgment outside the floor.
 * The wrapping work was correct. Re-run this script when:
 *   (a) the SDK's re-export surface widens (`packages/sdk/src/index.ts`)
 *   (b) a new private-package import is added to the docs and the
 *       contributor wants to know whether wrapping is the right move
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const DOCS_CONTENT_DIR = join(REPO_ROOT, "apps", "docs", "content", "docs");
const PACKAGES_DIR = join(REPO_ROOT, "packages");
const SDK_DIST = join(REPO_ROOT, "packages", "sdk", "dist", "index.js");

function collectPrivatePackages(): Set<string> {
  const out = new Set<string>();
  for (const entry of readdirSync(PACKAGES_DIR)) {
    const pkgJson = join(PACKAGES_DIR, entry, "package.json");
    let raw: string;
    try {
      raw = readFileSync(pkgJson, "utf-8");
    } catch {
      continue;
    }
    const parsed = JSON.parse(raw) as { name?: string; private?: boolean };
    if (parsed.private === true && typeof parsed.name === "string") {
      out.add(parsed.name);
    }
  }
  return out;
}

function walkMdx(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walkMdx(full));
    else if (entry.endsWith(".mdx")) out.push(full);
  }
  return out;
}

interface ImportCite {
  readonly symbol: string;
  readonly pkg: string;
  readonly file: string;
}

/**
 * Extract every imported symbol from a `from "@motebit/<X>"` clause
 * in an MDX file. Handles both single-line (`import { a, b } from
 * "..."`) and multi-line forms.
 */
function extractImports(file: string, content: string, privates: Set<string>): ImportCite[] {
  const out: ImportCite[] = [];
  const re = /import(?:\s+type)?\s*\{([\s\S]*?)\}\s*from\s+["']@motebit\/([a-zA-Z0-9_-]+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const pkgName = `@motebit/${match[2]}`;
    if (!privates.has(pkgName)) continue;
    const symbols = match[1]!
      .split(",")
      .map((s) =>
        s
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)[0]!
          .trim(),
      )
      .filter(Boolean);
    for (const symbol of symbols) {
      out.push({ symbol, pkg: pkgName, file });
    }
  }
  return out;
}

async function loadSdkExports(): Promise<Set<string>> {
  try {
    const sdk = (await import(SDK_DIST)) as Record<string, unknown>;
    return new Set(Object.keys(sdk));
  } catch {
    console.error(
      `audit failed: could not load ${SDK_DIST} — run \`pnpm --filter @motebit/sdk build\` first`,
    );
    process.exit(2);
  }
}

async function main(): Promise<void> {
  const privates = collectPrivatePackages();
  const sdkExports = await loadSdkExports();

  const imports: ImportCite[] = [];
  for (const file of walkMdx(DOCS_CONTENT_DIR)) {
    imports.push(...extractImports(file, readFileSync(file, "utf-8"), privates));
  }

  // Deduplicate by (symbol, pkg) — the same symbol may appear across
  // multiple pages or multiple times in one page.
  const unique = new Map<string, ImportCite>();
  for (const imp of imports) unique.set(`${imp.pkg}::${imp.symbol}`, imp);

  console.log(
    `audit-doc-imports-vs-sdk: ${unique.size} unique private-package symbol(s) imported across the docs site\n`,
  );
  let swappable = 0;
  for (const imp of [...unique.values()].sort((a, b) => a.symbol.localeCompare(b.symbol))) {
    const isPublic = sdkExports.has(imp.symbol);
    if (isPublic) swappable++;
    const verdict = isPublic
      ? `✓ already public via @motebit/sdk — swap the import`
      : `✗ truly private — wrap in <ReferenceExample>`;
    console.log(`  ${imp.symbol.padEnd(36)} (${imp.pkg.padEnd(28)}) ${verdict}`);
  }
  console.log(
    `\n${swappable} swappable, ${unique.size - swappable} truly private. ` +
      `Swap the swappable ones; verify the rest are wrapped via \`pnpm check-doc-private-imports\`.`,
  );
}

void main();
