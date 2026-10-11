#!/usr/bin/env tsx
/**
 * check-identity-authority-inventory — the committed identity-authority census
 * is fresh (docs/design/identity-authority-writers.md §4 item 5, Inc 0).
 *
 * The census (`docs/design/identity-authority-inventory.generated.md`) lists
 * every writer of identity-keyed state, which columns it assigns, and the
 * weakest door that reaches it. A new authority writer must show up as a diff
 * in review — before the static gate (`check-identity-authority-writers`)
 * names it, and whether or not it ever does. A census that silently lags the
 * code is the one way that diff never appears, so a stale census fails here.
 *
 * Aperture: the census script's SCAN_ROOTS (printed on success). Anything the
 * census cannot see (its header lists the limits) is invisible to this gate
 * too — the gate proves freshness, never completeness.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { failWithRepair, type RepairReport } from "./lib/gate-report.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The lines that differ between the committed census and a fresh render,
 * as committed/fresh line pairs, capped. Pure, so the stale verdict is
 * testable without the scan.
 */
export function censusDrift(committed: string, fresh: string, cap = 12): string[] {
  if (committed === fresh) return [];
  const a = committed.split("\n");
  const b = fresh.split("\n");
  const out: string[] = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n && out.length < cap; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] !== undefined)
      out.push(`line ${i + 1} committed: ${a[i]!.replace(/\s{2,}/g, " ").slice(0, 200)}`);
    if (b[i] !== undefined && out.length < cap)
      out.push(`line ${i + 1} fresh:     ${b[i]!.replace(/\s{2,}/g, " ").slice(0, 200)}`);
  }
  if (out.length === 0) out.push("(trailing whitespace / line-count difference only)");
  return out;
}

/** The failure block for a stale census — pure, so its repair contract is testable. */
export function staleReport(out: string, drift: string[], aperture: string): RepairReport {
  return {
    invariant: `the committed identity-authority census is stale — ${out} no longer matches the code it describes (${aperture})`,
    canonical: "scripts/inventory-identity-authority.ts",
    fix: `run \`npx tsx scripts/inventory-identity-authority.ts\` and commit ${out}. Review the diff: a new or changed row under "Authority writers" is a new door onto identity authority and must be justified against docs/design/identity-authority-writers.md (I1/I2) before merge.`,
    sites: drift,
    doctrine: "docs/design/identity-authority-writers.md §4 item 5",
  };
}

/**
 * The `table.column` pairs `AUTHORITY_COLUMNS` declares in the relay's single
 * writer (identity-authority.ts), read from the source text — the object
 * literal's keys and string-array values. Pure, so the comparison is testable.
 */
export function declaredAuthorityColumns(src: string): string[] {
  const start = src.indexOf("export const AUTHORITY_COLUMNS");
  if (start < 0) return [];
  const open = src.indexOf("= {", start);
  let depth = 0;
  let end = open + 2;
  for (; end < src.length; end++) {
    if (src[end] === "{") depth++;
    else if (src[end] === "}" && --depth === 0) break;
  }
  const body = src.slice(open + 3, end);
  const out: string[] = [];
  for (const m of body.matchAll(/(\w+):\s*\[([^\]]*)\]/g)) {
    for (const col of m[2]!.matchAll(/"(\w+)"/g)) out.push(`${m[1]}.${col[1]}`);
  }
  return out.sort();
}

/** Columns the census calls authority-bearing that the guard does not declare, and vice versa. */
export function guardCoverageDrift(census: string[], declared: string[]): string[] {
  const d = new Set(declared);
  const c = new Set(census);
  return [
    ...census
      .filter((f) => !d.has(f))
      .map(
        (f) => `UNGUARDED: ${f} is authority-bearing in the census but not in AUTHORITY_COLUMNS`,
      ),
    ...declared
      .filter((f) => !c.has(f))
      .map((f) => `STALE: ${f} is in AUTHORITY_COLUMNS but not authority-bearing in the census`),
  ];
}

/** The failure block for a guard that does not cover the census's columns. */
export function coverageReport(drift: string[]): RepairReport {
  return {
    invariant: `the identity-authority shadow guard covers exactly the census's authority-bearing columns (D5: the full list, never a hand-picked subset) — ${drift.length} difference(s)`,
    canonical: "services/relay/src/identity-authority.ts (AUTHORITY_COLUMNS)",
    fix: 'make AUTHORITY_COLUMNS equal the census\'s "Authority-bearing fields" (relay/persistence schema rows): add every UNGUARDED column, remove every STALE one. A column the census newly calls authority-bearing is guarded the moment it is declared — installAuthorityGuards installs its triggers and throws at boot if the column does not exist.',
    sites: drift,
    doctrine: "docs/design/identity-authority-writers.md §4 item 1 (Inc 2), decision D5",
  };
}

const SINGLE_WRITER_FILE = "services/relay/src/identity-authority.ts";

async function main(): Promise<void> {
  // Importing the census runs the scan (≈5 s); its main() is guarded.
  const { renderCensus, censusAperture, CENSUS_OUT, authoritySchemaFields } =
    await import("./inventory-identity-authority.js");
  const fresh = await renderCensus();
  const path = resolve(ROOT, CENSUS_OUT);
  const committed = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const drift = censusDrift(committed, fresh);
  if (drift.length > 0) {
    failWithRepair(staleReport(CENSUS_OUT, drift, censusAperture()));
  }
  const census = authoritySchemaFields();
  const declared = declaredAuthorityColumns(
    readFileSync(resolve(ROOT, SINGLE_WRITER_FILE), "utf-8"),
  );
  const coverage = guardCoverageDrift(census, declared);
  if (coverage.length > 0) failWithRepair(coverageReport(coverage));
  console.log(`✓ check-identity-authority-inventory — census fresh: ${censusAperture()}`);
  console.log(
    `  Shadow guard: AUTHORITY_COLUMNS (${SINGLE_WRITER_FILE}) declares exactly the census's ${census.length} authority-bearing schema column(s).`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
