#!/usr/bin/env tsx
/**
 * check-spec-impl-coverage — every Stable protocol spec has a declared
 * implementing package (invariant #31).
 *
 * ## Why this gate exists
 *
 * Motebit's thesis rests on the claim "any third party can stand up a
 * competing implementation using only the published specs and the
 * permissive-floor type packages." Three gates already guard pieces of
 * that claim:
 *
 *   - #9  `check-spec-coverage`               — Wire format types ↔ @motebit/protocol
 *   - #14 `check-spec-permissive-boundary`    — Spec callables ↔ permissive-floor exports
 *   - #23 `check-spec-wire-schemas`           — Spec wire types ↔ zod schemas
 *
 * All three verify the TYPE surface of each spec. None verifies that
 * *runtime behavior* for the spec is actually implemented anywhere in
 * this repo. A new spec can land, ship with all its Wire format types,
 * and never actually get implemented — silently. Consumers looking at
 * the repo have no machine-readable way to answer "which package
 * implements settlement-v1?" beyond grep.
 *
 * This gate closes that gap by requiring each Stable spec to name its
 * implementing package(s) in a machine-readable declaration, and
 * verifying the declaration bidirectionally.
 *
 * ## Declaration shape
 *
 * Each implementing package's `package.json` may carry a `motebit.implements`
 * array pointing to spec files (repo-relative, e.g. "spec/settlement-v1.md"):
 *
 *   {
 *     "name": "@motebit/market",
 *     "motebit": {
 *       "implements": ["spec/market-v1.md"]
 *     }
 *   }
 *
 * Multiple packages may implement the same spec (e.g. `@motebit/crypto`
 * and `@motebit/identity-file` both implement `identity-v1`). A single
 * package may implement multiple specs.
 *
 * ## Enforcement
 *
 *   1. Every entry in a `motebit.implements` array must resolve to an
 *      existing spec file under `spec/`.
 *   2. Every spec file with `**Status:** Stable` must be named by at
 *      least one package's `motebit.implements` array.
 *   3. Draft specs are exempt — declaration is allowed but not required.
 *
 * Exit 1 on violation. Runs in CI via `pnpm check`.
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SPEC_DIR = join(ROOT, "spec");

interface Violation {
  kind: "dangling-impl" | "uncovered-spec";
  detail: string;
}

interface PackageImplements {
  pkgJsonPath: string;
  pkgName: string;
  implementsList: string[];
}

function readJSON(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function collectPackageJsons(): string[] {
  const out: string[] = [];
  const roots = [join(ROOT, "packages"), join(ROOT, "services")];
  for (const root of roots) {
    let subdirs: string[];
    try {
      subdirs = readdirSync(root);
    } catch {
      continue;
    }
    for (const sub of subdirs) {
      const pkgJson = join(root, sub, "package.json");
      if (existsSync(pkgJson) && statSync(pkgJson).isFile()) {
        out.push(pkgJson);
      }
    }
  }
  return out;
}

function extractImplements(pkgJsonPath: string): PackageImplements | null {
  let parsed: unknown;
  try {
    parsed = readJSON(pkgJsonPath);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const name = typeof obj.name === "string" ? obj.name : "<unnamed>";
  const motebit = obj.motebit;
  if (typeof motebit !== "object" || motebit === null) return null;
  const list = (motebit as Record<string, unknown>).implements;
  if (!Array.isArray(list)) return null;
  const stringEntries = list.filter((e): e is string => typeof e === "string");
  return { pkgJsonPath, pkgName: name, implementsList: stringEntries };
}

function listStableSpecs(): string[] {
  const files: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(SPEC_DIR);
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const full = join(SPEC_DIR, entry);
    const body = readFileSync(full, "utf8");
    // The first occurrence of `**Status:**` in the spec frontmatter.
    const m = body.match(/\*\*Status:\*\*\s*(\w+)/i);
    if (m && m[1]?.toLowerCase() === "stable") {
      files.push(`spec/${entry}`);
    }
  }
  return files.sort();
}

function scan(): { violations: Violation[]; summary: string } {
  const violations: Violation[] = [];

  // Collect every declared spec→pkg mapping.
  const declarations: PackageImplements[] = [];
  for (const pkgJsonPath of collectPackageJsons()) {
    const d = extractImplements(pkgJsonPath);
    if (d && d.implementsList.length > 0) declarations.push(d);
  }

  // 1. Each declared spec-ref must resolve to an existing spec file.
  const declaredSpecs = new Set<string>();
  for (const d of declarations) {
    for (const specRef of d.implementsList) {
      const abs = resolve(ROOT, specRef);
      if (!existsSync(abs) || !specRef.startsWith("spec/")) {
        violations.push({
          kind: "dangling-impl",
          detail: `${relative(ROOT, d.pkgJsonPath)}: motebit.implements entry "${specRef}" does not resolve to a repo-relative file under spec/`,
        });
      } else {
        declaredSpecs.add(specRef);
      }
    }
  }

  // 2. Every Stable spec must have ≥1 declarer.
  const stable = listStableSpecs();
  for (const s of stable) {
    if (!declaredSpecs.has(s)) {
      violations.push({
        kind: "uncovered-spec",
        detail: `${s} is Stable but has no implementing package. Add \`"motebit": { "implements": ["${s}"] }\` to the authoritative package.json.`,
      });
    }
  }

  const summary = `${stable.length} stable spec(s); ${declaredSpecs.size} covered by at least one package; ${declarations.length} package(s) declare implementation`;
  return { violations, summary };
}

function main(): void {
  console.log(
    "▸ check-spec-impl-coverage — every Stable spec has ≥1 implementing package declared via `motebit.implements` (invariant #31, added 2026-04-19 to extend the type-surface guarantees of #9/#14/#23 to runtime-behavior ownership; without it a new spec could land and never be implemented, and consumers had no machine-readable way to map settlement-v1.md → packages/settlement-rails beyond grep)",
  );
  const { violations, summary } = scan();
  console.log(`  ${summary}`);
  if (violations.length === 0) {
    console.log(`✓ check-spec-impl-coverage: every Stable spec has a declared implementer.`);
    process.exit(0);
  }

  console.error(`✗ check-spec-impl-coverage: ${violations.length} violation(s):\n`);
  const dangling = violations.filter((v) => v.kind === "dangling-impl");
  const uncovered = violations.filter((v) => v.kind === "uncovered-spec");
  if (dangling.length > 0) {
    console.error(`  Dangling declarations (${dangling.length}):`);
    for (const v of dangling) console.error(`    ${v.detail}`);
  }
  if (uncovered.length > 0) {
    console.error(`  Uncovered Stable specs (${uncovered.length}):`);
    for (const v of uncovered) console.error(`    ${v.detail}`);
  }
  console.error(
    '\nFix: add a `motebit.implements` array to the authoritative package.json listing repo-relative spec paths (e.g. "spec/market-v1.md"). Drafts are exempt. If a Stable spec has genuinely no in-repo implementer (consumer-only spec), flip it to Draft or add a Change Log note explaining the gap.',
  );
  process.exit(1);
}

main();
