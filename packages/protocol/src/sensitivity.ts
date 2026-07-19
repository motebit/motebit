/**
 * Sensitivity ladder algebra — pure math over the closed
 * `SensitivityLevel` enum.
 *
 * The ladder is interop law. Every motebit implementation must agree
 * on which tier dominates which, or the cross-implementation gate
 * isn't interoperable: device A persisting a turn at "secret" must
 * mean the same thing to device B's session-tier filter.
 *
 * Pure deterministic math over a closed enum — qualifies as a
 * permissive-floor primitive per `packages/protocol/CLAUDE.md` rule 1
 * ("deterministic math (semiring algebra, canonical JSON, hash
 * primitives)"). The functions don't decide policy; they compose
 * ordered values. Policy thresholds (e.g. "medical+ requires
 * sovereign provider") live at the call site so call sites express
 * intent at the right level.
 *
 * Graduation history: `rankSensitivity` had three local definitions
 * by 2026-05-07 (runtime/motebit-runtime.ts, runtime/conversation.ts,
 * ai-core/loop.ts) plus a fourth-shaped table (`LEVEL_RANK` +
 * `higherLevel` in policy-invariants/computer-sensitivity.ts). The
 * ai-core copy's JSDoc explicitly named graduation as the trigger:
 * "if a third reader appears, the helper graduates." Past trigger.
 *
 * Naming distinction:
 * - `rankSensitivity` — load-bearing primitive; ordinal int over the
 *   closed union. Comparable, hashable, monotonic.
 * - `maxSensitivity` — typed wrapper for the join-semilattice
 *   composition (`max(a, b)`). Identity element is `None`. Used at
 *   every egress write boundary that floors message tier at
 *   `max(default, effective)`.
 * - `sensitivityPermits` — typed wrapper for the read-side filter
 *   (`candidate <= upper`). Used at every egress READ boundary that
 *   excludes content tagged above the current effective tier.
 *
 * Not a semiring. There's only one operation (max-monoid / join-
 * semilattice). Calling it a semiring would be a category error.
 */

// Type-only import: `index.ts` re-exports from this file, so a value
// import would create an init-order cycle in the bundled dist. The
// enum's runtime values are the same string literals used as keys
// below — verified by `check-sensitivity-routing` and the protocol
// tests under `__tests__/sensitivity.test.ts`.
import type { SensitivityLevel } from "./index.js";

/**
 * Ordinal rank for `SensitivityLevel`: `none(0) < personal(1) <
 * medical(2) < financial(3) < secret(4)`. The single source of truth
 * for the ladder ordering — every consumer must derive comparison
 * decisions from this rank, not from local enum-equality chains
 * (`x === Medical || x === Financial || x === Secret`), so a future
 * tier insertion remains a one-file change at the protocol layer.
 *
 * Keys are the enum's string values (not enum members) to avoid the
 * init-order cycle described above. The `Record<SensitivityLevel,
 * number>` type still binds the keys to the enum at the type layer.
 */
const SENSITIVITY_RANK: Readonly<Record<SensitivityLevel, number>> = Object.freeze({
  none: 0,
  personal: 1,
  medical: 2,
  financial: 3,
  secret: 4,
});

/**
 * Ordinal rank for a `SensitivityLevel`. Returns 0 (`None`) through
 * 4 (`Secret`) — see `SENSITIVITY_RANK` above. Use this as the
 * comparison primitive; prefer `maxSensitivity` / `sensitivityPermits`
 * at call sites that compose or filter.
 */
export function rankSensitivity(level: SensitivityLevel): number {
  return SENSITIVITY_RANK[level];
}

/**
 * Compose two sensitivity tiers: returns whichever has the higher
 * rank. The join-semilattice composition that the egress-write floor
 * arc depends on at every boundary (session × slab, default ×
 * effective, persisted-tier × runtime-tier). Identity is `None`.
 *
 * Property: `maxSensitivity(a, None) === a` for all `a`.
 */
export function maxSensitivity(a: SensitivityLevel, b: SensitivityLevel): SensitivityLevel {
  return rankSensitivity(a) >= rankSensitivity(b) ? a : b;
}

/**
 * Does the upper tier permit content tagged at `candidate`? Returns
 * `true` iff `candidate <= upper` in the ladder. Used at every
 * egress READ boundary (trimmed conversation history, memory-
 * candidate filter at AI-context construction, future cross-device-
 * sync filters).
 *
 * The dual of `maxSensitivity`: write-side floor stamps with
 * `maxSensitivity`, read-side filter excludes via
 * `!sensitivityPermits`. Both routes derive from the same single
 * source of truth (`SENSITIVITY_RANK`), so a tier insertion remains
 * a one-file change at the protocol layer.
 *
 * Property: `sensitivityPermits(upper, None) === true` for all
 * `upper` (None content is admissible at every tier).
 */
export function sensitivityPermits(upper: SensitivityLevel, candidate: SensitivityLevel): boolean {
  return rankSensitivity(candidate) <= rankSensitivity(upper);
}

