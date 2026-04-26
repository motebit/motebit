#!/usr/bin/env tsx
/**
 * check-readme-bin-claims — drift defense for "code-shaped prose drift"
 * in package documentation.
 *
 * Surfaced 2026-04-26 during a sibling-boundary audit: `@motebit/verifier`'s
 * README opened with `npm i -g @motebit/verifier && motebit-verify motebit.md`
 * for months after the 2026-04-09 verify↔verifier swap removed the package's
 * `bin` field. The README's install snippet was a broken executable
 * documentation example — it survived `tsc`, `eslint`, every test runner,
 * and every other `check-*` gate in this directory because none of them
 * read prose. Anyone landing on the npm page and copy-pasting the snippet
 * would silently install the library and then fail because there was no
 * `motebit-verify` binary in it.
 *
 * The drift class is **"code-shaped prose drift"** — documentation that
 * looks like runnable code but no longer matches the package's actual
 * capabilities. Common triggers:
 *
 *   - Package rename / repositioning (the verify↔verifier swap)
 *   - `bin` field removal (a package stops shipping a CLI)
 *   - `exports` change (an API moves between packages)
 *   - Major version bump with breaking changes
 *
 * After any of those, README/CLAUDE.md install snippets need re-validation.
 * The defense is structural — let a script extract the install commands
 * from prose and verify each names a package that actually ships a bin.
 *
 * What this probe enforces:
 *
 *   1. Every `npm i -g <@motebit/...>` / `npm install -g <@motebit/...>` /
 *      `npm install --global <@motebit/...>` in any README.md or CLAUDE.md
 *      points at a workspace package that has a `bin` field in its
 *      package.json.
 *   2. Same for `npx <@motebit/...>` invocations (they implicitly require
 *      a `bin`).
 *
 * Code-block fences are not parsed specially — install commands inside
 * fenced ```bash blocks are still install commands. The probe greps the
 * raw text.
 *
 * Out of scope: import-statement drift (`import { X } from "@motebit/foo"`
 * where `X` no longer exists). That requires resolving the named export
 * against the dist surface, which is more invasive than a regex sweep.
 * If a future drift incident demands it, this script is the natural home.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

interface PackageEntry {
  readonly name: string;
  readonly bin: unknown;
  readonly path: string;
}

interface Finding {
  readonly doc: string;
  readonly kind: "global-install-of-bin-less" | "npx-of-bin-less";
  readonly pkg: string;
  readonly snippet: string;
}

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".git",
  ".next",
  ".turbo",
  ".motebit",
]);

function findFiles(dir: string, predicate: (p: string) => boolean): string[] {
  const out: string[] = [];
  function walk(d: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (predicate(full)) out.push(full);
    }
  }
  walk(dir);
  return out;
}

function indexWorkspacePackages(): Map<string, PackageEntry> {
  const index = new Map<string, PackageEntry>();
  const packageJsons = findFiles(REPO_ROOT, (p) => p.endsWith("/package.json"));
  for (const p of packageJsons) {
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    const name = typeof pkg.name === "string" ? pkg.name : null;
    if (!name) continue;
    if (!name.startsWith("@motebit/") && name !== "motebit" && name !== "create-motebit") continue;
    index.set(name, { name, bin: pkg.bin ?? null, path: p });
  }
  return index;
}

function isMotebitPackageName(s: string): boolean {
  return s.startsWith("@motebit/") || s === "motebit" || s === "create-motebit";
}

function scanDoc(doc: string, binIndex: Map<string, PackageEntry>): Finding[] {
  const text = fs.readFileSync(doc, "utf8");
  const findings: Finding[] = [];
  const docRel = doc.replace(REPO_ROOT + "/", "");

  // `npm i -g <pkg>` / `npm install -g <pkg>` / `npm install --global <pkg>`
  // We capture the package token; strip a `@version` suffix off the pkg name
  // so `npm i -g foo@1.0` resolves to `foo`.
  const installPattern = /npm\s+(?:i|install)\s+(?:-g|--global)\s+(@?[\w/-]+)(?:@[\w.-]+)?/g;
  for (const m of text.matchAll(installPattern)) {
    const pkg = m[1]!;
    if (!isMotebitPackageName(pkg)) continue;
    const entry = binIndex.get(pkg);
    if (!entry) continue;
    if (!entry.bin) {
      findings.push({ doc: docRel, kind: "global-install-of-bin-less", pkg, snippet: m[0] });
    }
  }

  // `npx <pkg>` / `npx --yes <pkg>` / `npx -y <pkg>`. Same suffix-strip.
  const npxPattern = /npx\s+(?:--yes\s+|-y\s+)?(@?[\w/-]+)(?:@[\w.-]+)?/g;
  for (const m of text.matchAll(npxPattern)) {
    const pkg = m[1]!;
    if (!isMotebitPackageName(pkg)) continue;
    const entry = binIndex.get(pkg);
    if (!entry) continue;
    if (!entry.bin) {
      findings.push({ doc: docRel, kind: "npx-of-bin-less", pkg, snippet: m[0] });
    }
  }

  return findings;
}

function main(): void {
  const binIndex = indexWorkspacePackages();
  const docs = findFiles(REPO_ROOT, (p) => /(README\.md|CLAUDE\.md)$/.test(p));

  const allFindings: Finding[] = [];
  for (const doc of docs) {
    allFindings.push(...scanDoc(doc, binIndex));
  }

  console.log(
    "▸ check-readme-bin-claims — drift defense against code-shaped prose pointing at packages that don't ship a bin (e.g. `npm i -g @motebit/verifier && motebit-verify` after the 2026-04-09 verify↔verifier swap removed the bin field). Scans every README.md and CLAUDE.md for `npm i -g <pkg>`, `npm install -g <pkg>`, and `npx <pkg>` invocations naming workspace packages, and verifies each named package's package.json has a `bin` field.",
  );

  if (allFindings.length === 0) {
    console.log(
      `✓ check-readme-bin-claims: ${docs.length} README.md / CLAUDE.md file(s) scanned; every install or npx invocation targets a package that ships a bin.`,
    );
    return;
  }

  console.log(`✗ check-readme-bin-claims: ${allFindings.length} drift instance(s):\n`);
  for (const f of allFindings) {
    console.log(`  ${f.doc}`);
    console.log(
      `    ${f.kind}: \`${f.snippet}\` — ${f.pkg} has no \`bin\` field in package.json\n`,
    );
  }
  console.log(
    "Fix: either add a `bin` field to the named package's package.json, OR rewrite the install snippet to point at the package that actually ships the binary (likely a recently-renamed sibling).",
  );
  process.exit(1);
}

main();
