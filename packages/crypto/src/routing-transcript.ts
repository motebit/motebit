/**
 * RoutingDecisionTranscript signing + verification — the INTEGRITY rung of
 * the routing arc's proof artifact (`@motebit/protocol`
 * `routing-transcript.ts`; docs/doctrine/routing-decision-transcript.md,
 * Inc 2).
 *
 * The category law is subject = signer: the delegator signs a record of its
 * OWN act of choosing, so the transcript is receipt-family first-person
 * provenance (docs/doctrine/receipts-unified.md), not an attestation. The
 * verify law here establishes exactly one sentence — "this delegator
 * committed to this decision record: this frozen candidate set, these
 * parameters, this winner" — and DELIBERATELY nothing more:
 *
 *   - NOT decision faithfulness. Whether the recorded winner actually
 *     follows from the frozen inputs (the Thompson draw chain and the
 *     composite ranking) is the FAITHFULNESS rung —
 *     `recomputeRoutingDecision` in `@motebit/semiring`, which lives with
 *     the ranking implementation and is pinned by `algorithm_version`.
 *   - NOT the truth of the frozen inputs. The (α, β) posteriors are reads
 *     of the delegator's own private trust ledger; the transcript proves
 *     the decision was faithful to the recorded snapshot, not that the
 *     snapshot is honest history (that is the ledger's own provenance
 *     discipline).
 *   - NOT the delegator key → motebit_id binding — the consumer's
 *     `verifySovereignBinding`-shaped responsibility, as with bonds.
 *   - NOT authorization of anything. The transcript REVEALS, never
 *     authorizes (docs/doctrine/felt-accumulation.md); no verifier output
 *     feeds any gate.
 *
 * Fail-closed at every step it DOES own: unknown suite, unknown spec,
 * empty candidate set, a winner outside the frozen set, malformed
 * key/signature, signature mismatch.
 */

import type { RoutingDecisionTranscript } from "@motebit/protocol";
import { canonicalJson, hexToBytes, toBase64Url, fromBase64Url } from "./signing.js";
import { signBySuite, verifyBySuite } from "./suite-dispatch.js";

/**
 * The pinned suite for RoutingDecisionTranscript signing (JCS
 * canonicalization, Ed25519, base64url signature encoding). PQ migration =
 * a new `SuiteId` in `@motebit/protocol` + a new dispatch arm in
 * `suite-dispatch.ts`, not a wire break.
 */
export const ROUTING_TRANSCRIPT_SUITE = "motebit-jcs-ed25519-b64-v1" as const;

/**
 * Crypto-side mirror of the protocol spec id. Crypto keeps ZERO runtime
 * monorepo deps (protocol is a type-only devDependency), so the fail-closed
 * spec check cannot import `ROUTING_TRANSCRIPT_SPEC_ID` at runtime — the
 * same mirroring reason as `EVAL_KINDS_MIRROR` and the `SuiteId` dispatch
 * table.
 */
export const ROUTING_TRANSCRIPT_SPEC_MIRROR = "motebit/routing-transcript@1.0" as const;

/** Canonical bytes used for signing — the transcript without its own signature field. */
function canonicalizeForSigning(
  unsigned: Omit<RoutingDecisionTranscript, "signature">,
): Uint8Array {
  return new TextEncoder().encode(canonicalJson(unsigned));
}

/**
 * Sign a routing-decision transcript with the delegator's identity key. The
 * body must already carry `delegator_public_key` (lowercase hex of the key
 * that pairs with `delegatorPrivateKey`) — the artifact is self-describing.
 *
 * JCS discipline: build optional fields (`bonded`, `alpha`, `beta`, `theta`,
 * `pinned`) by conditional spread upstream; this primitive signs the body it
 * is given, byte-stably.
 */
export async function signRoutingTranscript(
  body: Omit<RoutingDecisionTranscript, "signature" | "suite">,
  delegatorPrivateKey: Uint8Array,
): Promise<RoutingDecisionTranscript> {
  const unsigned: Omit<RoutingDecisionTranscript, "signature"> = {
    ...body,
    suite: ROUTING_TRANSCRIPT_SUITE,
  };
  const message = canonicalizeForSigning(unsigned);
  const sig = await signBySuite(ROUTING_TRANSCRIPT_SUITE, message, delegatorPrivateKey);
  return { ...unsigned, signature: toBase64Url(sig) };
}

/** Verification outcome with a structured failure reason for audit logging. */
export interface VerifyRoutingTranscriptResult {
  readonly valid: boolean;
  /** Structured failure reason when `valid === false`. */
  readonly reason?:
    | "unsupported_suite"
    | "unsupported_spec"
    | "empty_candidates"
    | "winner_not_in_candidates"
    | "malformed_public_key"
    | "malformed_signature"
    | "signature_invalid";
}

/**
 * Verify a routing-decision transcript's INTEGRITY. See the module doc for
 * what this law deliberately does NOT check (decision faithfulness — the
 * `@motebit/semiring` recomputation rung — input truth, key→id binding).
 * Fail-closed: every rejection returns a typed reason rather than throwing.
 */
export async function verifyRoutingTranscript(
  transcript: RoutingDecisionTranscript,
): Promise<VerifyRoutingTranscriptResult> {
  // 1. Suite — fail-closed on unknown/missing (crypto CLAUDE.md rule 3).
  if (transcript.suite !== ROUTING_TRANSCRIPT_SUITE) {
    return { valid: false, reason: "unsupported_suite" };
  }

  // 2. Spec — the wire-format discriminator this law knows how to read.
  if (transcript.spec !== ROUTING_TRANSCRIPT_SPEC_MIRROR) {
    return { valid: false, reason: "unsupported_spec" };
  }

  // 3. Non-empty candidate set — a decision among nobody is not a decision;
  //    the frozen set is what makes the transcript auditable. Rebind through
  //    the declared type: `Array.isArray` would narrow the readonly array to
  //    `any[]` and poison downstream member access.
  const candidates: readonly RoutingDecisionTranscript["candidates"][number][] = Array.isArray(
    transcript.candidates,
  )
    ? transcript.candidates
    : [];
  if (candidates.length === 0) {
    return { valid: false, reason: "empty_candidates" };
  }

  // 4. Winner membership — a winner outside the frozen set is structurally
  //    dishonest regardless of the signature.
  if (!candidates.some((c) => c.motebit_id === transcript.winner_motebit_id)) {
    return { valid: false, reason: "winner_not_in_candidates" };
  }

  // 5. Delegator key shape.
  if (!/^[0-9a-f]{64}$/i.test(transcript.delegator_public_key)) {
    return { valid: false, reason: "malformed_public_key" };
  }
  const publicKey = hexToBytes(transcript.delegator_public_key);

  // 6. Signature bytes.
  let sigBytes: Uint8Array;
  try {
    sigBytes = fromBase64Url(transcript.signature);
  } catch {
    return { valid: false, reason: "malformed_signature" };
  }
  if (sigBytes.length !== 64) {
    return { valid: false, reason: "malformed_signature" };
  }

  // 7. Signature over canonical bytes, via suite dispatch.
  const { signature: _sig, ...unsigned } = transcript;
  const message = canonicalizeForSigning(unsigned);
  let valid: boolean;
  try {
    valid = await verifyBySuite(transcript.suite, message, sigBytes, publicKey);
  } catch {
    return { valid: false, reason: "signature_invalid" };
  }
  if (!valid) {
    return { valid: false, reason: "signature_invalid" };
  }
  return { valid: true };
}
