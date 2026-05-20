/**
 * Settlement mode types — relay-mediated vs peer-to-peer settlement.
 *
 * Permissive floor (Apache-2.0): these types define the interoperable format
 * for settlement mode selection and payment proof verification.
 */

// === Settlement Mode ===

/** How money moves for a task: through the relay's virtual accounts, or directly onchain. */
export type SettlementMode = "relay" | "p2p";

/**
 * The narrow subset of `SettlementMode` that the relay is permitted to
 * write for **new** worker-settlement rows after Arc 3 of the off-ramp
 * arc. Reads accept the full `SettlementMode` union (legacy `"relay"`
 * rows must remain readable for audit, verifier, and federation
 * compat); writes are structurally restricted to `"p2p"`.
 *
 * This is the asymmetric-typing enforcement shape from
 * [`architecture_disjointness_by_construction`](../../../../.claude/projects/-Users-daniel-src-motebit/memory/architecture_disjointness_by_construction.md)
 * — the surface stays open for reads but closed for writes; legacy
 * data remains verifiable but no new code can re-introduce the
 * relay-custody worker-settlement path. The doctrine: *the relay does
 * not accept delegator-paid funds on behalf of a worker*. The type:
 * `WritableSettlementMode = Extract<SettlementMode, "p2p">`. The
 * structural enforcement: a compile error at every site that tries to
 * write `"relay"` for a worker settlement.
 *
 * Composes with the prior arcs' Layer 1 enforcement shapes:
 *   - Surface deletion (`BridgeSettlementRail.withdraw`) — Arc 1
 *   - Marker interface (`WithdrawableGuestRail`) — Arc 1
 *   - Asymmetric typing (this) — Arc 3
 *
 * Doctrine: [`docs/doctrine/off-ramp-as-user-action.md`](../../../docs/doctrine/off-ramp-as-user-action.md) § "Arc 3 close".
 */
export type WritableSettlementMode = Extract<SettlementMode, "p2p">;

/**
 * Canonical iteration order over `SettlementMode`, frozen. The single
 * source of truth for "every settlement mode" — drift gates, exhaustive
 * switches, settlement-eligibility evaluators, and the protocol's
 * registry-coverage gate (`check-settlement-mode-canonical`) all
 * enumerate through this array.
 *
 * Promoted to a registered registry per
 * [`docs/doctrine/registry-pattern-canonical.md`](../../../docs/doctrine/registry-pattern-canonical.md)
 * on 2026-05-15 — the seventh instance after `SuiteId`, `TokenAudience`,
 * `ContentArtifactType`, `TaskShape`, `SensitivityLevel`, and
 * `EventType`. The four criteria are met: interop law (cross-
 * implementation agreement required for settlement to clear), multi-
 * consumer (relay, agents, discovery, settlement-rails, eligibility
 * evaluator), wire-format presence (`SettlementEligibility.mode`,
 * `AgentDiscovery.settlement_modes[]`), anticipated drift (the closed
 * union will grow when a third mode lands — escrow / hybrid / batched —
 * and silently breaking peers without the structural lock would
 * fail interoperability).
 *
 * Same shape as `ALL_SUITE_IDS`, `ALL_TOKEN_AUDIENCES`,
 * `ALL_CONTENT_ARTIFACT_TYPES`, `ALL_TASK_SHAPES`,
 * `ALL_SENSITIVITY_LEVELS`, `ALL_EVENT_TYPES`. Adding a settlement
 * mode is intentional protocol-level work: new union entry + new
 * entry here + gate reference update + spec update if wire-format-
 * relevant.
 */
export const ALL_SETTLEMENT_MODES: readonly SettlementMode[] = Object.freeze([
  "relay",
  "p2p",
] as SettlementMode[]);

/**
 * Type guard — narrows `unknown` to `SettlementMode`. Consumers that
 * derive settlement-mode values from external sources (peer
 * negotiation, discovery responses, relay routing decisions) call
 * this before dispatching so an unchecked cast is a fail-open path
 * the type system can't catch.
 *
 * Same shape as `isSuiteId`, `isTokenAudience`,
 * `isContentArtifactType`, `isTaskShape`, `isSensitivityLevel`,
 * `isEventType`.
 */
export function isSettlementMode(value: unknown): value is SettlementMode {
  return typeof value === "string" && (ALL_SETTLEMENT_MODES as readonly string[]).includes(value);
}

// === P2P Payment Proof ===

