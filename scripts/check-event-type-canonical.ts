#!/usr/bin/env tsx
/**
 * `check-event-type-canonical` — registry-coverage gate for the
 * `EventType` closed registry.
 *
 * Closed-registry / structural-lock pattern — same shape as
 * `check-suite-declared` (#10), `check-audience-canonical` (#46),
 * `check-artifact-type-canonical` (#85),
 * `check-routing-decision-coverage` (#95),
 * `check-panel-registry-coverage` (#96),
 * `check-sensitivity-canonical` (#97).
 *
 *   1. `EventType` (the enum in `packages/protocol/src/index.ts`)
 *      is the typed source of truth for motebit's event-log
 *      vocabulary — every `EventLogEntry` carries an `event_type`
 *      field; sync peers, federation participants, audit verifiers,
 *      and consolidation cycles dispatch on it.
 *
 *   2. Three sibling artifacts MUST stay in lockstep:
 *      - `EventType` enum in `packages/protocol/src/index.ts`
 *      - `ALL_EVENT_TYPES` in `packages/protocol/src/event-type.ts`
 *      - This gate's `EVENT_TYPES_REFERENCE` mirror
 *      A drift between any pair fails the gate.
 *
 *   3. Wire-format compliance: every value MUST be snake_case
 *      identifier-shaped (`^[a-z][a-z0-9]*(_[a-z0-9]+)*$`). Wire-
 *      format vocabularies cross process boundaries; mixed-case or
 *      hyphenated values would inconsistently round-trip JSON
 *      serializers across implementations.
 *
 * **Note on per-consumer literal scan.** Unlike
 * `check-audience-canonical` (which scans every `aud: "<literal>"`
 * site for typos because audience values appear as raw strings at
 * signing sites), `EventType` is consumed predominantly via
 * `EventType.X` enum-member access — TypeScript catches typos at
 * compile time. The gate's value-add over TS enforcement is the
 * three-way sibling lock + wire-format compliance: a registry rotation
 * that adds an enum entry without updating `ALL_EVENT_TYPES` would
 * pass `tsc` but break the iteration-array contract every consumer
 * downstream relies on. The textual scan for raw-string typos is
 * not added because the `event_type` field name is overloaded
 * (e.g. `packages/policy/src/audit.ts` uses `event_type: "tool_call"`
 * for the audit-chain's separate discriminator), so a broad scan
 * would generate false positives. If a real EventType typo incident
 * surfaces in raw-string-shaped consumer code, extend this gate
 * with a scope-limited literal scan at that time.
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
 * Doctrine: `docs/doctrine/registry-pattern-canonical.md` (sixth
 * registered registry).
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/**
 * The canonical set, mirrored from
 * `packages/protocol/src/event-type.ts:ALL_EVENT_TYPES`. The mirror
 * is intentional: this gate's correctness depends on the registry
 * being closed, so re-deriving the set at gate runtime would be a
 * circular dependency on the file the gate exists to defend. The
 * sibling-alignment block below reads the protocol sources and
 * asserts the three lists agree exactly, so a registry update
 * without a gate update is itself a CI failure.
 */
const EVENT_TYPES_REFERENCE = [
  "identity_created",
  "state_updated",
  "memory_formed",
  "memory_decayed",
  "memory_deleted",
  "memory_accessed",
  "provider_swapped",
  "export_requested",
  "delete_requested",
  "sync_completed",
  "audit_entry",
  "tool_used",
  "policy_violation",
  "goal_created",
  "goal_executed",
  "goal_removed",
  "approval_requested",
  "approval_approved",
  "approval_denied",
  "approval_expired",
  "goal_completed",
  "goal_progress",
  "memory_audit",
  "memory_pinned",
  "plan_created",
  "plan_step_started",
  "plan_step_completed",
  "plan_step_failed",
  "plan_completed",
  "plan_step_delegated",
  "credential_revoked",
  "identity_revoked",
  "plan_failed",
  "housekeeping_run",
  "reflection_completed",
  "idle_tick_fired",
  "memory_consolidated",
  "memory_promoted",
  "consolidation_cycle_run",
  "consolidation_receipt_signed",
  "consolidation_receipts_anchored",
  "agent_task_completed",
  "agent_task_failed",
  "agent_task_denied",
  "proposal_created",
  "proposal_accepted",
  "proposal_rejected",
  "proposal_countered",
  "collaborative_step_completed",
  "chain_trust_computed",
  "trust_level_changed",
  "key_rotated",
  "computer_session_opened",
  "computer_session_closed",
  "computer_session_summarized",
  "co_browse_control_changed",
  "user_input_forwarded",
  "skill_loaded",
  "sensitivity_gate_fired",
] as const;

const SNAKE_CASE_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

function readFile(path: string): string | null {
  try {
    return readFileSync(resolve(ROOT, path), "utf8");
  } catch {
    return null;
  }
}

/**
 * Extract enum string-values from the `EventType` enum in
 * `packages/protocol/src/index.ts`. Pattern: `Identifier = "value",`
 * inside the enum body.
 */
