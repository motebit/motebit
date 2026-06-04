/**
 * Settlement-summary wire body — the per-peer economic history the relay
 * assembles from its signed `relay_settlements` ledger and emits as a
 * `settlement-summary` content artifact (`/api/v1/agents/:motebitId/settlements`,
 * `services/relay/src/state-export.ts`).
 *
 * This is the money side of the first-person trust graph
 * (`docs/doctrine/agents-as-first-person-trust-graph.md` §6). Three
 * invariants the shape encodes:
 *
 *   1. **First-person.** Every figure is the caller's history with a
 *      specific counterparty — what *I* earned from / paid to *this*
 *      peer. Never a global reputation or a peer's standalone balance.
 *   2. **Projection, not balance.** The relay derives these sums from
 *      settlement rows at read time; they are NOT a denormalized field
 *      on any trust record. Receipts / settlement rows stay source of
 *      truth (`docs/doctrine/receipts-unified.md`).
 *   3. **Micro-units.** All amounts are integer micro-units (1 USD =
 *      1,000,000), per the money-model. Surfaces convert at the boundary
 *      with `fromMicro`. Zero floating-point in the money path.
 *
 * Permissive floor (Apache-2.0), type-only, zero runtime deps. Consumed
 * by the relay producer and the `@motebit/state-export-client` verifier;
 * `@motebit/panels` keeps its own surface-agnostic view-model (the panels
 * layer does not import `@motebit/protocol`).
 */

/**
 * One counterparty's economic history with the calling motebit. Keyed by
 * the peer's `motebit_id`. A peer appears here only when at least one
 * settlement between the pair carries an attributable counterparty id
 * (`delegator_id` on the settlement row) — see `SettlementSummaryExport`
 * for the unattributed remainder.
 */
export interface SettlementSummaryPeer {
  /** The counterparty's motebit_id. */
  peer_id: string;
  /**
   * Micro-units the caller *earned from* this peer — the caller was the
   * worker/payee, the peer was the delegator/payer. Sum of `amount_settled`
   * over settlements where `motebit_id = caller ∧ delegator_id = peer`.
   */
  earned_micro: number;
  /**
   * Micro-units the caller *paid to* this peer — the caller was the
   * delegator/payer, the peer was the worker/payee. Sum of `amount_settled`
   * over settlements where `delegator_id = caller ∧ motebit_id = peer`.
   */
  paid_micro: number;
  /** `earned_micro - paid_micro`. May be negative (net payer to this peer). */
  net_micro: number;
  /**
   * Platform fee (micro-units) the relay recorded on settlements this
   * caller funded with this peer (the 5% coordination fee, per the
   * economic-loop doctrine). Only the legs the caller paid — never the
   * peer's fees. Informational; not part of `net_micro` (the fee leaves
   * the caller, it is not owed to or from the peer).
   */
  fee_micro: number;
  /** Count of attributable settlements between the pair (both directions). */
  settled_count: number;
  /** How many of `settled_count` cleared P2P (onchain) vs relay-custody. */
  p2p_count: number;
  /** Earliest `settled_at` (epoch ms) across the pair's settlements. */
  first_at: number;
  /** Latest `settled_at` (epoch ms) across the pair's settlements. */
  last_at: number;
}

/**
 * Settlements that cannot be attributed to a specific counterparty — rows
 * whose `delegator_id` is null. Both P2P and relay-custody settlements
 * record the payer's `delegator_id` going forward, so this bucket holds:
 * settlements predating delegator attribution, multi-hop sub-delegation
 * rows (deferred residual — see `services/relay` CLAUDE.md), and
 * self-funded / unknown-submitter rows. Surfaced as an honest aggregate so
 * the totals stay truthful: the per-peer rows do NOT silently drop this
 * money. A surface MAY show it as "other / unattributed"; it is never
 * folded into a peer.
 */
export interface SettlementSummaryUnattributed {
  /** Micro-units the caller earned on rows with no attributable payer. */
  earned_micro: number;
  /** Platform fee (micro-units) on those rows. */
  fee_micro: number;
  /** Count of unattributable settlements. */
  settled_count: number;
}

/**
 * The signed body of a `settlement-summary` content artifact. The outer
 * `ContentArtifactManifest` (in the `X-Motebit-Content-Manifest` header)
 * attests that the relay assembled this from its settlement ledger at
 * read time; a verifier checks it against the relay's pinned key offline
 * (`@motebit/state-export-client`).
 */
export interface SettlementSummaryExport {
  /** The motebit whose first-person economic history this is. */
  motebit_id: string;
  /** Per-counterparty history, most-recently-settled first. */
  peers: SettlementSummaryPeer[];
  /** Settlements with no attributable counterparty (see the type doc). */
  unattributed: SettlementSummaryUnattributed;
}
