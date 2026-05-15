#!/usr/bin/env tsx
/**
 * `check-settlement-mode-canonical` — registry-coverage gate for the
 * `SettlementMode` closed registry.
 *
 * Closed-registry / structural-lock pattern — same shape as
 * `check-suite-declared` (#10), `check-audience-canonical` (#46),
 * `check-artifact-type-canonical` (#85),
 * `check-routing-decision-coverage` (#95),
 * `check-panel-registry-coverage` (#96),
 * `check-sensitivity-canonical` (#97),
 * `check-event-type-canonical` (#99).
 *
 *   1. `SettlementMode` (the union type in
 *      `packages/protocol/src/settlement-mode.ts`) is the closed
 *      vocabulary of money-movement modes for a task — through the
 *      relay's virtual accounts, or directly onchain. Every
 *      `SettlementEligibility` carries `mode: SettlementMode`; agent
 *      discovery declares `settlement_modes?: string[]`; relays
 *      dispatch on it. Cross-implementation drift would break
 *      interop — a peer offering a mode the counterpart doesn't
 *      understand stalls settlement.
 *
 *   2. The single-file source-of-truth (the union in
 *      `settlement-mode.ts`) is mirrored both by the
 *      `ALL_SETTLEMENT_MODES` frozen array AND by this gate's
 *      `SETTLEMENT_MODES_REFERENCE`. A drift between any pair fails
 *      the gate.
 *
 *   3. Wire-format compliance: every value MUST be lowercase
 *      identifier-shaped (`^[a-z][a-z0-9]*$`). Wire-format
 *      vocabularies cross process boundaries; mixed-case or
 *      hyphenated values would inconsistently round-trip JSON
 *      serializers across implementations.
 *
 * **What the meta-gate guarantees this gate is alongside.** Per
 * `docs/doctrine/registry-pattern-canonical.md`, the eight-artifact
 * set requires (1) closed type, (2) `ALL_X`, (3) `isX`, (4) tests,
 * (5) THIS gate, (6) gate registration in `scripts/check.ts`,
 * (7) perturbation probe, (8) inventory entry. The meta-gate
 * `check-closed-registry-canonical` enforces the structural
 * perimeter; this gate enforces the registry's specific consumer
 * surface.
 *
 * Doctrine: `docs/doctrine/registry-pattern-canonical.md` (seventh
 * registered registry).
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/**
 * The canonical set, mirrored from
 * `packages/protocol/src/settlement-mode.ts:ALL_SETTLEMENT_MODES`.
 * Re-deriving at gate runtime would be a circular dependency on the
 * file the gate exists to defend; instead the sibling-alignment block
 * below reads the protocol source and asserts the three lists agree
 * exactly.
 */
const SETTLEMENT_MODES_REFERENCE = ["relay", "p2p"] as const;

const LOWERCASE_IDENT_PATTERN = /^[a-z][a-z0-9]*$/;

function readFile(path: string): string | null {
  try {
    return readFileSync(resolve(ROOT, path), "utf8");
  } catch {
    return null;
  }
}

/**
 * Extract string-values from the `SettlementMode` union declaration.
 * Pattern: `export type SettlementMode = "<value>" | "<value>"...`.
 */
function readUnionValues(source: string): string[] {
  const unionMatch = source.match(/export type SettlementMode\s*=([^;]+);/);
  if (unionMatch === null) return [];
  const body = unionMatch[1] ?? "";
  const values: string[] = [];
  const valuePattern = /"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = valuePattern.exec(body)) !== null) {
    values.push(m[1] as string);
  }
  return values;
}

/**
 * Extract string-values from the `ALL_SETTLEMENT_MODES` frozen array
 * in the same file. Pattern: quoted strings inside the
 * `Object.freeze([…])` call body.
 */
function readArrayValues(source: string): string[] {
  const arrayMatch = source.match(/ALL_SETTLEMENT_MODES[^=]*=\s*Object\.freeze\(\[([\s\S]*?)\]/);
  if (arrayMatch === null) return [];
  const body = arrayMatch[1] ?? "";
  const values: string[] = [];
  const valuePattern = /"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = valuePattern.exec(body)) !== null) {
    values.push(m[1] as string);
  }
  return values;
}

