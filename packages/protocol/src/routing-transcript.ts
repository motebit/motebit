/**
 * RoutingDecisionTranscript — a hire you can prove, not just replay.
 *
 * The signed, self-contained record of why a worker won a paid hire
 * (docs/doctrine/routing-decision-transcript.md, Inc 2). The delegator signs a
 * record of ITS OWN act of choosing — subject = signer — so the transcript
 * joins the receipt family (docs/doctrine/receipts-unified.md: JCS + Ed25519 +
 * suite dispatch + independently verifiable), NOT the attestation family
 * (whose defining property is subject ≠ signer).
 *
 * Verification is two-rung:
 *
 *  1. INTEGRITY (permissive floor — `@motebit/crypto`, re-exported by
 *     `@motebit/verifier`): the signature verifies over the JCS-canonical body,
 *     the shape is well-formed, the winner is a member of the frozen candidate
 *     set. Anyone can check the delegator committed to this decision record.
 *  2. FAITHFULNESS (source-available — `@motebit/semiring`, where the ranking
 *     judgment lives): recompute the decision from the frozen inputs — the
 *     Thompson draw chain (α, β, seed → θ̃ → quality) and the composite ranking
 *     (frozen axis values × weights → winner) — and check the recorded outcome
 *     follows. Pinned by `algorithm_version`; determinism is same-version
 *     (golden vectors pin same-version identity, not cross-engine).
 *
 * Invariants (doctrine): the transcript REVEALS, never authorizes — no
 * verifier output feeds any gate. It is minted only by the real selection code
 * path (produced-basis). Disclosure is dispute-scoped: the per-candidate
 * (α, β) are the delegator's private interior, retained locally, egressed on
 * dispute or by owner choice — never broadcast, and never aggregated into any
 * cross-delegator score (REFUSED, not deferred).
 *
 * JCS discipline: optional fields are ABSENT, never `undefined`/`null`, so the
 * canonical bytes are stable (RFC 8785).
 */

/** Spec id for the routing-decision-transcript wire format. */
export const ROUTING_TRANSCRIPT_SPEC_ID = "motebit/routing-transcript@1.0";

/**
 * One member of the FROZEN admissible candidate set — the inputs the ranking
 * actually consumed for this candidate, as literal values (the decision
 * constants live inside the ranking implementation and are not importable;
 * the transcript carries what was used, not a pointer to it).
 */
export interface TranscriptCandidate {
  /** The candidate worker's motebit id. */
  motebit_id: string;
  /** The worker's unit_cost (USD) as priced at decision time. Absent ⇒ free (0). */
  unit_cost?: number;
  /**
   * Present (and `true`) ONLY when the candidate carried a relay-RPC-verified
   * commitment bond at decision time — the exploration-priority input
   * (docs/doctrine/exploration-as-market-vitality.md Inc 2). Absent otherwise;
   * never `false` (the flag asserts a verified fact or stays silent).
   */
  bonded?: true;
  /**
   * The trust-axis value the composite consumed for this candidate. In explore
   * mode this is the Thompson-blended quality; in exploit mode the categorical
   * trust score. Frozen so the composite ranking is recomputable standalone.
   */
  trust_axis: number;
  /** The reliability-axis value the composite consumed (equals `trust_axis` in explore mode). */
  reliability_axis: number;
  /**
   * The Beta-posterior shapes actually sampled (prior + ratio-capped counts),
   * present ONLY in explore mode. Integer pseudo-counts.
   */
  alpha?: number;
  /** See `alpha`. */
  beta?: number;
  /**
   * The Thompson draw θ̃ for this candidate, present ONLY in explore mode.
   * Redundant with (alpha, beta, seed) by construction — the faithfulness rung
   * recomputes it and rejects a transcript whose recorded draw does not match.
   */
  theta?: number;
}

/**
 * The signed routing-decision transcript. Field order is irrelevant on the
 * wire (JCS canonicalizes); `signature` is Ed25519 over
 * `canonicalJson({ ...transcript minus signature })`, base64url.
 */
export interface RoutingDecisionTranscript {
  /** Wire-format version discriminator. */
  readonly spec: typeof ROUTING_TRANSCRIPT_SPEC_ID;
  /** The capability hired for. */
  readonly capability: string;
  /** The delegator (the chooser and the signer — subject = signer). */
  readonly delegator_motebit_id: string;
  /** The delegator's Ed25519 public key, lowercase hex (64 chars). */
  readonly delegator_public_key: string;
  /**
   * The frozen admissible candidate set, in the order ranked. A caller who
   * omitted a candidate cannot be caught by the seed alone — this set is what
   * makes the decision auditable rather than merely replayable.
   */
  readonly candidates: readonly TranscriptCandidate[];
  /**
   * Seed provenance: the tick token's Ed25519 signature — a recorded, signed
   * artifact unique to the delegation turn. Binds the transcript to the
   * specific delegation; the per-candidate draw seed is `${seed}|${motebit_id}`.
   */
  readonly seed: string;
  /** Base exploration strength ∈ [0,1] used (before any bond boost). */
  readonly strength: number;
  /** The composite weights the ranking consumed. */
  readonly weights: {
    readonly trust: number;
    readonly reliability: number;
    readonly cost: number;
    readonly latency: number;
  };
  /** The evidence cap applied to posterior counts (frozen literal; internal to the ranker). */
  readonly count_cap: number;
  /** The multiplicative bond exploration boost (frozen literal; internal to the ranker). */
  readonly bond_explore_boost: number;
  /** Neutral latency (ms) assumed for every candidate (frozen literal; internal to the ranker). */
  readonly default_latency_ms: number;
  /** The ranking-implementation version this transcript is recomputable under. */
  readonly algorithm_version: string;
  /** The worker hired. MUST be a member of `candidates`. */
  readonly winner_motebit_id: string;
  /**
   * Present (and `true`) ONLY when the hire was a pinned deterministic
   * override (`targetWorkerId`) — the pin recorded as the reason; no draw ran.
   * A pinned transcript's `candidates` holds the pinned worker alone.
   */
  readonly pinned?: true;
  /** Whether the exploration draw overrode the exploit-favorite. */
  readonly explored: boolean;
  /** Decision time, epoch milliseconds. */
  readonly issued_at: number;
  /** Cryptosuite (pinned literal — new suites arrive as new transcript versions). */
  readonly suite: "motebit-jcs-ed25519-b64-v1";
  /** Ed25519 over the JCS-canonical transcript minus this field, base64url. */
  readonly signature: string;
}
