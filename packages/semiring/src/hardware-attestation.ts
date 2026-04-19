/**
 * Hardware attestation semiring — the fifth semiring consumer in the
 * codebase, a new routing dimension for "prefer hardware-attested agents".
 *
 * Prior consumers (in landing order):
 *   #1  agent routing (`@motebit/semiring/agent-network.ts`)
 *   #2  memory retrieval (`@motebit/memory-graph/retrieval.ts`)
 *   #2b notability ranking (`@motebit/memory-graph/notability.ts`)
 *   #3  trust propagation (`@motebit/market/trust-propagation.ts`)
 *   #4  intent disambiguation (`@motebit/semiring/disambiguation.ts`)
 *   #5  hardware attestation (this file)
 *
 * ## What this solves
 *
 * Sensitivity-aware delegation wants to prefer agents whose identity
 * key lives inside hardware (Secure Enclave, TPM, Android StrongBox,
 * Apple DeviceCheck) over agents whose key lives in software storage.
 * The attestation claim lives on `AgentTrustCredential.credentialSubject
 * .hardware_attestation` (spec/credential-v1.md §3.4); this file encodes
 * the ranking as algebra on the same routing graph.
 *
 * ## Algebra
 *
 * The ranking obeys two laws:
 *
 *   - **Parallel alternatives** (⊕): when picking one of several
 *     candidate agents for a given delegation, the best attestation
 *     wins. → `max`.
 *
 *   - **Sequential delegation chain** (⊗): a chain is only as strongly
 *     attested as its weakest link. A `secure_enclave` agent delegating
 *     through a `software` sub-agent gives a `software`-strength chain
 *     end-to-end. → `min`.
 *
 * This is the same shape as `BottleneckSemiring` in `@motebit/protocol`
 * (max, min, 0, ∞) — capacity routing. The structural isomorphism is
 * intentional: "widest bottleneck through the network" and "strongest
 * attested link through the network" are the same algebra under
 * different interpretations. One algorithm, one traversal, swap the
 * interpretation.
 *
 * ## Scoring
 *
 * `scoreAttestation(claim)` maps the claim shape to a scalar in [0, 1]:
 *
 *   1.0  — hardware (`secure_enclave` / `tpm` / `device_check` /
 *          `play_integrity`), `key_exported` false/absent
 *   0.5  — hardware, `key_exported: true` (the key left the hardware,
 *          so the binding between "this key signs" and "this hardware
 *          held it" is broken; still better than a software-only key
 *          because the provenance trail is auditable, but strictly
 *          weaker than non-exported hardware)
 *   0.1  — explicit `platform: "software"` claim (the agent truthfully
 *          declared "no hardware"; a non-zero score distinguishes this
 *          from absent — auditability is still present)
 *   0.0  — absent claim (no attestation, equivalent to `zero`)
 *
 * The scalars pick numbers, not names, so product-semiring composition
 * with other dimensions (trust, cost, latency) stays pure arithmetic.
 * Ranking ordering is what matters — the specific values are
 * convention, renormalizable by consumers that want to weight
 * attestation harder or softer.
 *
 * ## Pure algebra, no I/O
 *
 * MIT purity sits one level up — `BottleneckSemiring` is MIT (generic
 * algebra, no policy). The per-claim encoding function here is BSL
 * because it makes a policy judgment ("software gets 0.1, exported
 * hardware gets 0.5") that a competing implementation may disagree with.
 * Consumers who want a different mapping swap `scoreAttestation` for
 * their own encoder and compose it with the same semiring.
 */

import type { HardwareAttestationClaim, Semiring } from "@motebit/protocol";
import { BottleneckSemiring } from "@motebit/protocol";

// ── Scalar type + constants ─────────────────────────────────────────

/** Narrowed alias for the hardware-attestation scalar — a number in [0, 1]. */
export type HardwareAttestationScore = number;

/** Score for hardware-backed key that has NOT been exported (ideal). */
export const HW_ATTESTATION_HARDWARE = 1.0;

/** Score for hardware-backed key that WAS exported from hardware. */
export const HW_ATTESTATION_HARDWARE_EXPORTED = 0.5;