function main(): void {
  // === Sibling-alignment: three-way lock =========================
  //
  //   union (settlement-mode.ts) × ALL_SETTLEMENT_MODES × gate's
  //   SETTLEMENT_MODES_REFERENCE
  //
  // All three must agree exactly on the closed set.

  const source = readFile("packages/protocol/src/settlement-mode.ts");
  if (source === null) {
    console.error(
      "check-settlement-mode-canonical: could not read packages/protocol/src/settlement-mode.ts.",
    );
    console.error("The SettlementMode registry surface is missing; this gate cannot validate.");
    process.exit(1);
  }

  const unionValues = readUnionValues(source);
  const arrayValues = readArrayValues(source);
  const gateValues = [...SETTLEMENT_MODES_REFERENCE];

  if (unionValues.length === 0) {
    console.error("check-settlement-mode-canonical: could not parse SettlementMode union values.");
    process.exit(1);
  }
  if (arrayValues.length === 0) {
    console.error(
      "check-settlement-mode-canonical: could not parse ALL_SETTLEMENT_MODES array values.",
    );
    process.exit(1);
  }

  const unionSet = new Set(unionValues);
  const arraySet = new Set(arrayValues);
  const gateSet = new Set(gateValues);

  const unionOnly = [...unionSet].filter((v) => !arraySet.has(v) || !gateSet.has(v));
  const arrayOnly = [...arraySet].filter((v) => !unionSet.has(v) || !gateSet.has(v));
  const gateOnly = [...gateSet].filter((v) => !unionSet.has(v) || !arraySet.has(v));

  if (unionOnly.length > 0 || arrayOnly.length > 0 || gateOnly.length > 0) {
    console.error(
      "check-settlement-mode-canonical: sibling-alignment failure across SettlementMode × ALL_SETTLEMENT_MODES × gate reference.",
    );
    if (unionOnly.length > 0) {
      console.error(`  In union but not all three: ${unionOnly.map((v) => `"${v}"`).join(", ")}`);
      console.error(
        "  → Update `ALL_SETTLEMENT_MODES` in settlement-mode.ts AND `SETTLEMENT_MODES_REFERENCE` in this gate.",
      );
    }
    if (arrayOnly.length > 0) {
      console.error(
        `  In ALL_SETTLEMENT_MODES but not all three: ${arrayOnly.map((v) => `"${v}"`).join(", ")}`,
      );
      console.error(
        "  → Update the `SettlementMode` union in settlement-mode.ts AND `SETTLEMENT_MODES_REFERENCE` in this gate.",
      );
    }
    if (gateOnly.length > 0) {
      console.error(`  In gate but not all three: ${gateOnly.map((v) => `"${v}"`).join(", ")}`);
      console.error(
        "  → Update the `SettlementMode` union AND `ALL_SETTLEMENT_MODES` in settlement-mode.ts.",
      );
    }
    console.error("");
    console.error(
      "The three-way lock requires `SettlementMode` (union) × `ALL_SETTLEMENT_MODES` (array) × `SETTLEMENT_MODES_REFERENCE` (gate) to agree exactly.",
    );
    console.error(
      "Adding a settlement mode is intentional protocol-level work — update all three in the same commit.",
    );
    console.error("Doctrine: docs/doctrine/registry-pattern-canonical.md.");
    process.exit(1);
  }

  // === Wire-format compliance: lowercase ident for every value ===
  const malformed: string[] = [];
  for (const v of SETTLEMENT_MODES_REFERENCE) {
    if (!LOWERCASE_IDENT_PATTERN.test(v)) {
      malformed.push(v);
    }
  }

  if (malformed.length > 0) {
    console.error(
      `check-settlement-mode-canonical: ${malformed.length} value(s) violate wire-format convention:`,
    );
    for (const v of malformed) {
      console.error(`  - "${v}" — expected lowercase identifier ([a-z][a-z0-9]*)`);
    }
    console.error(
      "Wire-format vocabularies must be lowercase identifiers so JSON serializers round-trip identically across implementations.",
    );
    process.exit(1);
  }

  console.log(
    `✓ check-settlement-mode-canonical: ${SETTLEMENT_MODES_REFERENCE.length} settlement mode(s) locked across union + ALL_SETTLEMENT_MODES + gate reference; all wire-format-compliant.`,
  );
}

main();