// ── Canonical registry tooling ─────────────────────────────────────
//
// Closed-registry / structural-lock shape. Same five artifacts as
// `SuiteId` (`crypto-suite.ts`), `TokenAudience` (`audience.ts`),
// `ContentArtifactType` (`artifact-type.ts`), `TaskShape`
// (`routing.ts`):
//
//   1. closed type (the `SensitivityLevel` enum in `index.ts`)
//   2. canonical ordering (`SENSITIVITY_RANK` above)
//   3. frozen iteration array (`ALL_SENSITIVITY_LEVELS` below)
//   4. type guard (`isSensitivityLevel` below)
//   5. drift gate (`check-sensitivity-canonical` per `scripts/`)
//
// Pre-this-block, `SensitivityLevel` was the only top-tier closed
// registry without the iteration + guard pair — the gap surfaced in
// the registry-gate-family audit on 2026-05-14 (post panels-registry
// arc). The enum is preserved for back-compat with the ~900
// pre-existing literal sites; this block adds the missing canonical
// tooling next to it without converting the enum.

/**
 * Canonical iteration order over `SensitivityLevel`, frozen. The
 * single source of truth for "every level" — drift gates,
 * consumer-coverage scans, exhaustive switches, and the protocol's
 * registry-coverage gate (`check-sensitivity-canonical`) all
 * enumerate through this array.
 *
 * Ordered low → high to mirror `SENSITIVITY_RANK`: a consumer
 * iterating in declaration order sees the ladder in the same order
 * the algebra ranks it. Same shape as `ALL_SUITE_IDS`,
 * `ALL_TOKEN_AUDIENCES`, `ALL_CONTENT_ARTIFACT_TYPES`,
 * `ALL_TASK_SHAPES`. Adding a level is intentional protocol-level
 * work: new enum member + new entry here + new entry in
 * `SENSITIVITY_RANK` + drift-gate update.
 *
 * Values are the enum's string literals (not enum members) to avoid
 * the init-order cycle the file's `import type` already documents.
 */
export const ALL_SENSITIVITY_LEVELS: readonly SensitivityLevel[] = Object.freeze([
  "none",
  "personal",
  "medical",
  "financial",
  "secret",
] as SensitivityLevel[]);

/**
 * The sensitivity tiers whose content MAY cross to an EXTERNAL inference
 * provider — everything strictly below the medical egress ceiling. `medical`,
 * `financial`, and `secret` (rank ≥ medical) are excluded: per the root
 * CLAUDE.md fail-closed-privacy invariant they NEVER reach external AI, only a
 * sovereign (on-device) provider whose content never leaves the device.
 *
 * Derived from `rankSensitivity` rather than hardcoded, so the set can never
 * drift from the ceiling — a future below-medical tier extends it automatically.
 * This is the canonical form of the filter both the AI loop (auto-injected
 * memory) and the runtime (the `recall_memories` tool) apply toward external
 * providers; consumers MUST use it rather than re-listing `[none, personal]`.
 */
export const CONTEXT_SAFE_SENSITIVITY: readonly SensitivityLevel[] = Object.freeze(
  ALL_SENSITIVITY_LEVELS.filter(
    (l) => rankSensitivity(l) < rankSensitivity("medical" as SensitivityLevel),
  ),
);

/**
 * Type guard — narrows `unknown` to `SensitivityLevel`. Drift-gate-
 * driven literal scanners use this to validate values pulled from
 * wire-format payloads; consumers that derive sensitivity from
 * user input call this before dispatching so an unchecked cast is
 * a fail-open path the type system can't catch.
 *
 * Same shape as `isSuiteId`, `isTokenAudience`,
 * `isContentArtifactType`, `isTaskShape`.
 */
export function isSensitivityLevel(value: unknown): value is SensitivityLevel {
  return typeof value === "string" && (ALL_SENSITIVITY_LEVELS as readonly string[]).includes(value);
}

// ── Sensitivity-cleared brand (precondition encoding) ─────────────
//
// Phantom-type brand: `SensitivityCleared<T>` is `T` plus an opaque
// type-level tag that exists only at the type layer. The runtime
// representation is `T` — there is no extra field, no allocation, no
// runtime cost. The brand carries a single proof: "the sensitivity
// gate (`assertSensitivityPermitsAiCall`) fired before this value
// was produced."
//
// Consumer contract: any function that crosses the AI egress
// boundary (`runTurn`, `runTurnStreaming`) requires
// `SensitivityCleared<MotebitLoopDependencies>` rather than the bare
// deps. Callers cannot construct the brand themselves — the symbol
// is `declare const`-only, so the only valid production is an
// explicit `as SensitivityCleared<T>` cast inside the gate's
// implementation.
//
// Layer 1 enforcement: any future call site that reaches `runTurn`
// without threading the brand from a gate-firing producer is a
// compile error. Closes the off-gate paths that the static scanner
// `check-sensitivity-routing` misses (cross-file, cross-package
// indirect calls — `runtime/streaming.ts`, `planner/plan-engine.ts`).
// The static gate is now redundant for the runTurn family; it stays
// for `provider.generate(...)` direct calls (housekeeping
// completions) which are a separate brand-promotion arc.

declare const __sensitivityCleared: unique symbol;

/**
 * Precondition brand: `T` carrying the type-level proof that
 * `assertSensitivityPermitsAiCall()` fired before the value left
 * the gate.
 *
 * Produced only inside the runtime's gate method (the single
 * authorized `as SensitivityCleared<T>` cast). Required as the
 * deps parameter on `runTurn` / `runTurnStreaming`. Propagates
 * through every indirect AI-egress path (`StreamingManager` resume,
 * `PlanEngine` per-step) so the brand is the type-level proof a
 * sensitivity check happened at the right moment.
 *
 * Doctrine: `docs/doctrine/security-boundaries.md` (privacy gate),
 * CLAUDE.md ("Medical/financial/secret never reach external AI").
 */
export type SensitivityCleared<T> = T & { readonly [__sensitivityCleared]: true };
