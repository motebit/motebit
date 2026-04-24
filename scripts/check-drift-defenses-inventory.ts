/**
 * Meta-drift defense: the drift-defense inventory itself stays in sync
 * with the gates that enforce it.
 *
 * `docs/drift-defenses.md` is the canonical inventory of every
 * synchronization invariant in the repo. When a new gate lands, its
 * entry in `scripts/check.ts` GATES array should be paired with an
 * inventory row in that document — otherwise the defense exists in
 * code but is invisible in doctrine. Operators reading the inventory
 * would conclude the invariant doesn't exist; a future reviewer who
 * weakens or removes the gate has no doctrinal signal that it matters.
 *
 * This is the exact shape the drift-defense system was built to catch,
 * applied recursively. Sibling to #25 `check-claude-md` (which enforces
 * doctrine-index integrity for per-directory CLAUDE.md files) — one
 * layer up: doctrine-index integrity for the drift-defense system
 * itself.
 *
 * Rule: every entry in `scripts/check.ts` GATES must be represented in
 * the inventory table in `docs/drift-defenses.md`. The inventory may
 * additionally list defenses not in GATES (build-time `satisfies`
 * checks, test-enforced assertions, advisory-only gates like
 * `check-sibling-boundaries`) — those are legitimate entries, not
 * violations. The gate only fires when a hard-CI gate has NO
 * inventory row.
 *
 * Matching is by script name appearing anywhere in the Defense column
 * of the inventory table, so a gate that's one of several rules inside
 * a shared defense (e.g. `check-deploy-parity` rule 4) counts as
 * represented as long as the script name is named in at least one row.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── Parse GATES from scripts/check.ts ────────────────────────────────────
// The GATES array is the authoritative list of hard CI gates. Each entry
// has a `script:` field naming the npm script (= the check-* name). The
// inventory must represent every one of these.
function gatesInCheckTs(): Set<string> {
  const src = readFileSync(resolve(ROOT, "scripts/check.ts"), "utf-8");
  const names = new Set<string>();
  const re = /script:\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    names.add(m[1]);
  }
  return names;
}

// ── Resolve npm script aliases ───────────────────────────────────────────
// A GATES entry names an npm script (`check-specs`) whose definition in
// root package.json points to an underlying script file
// (`scripts/check-spec-references.ts`). The inventory may reference
// either the alias OR the file's basename — both are legitimate ways
// to name the gate. This function returns the set of acceptable names
// for a given GATES entry.
function aliasesFor(gateName: string, pkgScripts: Record<string, string>): Set<string> {
  const aliases = new Set<string>([gateName]);
  const script = pkgScripts[gateName];
  if (!script) return aliases;
  // Match `npx tsx scripts/<file>.ts` and add the basename (without .ts).
  const m = script.match(/scripts\/([a-z0-9-]+)\.ts/);
  if (m) aliases.add(m[1]);
  return aliases;
}

function readPackageScripts(): Record<string, string> {
  const pkgPath = resolve(ROOT, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
    scripts?: Record<string, string>;
  };
  return pkg.scripts ?? {};
}

// ── Parse inventory Defense column ───────────────────────────────────────
// The inventory table rows have the shape:
//
//   | N   | Invariant text … | `check-<name>.ts` … | date |
//
// A defense is represented if its check-* name appears anywhere inside a
// table row (handles rules that span a shared gate like deploy-parity).
// Also handles alternate defense forms:
//   - `check-<name>.ts`
//   - `yaml-config.test.ts` (test-enforced)
//   - `@motebit/wire-schemas` 3-way pin
// Only check-* mentions are relevant for this gate's purpose; the other
// forms legitimately exist for build-time/test-enforced invariants.
function invariantDefenses(): { scripts: Set<string>; rowCount: number } {
  const src = readFileSync(resolve(ROOT, "docs/drift-defenses.md"), "utf-8");
  const scripts = new Set<string>();
  let rowCount = 0;

  for (const line of src.split("\n")) {
    // Table rows start with `| ` followed by a digit. The header row
    // `| # | Invariant | Defense | Landed |` starts with `| #   |` —
    // the #-prefix column is a literal `#` not a digit, so it's excluded
    // by the digit test.
    if (!/^\|\s+\d+\s+\|/.test(line)) continue;
    rowCount++;

    // Extract every `check-<name>` mention from the row (handles both
    // `check-foo.ts` and bare `check-foo` — both are accepted).
    const checkRe = /check-[a-z0-9-]+/g;
    let m: RegExpExecArray | null;
    while ((m = checkRe.exec(line)) !== null) {
      scripts.add(m[0]);
    }
  }

  return { scripts, rowCount };
}

// ── Main ─────────────────────────────────────────────────────────────────

function main(): void {
  const gates = gatesInCheckTs();
  const { scripts: inventoryScripts, rowCount } = invariantDefenses();
  const pkgScripts = readPackageScripts();

  // A gate is represented if ANY of its aliases (npm name, script file
  // basename) appears in the inventory.
  const missing = [...gates]
    .filter((g) => {
      const aliases = aliasesFor(g, pkgScripts);
      for (const name of aliases) {
        if (inventoryScripts.has(name)) return false;
      }
      return true;
    })
    .sort();

  if (missing.length === 0) {
    console.log(
      `Drift-defense inventory check passed — all ${gates.size} gates in scripts/check.ts GATES are represented across ${rowCount} inventory rows in docs/drift-defenses.md.`,
    );
    return;
  }

  console.error(`Drift-defense inventory violations (${missing.length}):\n`);
  console.error(
    `  Gates registered in scripts/check.ts GATES but missing from the inventory table in docs/drift-defenses.md:\n`,
  );
  for (const name of missing) {
    console.error(`    - ${name}`);
  }
  console.error(
    `\nDoctrine: docs/drift-defenses.md is the canonical inventory of every synchronization invariant.`,
  );
  console.error(
    `Fix: add an inventory row for each missing gate, matching the shape \`| N | <invariant> | \\\`check-<name>.ts\\\` | YYYY-MM-DD |\`.`,
  );
  console.error(
    `An incident history entry is optional for pre-existing gates; required for new ones.`,
  );
  process.exit(1);
}

main();
