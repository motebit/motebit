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

async function main(): Promise<void> {
  // Importing the census runs the scan (≈5 s); its main() is guarded.
  const { renderCensus, censusAperture, CENSUS_OUT } =
    await import("./inventory-identity-authority.js");
  const fresh = await renderCensus();
  const path = resolve(ROOT, CENSUS_OUT);
  const committed = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const drift = censusDrift(committed, fresh);
  if (drift.length > 0) {
    failWithRepair(staleReport(CENSUS_OUT, drift, censusAperture()));
  }
  console.log(`✓ check-identity-authority-inventory — census fresh: ${censusAperture()}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
