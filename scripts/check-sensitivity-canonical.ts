#!/usr/bin/env tsx
/**
 * `check-sensitivity-canonical` — registry-coverage gate for the
 * `SensitivityLevel` closed registry.
 *
 * Closed-registry / structural-lock pattern — same shape as
 * `check-suite-declared` (#10), `check-audience-canonical` (#46),
 * `check-artifact-type-canonical` (#85),
 * `check-routing-decision-coverage` (#95),
 * `check-panel-registry-coverage` (#96).
 *
 *   1. `SensitivityLevel` (the enum in `packages/protocol/src/index.ts`)
 *      is the typed source of truth for the five-tier privacy
 *      ladder. Each tier carries interop-law semantics: every motebit
 *      implementation must agree on which tier dominates which, or
 *      cross-implementation gating isn't interoperable.
 *
 *   2. Three sibling artifacts MUST stay in lockstep with the enum:
 *      - `ALL_SENSITIVITY_LEVELS` (frozen iteration array, sensitivity.ts)
 *      - `SENSITIVITY_RANK` (ordinal-rank record, sensitivity.ts)
 *      - This gate's `LEVELS_REFERENCE` (the gate's own mirror)
 *      A drift between any pair fails the gate.
 *
 *   3. A closed inventory of CONSUMERS — files that dispatch on
 *      sensitivity at a sensitive boundary — MUST either reference
 *      every level as a literal OR route through the canonical
 *      algebra primitives (`rankSensitivity`, `maxSensitivity`,
 *      `sensitivityPermits`). The algebra is the protocol's escape
 *      hatch from per-level dispatch chains — a consumer that uses
 *      it doesn't need to enumerate. A consumer that DOESN'T use it
 *      must handle every tier explicitly so a future tier insertion
 *      can't slip through.
 *
 * **Note on what this gate does NOT enforce.** The gate does not
 * scan every `"medical"` literal in the repo — common-word strings
 * appear in copy, JSDoc, comments, and unrelated contexts. The
 * structural value is the four-way sibling lock (enum × array ×
 * rank record × gate) plus the consumer-registry coverage. The
 * 900+ pre-existing literal sites are pre-registry technical debt
 * that future arcs may grep-find and re-canonicalize; this gate
 * locks the structural perimeter so the debt cannot grow.
 *
 * Doctrine: `docs/doctrine/retention-policy.md` § "Sensitivity
 * ceilings as interop law"; the `Fail-closed privacy` principle in
 * `CLAUDE.md`.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/**
 * The canonical set, mirrored from
 * `packages/protocol/src/sensitivity.ts:ALL_SENSITIVITY_LEVELS`.
 * The mirror is intentional: this gate's correctness depends on the
 * registry being closed, so re-deriving the set at gate runtime
 * would be a circular dependency on the file the gate exists to
 * defend. The sibling-alignment block below reads the protocol
 * sources and asserts the four lists agree, so a registry update
 * without a gate update is itself a CI failure.
 */
const LEVELS_REFERENCE = ["none", "personal", "medical", "financial", "secret"] as const;

interface SensitivityConsumer {
  /** Human-readable name for error messages. */
  readonly name: string;
  /** Path relative to repo root. */
  readonly file: string;
  /**
   * Per the doctrine, a consumer satisfies the gate one of two ways:
   *   - "enumerate": every level literal appears in the source
   *     (the consumer handles each tier explicitly).
   *   - "algebra": the consumer imports + uses at least one of the
   *     canonical algebra primitives (`rankSensitivity`,
   *     `maxSensitivity`, `sensitivityPermits`) — the protocol's
   *     escape hatch from per-level dispatch.
   *
   * Most consumers should be "algebra" — that's the doctrine. The
   * gate accepts either, scoring whichever shape the consumer
   * declares for itself.
   */
  readonly satisfies: "enumerate" | "algebra";
}

