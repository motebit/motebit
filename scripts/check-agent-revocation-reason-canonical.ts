#!/usr/bin/env tsx
/**
 * `check-agent-revocation-reason-canonical` — registry-coverage gate for
 * the `AgentRevocationReason` closed registry.
 *
 * Closed-registry / structural-lock pattern — same shape as
 * `check-suite-declared` (#10), `check-audience-canonical` (#46),
 * `check-artifact-type-canonical` (#85),
 * `check-routing-decision-coverage` (#95),
 * `check-sensitivity-canonical` (#97), `check-event-type-canonical` (#99),
 * `check-settlement-mode-canonical`, `check-merkle-tree-hash-canonical`.
 *
 *   1. `AgentRevocationReason` (the union type in
 *      `packages/protocol/src/agent-revocation.ts`) is the closed
 *      vocabulary of *why* an operator de-listed (or reinstated) an
 *      agent. Every signed `AgentRevocationRecord` carries
 *      `reason: AgentRevocationReason`; the public revocations feed is
 *      verified by third parties, so cross-implementation drift on the
 *      reason vocabulary would break feed consumers.
 *
 *   2. The single-file source-of-truth (the union in
 *      `agent-revocation.ts`) is mirrored both by the
 *      `ALL_AGENT_REVOCATION_REASONS` frozen array AND by this gate's
 *      `AGENT_REVOCATION_REASONS_REFERENCE`. A drift between any pair
 *      fails the gate.
 *
 *   3. Wire-format compliance: every value MUST be a snake_case
 *      identifier (`^[a-z][a-z0-9]*(_[a-z0-9]+)*$`). Wire-format
 *      vocabularies cross process boundaries; mixed-case or hyphenated
 *      values would inconsistently round-trip JSON serializers.
 *
 * The meta-gate `check-closed-registry-canonical` enforces the structural
 * perimeter (the eight-artifact set); this gate enforces the registry's
 * specific consumer surface.
 *
 * Doctrine: `docs/doctrine/registry-pattern-canonical.md` (ninth
 * registered registry), `docs/doctrine/agents-as-first-person-trust-graph.md`.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/**
 * The canonical set, mirrored from
 * `packages/protocol/src/agent-revocation.ts:ALL_AGENT_REVOCATION_REASONS`.
 * The sibling-alignment block reads the protocol source and asserts the
 * three lists agree exactly.
 */
const AGENT_REVOCATION_REASONS_REFERENCE = [
  "operator_test_cleanup",
  "spam",
  "abuse",
  "malware",
  "policy_violation",
  "dmca",
  "reinstated",
] as const;

const SNAKE_CASE_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

function readFile(path: string): string | null {
  try {
    return readFileSync(resolve(ROOT, path), "utf8");
  } catch {
    return null;
  }
}

/** Extract string-values from the `AgentRevocationReason` union declaration. */
function readUnionValues(source: string): string[] {
  const unionMatch = source.match(/export type AgentRevocationReason\s*=([^;]+);/);
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

/** Extract string-values from the `ALL_AGENT_REVOCATION_REASONS` frozen array. */
function readArrayValues(source: string): string[] {
  const arrayMatch = source.match(
    /ALL_AGENT_REVOCATION_REASONS[^=]*=\s*Object\.freeze\(\[([\s\S]*?)\]/,
  );
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
  // === Sibling-alignment: three-way lock ==========================
  //   union × ALL_AGENT_REVOCATION_REASONS × gate reference
  const source = readFile("packages/protocol/src/agent-revocation.ts");
  if (source === null) {
    console.error(
      "check-agent-revocation-reason-canonical: could not read packages/protocol/src/agent-revocation.ts.",
    );
    process.exit(1);
  }

  const unionValues = readUnionValues(source);
  const arrayValues = readArrayValues(source);
  const gateValues = [...AGENT_REVOCATION_REASONS_REFERENCE];

  if (unionValues.length === 0) {
    console.error(
      "check-agent-revocation-reason-canonical: could not parse AgentRevocationReason union values.",
    );
    process.exit(1);
  }
  if (arrayValues.length === 0) {
    console.error(
      "check-agent-revocation-reason-canonical: could not parse ALL_AGENT_REVOCATION_REASONS array values.",
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
      "check-agent-revocation-reason-canonical: sibling-alignment failure across AgentRevocationReason × ALL_AGENT_REVOCATION_REASONS × gate reference.",
    );
    if (unionOnly.length > 0) {
      console.error(`  In union but not all three: ${unionOnly.map((v) => `"${v}"`).join(", ")}`);
    }
    if (arrayOnly.length > 0) {
      console.error(`  In array but not all three: ${arrayOnly.map((v) => `"${v}"`).join(", ")}`);
    }
    if (gateOnly.length > 0) {
      console.error(`  In gate but not all three: ${gateOnly.map((v) => `"${v}"`).join(", ")}`);
    }
    console.error("");
    console.error(
      "The three-way lock requires the union × ALL_AGENT_REVOCATION_REASONS × gate reference to agree exactly.",
    );
    console.error(
      "Adding a revocation reason is intentional protocol-level work — update all three in the same commit.",
    );
    console.error("Doctrine: docs/doctrine/registry-pattern-canonical.md.");
    process.exit(1);
  }

  // === Wire-format compliance: snake_case identifier for every value ===
  const malformed = AGENT_REVOCATION_REASONS_REFERENCE.filter((v) => !SNAKE_CASE_PATTERN.test(v));
  if (malformed.length > 0) {
    console.error(
      `check-agent-revocation-reason-canonical: ${malformed.length} value(s) violate wire-format convention:`,
    );
    for (const v of malformed) {
      console.error(`  - "${v}" — expected snake_case identifier ([a-z][a-z0-9]*(_[a-z0-9]+)*)`);
    }
    process.exit(1);
  }

  console.log(
    `✓ check-agent-revocation-reason-canonical: ${AGENT_REVOCATION_REASONS_REFERENCE.length} revocation reason(s) locked across union + ALL_AGENT_REVOCATION_REASONS + gate reference; all wire-format-compliant.`,
  );
}

main();