/** Score for an explicit `platform: "software"` claim (truthful non-hardware). */
export const HW_ATTESTATION_SOFTWARE = 0.1;

/** Score for an absent claim (unknown / no assertion). Semiring zero. */
export const HW_ATTESTATION_NONE = 0.0;

// ── Semiring ────────────────────────────────────────────────────────

/**
 * `HardwareAttestationSemiring` — (max, min, 0, 1) on [0, 1] scalars.
 *
 * Isomorphic to `BottleneckSemiring` on [0, 1] — "strongest attestation
 * link" has the same algebra as "widest bottleneck". We re-export the
 * same semiring under a domain-specific name so callers that want to
 * rank agents by attestation can reference the dimension they mean,
 * instead of invoking capacity semantics on a routing graph.
 *
 * Why expose both names. `BottleneckSemiring.one` is `∞` (the
 * mathematical neutral for `min`). For the attestation interpretation
 * we want `one` to be `1.0` — every scalar lives in [0, 1], so `∞` is
 * outside the domain even though it's harmless as an identity. The
 * `HardwareAttestationSemiring` constant below pins `one = 1.0` so the
 * scalars stay in range throughout composition, matching the domain
 * consumers reason about.
 */
export const HardwareAttestationSemiring: Semiring<HardwareAttestationScore> = {
  zero: HW_ATTESTATION_NONE,
  one: HW_ATTESTATION_HARDWARE, // 1.0 — hardware-attested ideal
  add: (a, b) => Math.max(a, b),
  mul: (a, b) => Math.min(a, b),
};

// ── Scoring ─────────────────────────────────────────────────────────

/**
 * Encode a `HardwareAttestationClaim` (or its absence) as a semiring
 * scalar. Pure, deterministic — same claim → same score, always.
 *
 * Absent claim (`undefined`) returns the semiring zero, which
 * annihilates under `mul`: a single absent link in a delegation chain
 * collapses the whole chain's attestation score to zero. That's the
 * correct behavior for "unknown custody" — verifiers cannot trust a
 * chain whose weakest link they can't see.
 *
 * If that annihilation is too aggressive for a given policy (some
 * consumers may prefer to treat "unknown" as `software`-equivalent for
 * a softer signal), compose a mapped encoding layer in the consumer
 * rather than mutating this baseline.
 */
export function scoreAttestation(claim: HardwareAttestationClaim | undefined): number {
  if (claim == null) return HW_ATTESTATION_NONE;
  switch (claim.platform) {
    case "secure_enclave":
    case "tpm":
    case "device_check":
    case "play_integrity":
      return claim.key_exported === true
        ? HW_ATTESTATION_HARDWARE_EXPORTED
        : HW_ATTESTATION_HARDWARE;
    case "software":
      return HW_ATTESTATION_SOFTWARE;
    default: {
      // Future-proof: new platforms added to the enum land here until
      // the policy explicitly scores them. Treat as `software`-equivalent
      // (not zero) — the claim was present but unrecognized, which is
      // a stronger signal than silence.
      const _exhaustive: never = claim.platform;
      void _exhaustive;
      return HW_ATTESTATION_SOFTWARE;
    }
  }
}

/**
 * Convenience comparator: true iff `a` ranks strictly stronger than `b`
 * under the hardware-attestation ordering. Matches the `max`-oriented
 * ⊕: `a > b` iff `add(a, b) === a && a !== b`.
 */
export function attestationRanksAbove(a: number, b: number): boolean {
  return a > b;
}

// ── Re-export the structural twin for algebra-level callers ────────

/**
 * `BottleneckSemiring` imported at module top so consumers that want
 * the structural proof — "hardware attestation IS bottleneck routing
 * under a different interpretation" — can reach it from this module
 * without crossing into `@motebit/protocol`. The two constants compose
 * identically under `productSemiring`, `recordSemiring`, and
 * `mappedSemiring`; which name a caller uses is a matter of which
 * dimension they're reasoning about, not which algebra they want.
 */
export { BottleneckSemiring as _StructuralTwin };
