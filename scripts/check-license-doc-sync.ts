#!/usr/bin/env tsx
/**
 * check-license-doc-sync — drift defense for the permissive-floor list.
 *
 * The permissive-floor membership (Apache-2.0 today; the role is "permissive
 * floor", the instance is the SPDX identifier) is described in three prose
 * surfaces and one structural surface:
 *
 *   - LICENSING.md — the canonical table (`packages/X/` rows + npm column +
 *     purpose) and the "Quick reference" inline list of short names
 *   - CONTRIBUTING.md — the parenthesized list under § "License"
 *   - CLA.md — the inline list in § 6 "Licensing of Contributions"
 *   - LICENSE — the "Apache-2.0-Licensed Components" fixed-column block
 *   - Each workspace package.json — the SPDX `license` field
 *
 * On 2026-04-26 a principal-engineer review caught CONTRIBUTING.md missing
 * `packages/crypto-android-keystore/` while LICENSING.md (added the same day)
 * had it. Both files claim to enumerate the same permissive set; nothing
 * enforced the claim. Same drift shape every gate in this directory guards:
 * canonical truth invisible, prose siblings drift independently. The same
 * pass also flipped 53 package.json `license` fields from `BSL-1.1` (not on
 * the SPDX list — npm warns, license-scan tools fail closed) to the canonical
 * `BUSL-1.1`; without a gate the next workspace package added would silently
 * drift back to `BSL-1.1` because that's what the rest of the codebase still
 * displays in unrelated prose.
 *
 * What this probe enforces:
 *
 *   1. Every workspace package.json declares `license: "Apache-2.0"` or
 *      `license: "BUSL-1.1"` (the two SPDX-canonical identifiers in motebit's
 *      dual-license model). `BSL-1.1`, missing, or any other value is drift.
 *   2. The set of permissive paths derived from package.json `license`
 *      fields (plus `spec/` and `packages/github-action/` — directories
 *      without a package.json that ship their own Apache-2.0 LICENSE)
 *      matches the path list in LICENSING.md's main table.
 *   3. The same set matches LICENSING.md's "Quick reference" inline list
 *      (compared by short name — `packages/X/` → `X`, `spec/` → `spec`).
 *   4. The same set matches CONTRIBUTING.md's permissive-floor parenthesized
 *      list under § "License".
 *   5. The same set matches CLA.md's permissive-floor inline list in § 6
 *      "Licensing of Contributions" — the legal artifact every contributor
 *      signs.
 *   6. The same set matches LICENSE's "Apache-2.0-Licensed Components"
 *      fixed-column block — the legal artifact itself, the canonical place
 *      a third party reads to know what is or isn't subject to BSL.
 *
 * Out of scope: the BSL section of LICENSING.md (the "What's in the runtime
 * layer" by-category enumeration) — that one is editorial grouping, not a
 * canonical 1:1 list, and forcing it to track package.json would over-fit
 * the gate to today's grouping. The gate above already catches every
 * permissive package; missing a package from the BSL prose grouping is a
 * weaker drift class.
 *
 * This is the fifty-second synchronization invariant defense.
 *
 * Usage:
 *   tsx scripts/check-license-doc-sync.ts        # exit 1 on drift
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const PERMISSIVE_SPDX = "Apache-2.0";
const RUNTIME_SPDX = "BUSL-1.1";

// Directories that ship Apache-2.0 via a standalone LICENSE file but have no
// package.json (so the workspace walk below won't find them). Each entry is
// the canonical path used in prose (with no trailing slash for the lookup;
// the comparator adds the slash where the prose form requires it).
const STANDALONE_PERMISSIVE: ReadonlyArray<string> = ["spec", "packages/github-action"];

// ── Step 1: derive canonical permissive set from package.json + standalones ──

interface WorkspacePkg {
  readonly name: string;
  readonly relPath: string; // e.g. "packages/protocol"
  readonly license: string | null;
}

function readJson(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function listSubdirs(parent: string): string[] {
  const dir = resolve(ROOT, parent);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => !entry.startsWith("."))
    .filter((entry) => {
      try {
        return statSync(resolve(dir, entry)).isDirectory();
      } catch {
        return false;
      }
    });
}

function collectWorkspacePackages(): WorkspacePkg[] {
  const out: WorkspacePkg[] = [];
  for (const parent of ["packages", "apps", "services"]) {
    for (const sub of listSubdirs(parent)) {
      const relPath = `${parent}/${sub}`;
      const pkgPath = resolve(ROOT, relPath, "package.json");
      if (!existsSync(pkgPath)) continue;
      const pkg = readJson(pkgPath);
      if (!pkg) continue;
      const name = typeof pkg.name === "string" ? pkg.name : relPath;
      const license = typeof pkg.license === "string" ? pkg.license : null;
      out.push({ name, relPath, license });
    }
  }
  // Root package.json is the only top-level workspace participant.
  const rootPkg = readJson(resolve(ROOT, "package.json"));
  if (rootPkg) {
    const license = typeof rootPkg.license === "string" ? rootPkg.license : null;
    out.push({ name: "(root)", relPath: ".", license });
  }
  return out;
}

function shortName(relPath: string): string {
  // packages/protocol → protocol; spec → spec
  const slash = relPath.lastIndexOf("/");
  return slash === -1 ? relPath : relPath.slice(slash + 1);
}

// ── Step 2: parse the three prose surfaces ──

function parseLicensingTable(text: string): Set<string> {
  // Lines in the main table look like:
  // | `spec/` | — | ... |
  // | `packages/protocol/` | `@motebit/protocol` | ... |
  // We capture column 1 path tokens and strip the trailing slash.
  const found = new Set<string>();
  // Match table rows whose first column is a backticked path with trailing slash.
  const rowRegex = /^\|\s*`([^`]+)\/`\s*\|/gm;
  for (const m of text.matchAll(rowRegex)) {
    const p = m[1] ?? "";
    if (!p) continue;
    found.add(p);
  }
  return found;
}

function parseLicensingQuickRef(text: string): Set<string> {
  // The block sits under "## Quick reference" inside a fenced code block.
  // First non-blank line begins with "Apache-2.0 (now, any use):" and the
  // package list continues until the next line that begins with a non-
  // whitespace label like "BSL-1.1" or "BSL → Apache-2.0".
  const blockStart = text.indexOf("## Quick reference");
  if (blockStart === -1) {
    throw new Error(
      "LICENSING.md: '## Quick reference' heading not found — gate's expected anchor is gone",
    );
  }
  const after = text.slice(blockStart);
  const apacheLineMatch = after.match(/Apache-2\.0 \(now, any use\):([\s\S]*?)\n[A-Za-z]/);
  if (!apacheLineMatch) {
    throw new Error(
      "LICENSING.md: '## Quick reference' fenced block did not match the expected " +
        "'Apache-2.0 (now, any use):' shape — gate's expected anchor drifted",
    );
  }
  // Strip the labels, split on '·', trim.
  const raw = apacheLineMatch[1] ?? "";
  const tokens = raw
    .replace(/\n/g, " ")
    .split("·")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return new Set(tokens);
}

function parseContributingPermissive(text: string): Set<string> {
  // The line under § License looks like:
  // - **Permissive floor** (`spec/`, `packages/protocol/`, `packages/sdk/`, ...) -- **Apache-2.0** ...
  const found = new Set<string>();
  const lineMatch = text.match(/\*\*Permissive floor\*\*\s*\(([^)]+)\)/);
  if (!lineMatch) {
    throw new Error(
      "CONTRIBUTING.md: '**Permissive floor** (...)' anchor not found — gate's expected anchor drifted",
    );
  }
  const inside = lineMatch[1] ?? "";
  // Each entry is `path/` between backticks.
  for (const m of inside.matchAll(/`([^`]+)\/`/g)) {
    const p = m[1] ?? "";
    if (p) found.add(p);
  }
  return found;
}

function parseClaPermissive(text: string): Set<string> {
  // The bullet under § 6 looks like:
  // - Contributions to the **permissive floor** — `spec/`, `packages/protocol/`, ..., and `packages/github-action/` — are licensed under...
  // We anchor on "**permissive floor**" then capture every backticked
  // path-with-trailing-slash up to the closing em-dash before "are licensed".
  const found = new Set<string>();
  const sectionMatch = text.match(/\*\*permissive floor\*\*\s*[—-]([\s\S]*?)[—-]\s*are licensed/);
  if (!sectionMatch) {
    throw new Error(
      "CLA.md: '**permissive floor** — ... — are licensed' anchor not found — gate's expected anchor drifted",
    );
  }
  const inside = sectionMatch[1] ?? "";
  for (const m of inside.matchAll(/`([^`]+)\/`/g)) {
    const p = m[1] ?? "";
    if (p) found.add(p);
  }
  return found;
}

function parseLicenseApacheBlock(text: string): Set<string> {
  // The block sits under "Apache-2.0-Licensed Components" header and ends
  // before the prose closing line ("These components may be used..."). Each
  // entry line is two-space-indented, then `path/` (with trailing slash),
  // then padded spaces, then a description.
  //   spec/                            Protocol specifications
  //   packages/protocol/               @motebit/protocol — network protocol types
  const headerIdx = text.indexOf("Apache-2.0-Licensed Components");
  if (headerIdx === -1) {
    throw new Error(
      "LICENSE: 'Apache-2.0-Licensed Components' header not found — gate's expected anchor drifted",
    );
  }
  const tailIdx = text.indexOf("These components may be used", headerIdx);
  if (tailIdx === -1) {
    throw new Error(
      "LICENSE: 'These components may be used' closing prose not found — gate's expected anchor drifted",
    );
  }
  const block = text.slice(headerIdx, tailIdx);
  const found = new Set<string>();
  // Each indented line: leading whitespace, then a path token ending in '/'.
  const rowRegex = /^\s+([\w/-]+)\/\s{2,}/gm;
  for (const m of block.matchAll(rowRegex)) {
    const p = m[1] ?? "";
    if (p) found.add(p);
  }
  return found;
}

// ── Step 3: compare and report ──

interface Drift {
  readonly kind: string;
  readonly detail: string;
}

function diff(label: string, expected: Set<string>, actual: Set<string>): Drift[] {
  const drifts: Drift[] = [];
  for (const p of expected) {
    if (!actual.has(p)) drifts.push({ kind: label, detail: `missing entry: ${p}` });
  }
  for (const p of actual) {
    if (!expected.has(p)) drifts.push({ kind: label, detail: `unexpected entry: ${p}` });
  }
  return drifts;
}

function main(): void {
  const pkgs = collectWorkspacePackages();
  const drifts: Drift[] = [];

  // 1. License-field validity.
  for (const pkg of pkgs) {
    if (pkg.license !== PERMISSIVE_SPDX && pkg.license !== RUNTIME_SPDX) {
      drifts.push({
        kind: "license-field",
        detail:
          `${pkg.relPath}/package.json (${pkg.name}): license="${pkg.license ?? "<missing>"}" — ` +
          `expected "${PERMISSIVE_SPDX}" or "${RUNTIME_SPDX}" (SPDX-canonical identifiers; "BSL-1.1" is not on the SPDX list and tooling treats it as unrecognized)`,
      });
    }
  }

  // 2. Canonical permissive path set (the source of truth for the prose checks).
  const canonical = new Set<string>(STANDALONE_PERMISSIVE);
  for (const pkg of pkgs) {
    if (pkg.license === PERMISSIVE_SPDX) canonical.add(pkg.relPath);
  }

  // 3. LICENSING.md table.
  const licensingPath = resolve(ROOT, "LICENSING.md");
  const licensing = readFileSync(licensingPath, "utf8");
  const tableSet = parseLicensingTable(licensing);
  drifts.push(...diff("LICENSING.md table", canonical, tableSet));

  // 4. LICENSING.md quick-reference (compare by short name).
  const canonicalShort = new Set([...canonical].map(shortName));
  const quickRefSet = parseLicensingQuickRef(licensing);
  drifts.push(...diff("LICENSING.md '## Quick reference'", canonicalShort, quickRefSet));

  // 5. CONTRIBUTING.md permissive-floor list.
  const contributing = readFileSync(resolve(ROOT, "CONTRIBUTING.md"), "utf8");
  const contributingSet = parseContributingPermissive(contributing);
  drifts.push(...diff("CONTRIBUTING.md '**Permissive floor**'", canonical, contributingSet));

  // 6. CLA.md § 6 permissive-floor list (legal: every contributor signs this).
  const cla = readFileSync(resolve(ROOT, "CLA.md"), "utf8");
  const claSet = parseClaPermissive(cla);
  drifts.push(...diff("CLA.md § 6 '**permissive floor**'", canonical, claSet));

  // 7. LICENSE Apache-2.0-Licensed Components fixed-column block (legal:
  // the canonical place a third party reads to know what is or isn't BSL).
  const license = readFileSync(resolve(ROOT, "LICENSE"), "utf8");
  const licenseSet = parseLicenseApacheBlock(license);
  drifts.push(...diff("LICENSE 'Apache-2.0-Licensed Components'", canonical, licenseSet));

  console.log(
    "▸ check-license-doc-sync — every workspace package.json must declare a SPDX-canonical license " +
      `("${PERMISSIVE_SPDX}" or "${RUNTIME_SPDX}"), and the permissive-floor membership must agree across ` +
      "LICENSING.md (table + quick reference), CONTRIBUTING.md, CLA.md, and LICENSE.",
  );

  if (drifts.length === 0) {
    console.log(
      `✓ check-license-doc-sync: ${pkgs.length} workspace package.json(s) and ` +
        `${canonical.size} permissive entr${canonical.size === 1 ? "y" : "ies"} ` +
        "agree across LICENSING.md (table + quick reference), CONTRIBUTING.md, CLA.md § 6, and LICENSE 'Apache-2.0-Licensed Components'.",
    );
    return;
  }

  process.stderr.write(`\n✗ check-license-doc-sync: ${drifts.length} drift(s) detected.\n\n`);
  const grouped = new Map<string, string[]>();
  for (const d of drifts) {
    const arr = grouped.get(d.kind) ?? [];
    arr.push(d.detail);
    grouped.set(d.kind, arr);
  }
  for (const [kind, details] of grouped) {
    process.stderr.write(`  ${kind}\n`);
    for (const detail of details) process.stderr.write(`    ${detail}\n`);
    process.stderr.write("\n");
  }
  process.stderr.write(
    "Fix: align the drifted surface with the canonical license-field-derived set.\n" +
      "If a package's license changed deliberately, update the prose surfaces in the same pass.\n",
  );
  process.exit(1);
}

main();