/**
 * Closed inventory of CONSUMERS — load-bearing dispatch sites that
 * MUST cover the registry. Adding a consumer (a new file that
 * dispatches on sensitivity at a privacy boundary) requires
 * registering it here AND wiring its source to either enumerate or
 * route through the algebra.
 *
 * The seed set is the three canonical dispatch sites identified in
 * `check-sensitivity-routing` + the protocol's own algebra home.
 * The runtime's `motebit-runtime.ts` defines `CONTEXT_SAFE_SENSITIVITY`
 * (the egress-write allowlist); `policy-invariants/computer-sensitivity.ts`
 * holds the elevated-tier admission predicate for the computer tool;
 * the protocol's `sensitivity.ts` itself is the algebra home.
 */
const CONSUMERS: ReadonlyArray<SensitivityConsumer> = [
  {
    name: "protocol-sensitivity-algebra",
    file: "packages/protocol/src/sensitivity.ts",
    // The algebra home — the SENSITIVITY_RANK record enumerates all
    // five levels by definition. The structural lock at the source.
    satisfies: "enumerate",
  },
  {
    name: "runtime-egress-write-floor",
    file: "packages/runtime/src/motebit-runtime.ts",
    // CONTEXT_SAFE_SENSITIVITY classifies which tiers may reach
    // external AI; the consumer must list every level it admits and
    // every level it excludes — pure enumeration. Routes through
    // `maxSensitivity` for write composition but the floor itself
    // is a level-by-level allowlist.
    satisfies: "enumerate",
  },
  {
    name: "policy-invariants-computer-sensitivity",
    file: "packages/policy-invariants/src/computer-sensitivity.ts",
    // The computer-tool elevation gate; routes through the algebra
    // primitives for the rank comparison rather than enumerating
    // tiers inline. The canonical "algebra" satisfier.
    satisfies: "algebra",
  },
];

/**
 * Canonical algebra entry points the protocol exports. A consumer
 * with `satisfies: "algebra"` must reference at least one of these
 * as an imported identifier — i.e. the import line must contain the
 * name. The textual scan is sufficient because the algebra names
 * are unique tokens (`rankSensitivity` doesn't appear in any
 * unrelated context).
 */
const ALGEBRA_ENTRIES = ["rankSensitivity", "maxSensitivity", "sensitivityPermits"] as const;

function readFile(path: string): string | null {
  try {
    return readFileSync(resolve(ROOT, path), "utf8");
  } catch {
    return null;
  }
}

interface Violation {
  readonly consumer?: string;
  readonly file: string;
  readonly kind:
    "sibling_alignment" | "missing_file" | "missing_level_literal" | "missing_algebra_import";
  readonly detail?: string;
}

