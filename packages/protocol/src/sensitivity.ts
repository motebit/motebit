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