function readEnumValues(source: string): string[] {
  const enumMatch = source.match(/^export enum EventType \{([\s\S]*?)^\}/m);
  if (enumMatch === null) return [];
  const body = enumMatch[1] ?? "";
  // Match only enum-member declaration lines: `  Identifier = "value",`.
  // Anchored to start-of-line (after whitespace) + identifier + `=` so
  // comment lines containing JSDoc code-emphasis like `"user"` or
  // equality checks like `=== "user"` don't false-match.
  const values: string[] = [];
  const valuePattern = /^\s+[A-Z][A-Za-z0-9]*\s*=\s*["']([^"']+)["']\s*,?\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = valuePattern.exec(body)) !== null) {
    values.push(m[1] as string);
  }
  return values;
}

/**
 * Extract string-values from the `ALL_EVENT_TYPES` frozen array in
 * `packages/protocol/src/event-type.ts`. Pattern: quoted strings
 * inside the `Object.freeze([…])` call body.
 */
function readArrayValues(source: string): string[] {
  const arrayMatch = source.match(/ALL_EVENT_TYPES[^=]*=\s*Object\.freeze\(\[([\s\S]*?)\]/);
  if (arrayMatch === null) return [];
  const body = arrayMatch[1] ?? "";
  const values: string[] = [];
  const valuePattern = /["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = valuePattern.exec(body)) !== null) {
    values.push(m[1] as string);
  }
  return values;
}

function main(): void {
  // === Sibling-alignment: three-way lock =========================
  //
  //   enum (index.ts) × ALL_EVENT_TYPES (event-type.ts) ×
  //   gate's EVENT_TYPES_REFERENCE
  //
  // All three must agree exactly on the closed set.

  const indexSource = readFile("packages/protocol/src/index.ts");
  const eventTypeSource = readFile("packages/protocol/src/event-type.ts");
  if (indexSource === null || eventTypeSource === null) {
    console.error(
      "check-event-type-canonical: could not read packages/protocol/src/index.ts or event-type.ts.",
    );
    console.error("The EventType registry surface is missing; this gate cannot validate.");
    process.exit(1);
  }

  const enumValues = readEnumValues(indexSource);
  const arrayValues = readArrayValues(eventTypeSource);
  const gateValues = [...EVENT_TYPES_REFERENCE];

  if (enumValues.length === 0) {
    console.error("check-event-type-canonical: could not parse EventType enum values.");
    process.exit(1);
  }
  if (arrayValues.length === 0) {
    console.error("check-event-type-canonical: could not parse ALL_EVENT_TYPES array values.");
    process.exit(1);
  }

  const enumSet = new Set(enumValues);
  const arraySet = new Set(arrayValues);
  const gateSet = new Set(gateValues);

  const enumOnly = [...enumSet].filter((v) => !arraySet.has(v) || !gateSet.has(v));
  const arrayOnly = [...arraySet].filter((v) => !enumSet.has(v) || !gateSet.has(v));
  const gateOnly = [...gateSet].filter((v) => !enumSet.has(v) || !arraySet.has(v));

  if (enumOnly.length > 0 || arrayOnly.length > 0 || gateOnly.length > 0) {
    console.error(
      "check-event-type-canonical: sibling-alignment failure across enum × ALL_EVENT_TYPES × gate reference.",
    );
    if (enumOnly.length > 0) {
      console.error(`  In enum but not all three: ${enumOnly.map((v) => `"${v}"`).join(", ")}`);
      console.error(
        "  → Update `ALL_EVENT_TYPES` in event-type.ts AND `EVENT_TYPES_REFERENCE` in this gate.",
      );
    }
    if (arrayOnly.length > 0) {
      console.error(
        `  In ALL_EVENT_TYPES but not all three: ${arrayOnly.map((v) => `"${v}"`).join(", ")}`,
      );
      console.error(
        "  → Update the `EventType` enum in index.ts AND `EVENT_TYPES_REFERENCE` in this gate.",
      );
    }
    if (gateOnly.length > 0) {
      console.error(`  In gate but not all three: ${gateOnly.map((v) => `"${v}"`).join(", ")}`);
      console.error(
        "  → Update the `EventType` enum in index.ts AND `ALL_EVENT_TYPES` in event-type.ts.",
      );
    }
    console.error("");
    console.error(
      "The three-way lock requires `EventType` (enum) × `ALL_EVENT_TYPES` (array) × `EVENT_TYPES_REFERENCE` (gate) to agree exactly.",
    );
    console.error(
      "Adding an event type is intentional protocol-level work — update all three in the same commit.",
    );
    console.error("Doctrine: docs/doctrine/registry-pattern-canonical.md.");
    process.exit(1);
  }

  // === Wire-format compliance: snake_case for every value ========
  const malformed: string[] = [];
  for (const v of EVENT_TYPES_REFERENCE) {
    if (!SNAKE_CASE_PATTERN.test(v)) {
      malformed.push(v);
    }
  }

  if (malformed.length > 0) {
    console.error(
      `check-event-type-canonical: ${malformed.length} value(s) violate wire-format snake_case convention:`,
    );
    for (const v of malformed) {
      console.error(`  - "${v}" — expected `);
    }
    console.error(
      "Wire-format vocabularies must be snake_case so JSON serializers round-trip identically across implementations.",
    );
    process.exit(1);
  }

  console.log(
    `✓ check-event-type-canonical: ${EVENT_TYPES_REFERENCE.length} event type(s) locked across enum + ALL_EVENT_TYPES + gate reference; all wire-format snake_case-compliant.`,
  );
}

main();