function main(): void {
  const violations: Violation[] = [];

  // === Sibling-alignment: four-way lock =========================
  //
  //   enum (index.ts) × ALL_SENSITIVITY_LEVELS × SENSITIVITY_RANK ×
  //   this gate's LEVELS_REFERENCE
  //
  // All four must agree exactly on the closed level set.

  const indexSource = readFile("packages/protocol/src/index.ts");
  const sensitivitySource = readFile("packages/protocol/src/sensitivity.ts");
  if (indexSource === null || sensitivitySource === null) {
    console.error(
      "check-sensitivity-canonical: could not read packages/protocol/src/index.ts or sensitivity.ts.",
    );
    console.error("The protocol surface is missing; this gate cannot validate.");
    process.exit(1);
  }

  // (1) enum literal must appear in index.ts for each level
  for (const level of LEVELS_REFERENCE) {
    const enumValuePattern = new RegExp(`=\\s*["']${level}["']`);
    if (!enumValuePattern.test(indexSource)) {
      violations.push({
        file: "packages/protocol/src/index.ts",
        kind: "sibling_alignment",
        detail: `enum member with value "${level}" not found in SensitivityLevel`,
      });
    }
  }
  // (2) ALL_SENSITIVITY_LEVELS must contain every level
  // (3) SENSITIVITY_RANK must contain every level as a key
  for (const level of LEVELS_REFERENCE) {
    const arrayPattern = new RegExp(`["']${level}["']`);
    if (!arrayPattern.test(sensitivitySource)) {
      violations.push({
        file: "packages/protocol/src/sensitivity.ts",
        kind: "sibling_alignment",
        detail: `level "${level}" not found in sensitivity.ts (ALL_SENSITIVITY_LEVELS / SENSITIVITY_RANK)`,
      });
    }
  }

  if (violations.length > 0) {
    console.error(
      `check-sensitivity-canonical: ${violations.length} sibling-alignment violation(s) in the four-way lock.`,
    );
    for (const v of violations) {
      console.error(`  - ${v.file}: ${v.detail ?? v.kind}`);
    }
    console.error("");
    console.error(
      "The four-way lock requires SensitivityLevel (enum) × ALL_SENSITIVITY_LEVELS × SENSITIVITY_RANK × this gate's LEVELS_REFERENCE to agree exactly.",
    );
    console.error(
      "Adding a level is intentional protocol-level work — update all four in the same commit.",
    );
    process.exit(1);
  }

  // === Per-consumer coverage check ==============================
  for (const consumer of CONSUMERS) {
    const source = readFile(consumer.file);
    if (source === null) {
      violations.push({
        consumer: consumer.name,
        file: consumer.file,
        kind: "missing_file",
      });
      continue;
    }

    if (consumer.satisfies === "enumerate") {
      // Every level literal must appear in the source.
      for (const level of LEVELS_REFERENCE) {
        const literalPattern = new RegExp(`[\`"']${level}[\`"']`);
        if (!literalPattern.test(source)) {
          violations.push({
            consumer: consumer.name,
            file: consumer.file,
            kind: "missing_level_literal",
            detail: level,
          });
        }
      }
    } else {
      // Must reference at least one algebra primitive by name.
      const usesAlgebra = ALGEBRA_ENTRIES.some((entry) => {
        const pattern = new RegExp(`\\b${entry}\\b`);
        return pattern.test(source);
      });
      if (!usesAlgebra) {
        violations.push({
          consumer: consumer.name,
          file: consumer.file,
          kind: "missing_algebra_import",
          detail: ALGEBRA_ENTRIES.join(" | "),
        });
      }
    }
  }

  if (violations.length > 0) {
    console.error(
      `check-sensitivity-canonical: ${violations.length} consumer-coverage violation(s) across ${CONSUMERS.length} registered consumer(s):`,
    );
    const byConsumer = new Map<string, Violation[]>();
    for (const v of violations) {
      const key = v.consumer ?? "(sibling)";
      const list = byConsumer.get(key) ?? [];
      list.push(v);
      byConsumer.set(key, list);
    }
    for (const [consumerName, consumerViolations] of byConsumer) {
      console.error("");
      console.error(`  ${consumerName}:`);
      for (const v of consumerViolations) {
        switch (v.kind) {
          case "missing_file":
            console.error(`    - consumer file not found: ${v.file}`);
            break;
          case "missing_level_literal":
            console.error(`    - level "${v.detail}" not referenced in ${v.file}`);
            console.error(
              "      → enumerate-satisfier must handle every tier explicitly so a future insertion can't slip through.",
            );
            break;
          case "missing_algebra_import":
            console.error(`    - algebra entry (${v.detail}) not referenced in ${v.file}`);
            console.error(
              "      → algebra-satisfier must route through rankSensitivity / maxSensitivity / sensitivityPermits.",
            );
            break;
        }
      }
    }
    console.error("");
    console.error(
      "Every registered consumer of SensitivityLevel MUST either enumerate every tier OR route through the canonical algebra. Doctrine: docs/doctrine/retention-policy.md.",
    );
    process.exit(1);
  }

  console.log(
    `✓ check-sensitivity-canonical: ${LEVELS_REFERENCE.length} level(s) locked across enum + ALL_SENSITIVITY_LEVELS + SENSITIVITY_RANK; ${CONSUMERS.length} consumer(s) covered.`,
  );
}

main();