/**
 * Proof of direct onchain payment for a P2P-settled task. After Arc 2
 * of the off-ramp arc, the delegator's single signed Solana
 * transaction composes TWO atomic SPL Transfer instructions:
 *
 *   1. **Worker leg** — delegator → worker, amount = `amount_micro`
 *      (the worker's listing unit_cost, what they earn net).
 *   2. **Fee leg** — delegator → relay treasury, amount =
 *      `fee_amount_micro` (the platform fee, derived from the gross
 *      via `platform_fee_rate`).
 *
 * Both legs land atomically (either the whole tx succeeds or it
 * doesn't); the `p2p-verifier` walks the on-chain `transfers[]` to
 * confirm both legs match the declared addresses + amounts. The relay
 * treasury address is the relay's identity-derived Solana wallet
 * (`deriveSolanaAddress(relay.publicKey)`) — same address that funds
 * `SolanaMemoSubmitter` for anchoring and that `OperatorSolanaTransfer`
 * uses for Path 0 withdrawals. Delegators discover it via the published
 * relay public key on `/.well-known/motebit.json` or
 * `/.well-known/motebit-transparency.json`.
 *
 * Doctrine: `docs/doctrine/off-ramp-as-user-action.md` — Arc 2 closes
 * the sibling-doc contradiction between the top-level `CLAUDE.md`
 * Economic Loop "5% applies through both lanes" claim and
 * `services/relay/CLAUDE.md` rule 8's pre-Arc-2 "Fee: zero on P2P"
 * policy. The fee is now structurally present on every P2P settlement
 * as a direct delegator→treasury leg.
 *
 * **Breaking change from pre-Arc-2 P2pPaymentProof shape**: the new
 * `fee_to_address` + `fee_amount_micro` fields are required. The
 * worker-leg fields (`to_address`, `amount_micro`) keep their existing
 * semantics — they describe only the worker leg, not the gross.
 */
export interface P2pPaymentProof {
  /** Onchain transaction signature (Solana base58, 87-88 chars). */
  tx_hash: string;
  /** Chain identifier (e.g., "solana"). */
  chain: string;
  /** CAIP-2 network identifier. */
  network: string;
  /** Worker's declared settlement address (base58 for Solana). */
  to_address: string;
  /**
   * Worker leg amount in micro-units (USDC 6 decimals). Equals the
   * worker's listing unit_cost — what the worker earns net.
   */
  amount_micro: number;
  /**
   * Relay treasury Solana address (base58). Derivable from the relay's
   * published Ed25519 public key via `deriveSolanaAddress(publicKey)`
   * (see `@motebit/wallet-solana`). Delegators MUST fetch the relay's
   * public key from a verified source (transparency declaration or
   * pinned config) — passing a wrong address sends the fee leg to a
   * non-relay address and verification fails-closed.
   */
  fee_to_address: string;
  /**
   * Fee leg amount in micro-units. The platform fee, computed as
   * `gross - amount_micro` where `gross = amount_micro / (1 - platformFeeRate)`.
   * The verifier validates this matches the relay's recorded
   * `platform_fee_rate` against the declared `amount_micro`.
   */
  fee_amount_micro: number;
}

// === Payment Verification ===

/** Verification status of an onchain payment proof. */
export type PaymentVerificationStatus = "pending" | "verified" | "failed";

// === Solvency Proof ===

/**
 * Relay-signed attestation of an agent's available balance.
 *
 * Workers verify this before starting expensive p2p tasks where
 * the relay doesn't escrow. Short TTL (5 minutes) prevents stale attestations.
 *
 * Verification: strip `signature`, canonicalJson the rest, Ed25519 verify
 * against the relay's public key (from /.well-known/motebit.json).
 */
export interface SolvencyProof {
  /** The agent whose balance is attested. */
  motebit_id: string;
  /** Available balance in micro-units (after dispute holds). */
  balance_available: number;
  /** The amount the requester asked about. */
  amount_requested: number;
  /** Whether balance_available >= amount_requested. */
  sufficient: boolean;
  /** Relay that issued this proof. */
  relay_id: string;
  /** When the proof was generated (ms since epoch). */
  attested_at: number;
  /** When the proof expires (ms since epoch). attested_at + 300_000. */
  expires_at: number;
  /** Ed25519 signature over canonical JSON of all other fields. */
  signature: string;
}

// === Settlement Eligibility ===

/**
 * Result of policy-based settlement-eligibility evaluation. After Arc 3
 * of the off-ramp arc, the eligibility check no longer routes between
 * relay-custody and P2P — P2P is the only worker-settlement path. The
 * gate now answers a binary question: "can this delegator-worker pair
 * transact at all?"
 *
 * Disjunctive eligibility per [`docs/doctrine/off-ramp-as-user-action.md`](../../../docs/doctrine/off-ramp-as-user-action.md):
 *   - **Established-pair branch**: trust ≥ 0.6 AND interactions ≥ 5
 *     AND no_active_disputes AND worker_has_settlement_address.
 *   - **New-pair branch**: `delegator_acknowledges_no_history_risk`
 *     AND no_active_disputes AND worker_not_blocked AND
 *     worker_has_settlement_address.
 *
 * The disjunctive type encodes "allowed implies p2p" structurally —
 * the `mode` field uses `WritableSettlementMode` so consumers that
 * destructure `{ mode }` on an allowed result get the narrow type;
 * the disallowed case has no `mode` field because there's no
 * fallback rail to route to.
 *
 * Composes with [[trust_as_economic_membrane]] — the established-pair
 * branch is the trust-as-fast-path; the new-pair branch is the
 * cold-start unlock with explicit consent.
 */
export type SettlementEligibility =
  | { allowed: true; mode: WritableSettlementMode; reason: string }
  | { allowed: false; reason: string };
