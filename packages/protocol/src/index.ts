// Type-only import for the Merkle tree-hash axis used by `ConsolidationAnchor`
// below. Re-exported (with the rest of the registry surface) near the bottom of
// this barrel; the local binding here is what lets the anchor type reference it.
import type { MerkleTreeVersion } from "./merkle-tree-hash.js";
import type { MemorySource } from "./memory-source.js";
// Local bindings for `Citation.provenance` + the producer-side `source_digest`
// fields below (re-exported with the rest of the evidence-provenance vocabulary
// near the bottom of this barrel).
import type { EvidenceProvenance, DigestRef } from "./evidence-provenance.js";

// === Branded ID Types ===
//
// Compile-time safety against accidental ID swaps. Optional brand pattern:
//   string → MotebitId    ✅  (backward compat — plain strings still assignable)
//   MotebitId → DeviceId  ❌  (catches the bug — different brand literals)
//
// This means branded types can be applied to interfaces WITHOUT breaking existing
// construction sites. The protection is directional: you can put any string INTO
// a branded field, but you can't take a MotebitId and use it as a DeviceId.
//
// Factory functions (asMotebitId etc.) are for explicit intent at system boundaries.

declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]?: B };

export type MotebitId = Brand<string, "MotebitId">;
export type DeviceId = Brand<string, "DeviceId">;
export type NodeId = Brand<string, "NodeId">;
export type GoalId = Brand<string, "GoalId">;
export type EventId = Brand<string, "EventId">;
export type ConversationId = Brand<string, "ConversationId">;
export type PlanId = Brand<string, "PlanId">;
export type AllocationId = Brand<string, "AllocationId">;
export type SettlementId = Brand<string, "SettlementId">;
export type ListingId = Brand<string, "ListingId">;
export type ProposalId = Brand<string, "ProposalId">;

/** Brand a string as a MotebitId after validation. */
export function asMotebitId(id: string): MotebitId {
  return id as MotebitId;
}
/** Brand a string as a DeviceId after validation. */
export function asDeviceId(id: string): DeviceId {
  return id as DeviceId;
}
/** Brand a string as a NodeId after validation. */
export function asNodeId(id: string): NodeId {
  return id as NodeId;
}
/** Brand a string as a GoalId after validation. */
export function asGoalId(id: string): GoalId {
  return id as GoalId;
}
/** Brand a string as an EventId after validation. */
export function asEventId(id: string): EventId {
  return id as EventId;
}
/** Brand a string as a ConversationId after validation. */
export function asConversationId(id: string): ConversationId {
  return id as ConversationId;
}
/** Brand a string as a PlanId after validation. */
export function asPlanId(id: string): PlanId {
  return id as PlanId;
}
/** Brand a string as an AllocationId after validation. */
export function asAllocationId(id: string): AllocationId {
  return id as AllocationId;
}
/** Brand a string as a SettlementId after validation. */
export function asSettlementId(id: string): SettlementId {
  return id as SettlementId;
}
/** Brand a string as a ListingId after validation. */
export function asListingId(id: string): ListingId {
  return id as ListingId;
}
/** Brand a string as a ProposalId after validation. */
export function asProposalId(id: string): ProposalId {
  return id as ProposalId;
}

// === Enums ===

export enum TrustMode {
  Full = "full",
  Guarded = "guarded",
  Minimal = "minimal",
}

export enum BatteryMode {
  Normal = "normal",
  LowPower = "low_power",
  Critical = "critical",
}

export enum AgentTrustLevel {
  Unknown = "unknown",
  FirstContact = "first_contact",
  Verified = "verified",
  Trusted = "trusted",
  Blocked = "blocked",
}

export enum MotebitType {
  Personal = "personal",
  Service = "service",
  Collaborative = "collaborative",
}

export enum ProposalStatus {
  Pending = "pending",
  Accepted = "accepted",
  Countered = "countered",
  Rejected = "rejected",
  Withdrawn = "withdrawn",
  Expired = "expired",
}

export enum ProposalResponseType {
  Accept = "accept",
  Reject = "reject",
  Counter = "counter",
}

export interface AgentTrustRecord {
  motebit_id: MotebitId;
  remote_motebit_id: MotebitId;
  trust_level: AgentTrustLevel;
  public_key?: string;
  first_seen_at: number;
  last_seen_at: number;
  interaction_count: number;
  successful_tasks?: number;
  failed_tasks?: number;
  notes?: string;
  /**
   * First-person local nickname for this peer — what *I* call them, in my own
   * namespace. Local-only: never on the wire, never sent to a peer or the relay.
   * Naming is first-person (the petname resolution to Zooko's triangle — see
   * `docs/doctrine/agents-as-first-person-trust-graph.md` §3), distinct from the
   * peer's squattable self-asserted listing name. Optional; absent ⇒ no petname.
   */
  petname?: string;
  /** Exponential moving average of result quality [0, 1]. */
  avg_quality?: number;
  /** Number of quality samples collected. */
  quality_sample_count?: number;
  /**
   * Most-recent verified hardware-attestation snapshot about the remote
   * agent. Projected from the latest peer-issued `AgentTrustCredential`
   * in the credential store at read time — never persisted on
   * `agent_trust`. The credential is the authoritative source; caching
   * the claim on the trust row would invite drift on revocation /
   * re-attestation. Absent when no credential carries a claim.
   *
   * Shape mirrors `AgentHardwareAttestation` in `@motebit/panels` so
   * surfaces can pass `AgentTrustRecord[]` straight to the Agents-panel
   * adapter without per-field transformation. `score` is computed once
   * at projection time via `scoreAttestation`
   * (`packages/semiring/src/hardware-attestation.ts`) — keep both shapes
   * byte-aligned. The same data flows into `HardwareAttestationSemiring`
   * for routing — see `docs/doctrine/self-attesting-system.md`: a
   * routing-input claim MUST be visible to the user.
   */
  hardware_attestation?: {
    platform: HardwareAttestationClaim["platform"];
    key_exported?: boolean;
    score: number;
  };
  /**
   * Most-recent observed-latency snapshot for delegations to this peer.
   * Projected from the local `LatencyStatsStore` at read time — never
   * persisted on `agent_trust`. The store is the authoritative source;
   * caching avg/p95 on the trust row would invite drift on every new
   * task. Absent when the store has zero samples for this pair.
   *
   * Same surface contract as `hardware_attestation`: every routing-input
   * the runtime computes against MUST be visible to the user, per
   * `docs/doctrine/self-attesting-system.md`. Latency factors into peer
   * ranking through `agent-graph.ts`'s latency map (default 3000ms when
   * stats are absent); the Agents-panel latency render is the user-facing
   * surface for that input.
   *
   * Shape mirrors `AgentLatencyStats` in `@motebit/panels` so surfaces
   * can pass `AgentTrustRecord[]` straight to the Agents-panel adapter
   * without per-field transformation. Numbers in milliseconds; integer
   * sample counts. The relay-side enricher uses the same shape from its
   * `relay_latency_stats` table.
   */
  latency_stats?: {
    avg_ms: number;
    p95_ms: number;
    sample_count: number;
  };
}

// ── Trust Level Transitions ──────────────────────────────────────────

/** Thresholds for automatic trust level promotion/demotion. */
export interface TrustTransitionThresholds {
  /** Min successful tasks for FirstContact → Verified (default 5) */
  promoteToVerified_minTasks: number;
  /** Min success rate for FirstContact → Verified (default 0.8) */
  promoteToVerified_minRate: number;
  /** Min successful tasks for Verified → Trusted (default 20) */
  promoteToTrusted_minTasks: number;
  /** Min success rate for Verified → Trusted (default 0.9) */
  promoteToTrusted_minRate: number;
  /** Success rate below this triggers demotion (default 0.5) */
  demote_belowRate: number;
  /** Min total tasks before demotion can trigger (default 3) */
  demote_minTasks: number;
}

/** Structural type for recursive delegation receipt walking. */
export interface DelegationReceiptLike {
  motebit_id: string;
  delegation_receipts?: DelegationReceiptLike[];
}

/**
 * A signed delegation token authorizing one agent to act on behalf of
 * another within a declared scope. The delegator signs the token body
 * (everything except `signature`) with their private key.
 *
 * Public keys are hex-encoded, matching every other motebit artifact
 * that carries an Ed25519 key; the signature is base64url-encoded per
 * the `motebit-jcs-ed25519-b64-v1` suite. `@motebit/crypto` re-exports
 * this type alongside `signDelegation` / `verifyDelegation` helpers;
 * the shape itself is the binding wire format.
 *
 * See `spec/market-v1.md §12.1` for the full spec.
 */
export interface DelegationToken {
  delegator_id: string;
  /** Delegator's Ed25519 public key, hex-encoded (64 characters, lowercase). */
  delegator_public_key: string;
  delegate_id: string;
  /** Delegate's Ed25519 public key, hex-encoded (64 characters, lowercase). */
  delegate_public_key: string;
  /** Comma-separated capability list, or `"*"` for wildcard. See market-v1 §12.3. */
  scope: string;
  issued_at: number;
  expires_at: number;
  /**
   * Optional activation time (Unix ms). Present ⇒ the token is INVALID before
   * it — `verifyDelegation` rejects when `now < not_before`. This makes
   * pre-minting honest: a standing grant's delegator can sign a future slot's
   * tick at grant-creation time (while the seed is unlocked), and that tick
   * cannot verify until its slot. Absent ⇒ active from `issued_at` (today's
   * behavior; legacy tokens replay identically). standing-delegation@1.0 §3.
   */
  not_before?: number;
  /**
   * Optional link to a {@link StandingDelegation} this token was minted under.
   * Absent ⇒ a standalone, single-act delegation (today's semantics). Present ⇒
   * one tick of a standing grant; verified against the grant via
   * `verifyTokenAgainstGrant` (scope ⊆ grant, ttl ≤ grant.max_token_ttl_ms,
   * grant not revoked). See standing-delegation@1.0 §3. Backward compatible.
   */
  grant_id?: string;
  /**
   * Cryptosuite discriminator. Always `"motebit-jcs-ed25519-b64-v1"` for
   * this artifact today. Part of the signed body — tampering breaks
   * verification. Verifiers reject missing or unknown values fail-closed.
   */
  suite: "motebit-jcs-ed25519-b64-v1";
  /** Base64url-encoded Ed25519 signature. */
  signature: string;
}

/**
 * Binds a `StandingDelegation` to a detached, content-addressed subject-scope
 * artifact — the EXACT resolved identities the grant's authority reaches —
 * without putting any vertical's identity structures inside the generic grant.
 *
 * The motivation (standing-delegation@1.1): a monitor's authority cannot be the
 * delegator-signed free-text `subject` alone, because the agent acts on RESOLVED
 * identities ("Nvidia" → `sec:cik:1045810`), and an interpreter — not the
 * delegator — does that resolution. An interpreted scope only proves "the agent
 * read the grant thus," never "the delegator authorized THESE identities." So the
 * delegator's signature must reach the resolved set. It does, transitively: the
 * delegator signs the whole `StandingDelegation` body, which carries this
 * `SubjectBindingV1`, whose `digest` content-addresses the detached artifact.
 * One sovereign signature; the detached artifact needs no second signature
 * (collision-resistance binds its bytes to the signed digest — the same move as
 * `SignedRequestEnvelope.payload_digest`).
 *
 * Generic by construction: the detached artifact's TYPE is named in
 * `artifact_schema` (e.g. agency's `"motebit.monitor-scope.v1"`), so the grant
 * stays free of vertical payloads and a future non-monitoring consumer reuses
 * this same primitive. NOTE: `digest_method` is deliberately NOT a `suite` —
 * `suite` is reserved for SIGNATURE cryptosuites (`SuiteId`); this is a HASH.
 */
export interface SubjectBindingV1 {
  /** This binding's own type tag. Carried in the signed bytes (in-body domain
   *  separation, per motebit convention — no raw-byte prefix). */
  schema: "motebit.subject-binding.v1";
  /** Declared type of the detached artifact this digest addresses. The verifier
   *  MUST check the presented artifact's own `schema` equals this, fail-closed —
   *  so a different artifact type cannot be substituted under the bound digest. */
  artifact_schema: string;
  /**
   * How `digest` was computed, fail-closed: `"jcs-sha256-hex"` =
   * `hex(SHA-256(canonicalJson(artifact)))` — the same digest primitive as
   * `SignedRequestEnvelope.payload_digest`. A new hash (PQ) is a new literal
   * here, never a silent change. NOT a `suite` — a digest method, not a
   * signature scheme.
   */
  digest_method: "jcs-sha256-hex";
  /** `hex(SHA-256(canonicalJson(detached artifact)))`, 64 lowercase. Recompute
   *  from the artifact AS RECEIVED so JSON whitespace can't break the match. */
  digest: string;
}

/**
 * The delegator's signed autonomous-spend ceiling (standing-delegation@1.2) —
 * the HOW-MUCH a standing grant authorizes, as a cryptographic commitment.
 * Rides in the grant's signed body, so the delegator's signature covers it;
 * an enforcer MUST take its ceiling from a VERIFIED grant, never from local
 * config (the ceiling is authority, and authority comes only from signed
 * artifacts — memory-never-confers-authority applied to money).
 *
 * Every limit is in integer micro-units, **USD-denominated** (1 USD =
 * 1,000,000) — the denomination is pinned by spec prose, not a field; a
 * future non-USD asset is a new agility axis (a new `schema` literal), never
 * a silent reinterpretation of these numbers. Absent ⇒ the grant authorizes
 * NO autonomous money (enforcers deny `ceiling_absent`, fail-closed) — so a
 * @1.0/@1.1 grant cannot move money, and adding this field is additive.
 *
 * Semantics (enforced by the blast-radius evaluator, `@motebit/policy`):
 * at least one of `cumulative_limit_micro` / `lifetime_limit_micro` MUST be
 * set or the ceiling authorizes nothing; a SET limit of `0` denies all
 * positive spend on that dimension; per-window limits require `window_ms`.
 * These ceilings bind the trusted-runtime/online path — offline, the binding
 * bounds are the grant's `expires_at` and counterparty-side enforcement
 * (see spec §3.3 threat model).
 */
export interface SpendCeilingV1 {
  /** This ceiling's own type tag (in-body domain separation). A new
   *  denomination/asset model is a NEW literal, never a silent change. */
  schema: "motebit.spend-ceiling.v1";
  /** Max cumulative spend (micro-USD) within one rolling window. Requires `window_ms`. */
  cumulative_limit_micro?: number;
  /** Max spend (micro-USD) to any single canonical counterparty within one window. Requires `window_ms`. */
  per_counterparty_limit_micro?: number;
  /** Max number of money actions within one window. Requires `window_ms`. */
  max_action_count?: number;
  /** Max cumulative spend (micro-USD) over the grant's ENTIRE life — never
   *  reset by a window roll. The offline-meaningful total bound (paired with
   *  the grant's `expires_at`). */
  lifetime_limit_micro?: number;
  /** Rolling window length in ms. Required (> 0) when any per-window limit is set. */
  window_ms?: number;
}

/**
 * A standing (open-ended-feeling, cadence-scoped, revocable) delegation grant.
 * Unlike a {@link DelegationToken} — which authorizes ONE act and is short-lived
 * by invariant — a StandingDelegation authorizes its holder to MINT short-lived
 * per-tick `DelegationToken`s within a fixed scope ceiling and cadence, for a
 * long-but-finite, revocable lifetime. The standing authority lives only here;
 * each minted token stays 1h/task-scoped; revocation lives on the grant (a
 * signed {@link DelegationRevocation}). Forcing use case: a standing monitor
 * ("daily research on subject S until revoked"). See standing-delegation@1.0.
 */
export interface StandingDelegation {
  /** UUID v7. The stable handle a {@link DelegationRevocation} targets. */
  grant_id: string;
  delegator_id: string;
  /** Delegator's Ed25519 public key, hex-encoded (64 lowercase). The verify key. */
  delegator_public_key: string;
  delegate_id: string;
  /** Delegate's Ed25519 public key, hex-encoded (64 lowercase). */
  delegate_public_key: string;
  /**
   * Comma-separated capability CEILING, or `"*"`. Each minted per-tick token's
   * scope must narrow within this (same grammar as `DelegationToken.scope`).
   */
  scope: string;
  /**
   * Human-meaningful binding (e.g. `"research:thesis=acme-q3"`). Opaque to
   * verification; carried for receipt-linkage and operator legibility.
   */
  subject: string;
  /**
   * Optional (standing-delegation@1.1). Digest-binds the resolved subject-scope
   * artifact this grant's authority reaches (see {@link SubjectBindingV1}). It is
   * part of the signed body, so the delegator's signature covers the resolved
   * scope — closing the "an interpreter, not the delegator, chose these
   * identities" gap. Absent ⇒ a @1.0 grant with no signed resolved scope;
   * higher-assurance consumers (e.g. verified monitors) MUST fail closed and
   * refuse such a grant. NOT a capability `scope` — this names the concrete
   * SUBJECTS, the `scope` field names the permitted CAPABILITIES.
   */
  subject_binding?: SubjectBindingV1;
  /**
   * Optional (standing-delegation@1.2). The delegator's signed autonomous-spend
   * ceiling (see {@link SpendCeilingV1}) — the HOW-MUCH this grant authorizes.
   * Part of the signed body. Absent ⇒ the grant authorizes NO autonomous money
   * (blast-radius enforcers deny `ceiling_absent`, fail-closed) — which is what
   * makes this field additive: a @1.0/@1.1 grant verifies unchanged and simply
   * cannot move money.
   */
  spend_ceiling?: SpendCeilingV1;
  /** Authorized minimum firing interval (ms). Enforced at mint/relay time, not by single-token verify. */
  cadence_ms: number;
  issued_at: number;
  /** Optional activation delay. Null ⇒ active from `issued_at`. */
  not_before: number | null;
  /**
   * Grant expiry (Unix ms). Long-but-finite and renewable — NOT open-ended:
   * revocation has a propagation horizon, so a grant that outlives revocation
   * reachability would be unsafe. The delegate renews by re-signing. See
   * standing-delegation@1.0 §6 D1.
   */
  expires_at: number;
  /** Ceiling on each minted token's `(expires_at - issued_at)` — keeps per-tick tokens short-lived. */
  max_token_ttl_ms: number;
  /** Cryptosuite discriminator. Always `"motebit-jcs-ed25519-b64-v1"` today. */
  suite: "motebit-jcs-ed25519-b64-v1";
  /** Base64url-encoded Ed25519 signature over JCS(body). */
  signature: string;
}

/**
 * Stateless request authentication from a registered identity — the key is
 * the login. Binds the requesting `motebit_id`, a timestamp, a digest of the
 * (detached) request body, and an audience into one Ed25519 signature,
 * verified against the identity's REGISTERED public key — never a key the
 * request self-asserts. The stateless sibling of `auth-token@1.0`, for a
 * different caller and trust root. Spec: `spec/signed-request-envelope-v1.md`.
 */
export interface SignedRequestEnvelope {
  /** Requesting identity. The verifier resolves the Ed25519 key for this id
   *  from its registry; a key carried by the request is never trusted. */
  motebit_id: string;
  /** Unix ms at signing. Freshness, not entropy — verifiers reject when
   *  `|now − ts|` exceeds the freshness window (default ±300s). */
  ts: number;
  /** SHA-256 of `canonicalJson(payload)`, hex-encoded (64 lowercase). Binds
   *  the detached request body to the envelope; recomputed from the body as
   *  received, so JSON whitespace differences do not break verification. */
  payload_digest: string;
  /** Audience — free-form string (deliberately NOT the `TokenAudience`
   *  registry; request audiences are finer-grained), convention `"{host}/{route}"`.
   *  Exact-match at the verifier, fail-closed; kills cross-service replay. */
  aud: string;
  /** Optional. Present ⇒ the signer requests replay-once semantics; verifiers
   *  offering them dedup within the freshness window. Absent ⇒ a within-window
   *  replay re-executes the same idempotent operation. */
  nonce?: string;
  /** Cryptosuite discriminator. Always `"motebit-jcs-ed25519-b64-v1"`. */
  suite: "motebit-jcs-ed25519-b64-v1";
  /** Base64url-encoded Ed25519 signature over `canonicalJson(body)` where
   *  `body` = this object minus `signature`. Verify with the REGISTERED key. */
  signature: string;
}

/**
 * A signed revocation of a {@link StandingDelegation}. Only the grant's
 * delegator can sign one (verified against `delegator_public_key`). Self-
 * contained and offline-verifiable like the token — it carries the delegator's
 * public key so a third party verifies it without relay contact, then matches
 * it to the grant. It is the canonical, append-only-feed source of truth for
 * grant revocation; a relay deny-list is a cache, not the authority
 * (self-attesting-system doctrine). Revocation is terminal in v1.
 */
export interface DelegationRevocation {
  /** The {@link StandingDelegation.grant_id} being revoked. */
  grant_id: string;
  delegator_id: string;
  /** Delegator's Ed25519 public key, hex-encoded (64 lowercase). The verify key. */
  delegator_public_key: string;
  revoked_at: number;
  /** Cryptosuite discriminator. Always `"motebit-jcs-ed25519-b64-v1"` today. */
  suite: "motebit-jcs-ed25519-b64-v1";
  /** Base64url-encoded Ed25519 signature over JCS(body). */
  signature: string;
}

// === Settlement invoice (settlement-invoice@1.0) ===
// The settlement-layer members of the receipt family — the bill a customer
// re-derives offline. motebit owns the FORMAT; the issuer runs the rails. There
// is no charge/balance/ledger primitive here, ever. Spec: spec/settlement-invoice-v1.md.
// Doctrine: docs/doctrine/clearing-house-not-thin-waist.md.

/**
 * An issuer-signed declaration of the cost of ONE execution, in integer nano-USD
 * against a named rate table — the thing summed by an {@link InvoiceV1}. Separate
 * from the `ExecutionReceipt` by design: cost is a declaration ("what we computed,
 * by these rates"), not the receipt's proof ("this work happened"). Correctable via
 * supersession (a new `attestation_id` against the same receipt) without re-signing
 * the immutable receipt. Signed/verified by `@motebit/crypto`
 * `signCostAttestation`/`verifyCostAttestation`.
 */
export interface CostAttestationV1 {
  schema: "motebit.cost-attestation.v1";
  /** UUIDv7. A supersession is a NEW id (spec §3.3). */
  attestation_id: string;
  /** The {@link ExecutionReceipt.task_id} this prices (human/index handle). */
  receipt_id: string;
  /** `executionReceiptDigest(receipt)` over the full signed receipt — binds the cost to the exact receipt. */
  receipt_digest: DigestRef;
  /** The cost, in integer nano-USD (1 USD = 1e9 nano). Positive. */
  cost_nanos: number;
  /** The versioned rate table the cost was computed under (e.g. `"agency-rates-v1"`). */
  rate_table_id: string;
  /** Issuer-owned label for what the cost accounts for (rate-table basis). Opaque to motebit. */
  covers: string;
  /** The issuer's motebit_id / did. */
  issuer_id: string;
  /** Issuer Ed25519 public key, hex (64 lowercase). OPTIONAL (TOFU); verify against the REGISTERED key. */
  issuer_public_key?: string;
  /** ms epoch. MUST be >= the receipt's `completed_at` — a cost can't be attested before the work finished. */
  attested_at: number;
  suite: "motebit-jcs-ed25519-b64-v1";
  /** Base64url Ed25519 over JCS(body). */
  signature: string;
}

/** One billed line of an {@link InvoiceV1} — binds to a receipt and the cost attestation that priced it. */
export interface InvoiceLineItem {
  /** The billed {@link ExecutionReceipt.task_id}. */
  receipt_id: string;
  /** `executionReceiptDigest(receipt)` — binds the line to the exact receipt. */
  receipt_digest: DigestRef;
  /** The passthrough cost for this line, integer nano-USD. Non-negative. */
  cost_nanos: number;
  /** `costAttestationDigest(att)` — binds the line to the {@link CostAttestationV1} that priced it. */
  cost_attestation_digest: DigestRef;
}

/**
 * An issuer-signed demand for payment: a flat fee per signed outcome plus passthrough
 * compute bounded by the summed {@link CostAttestationV1} costs — re-derivable and
 * refusable offline. Amounts are minor units (cents); cost references carry nano-USD to
 * preserve the `≤`/floor passthrough law. Idempotency is the issuer's stateful ledger,
 * never the artifact. Signed/verified by `signInvoice`/`verifyInvoice`.
 */
export interface InvoiceV1 {
  schema: "motebit.invoice.v1";
  /** UUIDv7. The bill's idempotency anchor. */
  invoice_id: string;
  issuer_id: string;
  /** hex, optional; verify against the registered key. */
  issuer_public_key?: string;
  /** Opaque issuer-owned addressing token. NOT PII. */
  customer_ref: string;
  currency: "USD";
  /** ms epoch, inclusive. */
  period_start: number;
  /** ms epoch, exclusive. */
  period_end: number;
  line_items: InvoiceLineItem[];
  /** The per-outcome flat fee, minor units (cents). Non-negative. */
  flat_fee_minor: number;
  /** Passthrough compute, minor units. Bounded by `passthrough_cost_minor <= floor(Σ cost_nanos / 1e7)`. */
  passthrough_cost_minor: number;
  /** `flat_fee_minor + passthrough_cost_minor`. The verifier recomputes. */
  total_minor: number;
  rate_table_id: string;
  issued_at: number;
  suite: "motebit-jcs-ed25519-b64-v1";
  signature: string;
}

/** Per-axis verdict from `verifyCostAttestation` (structured, never a naked boolean). */
export interface CostAttestationVerdict {
  /** All MUST axes hold. */
  valid: boolean;
  /** Signature verifies against the registered issuer key. */
  signature_valid: boolean;
  /** `cost_nanos` is a positive safe integer. */
  cost_positive: boolean;
  /** Digest+issuer binding to the supplied receipt — `unchecked` when no receipt was supplied. */
  binding: "valid" | "invalid" | "unchecked";
  /** `attested_at >= receipt.completed_at` — `unchecked` when the receipt/`completed_at` is absent. */
  temporal: "valid" | "invalid" | "unchecked";
}

/** Per-axis verdict from `verifyInvoice` (structured — so "valid against the cite" and "stale vs latest" are distinct). */
export interface InvoiceVerdict {
  /** All MUST axes hold (idempotency + stale-cost are detectable, not gating). */
  valid: boolean;
  signature_valid: boolean;
  /** `total == flat + passthrough`, all amounts non-negative safe integers. */
  arithmetic: boolean;
  /** `passthrough_cost_minor <= floor(Σ line.cost_nanos / 1e7)`. */
  passthrough_cap: boolean;
  /** Each line resolves to its cited cost attestation (schema-checked) and `line.cost_nanos <= att.cost_nanos`. */
  per_line_binding: "valid" | "invalid" | "unchecked";
  /** Every referenced receipt/attestation shares the invoice's issuer. */
  issuer_consistency: "valid" | "invalid" | "unchecked";
  /** A receipt_id seen across supplied invoices — detectable, not gating. */
  idempotency: "ok" | "duplicate_detected" | "unchecked";
  /** Passthrough overstates the LATEST non-superseded cost (the §3.3 customer-protection axis) — detectable, not gating. */
  stale_cost_overstatement: "none" | "detected" | "unchecked";
}

export enum SensitivityLevel {
  None = "none",
  Personal = "personal",
  Medical = "medical",
  Financial = "financial",
  Secret = "secret",
}

export enum EventType {
  IdentityCreated = "identity_created",
  StateUpdated = "state_updated",
  MemoryFormed = "memory_formed",
  MemoryDecayed = "memory_decayed",
  MemoryDeleted = "memory_deleted",
  MemoryAccessed = "memory_accessed",
  ProviderSwapped = "provider_swapped",
  ExportRequested = "export_requested",
  DeleteRequested = "delete_requested",
  SyncCompleted = "sync_completed",
  AuditEntry = "audit_entry",
  ToolUsed = "tool_used",
  PolicyViolation = "policy_violation",
  GoalCreated = "goal_created",
  GoalExecuted = "goal_executed",
  GoalRemoved = "goal_removed",
  ApprovalRequested = "approval_requested",
  ApprovalApproved = "approval_approved",
  ApprovalDenied = "approval_denied",
  ApprovalExpired = "approval_expired",
  GoalCompleted = "goal_completed",
  GoalProgress = "goal_progress",
  MemoryAudit = "memory_audit",
  MemoryPinned = "memory_pinned",
  PlanCreated = "plan_created",
  PlanStepStarted = "plan_step_started",
  PlanStepCompleted = "plan_step_completed",
  PlanStepFailed = "plan_step_failed",
  PlanCompleted = "plan_completed",
  PlanStepDelegated = "plan_step_delegated",
  CredentialRevoked = "credential_revoked",
  IdentityRevoked = "identity_revoked",
  PlanFailed = "plan_failed",
  HousekeepingRun = "housekeeping_run",
  ReflectionCompleted = "reflection_completed",
  IdleTickFired = "idle_tick_fired",
  MemoryConsolidated = "memory_consolidated",
  MemoryPromoted = "memory_promoted",
  ConsolidationCycleRun = "consolidation_cycle_run",
  ConsolidationReceiptSigned = "consolidation_receipt_signed",
  ConsolidationReceiptsAnchored = "consolidation_receipts_anchored",
  AgentTaskCompleted = "agent_task_completed",
  AgentTaskFailed = "agent_task_failed",
  AgentTaskDenied = "agent_task_denied",
  ProposalCreated = "proposal_created",
  ProposalAccepted = "proposal_accepted",
  ProposalRejected = "proposal_rejected",
  ProposalCountered = "proposal_countered",
  CollaborativeStepCompleted = "collaborative_step_completed",
  ChainTrustComputed = "chain_trust_computed",
  TrustLevelChanged = "trust_level_changed",
  KeyRotated = "key_rotated",
  // Computer-use session lifecycle — opened/closed by `createComputerSessionManager`
  // on `openSession()` / `closeSession()`. Third parties replay the audit trail
  // via the session_id → observation-action sequence binding.
  ComputerSessionOpened = "computer_session_opened",
  ComputerSessionClosed = "computer_session_closed",
  // v1.5 — session-summary receipt. Emitted at closeSession time after
  // the structural roll-up has been signed under
  // `motebit-jcs-ed25519-b64-v1`. Payload is the signed
  // `ComputerSessionReceipt`. Verifiers replaying the audit log gain
  // a single self-verifiable artifact per session, in addition to the
  // open/close lifecycle pair already on the trail.
  ComputerSessionSummarized = "computer_session_summarized",
  // Co-browse control transitions (Slice 0). Every change to who's
  // driving an isolated-browser session — `user → motebit`,
  // `motebit → user`, requests, grants, denies, pauses, disconnect-
  // induced reverts — emits one of these. Verifiers replaying the
  // event log can rebuild the control state machine independently;
  // the agent can `list_events` to know who was driving when.
  CoBrowseControlChanged = "co_browse_control_changed",
  // Co-browse user-driven input forward (Slice 2c). Emitted on
  // every user input attempt against the cloud Chromium —
  // forwarded clicks/keys/pastes when `controlState.kind === "user"`,
  // rejections (gate denied, transport error) on every other
  // outcome. Payload (`UserInputForwardedPayload` in co-browse.ts)
  // is REDACTED by construction: keys log as character_class +
  // key_role, pastes log length + line_count + looks_like_url,
  // pointer events log normalized [0, 1] coordinates. Raw text
  // never lands in the audit. The `control_state_at_forwarding`
  // field mirrors `control_state_at_denial` on motebit-side denials
  // so verifiers replaying the log don't have to cross-reference
  // adjacent control events for context.
  UserInputForwarded = "user_input_forwarded",
  // Skill load — per-skill audit entry emitted by the runtime when the
  // SkillSelector pulls a skill body into the system context. One event
  // per selected skill, keyed to the run that triggered the load. See
  // spec/skills-v1.md §7.4 and SkillLoadPayload in skills.ts.
  SkillLoaded = "skill_loaded",
  // Sensitivity gate fired — emitted by `assertSensitivityPermitsAiCall`
  // when the runtime blocks an AI-call entry because effective session
  // sensitivity exceeds the provider's tier permission. Converts the
  // shipped fail-closed gate from invisible-but-correct to
  // observable-and-provable. Payload: `SensitivityGateFiredPayload` in
  // `perception.ts`. STRICTLY metadata — never raw drop / tool / slab
  // content. Doctrine: motebit-computer.md §"Mode contract" and the
  // four-egress closure arc.
  SensitivityGateFired = "sensitivity_gate_fired",
  // Emitted by the runtime when `SecretRedactingProvider` masks credential-class
  // secrets a user typed into an UNMARKED cloud session, before the payload reaches
  // a non-sovereign provider. The sibling of `SensitivityGateFired` on the same
  // privacy-egress axis: the gate BLOCKS a marked-sensitive session; this RECORDS a
  // redaction in an unmarked one — turning the otherwise-silent transform into an
  // observable, inspectable trail. Payload: `SecretRedactedFromEgressPayload` in
  // `perception.ts`. STRICTLY metadata — count + credential-class label names, never
  // the secret content. Doctrine: security-boundaries.md.
  SecretRedactedFromEgress = "secret_redacted_from_egress",
}

export enum MemoryType {
  Episodic = "episodic",
  Semantic = "semantic",
}

// === Core Identity ===

export interface MotebitIdentity {
  readonly motebit_id: MotebitId;
  readonly created_at: number;
  readonly owner_id: string;
  version_clock: number;
}

// === Memory ===

/** Cognition-facing memory content — what the agent's mind sees. */
export interface MemoryContent {
  content: string;
  confidence: number;
  sensitivity: SensitivityLevel;
  memory_type?: MemoryType;
  valid_from?: number;
  valid_until?: number | null;
  /**
   * Provenance — who contributed this fact (see `MemorySource`).
   * Optional on reads: nodes formed before provenance tracking (or
   * synced from peers with unknown vocabularies) have no source and
   * render as provenance `unknown` — honestly absent, never fabricated.
   * Required at formation entry points via `AttributedMemoryCandidate`.
   */
  source?: MemorySource;
  /**
   * Local turn identifier of the conversation turn this memory formed
   * in, when formation was turn-scoped. Local provenance only — never
   * on the wire (turn ids have no cross-device meaning).
   */
  source_turn_id?: string;
}

export interface MemoryCandidate {
  content: string;
  confidence: number;
  sensitivity: SensitivityLevel;
  memory_type?: MemoryType;
  /**
   * Provenance, assigned by the FORMING CODE PATH — never parsed from
   * model output (`extractMemoryTags` has no source attribute) and
   * never accepted from a peer's self-declaration. Optional here
   * because tag extraction produces unattributed candidates; the
   * formation boundary requires `AttributedMemoryCandidate`.
   */
  source?: MemorySource;
  /** Local turn id stamped by the loop when formation is turn-scoped. */
  source_turn_id?: string;
}

/**
 * A `MemoryCandidate` whose provenance has been declared. The formation
 * entry points (`formMemory`, `consolidateAndForm`,
 * `formMemoriesFromCandidates`) take THIS type, not `MemoryCandidate` —
 * so every new formation call site is a compile error until it declares
 * a source. Asymmetric-typing enforcement, same shape as
 * `WritableSettlementMode`: reads stay open for legacy data; writes are
 * structurally closed.
 *
 * The key is REQUIRED but the value admits explicit `undefined`: a
 * call site must always write `source: …`, and `source: undefined` is
 * a deliberate declaration of unknown provenance — used only where
 * provenance legitimately cannot be known, e.g. a supersede that
 * inherits from a pre-provenance legacy node. Declared-unknown beats
 * fabricated; omission stays impossible.
 */
export type AttributedMemoryCandidate = MemoryCandidate & {
  source: MemorySource | undefined;
};

// === Event Log ===

export interface EventLogEntry {
  event_id: EventId;
  motebit_id: MotebitId;
  /** Device that originated this event (for multi-device conflict resolution) */
  device_id?: DeviceId;
  timestamp: number;
  event_type: EventType;
  payload: Record<string, unknown>;
  version_clock: number;
  tombstoned: boolean;
}

// === Risk Model ===

export enum RiskLevel {
  R0_READ = 0,
  R1_DRAFT = 1,
  R2_WRITE = 2,
  R3_EXECUTE = 3,
  R4_MONEY = 4,
}

export enum DataClass {
  PUBLIC = "public",
  PRIVATE = "private",
  SECRET = "secret",
}

export enum SideEffect {
  NONE = "none",
  REVERSIBLE = "reversible",
  IRREVERSIBLE = "irreversible",
}

export interface ToolRiskProfile {
  risk: RiskLevel;
  dataClass: DataClass;
  sideEffect: SideEffect;
  requiresApproval: boolean;
}

/** M-of-N approval quorum configuration. */
export interface ApprovalQuorum {
  /** Number of approvals required (M). */
  threshold: number;
  /** Authorized approver identifiers. */
  approvers: string[];
  /** Minimum risk level that triggers quorum (optional — default: all approval-required tools). */
  risk_floor?: string;
}

/**
 * The typed residual of a refused (or approval-raised) authority check —
 * WHAT is missing, as data, so owner surfaces can render the exact
 * repair instruction ("mint the difference") instead of prose.
 *
 * Two invariants, both load-bearing:
 *
 * ASYMMETRY — the delta is OWNER-FACING. Model-visible channels (tool
 * results pushed into conversation history) carry only the coarse
 * `reason` string: a precise residual is a boundary oracle, and
 * "you need exactly publish.external and $0.40 more" is also a
 * perfectly optimized social-engineering script aimed at the one party
 * who can mint the difference. Owner surfaces (stream chunks, audit
 * log, pre-flight) get precision; the model keeps today's actionable
 * category, never the oracle.
 *
 * PREDICTOR, NEVER AUTHORITY — the delta describes a boundary's
 * refusal; it never participates in allowing anything. The gate and
 * the money meter remain the sole enforcement authorities.
 *
 * Closed field set (extend by registry-append discipline, never by a
 * generic effect-algebra parameter). Sibling of `Semiring` on the
 * algebra floor: the semiring answers "which path is best"; the delta
 * answers "what authority is missing". Money is integer micro-units
 * (`number`, wire-safe) per the repo money model.
 */
export interface AuthorityDelta {
  /** Scope entries the delegated scope lacks (e.g. the denied tool name). */
  missing_scope?: string[];
  /** The action's risk level. */
  required_risk?: RiskLevel;
  /** The ceiling the governance posture permits (deny threshold or max risk). */
  posture_ceiling?: RiskLevel;
  /** R4 without a verified standing grant: the missing authority IS a grant
   *  (or a live human approval) — memory-never-confers-authority. */
  requires_verified_grant?: true;
  /** Micro-USD by which the attempted spend exceeds remaining ceiling. */
  spend_overage_micro?: number;
  /** Epoch ms when the next authority window opens (tick schedule). */
  not_before?: number;
  /** Approvals still needed to meet the configured quorum. */
  quorum_shortfall?: number;
  /** Terminal states: no residual exists; re-mint is the only repair. */
  terminal?: "revoked" | "expired";
}

export interface PolicyDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reason?: string;
  budgetRemaining?: { calls: number; timeMs: number; cost: number };
  /** When quorum is required, contains the quorum metadata. */
  quorum?: { required: number; approvers: string[]; collected: string[] };
  /** Owner-facing typed residual of a refusal/raise. See `AuthorityDelta`
   *  for the asymmetry + predictor invariants. */
  missing_authority?: AuthorityDelta;
}

export interface TurnContext {
  turnId: string;
  runId?: string;
  toolCallCount: number;
  turnStartMs: number;
  costAccumulated: number;
  /** Caller motebit ID — set in MCP server mode when caller presents a signed token. */
  callerMotebitId?: string;
  /** Caller trust level — set in MCP server mode for identity-aware policy decisions. */
  callerTrustLevel?: AgentTrustLevel;
  /** Type of the remote motebit making the call (personal/service/collaborative). */
  remoteMotebitType?: string;
  /** Delegation scope — when set, only tools within this scope are allowed. */
  delegationScope?: string;
  /**
   * Cryptographically verified standing-delegation grant covering this
   * turn. Populated EXCLUSIVELY by the runtime's dispatch-layer grant
   * verifier after `verifyStandingDelegation` + `verifyTokenAgainstGrant`
   * + a revocation check pass on signed artifacts — never from model
   * output, recalled memory, trust level, or configuration. Its sole
   * consumer is the policy gate's standing-authority invariant: an
   * R4_MONEY tool call auto-executes only when this is present;
   * otherwise it requires live human approval regardless of any
   * approval-lowering path. Doctrine:
   * `docs/doctrine/memory-never-confers-authority.md`.
   */
  verifiedGrant?: {
    /** UUIDv7 grant id of the verified `StandingDelegation`. */
    grant_id: string;
    /** Unix ms at which verification completed. */
    verified_at: number;
    /**
     * The verified tick token's signed `issued_at` — the monotonic replay
     * nonce for the blast-radius enforcer (one tick meters at most one
     * money action). Signature-derived by the sole producer; absent on
     * pre-@1.2 producers.
     */
    token_issued_at?: number;
    /**
     * The verified grant's signed `spend_ceiling` (standing-delegation@1.2),
     * copied verbatim by the sole producer from the artifact it verified —
     * the only path a ceiling may take to the dispatch enforcer (spec §3.3
     * rule 2). Absent ⇒ no ceiling ⇒ `ceiling_absent` deny, no money moves.
     */
    spend_ceiling?: SpendCeilingV1;
  };
}

export interface InjectionWarning {
  detected: boolean;
  patterns: string[];
  directiveDensity?: number;
  structuralFlags?: string[];
}

export interface ToolAuditEntry {
  turnId: string;
  runId?: string;
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  decision: PolicyDecision;
  result?: { ok: boolean; durationMs: number };
  injection?: InjectionWarning;
  costUnits?: number;
  timestamp: number;
  /**
   * Sensitivity tier classified at write time. Optional in v1: pre-
   * phase-5 entries drop the field, and the consolidation-cycle flush
   * phase lazy-classifies on read per docs/doctrine/retention-policy.md
   * §"Decision 6b". Tool-audit entries also carry an obligation floor
   * resolved per record (settlement window, dispute window, regulatory
   * floor); the cycle's flush phase computes
   * `max(sensitivity_floor, obligation_floor)` per decision 3.
   */
  sensitivity?: SensitivityLevel;
}

// === Tools ===

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
  requiresApproval?: boolean;
  /** Risk hint for PolicyGate classification. If absent, inferred from name/description. */
  riskHint?: {
    risk?: RiskLevel;
    dataClass?: DataClass;
    sideEffect?: SideEffect;
  };
  /**
   * Cost-tier declaration driving registry sort order. `api` (cheap,
   * structured) ranks above `ax` (structured accessibility tree) above
   * `pixels` (screen capture + synthetic input). Untagged tools sort
   * last. See `@motebit/protocol/tool-mode`.
   */
  mode?: ToolMode;
  /**
   * Outbound axis — true when execution sends bytes outside the device
   * (HTTP fetch, search-engine query, MCP server call,
   * cross-motebit delegation). Independent of `riskHint` (which
   * captures local risk: file overwrite, irreversible side effect).
   *
   * Consumed by the runtime's sensitivity-routing gate: an outbound
   * tool refuses to execute when session sensitivity is
   * medical/financial/secret AND the configured provider is not
   * sovereign — the same fail-closed contract that gates AI provider
   * calls (CLAUDE.md privacy doctrine: "Medical/financial/secret never
   * reach external AI"; the principle generalizes to any outbound
   * surface). Default `false`/absent ≡ local — matches the
   * pre-existing builtin set (read_file, recall_memories, current_time).
   *
   * Tools added through `@motebit/mcp-client` always set this to
   * `true` (MCP tools execute against a remote server by definition).
   * See `check-tool-modes` for the cost-tier sibling and
   * `check-sensitivity-routing` for the outbound enforcement gate.
   */
  outbound?: boolean;
  /**
   * Embodiment mode the slab item should stamp when this tool's
   * activity lands on the slab. One of: `"mind"` | `"tool_result"` |
   * `"virtual_browser"` | `"shared_gaze"` | `"desktop_drive"` |
   * `"peer_viewport"`. The string union is canonically declared as
   * `EmbodimentMode` in `@motebit/render-engine` (typed as `string`
   * here to avoid the protocol→render-engine layer break — promoting
   * the type into `@motebit/protocol` is a separate slice the doctrine
   * names as deferred).
   *
   * Why this lives on the tool definition (not on each chunk): the
   * embodiment is determined at registration time by the surface
   * wiring the dispatcher. The `computer` tool's wire format is
   * surface-agnostic but its embodiment is dispatcher-specific:
   * `apps/web/src/computer-tool.ts` registers it with
   * `embodimentMode: "virtual_browser"` (cloud Chromium); the desktop
   * surface registers the same name with `embodimentMode:
   * "desktop_drive"` (real OS). The runtime's slab-projection picks
   * `chunk.mode` (sourced from this field) over `tool-policy.ts`'s
   * generic floor — so the same tool name produces the right
   * embodiment per surface without forcing surface-aware code into
   * the central registry. Doctrine: motebit-computer.md §"v1
   * implementation status — Deferred to v1.5+: per-dispatcher mode
   * stamping" — landed as v1.1 of the virtual_browser arc.
   */
  embodimentMode?: string;
  /**
   * Slab-projection policy for this tool. Closed string-literal union:
   *
   *   - `"tool_call"` (default when omitted) — open a generic
   *     `tool_call` slab item on each invocation. The familiar
   *     "REQUEST_X / calling…" card. Right for tools that produce
   *     body acts (web_search, read_file, computer).
   *   - `"none"` — do NOT open a slab item. The tool is **state
   *     chrome**, not a body act, and its visible representation is
   *     a different surface (e.g. `request_control`'s visible
   *     surface is the slab control band, not a tool_call card).
   *     Without this, state-chrome tools would render duplicate UI:
   *     the affordance card AND the chrome both visible, competing
   *     for attention and obscuring the band's Grant/Deny buttons.
   *
   * Doctrine: motebit-computer.md — slab content is body acts
   * (browser, peer viewport, memory artifact, tool result, desktop
   * surface). Slab CHROME is state-aware overlays (control band,
   * address bar, halt indicator). State-chrome tools belong in the
   * latter; the slab item projection is for the former.
   *
   * Plumbing: read on the tool_status chunk by ai-core's loop.ts
   * and consumed by the runtime's slab-projection at open time.
   * The closed-string-literal union keeps additions backward
   * compatible (a future `"observation"` variant could narrow
   * further without breaking existing consumers).
   */
  slabProjection?: "none" | "tool_call";
  /**
   * When this tool's money facts become known — the R4 metering axis
   * (standing-delegation §3.3; the loop's gate-allow ∧ meter-allow
   * AND-composition):
   *
   * - `"args"` (default when absent): the spend is declared in the tool
   *   call's own args (`amount_micro` + `counterparty`), so the loop
   *   meters BEFORE execution and denies unmeterable calls.
   * - `"late"`: the spend materializes inside execution (e.g. a
   *   delegation quote resolved after worker discovery). The loop still
   *   requires a verified grant + a wired meter to let a grant-cleared
   *   call proceed, but the metering itself happens at the RAIL seam —
   *   the runtime binds the payment builder only through the metering
   *   wrapper (`wrapP2pPaymentWithMeter`, gate `check-ceiling-from-grant`),
   *   which refuses the broadcast on deny. Declaring `"late"` without
   *   rail-seam metering is the drift that gate exists to catch.
   *
   * Closed literal union, additions backward compatible — same
   * discipline as `slabProjection`.
   */
  moneyBinding?: "args" | "late";
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  /**
   * Optional structured failure category, set by handlers that wrap
   * a typed error carrying its own `reason` field (e.g.
   * `ComputerDispatcherError`). Lets downstream consumers route on
   * category without parsing the human-readable `error` text.
   *
   * v1 carriers:
   *   - `not_in_control` — Slice 1 co-browse gate denial. The
   *     runtime's slab projection uses this to suppress a body
   *     `tool_call` item: control-state denials' canonical surface
   *     is the slab control band (Slice 2b doorbell), not the body.
   *
   * Open string-literal — additive. New reason categories land
   * without breaking existing callers (consumers either route on
   * the value they care about or ignore the field).
   */
  reason?: string;
  /** Set by adapters that already applied boundary wrapping (e.g. MCP client). */
  _sanitized?: boolean;
  /**
   * Content digest of the RAW retrieved primary-source bytes, set by a
   * fetch-type tool (today: `read_url`) ONLY when the returned `data` is a
   * verbatim span of those raw bytes — i.e. re-derivable by a third party who
   * re-fetches the source with no shared extraction code (`text/*` non-HTML).
   * Its PRESENCE is the signal that `data` is raw-byte-addressable; absent for
   * extracted/reformatted output (HTML, pretty-printed JSON) where a span is not
   * re-derivable without a published projection recipe. The producer threads this
   * into the signed receipt's `source_digest`, which a citation builder copies
   * into `Citation.provenance` (evidence-provenance, raw-byte path). Optional and
   * ignored by every tool/consumer that doesn't set or read it.
   */
  source_digest?: DigestRef;
  /**
   * The app-owned projection recipe id whose output `data` is (e.g.
   * `"agency.html-text.v1"` for `read_url` over HTML). Set ONLY alongside
   * {@link source_digest} when `data` is NOT the raw bytes verbatim but a
   * byte-deterministic transform of them — so a citation's span is re-checkable by
   * re-fetching the raw bytes (digest) and re-applying the named recipe. ABSENT on
   * the raw-byte path (`text/*`), where the span is located over the raw bytes
   * directly. Copied into `Citation.provenance.projection`; the domain-blind verifier
   * resolves it via an injected `resolveProjection`. Back-compat by absence.
   */
  source_projection?: string;
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

export interface ToolRegistry {
  list(): ToolDefinition[];
  execute(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  register(tool: ToolDefinition, handler: ToolHandler): void;
  /** Replace the handler for an existing tool, or register if new. */
  replace?(tool: ToolDefinition, handler: ToolHandler): void;
  /** Remove a tool from the registry. Returns true if it existed. */
  unregister?(name: string): boolean;
}

// === Privacy ===

export interface AuditRecord {
  audit_id: string;
  motebit_id: MotebitId;
  timestamp: number;
  action: string;
  target_type: string;
  target_id: string;
  details: Record<string, unknown>;
}

// === Sync ===

export interface SyncCursor {
  motebit_id: MotebitId;
  last_event_id: EventId;
  last_version_clock: number;
}

export interface ConflictEdge {
  local_event: EventLogEntry;
  remote_event: EventLogEntry;
  resolution: "local_wins" | "remote_wins" | "merged" | "unresolved";
}

// === Conversation Sync ===

/** Conversation metadata for sync. Matches persistence Conversation shape using snake_case for wire format. */
export interface SyncConversation {
  conversation_id: ConversationId;
  motebit_id: MotebitId;
  started_at: number;
  last_active_at: number;
  title: string | null;
  summary: string | null;
  message_count: number;
}

/** Conversation message for sync. Matches persistence ConversationMessage shape using snake_case for wire format. */
export interface SyncConversationMessage {
  message_id: string;
  conversation_id: ConversationId;
  motebit_id: MotebitId;
  role: string;
  content: string;
  tool_calls: string | null;
  tool_call_id: string | null;
  created_at: number;
  token_estimate: number;
  /**
   * Sensitivity tier classified at write time. Optional in v1: peers
   * running pre-phase-5 builds drop the field on push, and the receiver
   * lazy-classifies on flush per docs/doctrine/retention-policy.md
   * §"Decision 6b" using the operator's
   * `pre_classification_default_sensitivity`.
   */
  sensitivity?: import("./retention-policy.js").SensitivityLevelString;
}

/** Result of a conversation sync cycle. */
export interface ConversationSyncResult {
  conversations_pushed: number;
  conversations_pulled: number;
  messages_pushed: number;
  messages_pulled: number;
}

// === Plan-Execute Engine ===

export enum PlanStatus {
  Active = "active",
  Completed = "completed",
  Failed = "failed",
  Paused = "paused",
}

export enum StepStatus {
  Pending = "pending",
  Running = "running",
  Completed = "completed",
  Failed = "failed",
  Skipped = "skipped",
}

export interface PlanStep {
  step_id: string;
  plan_id: PlanId;
  ordinal: number;
  description: string;
  prompt: string;
  depends_on: string[];
  optional: boolean;
  status: StepStatus;
  required_capabilities?: DeviceCapability[];
  /** Task ID assigned by the relay when this step was delegated to a remote device. */
  delegation_task_id?: string;
  /** Motebit ID of the agent assigned to execute this step in collaborative plans. */
  assigned_motebit_id?: MotebitId;
  result_summary: string | null;
  error_message: string | null;
  tool_calls_made: number;
  started_at: number | null;
  completed_at: number | null;
  retry_count: number;
  updated_at: number;
}

export interface Plan {
  plan_id: PlanId;
  goal_id: GoalId;
  motebit_id: MotebitId;
  title: string;
  status: PlanStatus;
  created_at: number;
  updated_at: number;
  current_step_index: number;
  total_steps: number;
  proposal_id?: ProposalId;
  collaborative?: boolean;
}

// === Plan Sync ===

/** Plan record for cross-device sync. Mirrors Plan but uses wire-format field names. */
export interface SyncPlan {
  plan_id: PlanId;
  goal_id: GoalId;
  motebit_id: MotebitId;
  title: string;
  status: PlanStatus;
  created_at: number;
  updated_at: number;
  current_step_index: number;
  total_steps: number;
  proposal_id: string | null;
  collaborative: number; // 0 | 1 for SQLite wire
}

/** Plan step record for cross-device sync. */
export interface SyncPlanStep {
  step_id: string;
  plan_id: PlanId;
  motebit_id: MotebitId;
  ordinal: number;
  description: string;
  prompt: string;
  depends_on: string; // JSON-serialized string[] for wire format
  optional: boolean;
  status: StepStatus;
  required_capabilities: string | null; // JSON-serialized DeviceCapability[] | null
  delegation_task_id: string | null;
  assigned_motebit_id: string | null;
  result_summary: string | null;
  error_message: string | null;
  tool_calls_made: number;
  started_at: number | null;
  completed_at: number | null;
  retry_count: number;
  updated_at: number;
}

/** Result of a plan sync cycle. */
export interface PlanSyncResult {
  plans_pushed: number;
  plans_pulled: number;
  steps_pushed: number;
  steps_pulled: number;
}

// === Agent Protocol ===

export enum DeviceCapability {
  StdioMcp = "stdio_mcp",
  HttpMcp = "http_mcp",
  FileSystem = "file_system",
  Keyring = "keyring",
  Background = "background",
  LocalLlm = "local_llm",
  /** Device supports push-triggered wake for background task execution. */
  PushWake = "push_wake",
  /**
   * Device holds its identity key inside hardware (Secure Enclave / TPM /
   * hardware keystore) and can produce signatures the private material
   * never leaves. Consumed by `HardwareAttestationSemiring` to rank
   * hardware-attested agents above software-only agents when the routing
   * caller asks for the attestation dimension. Pairs with the
   * `hardware_attestation` subject-field extension on `AgentTrustCredential`
   * (spec/credential-v1.md §3.4).
   */
  SecureEnclave = "secure_enclave",
}

/** Push notification platform for wake-on-demand mobile execution. */
export type PushPlatform = "fcm" | "apns" | "expo";

/** Push token registration payload — sent from device to relay. */
export interface PushTokenRegistration {
  device_id: string;
  push_token: string;
  platform: PushPlatform;
  /** Unix ms timestamp when the token was obtained. Used for staleness detection. */
  registered_at: number;
}

export enum AgentTaskStatus {
  Pending = "pending",
  Claimed = "claimed",
  Running = "running",
  Completed = "completed",
  Failed = "failed",
  Denied = "denied",
  Expired = "expired",
}

export interface AgentTask {
  task_id: string;
  motebit_id: MotebitId;
  prompt: string;
  submitted_at: number;
  submitted_by?: string;
  wall_clock_ms?: number;
  status: AgentTaskStatus;
  claimed_by?: string;
  required_capabilities?: DeviceCapability[];
  step_id?: string;
  /** Delegation scope — when set, restricts which tools the task can use. */
  delegated_scope?: string;
  /**
   * How this task was authorized for invocation. Propagated from the task
   * submission body through the agent envelope to the outer receipt. See
   * `IntentOrigin` for the closed value set and
   * `docs/doctrine/surface-determinism.md` for the surface-determinism
   * doctrine this discriminator supports.
   */
  invocation_origin?: IntentOrigin;
}

export interface ExecutionReceipt {
  task_id: string;
  motebit_id: MotebitId;
  /** Signer's Ed25519 public key (hex). Enables verification without relay lookup. */
  public_key?: string;
  device_id: DeviceId;
  submitted_at: number;
  completed_at: number;
  /**
   * Task outcome. The discriminator between the two non-completed values is
   * WHO refused: `denied` is the governance boundary's verdict (a policy gate
   * blocked the task's actions and no permitted work completed); `failed` is
   * the execution interior's verdict (the run did not yield its outcome —
   * crashes, timeouts, and the worker's own principled refusals all
   * included, however much work was metered along the way). Workers never
   * classify their own refusals as `denied` — trust accumulation treats
   * `denied` as neutral and `failed` as a success-rate debit, so
   * self-classified denials would launder failures out of trust history.
   * See `spec/execution-ledger-v1.md` §11.1 "Status semantics".
   */
  status: "completed" | "failed" | "denied";
  result: string;
  tools_used: string[];
  memories_formed: number;
  prompt_hash: string;
  result_hash: string;
  delegation_receipts?: ExecutionReceipt[];
  /**
   * Cryptographic binding to the relay's economic identity for this task.
   *
   * Optional for local (non-relay) execution. **Required** for relay-mediated
   * tasks — the relay rejects receipts without this field (HTTP 400). The value
   * is included in the Ed25519 signature, so tampering breaks verification.
   */
  relay_task_id?: string;
  /** Scope from the delegation token that authorized this execution, if any. */
  delegated_scope?: string;
  /**
   * Content digest of the RAW primary-source bytes this task retrieved, when the
   * task's `result` is a verbatim, raw-byte-addressable span of those bytes
   * (a fetch-type atom — `read_url` — over a `text/*` non-HTML source). Set from
   * the tool's {@link ToolResult.source_digest}. Signature-bound (canonicalized
   * with the rest of the body), so a re-fetcher who reproduces the bytes can
   * trust the attestation; absent for extracted/reformatted output (HTML/JSON) or
   * non-fetch tasks — back-compat by absence. A citation builder copies this into
   * `Citation.provenance` to make the cited excerpt re-verifiable down to the
   * primary record (evidence-provenance, raw-byte path).
   */
  source_digest?: DigestRef;
  /**
   * The projection recipe id whose byte-deterministic output the task's `result`
   * is, when `result` is NOT the raw bytes verbatim but a published transform of
   * them (a fetch-type atom — `read_url` over HTML — sets `"agency.html-text.v1"`).
   * Set from the tool's {@link ToolResult.source_projection}; signature-bound.
   * Present ⇒ `source_digest` is over the RAW bytes and a re-verifier applies this
   * recipe before locating the span; ABSENT ⇒ the raw-byte path (span over raw bytes
   * directly). Copied into `Citation.provenance.projection`. Back-compat by absence.
   */
  source_projection?: string;
  /**
   * How this task was authorized for invocation. Discriminates user-explicit
   * affordances (chip tap, slash command, scene click) from AI-mediated
   * delegations (the model called `delegate_to_agent` in its loop) and from
   * machine-driven origins (cron, agent-to-agent). Optional and additive —
   * absent ≡ unknown origin (legacy receipts predate the field; no
   * back-fill). When present, the value is signature-bound: verifiers
   * reject any tampered substitution.
   *
   * Carried through to the relay's task-submission body and emitted on
   * the agent's outer receipt by `buildServiceReceipt`. Surface determinism
   * (CLAUDE.md principle): user-tap delegations MUST set `"user-tap"`.
   */
  invocation_origin?: IntentOrigin;
  /**
   * Cryptosuite discriminator. Always `"motebit-jcs-ed25519-b64-v1"` for
   * this artifact today — the verification recipe is JCS canonicalization
   * of the unsigned body (this object without `signature`), Ed25519
   * primitive, base64url signature encoding, hex public-key encoding.
   *
   * Narrowed to the single suite today so widening requires intentional
   * registry + type change (the plan for post-quantum migration). Verifiers
   * reject missing or unknown suite values fail-closed.
   */
  suite: "motebit-jcs-ed25519-b64-v1";
  signature: string;
}

/**
 * Signed per-tool-call proof: one receipt per invocation of a tool during
 * an agent turn. Complements `ExecutionReceipt` (which commits to the
 * task as a whole) by committing to each individual tool call inside
 * the task — the finer-grained audit granularity the Motebit Computer
 * needs to show the user exactly which tool ran, what it was given,
 * and what it returned, with a signature per call.
 *
 * Why this exists as its own artifact instead of an inner field on
 * `ExecutionReceipt`:
 *
 *   - Third-party implementers verifying a single tool's output do not
 *     need the enclosing task's receipt — the per-call receipt is
 *     independently self-verifiable with just the signer's public key.
 *   - The slab emits these live as tool calls complete, before the
 *     enclosing task finishes; nesting inside `ExecutionReceipt`
 *     would force the UI to wait for the outer receipt.
 *   - Delegation is recursive at the task level (`delegation_receipts`);
 *     keeping tool-invocation receipts separate avoids tangling two
 *     different recursion shapes in one artifact.
 *
 * Commits only to structural facts: tool name, canonical SHA-256 hashes
 * of the args and the result, the result status, the motebit + device
 * identities, and timestamps. The receipt does *not* carry the raw args
 * or raw result bytes — those may contain sensitive content. A verifier
 * who holds the raw bytes can recompute the hash and check against the
 * signature; one who holds only the receipt can still prove the tool
 * ran with *some* input at *some* time.
 *
 * Binding to the enclosing task is via `task_id` — the same task_id
 * carried on the parent `ExecutionReceipt`. A verifier can gather all
 * tool-invocation receipts for a task by matching task_id and verify
 * them in parallel.
 */
export interface ToolInvocationReceipt {
  /** Stable identifier for this invocation — UUID assigned when the tool is dispatched. */
  invocation_id: string;
  /** Task this invocation belongs to. Matches `ExecutionReceipt.task_id` when nested in a task. */
  task_id: string;
  motebit_id: MotebitId;
  /** Signer's Ed25519 public key (hex). Enables verification without relay lookup. */
  public_key?: string;
  device_id: DeviceId;
  /** Tool name as registered in the runtime's tool registry (e.g., "read_url", "web_search"). */
  tool_name: string;
  /** Unix ms when the tool was dispatched. */
  started_at: number;
  /** Unix ms when the tool reached terminal state. Equal to `started_at` for instantaneous tools. */
  completed_at: number;
  /**
   * Terminal state of the tool invocation. Same boundary/interior split as
   * `ExecutionReceipt.status`, at per-call granularity: `denied` = a policy
   * gate blocked this call; `failed` = the tool itself errored.
   */
  status: "completed" | "failed" | "denied";
  /**
   * SHA-256 hex digest of the canonical JSON of the tool's arguments.
   * A verifier with the raw args recomputes and matches; absence of raw
   * args does not weaken the receipt's self-verifiability.
   */
  args_hash: string;
  /**
   * SHA-256 hex digest of the canonical JSON of the tool's result (or of
   * the error message string, when status is `failed` or `denied`).
   */
  result_hash: string;
  /**
   * How this invocation was authorized. `user-tap` for explicit affordance
   * invocations (surface-determinism); `ai-loop` for model-mediated calls
   * inside a turn. Propagates the enclosing task's origin so per-call
   * receipts can be audited independently of the task receipt.
   */
  invocation_origin?: IntentOrigin;
  /**
   * Cryptosuite discriminator. Always `"motebit-jcs-ed25519-b64-v1"` today.
   * Widening requires a registry change in `SuiteId` + a new dispatch
   * arm in `@motebit/crypto`, not a wire-format break.
   */
  suite: "motebit-jcs-ed25519-b64-v1";
  signature: string;
}

/**
 * Signed human-consent decision over a tool call that governance gated for
 * approval (the middle band: `require_approval_above < risk <= deny_above`).
 *
 * The third governance band made verifiable. The auto band proves itself with
 * a `ToolInvocationReceipt`; the deny band proves itself with an agent-signed
 * `ExecutionReceipt{status:"denied"}` (the delegation policy refusal path). The
 * approve band was the only one whose decision was unsigned — a plaintext DB
 * row + event. This artifact closes that asymmetry: when a human approves (or
 * denies) a gated act, the verdict becomes a self-verifiable fact — "this
 * approver consented to THIS tool call with THESE args at THIS time" — that any
 * third party can check offline with the approver's public key, no relay
 * contact required.
 *
 * Signed by the APPROVER's device key (the human consenting), mirroring how the
 * worker signs its own refusal: consent is the approver's assertion, not the
 * system's word for it. Prior art for signed approval votes: the key-rotation
 * guardian quorum (`relay_approval_votes.signature`) — this lifts that shape
 * from the narrow key-rotation case to the general agentic tool-consent path.
 *
 * Privacy: commits to `args_hash` (SHA-256 of the canonical args), never the
 * raw args — same discipline as `ToolInvocationReceipt`. A verifier holding the
 * raw args recomputes and matches; one holding only the decision still proves a
 * verdict was rendered over *some* call at *some* time.
 *
 * Member of the JCS + Ed25519 + suite-dispatch signed-artifact family
 * (`docs/doctrine/receipts-unified.md`). Verify with `verifyApprovalDecision`.
 */
export interface ApprovalDecision {
  /**
   * Binds the decision to the specific gated call — the `tool_call_id` from the
   * `approval_request`. Part of the signed body, so a verdict cannot be
   * replayed onto a different call (the binding breaks the signature).
   */
  approval_id: string;
  /** The motebit whose governance gated the call (the executor being approved). */
  motebit_id: MotebitId;
  /** Signer's (approver's) Ed25519 public key (hex). Enables offline verification without a key lookup. */
  public_key?: string;
  /** The approver's device that rendered the verdict and holds the signing key. */
  device_id: DeviceId;
  /** Tool the verdict authorizes (or refuses). */
  tool_name: string;
  /**
   * SHA-256 hex of the canonical JSON of the tool's arguments — never the raw
   * args. Binds consent to the exact call shape the approver saw.
   */
  args_hash: string;
  /** The `RiskLevel` numeric that triggered the approval gate. */
  risk_level: number;
  /** The human's verdict. `denied` carries an optional `denied_reason`. */
  verdict: "approved" | "denied";
  /** Unix ms when the approval was requested (the gate fired). */
  requested_at: number;
  /** Unix ms when the human rendered the verdict. */
  resolved_at: number;
  /** Free-text reason, present only on `denied`. */
  denied_reason?: string;
  /** The turn/run the gated call belongs to, when known. */
  run_id?: string;
  /**
   * Cryptosuite discriminator. Always `"motebit-jcs-ed25519-b64-v1"` today.
   * Widening requires a `SuiteId` registry change + a new dispatch arm in
   * `@motebit/crypto`, not a wire-format break.
   */
  suite: "motebit-jcs-ed25519-b64-v1";
  signature: string;
}

/**
 * Signed proof that the motebit performed a consolidation cycle. The
 * receipt commits to structural facts only — counts of memories merged,
 * promoted, pruned, and the cycle's identity / timestamps — never to
 * memory content, embeddings, or any sensitive identifier. Anyone with
 * the signer's public key can verify; no relay contact required.
 *
 * Why this exists: every other proactive AI agent today binds the
 * agent's identity to the operator's billing relationship. Motebit
 * binds it to a sovereign Ed25519 identity, so the consolidation work
 * the motebit performs while idle becomes self-attesting evidence the
 * motebit can show to anyone — including itself, across time. The
 * receipt is the evidence; anchoring it on a public ledger (Solana
 * memo via `SolanaMemoSubmitter`, batched per `spec/credential-anchor-v1`)
 * is the additive proof that the receipt existed at the time it claims.
 *
 * Doctrine: [`docs/doctrine/proactive-interior.md`](../../docs/doctrine/proactive-interior.md).
 */
export interface ConsolidationReceipt {
  /** UUID — the receipt's own identity (separate from cycle_id). */
  receipt_id: string;
  /** The motebit that performed the cycle. */
  motebit_id: MotebitId;
  /** Signer's Ed25519 public key (hex). Embedded for portable verification
   *  — third parties verify without contacting any relay. */
  public_key?: string;
  /** Matches the `cycle_id` carried by the `consolidation_cycle_run` event
   *  emitted at cycle completion. Verifiers cross-reference. */
  cycle_id: string;
  /** Cycle timing — milliseconds since Unix epoch. */
  started_at: number;
  finished_at: number;
  /** Phases that ran to completion. Closed union — adding a phase is a
   *  protocol-coordinated change. */
  phases_run: ReadonlyArray<"orient" | "gather" | "consolidate" | "prune" | "flush">;
  /** Phases that yielded mid-execution because their AbortSignal fired
   *  (budget exhausted or parent signal aborted). Subset of `phases_run`. */
  phases_yielded: ReadonlyArray<"orient" | "gather" | "consolidate" | "prune" | "flush">;
  /** Structural counts only — never memory content. The privacy boundary
   *  is the type: there is no field here that could leak a memory's text
   *  or embedding. Adding such a field is a protocol break. */
  summary: {
    orient_nodes?: number;
    gather_clusters?: number;
    gather_notable?: number;
    consolidate_merged?: number;
    pruned_decay?: number;
    pruned_notability?: number;
    pruned_retention?: number;
    /** Conversation messages flushed under `consolidation_flush` (phase 5-ship). */
    flushed_conversations?: number;
    /** Tool-audit entries flushed under `consolidation_flush` (phase 5-ship). */
    flushed_tool_audits?: number;
  };
  /**
   * Cryptosuite discriminator. Always `"motebit-jcs-ed25519-b64-v1"` for
   * this artifact today — the verification recipe is JCS canonicalization
   * of the unsigned body (this object without `signature`), Ed25519
   * primitive, base64url signature encoding, hex public-key encoding.
   * Verifiers reject missing or unknown suite values fail-closed.
   */
  suite: "motebit-jcs-ed25519-b64-v1";
  signature: string;
}

/**
 * One commitment inside a `ConsolidationMutationManifest` — binds a single
 * formed/refined memory node without carrying its text.
 */
export interface ConsolidationMutationCommitment {
  /** The formed/refined memory node this commitment covers. */
  node_id: string;
  /** Whether the cycle formed a fresh node or refined an existing belief.
   *  Committed so a relabel (creation ↔ modification) breaks the signature. */
  kind: "formed" | "refined";
  /** SHA-256 (hex) of the node's content at formation — commits to the exact
   *  sentence the felt surface displays WITHOUT carrying it (the digest is
   *  one-way). A keyed/salted commitment + the sync privacy model is the
   *  export-triggered follow-up: a raw digest is dictionary-attackable only
   *  once the manifest travels without its content, and this artifact is
   *  local-only today. `docs/doctrine/felt-interior.md`. */
  content_sha256: string;
  /** Provenance marker committed so a taught↔inferred relabel breaks the
   *  signature. Emitter-authored (`docs/doctrine/memory-provenance.md`). */
  provenance: MemorySource;
  /** Sensitivity tier committed so a downgrade (which would loosen the felt
   *  disclosure ceiling) breaks the signature. */
  sensitivity: SensitivityLevel;
}

/**
 * The owner-facing adjunct to a `ConsolidationReceipt`: a signed commitment
 * to the EXACT durable mutations a consolidation cycle formed, joined to its
 * counts-only receipt by id + digest. Two artifacts, two privacy boundaries
 * (`docs/doctrine/felt-interior.md`): the receipt is portable and counts-only
 * — a third party verifies that work happened without touching memory text;
 * this manifest is local and commits per-mutation digests so a surface can
 * prove the displayed sentences are exactly the signed cycle's mutations,
 * the receipt never carrying content.
 *
 * Domain-separated from the receipt family by `artifact_type` inside the
 * signed body (the same JCS+Ed25519 suite, distinct committed bytes), so a
 * receipt signature can never verify as a manifest and vice versa — no new
 * `SuiteId` required.
 *
 * Retirements are deliberately NOT committed here: the felt surface displays
 * them as a count, never content, and the count is already covered by the
 * receipt's signed `summary`. The manifest covers exactly what is displayed
 * as detail — the formed/refined lines.
 */
export interface ConsolidationMutationManifest {
  /** Domain-separation discriminator, inside the signed body. (Distinct field
   *  from the `ContentArtifactType` `artifact_type` registry — a manifest is
   *  not a content artifact.) */
  manifest_type: "consolidation_mutation_manifest";
  /** Manifest schema version, independent of the receipt's. */
  schema_version: "1";
  /** This manifest's own identity. */
  manifest_id: string;
  /** The motebit that performed the cycle. */
  motebit_id: MotebitId;
  /** The cycle whose mutations this commits to — matches the receipt and the
   *  `consolidation_cycle_run` event. */
  cycle_id: string;
  /** Binds to the EXACT counts-only receipt this supplements, not merely a
   *  reusable cycle id: a regenerated or substituted receipt breaks the link. */
  receipt_id: string;
  /** Canonical SHA-256 (hex) of the signed `ConsolidationReceipt` body. */
  receipt_digest: string;
  /** Commitments to the cycle's formed/refined mutations, ordered by
   *  `node_id` for deterministic canonicalization. */
  mutations: ReadonlyArray<ConsolidationMutationCommitment>;
  /** Formation time — milliseconds since Unix epoch. */
  created_at: number;
  /** Signer's Ed25519 public key (hex), embedded for portable verification. */
  public_key?: string;
  /** Cryptosuite — the same JCS+Ed25519+base64url recipe as the receipt
   *  family; domain separation is by `artifact_type`, not a distinct suite. */
  suite: "motebit-jcs-ed25519-b64-v1";
  signature: string;
}

/**
 * Merkle-batched anchor over signed `ConsolidationReceipt`s. The motebit
 * batches its own receipts (no relay required), computes a Merkle root
 * over canonical-JSON SHA-256 leaves, and optionally submits the root
 * via a `ChainAnchorSubmitter` (the same primitive the relay uses for
 * credential anchoring; `SolanaMemoSubmitter` is the reference impl).
 *
 * When `tx_hash` is populated the anchor is onchain — anyone can verify
 * that the included receipts existed at `anchored_at` by recomputing
 * their leaf hashes and checking inclusion against the root recorded in
 * the Solana transaction memo (`motebit:anchor:v1:{root}:{leaf_count}`).
 * When `tx_hash` is absent, the anchor is a local-only Merkle commitment
 * — still verifiable by recomputation, just not timestamp-attested.
 *
 * The anchor itself is NOT separately signed. Its cryptographic load is
 * carried by (a) the signatures on the receipts it groups, and (b) the
 * onchain Solana transaction signed by the motebit's identity key (which
 * IS the Solana address — Ed25519 curve coincidence, see
 * `packages/wallet-solana/CLAUDE.md`). Adding a batch-level signature
 * would be redundant.
 *
 * Doctrine: [`docs/doctrine/proactive-interior.md`](../../docs/doctrine/proactive-interior.md).
 */
export interface ConsolidationAnchor {
  /** UUID identifying this anchor batch. */
  batch_id: string;
  /** Motebit that produced the receipts in this batch (and signed the
   *  Solana transaction that carries the root, when onchain). */
  motebit_id: MotebitId;
  /** Hex-encoded SHA-256 Merkle root over the receipts' canonical-body
   *  leaf hashes. Stable for a given ordered set of receipts. */
  merkle_root: string;
  /** Receipt IDs included in this batch, in the order their leaf hashes
   *  were inserted into the Merkle tree. Consumers recomputing inclusion
   *  proofs MUST preserve this order. */
  receipt_ids: ReadonlyArray<string>;
  /** leaf_count = receipt_ids.length (duplicated for parsers that don't
   *  want to count the array). */
  leaf_count: number;
  /** Milliseconds since Unix epoch when the anchor was produced. */
  anchored_at: number;
  /** On-chain transaction hash (Solana signature base58 for
   *  `SolanaMemoSubmitter`) if the anchor was submitted. Absent when the
   *  anchor was constructed without a submitter. */
  tx_hash?: string;
  /** CAIP-2 network identifier the anchor was submitted to (e.g.,
   *  `"solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"` for mainnet). Paired
   *  with `tx_hash` — absent when `tx_hash` is absent. */
  network?: string;
  /**
   * Tree-hash recipe for the receipts' Merkle root (leaf-domain / node-domain
   * tags + hash). A `MerkleTreeVersion`. **Absent ⇒ `merkle-sha256-plain-v1`** —
   * every anchor produced before this axis existed still recomputes offline.
   * Verifiers resolve absent to the default and reject an unknown value
   * fail-closed (never silently downgrade); a v2 producer MUST emit it rather
   * than rely on the default. See
   * `docs/doctrine/merkle-tree-hash-versioning.md`.
   */
  tree_hash_version?: MerkleTreeVersion;
}

/**
 * Provenance discriminator on `ExecutionReceipt.invocation_origin` and on
 * relay task-submission bodies. Closed string-literal union; verifiers and
 * routers MAY use this to score, audit, or differentiate paths.
 *
 *   - `"user-tap"`        — explicit user authorization via a UI affordance
 *                           (chip, button, slash command, scene-object click,
 *                           voice opt-in). Strongest consent signal.
 *   - `"ai-loop"`         — the AI loop chose to delegate (e.g., the model
 *                           called `delegate_to_agent`). Weakest consent
 *                           signal — the user authorized the conversation,
 *                           not the specific delegation.
 *   - `"scheduled"`       — a cron / scheduled trigger initiated the task.
 *   - `"agent-to-agent"`  — a downstream agent initiated as part of its own
 *                           handleAgentTask (composition).
 *
 * Doctrine: `docs/doctrine/surface-determinism.md`.
 */
export type IntentOrigin = "user-tap" | "ai-loop" | "scheduled" | "agent-to-agent";

/**
 * Provenance tier for a citation's source. Mirrors the three-tier knowledge
 * hierarchy of the answer engine:
 *
 *   - `"interior"`  — the motebit's own pre-built knowledge corpus
 *                     (@motebit/self-knowledge). Offline, no delegation, no
 *                     receipt — the source is the committed corpus itself.
 *   - `"federation"` — another motebit queried through the delegation graph.
 *                      The `receipt_task_id` field binds the citation to a
 *                      specific signed ExecutionReceipt in the parent
 *                      receipt's `delegation_receipts` chain.
 *   - `"web"`       — an external URL fetched through a read-url atom. The
 *                     `receipt_task_id` binds to the read-url atom's signed
 *                     receipt; the claim is "this motebit actually read that
 *                     URL," not "this URL is correct."
 *
 * Verifiers treat `"interior"` as self-attested (trust the corpus checksum),
 * `"federation"` and `"web"` as receipt-attested (verify the bound receipt's
 * signature and match its `task_id`).
 */
export type CitationSource = "interior" | "federation" | "web";

/**
 * One grounded citation in a `CitedAnswer`. The `text_excerpt` is the span
 * actually incorporated into the answer; the `source` discriminator tells
 * verifiers how to check it.
 *
 * Wire format (foundation law): this is the universal shape for "here is
 * the source of one claim in my answer." Adding fields is additive; changing
 * the discriminator or removing fields is a wire-format break.
 */
export interface Citation {
  /** The span of source text the answer drew on. */
  text_excerpt: string;
  /** Which tier produced this source. */
  source: CitationSource;
  /**
   * For `"web"`: the fetched URL.
   * For `"interior"`: the doc path relative to the corpus (e.g., "README.md#section").
   * For `"federation"`: the queried motebit's ID.
   */
  locator: string;
  /**
   * For `"federation"` and `"web"` — the `task_id` of the bound
   * `ExecutionReceipt` in the parent answer's `delegation_receipts`. Undefined
   * for `"interior"` (the committed corpus is the provenance).
   */
  receipt_task_id?: string;
  /**
   * Re-verifiable evidence provenance for a `"web"` citation: the `text_excerpt`
   * as a content-addressed span in the primary record at `locator`
   * (`@motebit/crypto` `verifyEvidenceProvenance`; spec/evidence-provenance-v1.md).
   * Present only when the producer retrieved the source AND the excerpt is
   * re-derivable from the raw fetched bytes (digest over the raw response;
   * `projection` absent for raw-byte spans, or a published recipe id for an
   * extraction). ABSENT otherwise — back-compat by absence, never a claim the
   * producer can't back. The bare `{ kind, ref }`-style citation is unchanged;
   * this only adds independent re-checkability down to the primary record.
   */
  provenance?: EvidenceProvenance;
}

/**
 * A grounded answer with per-claim citations. Emitted by the answer-engine
 * path (research service today; any grounded-generation surface in future).
 *
 * Wire format: JCS-canonicalizable. Auditors with only `@motebit/protocol`
 * and `@motebit/crypto` can verify:
 *   1. The outer `receipt` signature.
 *   2. Every `citation.receipt_task_id` resolves to a receipt in
 *      `receipt.delegation_receipts` whose own signature verifies.
 *   3. For `"interior"` citations, the corpus hash matches the motebit's
 *      committed self-knowledge build.
 *
 * The answer text is a plain string; citation-to-text alignment is the
 * renderer's concern (e.g., numbered markers like `[1]` in `answer`).
 */
export interface CitedAnswer {
  /** Natural-language answer. */
  answer: string;
  /** Ordered list of sources. `answer` may reference them by index. */
  citations: Citation[];
  /**
   * Outer receipt signed by the emitting motebit. Its
   * `delegation_receipts` chain carries the per-atom signatures that
   * back each `"federation"` / `"web"` citation.
   */
  receipt: ExecutionReceipt;
}

/**
 * Self-attesting device-to-relay registration request body.
 *
 * The cryptographic equivalent of a TOFU handshake: the device signs a
 * canonical-JSON serialization of this object (with `signature` removed) using
 * its Ed25519 private key, and the relay verifies the signature against the
 * `public_key` carried in the same request. No prior trust anchor required —
 * the signature proves key control, and key control proves the registrant
 * controls this `motebit_id` going forward (until a key-rotation request
 * explicitly changes the binding, per `spec/auth-token-v1.md` §9).
 *
 * Wire format (foundation law) — the spec lives at
 * `spec/device-self-registration-v1.md`. Verifiers MUST reject requests that
 * fall outside the ±5-minute timestamp window; the relay endpoint is
 * intentionally auth-less because the signature IS the auth.
 *
 * Trust posture: a self-registered device starts at trust zero. Trust
 * accrues through receipts, credentials, and onchain anchors — never
 * through registration alone. See `docs/doctrine/protocol-model.md`.
 */
export interface DeviceRegistrationRequest {
  /** Self-asserted identifier. Bound to `public_key` upon successful registration. */
  motebit_id: MotebitId;
  /** Self-asserted device identifier. Bound to `public_key` for the device's lifetime. */
  device_id: string;
  /** 64-char lowercase hex Ed25519 public key (32 bytes). */
  public_key: string;
  /** Optional human-readable label for operator panels and audit logs. */
  device_name?: string;
  /**
   * Optional owner reference. Sovereign devices that own themselves SHOULD
   * set `"self:<motebit_id>"`. Multi-tenant SDKs MAY set their tenant
   * identifier. The relay defaults to `"self:<motebit_id>"` when absent.
   */
  owner_id?: string;
  /**
   * Epoch milliseconds at request creation. Relay rejects requests where
   * `abs(now - timestamp) > 5 minutes` — the only replay defense at the
   * wire level. See spec §6.1 for the threat model this defends.
   */
  timestamp: number;
  /**
   * Cryptosuite identifier. Routes through the suite-dispatch in
   * `@motebit/crypto`; PQ migration is a registry addition, not a
   * wire-format break.
   */
  suite: import("./crypto-suite.js").SuiteId;
  /**
   * base64url-encoded Ed25519 signature over the canonical-JSON
   * serialization of this object with `signature` removed.
   */
  signature: string;
}

export interface DelegatedStepResult {
  step_id: string;
  task_id: string;
  receipt: ExecutionReceipt;
  result_text: string;
  /** Routing provenance from the relay — why this agent was selected. */
  routing_choice?: {
    selected_agent: string;
    composite_score: number;
    sub_scores: Record<string, number>;
    routing_paths: string[][];
    alternatives_considered: number;
  };
}

// === Key Succession ===

/**
 * Encrypted identity key transfer payload for multi-device pairing.
 *
 * Device A encrypts its Ed25519 identity seed using ephemeral X25519 key agreement
 * and posts this payload through the relay. The relay sees only opaque ciphertext.
 * Device B decrypts using its held ephemeral X25519 private key + the pairing code.
 */
export interface KeyTransferPayload {
  /** Device A's ephemeral X25519 public key (64-char hex). */
  x25519_pubkey: string;
  /** AES-256-GCM encrypted 32-byte Ed25519 identity seed (hex). */
  encrypted_seed: string;
  /** AES-256-GCM nonce, 12 bytes (24-char hex). */
  nonce: string;
  /** AES-256-GCM auth tag, 16 bytes (32-char hex). */
  tag: string;
  /** Device A's Ed25519 identity public key for post-decryption verification (64-char hex). */
  identity_pubkey_check: string;
}

/**
 * Durability without custody — an identity's Ed25519 seed, AEAD-encrypted under a
 * key only the owner's authenticator can reproduce, parked with a custodian that
 * is structurally unable to open it. Escrow, not custody. The sibling of
 * {@link KeyTransferPayload}: transfer moves a key between parties under key
 * agreement; escrow parks a seed with a custodian under an authenticator-held
 * secret. Deliberate deltas: no X25519 ephemeral, `kdf` as a registry, same
 * post-decryption verification posture. Unsigned by design — integrity is the
 * GCM tag, correctness is the mandatory `identity_pubkey_check`, and placement is
 * authenticated by `signed-request-envelope@1.0`. Spec: `spec/seed-escrow-v1.md`.
 */
export interface SeedEscrowPayload {
  /** Opaque locator for the unwrap secret. For kdf `webauthn-prf-hkdf-sha256`:
   *  the WebAuthn credential id (base64url). Unguessable; retrieval is keyed on
   *  it and MUST NOT be publicly enumerable. */
  unlock_hint: string;
  /** KDF descriptor — closed enum, registered never forked. v1's sole entry:
   *  WebAuthn PRF output → HKDF-SHA256 → AES-256-GCM key. Unknown values are
   *  rejected fail-closed by custodians and restoring clients alike. */
  kdf: "webauthn-prf-hkdf-sha256";
  /** AES-256-GCM ciphertext of the 32-byte Ed25519 seed (64-char hex). */
  encrypted_seed: string;
  /** AES-256-GCM nonce, 12 bytes (24-char hex). Fresh per placement. */
  nonce: string;
  /** AES-256-GCM authentication tag, 16 bytes (32-char hex). AEAD failure on
   *  restore is rejection — wrong credential, corruption, and tampering are
   *  indistinguishable by design. */
  tag: string;
  /** Ed25519 public key derived from the escrowed seed (64-char hex). MANDATORY
   *  post-decryption check: a restored seed that does not re-derive to this key
   *  is discarded — an AEAD success is not yet a restore. */
  identity_pubkey_check: string;
}

/**
 * A key succession record proving that one Ed25519 key has been replaced by another.
 * Both the old and new keys sign the record, creating a cryptographic chain of custody.
 * Structurally compatible with @motebit/crypto KeySuccessionRecord.
 *
 * Guardian recovery records have `recovery: true` and `guardian_signature` instead of
 * `old_key_signature`. This allows identity recovery when the primary key is compromised.
 */
export interface KeySuccessionRecord {
  old_public_key: string; // hex
  new_public_key: string; // hex
  timestamp: number;
  reason?: string;
  /**
   * Cryptosuite discriminator. Always `"motebit-jcs-ed25519-hex-v1"` for
   * this artifact today — JCS canonicalization of the unsigned payload,
   * Ed25519 primitive, hex signature encoding, hex public-key encoding.
   * The same suite as the identity frontmatter (spec/identity-v1.md §3.8).
   * Verifiers reject missing or unknown suite values fail-closed.
   */
  suite: "motebit-jcs-ed25519-hex-v1";
  old_key_signature?: string; // hex — present in normal rotation, absent in guardian recovery
  new_key_signature: string; // hex, new key signs the canonical payload
  /** Guardian recovery: true when succession was authorized by guardian, not old key. */
  recovery?: boolean;
  /** Guardian signature — present only when recovery is true. */
  guardian_signature?: string; // hex
}

/**
 * Organizational guardian — enables key recovery and organizational custody.
 * The guardian's private key is held by the organization (cold storage).
 * When present, the guardian can sign succession records on behalf of a compromised key.
 */
export interface IdentityGuardian {
  /** Ed25519 public key of the guardian (hex). */
  public_key: string;
  /** Human-readable organization name. */
  organization?: string;
  /** Machine-readable organization identifier. */
  organization_id?: string;
  /** ISO 8601 timestamp when guardianship was established. */
  established_at: string;
}

/** Result of verifying a key succession chain. */
export interface SuccessionChainResult {
  valid: boolean;
  /** The original (genesis) public key. */
  genesis_public_key: string;
  /** The current (active) public key. */
  current_public_key: string;
  /** Number of key rotations. */
  length: number;
  /** If invalid, the index of the first broken link and error. */
  error?: { index: number; message: string };
}

// === Execution Ledger ===

export type ExecutionTimelineType =
  | "goal_started"
  | "plan_created"
  | "step_started"
  | "tool_invoked"
  | "tool_result"
  | "step_completed"
  | "step_failed"
  | "step_delegated"
  | "plan_completed"
  | "plan_failed"
  | "goal_completed"
  | "proposal_created"
  | "proposal_accepted"
  | "proposal_rejected"
  | "proposal_countered"
  | "collaborative_step_completed";

export interface ExecutionTimelineEntry {
  timestamp: number;
  type: ExecutionTimelineType;
  payload: Record<string, unknown>;
}

export interface ExecutionStepSummary {
  step_id: string;
  ordinal: number;
  description: string;
  status: string;
  tools_used: string[];
  tool_calls: number;
  started_at: number | null;
  completed_at: number | null;
  delegation?: {
    task_id: string;
    receipt_hash?: string;
    /** Routing provenance: why this agent was selected for delegation. */
    routing_choice?: {
      selected_agent: string;
      composite_score: number;
      sub_scores: {
        trust: number;
        success_rate: number;
        latency: number;
        price_efficiency: number;
        capability_match: number;
        availability: number;
      };
      /** Derivation paths through the agent graph. */
      routing_paths: string[][];
      /** Number of candidate agents that were scored. */
      alternatives_considered: number;
    };
  };
}

export interface GoalExecutionManifest {
  /**
   * `motebit/execution-ledger@1.0` for legacy ledgers, `motebit/execution-ledger@1.1`
   * for ledgers that embed byte-identical inner signed receipts via `signed_receipts`.
   * v1.1 is purely additive — every v1.0 consumer continues to parse v1.1 bodies
   * by ignoring the optional field. See `spec/execution-ledger-v1.md` §4.3.
   */
  spec: "motebit/execution-ledger@1.0" | "motebit/execution-ledger@1.1";
  motebit_id: string;
  goal_id: string;
  plan_id: string;
  started_at: number;
  completed_at: number;
  status: "completed" | "failed" | "paused" | "active";
  timeline: ExecutionTimelineEntry[];
  steps: ExecutionStepSummary[];
  delegation_receipts: DelegationReceiptSummary[];
  /**
   * Byte-identical canonical-JSON of each delegated motebit's signed
   * `ExecutionReceipt`. Optional and only present in v1.1 reconstructions
   * where the relay has the receipts archived (per
   * `services/relay/CLAUDE.md` Rule 11). Each element is the JSON-stringified
   * receipt the motebit signed; verifiers MAY parse + recursively verify
   * each one's Ed25519 signature independently. Closes the operator-trust
   * gap that v1.0 summaries leave open — a relay that lies about which
   * motebit did the work is detectable because the inner signature can be
   * checked against the named motebit's public key without trusting the
   * relay. See `spec/execution-ledger-v1.md` §4.3.
   */
  signed_receipts?: string[];
  content_hash: string;
  signature?: string;
}

export interface DelegationReceiptSummary {
  task_id: string;
  motebit_id: string;
  device_id: string;
  status: string;
  completed_at: number;
  tools_used: string[];
  signature_prefix: string;
}

/**
 * Canonical spec identifiers for the execution-ledger reconstruction.
 * v1.1 adds the optional `signed_receipts` field; the wire shape is
 * otherwise identical to v1.0. Verifiers that recognize v1.1 SHOULD
 * iterate `signed_receipts` and verify each inner signature when present.
 */
export const EXECUTION_LEDGER_SPEC_V1_0 = "motebit/execution-ledger@1.0" as const;
export const EXECUTION_LEDGER_SPEC_V1_1 = "motebit/execution-ledger@1.1" as const;

export interface AgentCapabilities {
  motebit_id: MotebitId;
  public_key: string;
  /** W3C did:key URI derived from the Ed25519 public key. */
  did?: string;
  tools: string[];
  governance: {
    trust_mode: string;
    max_risk_auto: number;
    require_approval_above: number;
    deny_above: number;
  };
  online_devices: number;
}

// === Market Types ===

export interface CapabilityPrice {
  capability: string;
  unit_cost: number;
  currency: string;
  per: "task" | "tool_call" | "token";
}

export interface AgentServiceListing {
  listing_id: ListingId;
  motebit_id: MotebitId;
  capabilities: string[];
  pricing: CapabilityPrice[];
  sla: { max_latency_ms: number; availability_guarantee: number };
  description: string;
  /** Wallet address for x402 on-chain payment settlement (e.g. "0x..." for EVM). */
  pay_to_address?: string;
  /**
   * Self-declared regulatory risk score [0, ∞). 0 = no risk, higher = more risk.
   * Accumulates along delegation chains via RegulatoryRiskSemiring (min, +).
   * Sources: jurisdiction, data handling classification, compliance certifications,
   * audit requirements. The score is declared by the agent; verification is via
   * credentials (e.g. compliance attestation VCs).
   */
  regulatory_risk?: number;
  updated_at: number;
}

export interface RouteScore {
  motebit_id: MotebitId;
  composite: number;
  sub_scores: {
    trust: number;
    success_rate: number;
    latency: number;
    price_efficiency: number;
    capability_match: number;
    availability: number;
  };
  selected: boolean;
}

export interface BudgetAllocation {
  allocation_id: AllocationId;
  goal_id: GoalId;
  candidate_motebit_id: MotebitId;
  amount_locked: number;
  currency: string;
  created_at: number;
  status: "locked" | "settled" | "released" | "disputed";
}

/**
 * Default platform fee rate (5%) — used by the reference relay deployment.
 * The protocol supports any fee structure; relays configure their own rate
 * via MOTEBIT_PLATFORM_FEE_RATE env or config.platformFeeRate.
 */
export const PLATFORM_FEE_RATE = 0.05;

/**
 * Per-task settlement bookkeeping artifact.
 *
 * Foundation Law (services/relay/CLAUDE.md rule 6):
 * - Every truth the relay asserts (credential anchor proofs,
 *   revocation memos, settlement receipts) is independently
 *   verifiable onchain without relay contact.
 *
 * The settlement is signed by the issuing relay over the canonical
 * JSON of all fields except `signature`. Verifiers reconstruct the
 * canonical bytes (omitting `signature`) and check Ed25519 against
 * the issuing relay's public key. A malicious relay therefore
 * cannot issue inconsistent records to different observers — the
 * signature commits the relay to the exact (amount_settled,
 * platform_fee, platform_fee_rate, status) tuple it published.
 *
 * Federation settlements additionally get Merkle-batched and
 * onchain-anchored (relay-federation-v1.md §7.6); per-agent
 * settlements rely on the signature for self-attestation.
 */
export interface SettlementRecord {
  settlement_id: SettlementId;
  allocation_id: AllocationId;
  /**
   * The payee — the `motebit_id` of the worker this settlement pays. A
   * settlement receipt names *who was paid* in its signed body, not only
   * the relay-internal `allocation_id` (which is an opaque bookkeeping
   * handle a sovereign verifier cannot resolve offline). This makes the
   * receipt self-contained: a worker proves "I (W) was paid X for receipt
   * H by relay R" from the signed bytes alone, with no relay-side
   * allocation→payee join. Carried in the signed body so the payee is part
   * of the relay's attestation and cannot be re-pointed after the fact.
   * Equals the executing agent's `ExecutionReceipt.motebit_id`.
   */
  motebit_id: MotebitId;
  receipt_hash: string;
  ledger_hash: string | null;
  /** Amount paid to the executing agent (after platform fee deduction). */
  amount_settled: number;
  /** Platform fee extracted by the relay. */
  platform_fee: number;
  /** Fee rate applied (e.g. 0.05 = 5%). Recorded per-settlement for auditability. */
  platform_fee_rate: number;
  /**
   * How the money moved for this settlement: `relay` (relay holds custody;
   * virtual-account credit/debit on the relay's books) or `p2p` (peer-to-
   * peer onchain transfer; relay records the audit but never held the
   * funds). Closed registry — see `SettlementMode` in `./settlement-mode.ts`.
   *
   * Carried in the signed body so the lane is part of the relay's
   * attestation, not a derivable side-fact. Auditors and counsel reading
   * the receipt see the custody posture directly; the relay cannot
   * silently re-label a custodied settlement as p2p after the fact.
   *
   * Treasury reconciliation (operator fee accrual vs. onchain balance)
   * is structurally NOT a settlement and never appears here — see
   * `docs/doctrine/settlement-rails.md` § "Lanes for external readers".
   */
  settlement_mode: SettlementMode;
  /** x402 payment transaction hash (when paid on-chain). */
  x402_tx_hash?: string;
  /** x402 network used for payment (CAIP-2 identifier). */
  x402_network?: string;
  status: "completed" | "partial" | "refunded";
  settled_at: number;
  /**
   * Issuing relay's motebit_id. The signer of this record. Must
   * match the public key resolvable through the relay's identity.
   */
  issuer_relay_id: string;
  /**
   * Cryptosuite discriminator. Always `"motebit-jcs-ed25519-b64-v1"` —
   * JCS canonicalization, Ed25519 primitive, base64url signature
   * encoding. Verifiers reject missing or unknown values fail-closed.
   */
  suite: "motebit-jcs-ed25519-b64-v1";
  /**
   * Base64url-encoded Ed25519 signature by the issuing relay over
   * canonical JSON of all fields except `signature`. Lets a worker
   * (or any auditor) prove what the relay claimed without trusting
   * the relay's word about it.
   */
  signature: string;
}

// === Settlement Rails ===
// Rail types classify how money moves, not which vendor moves it.
// Protocol, provider, and network are properties of the implementation, not the interface.

/** Proof of payment from a settlement rail. */
export interface PaymentProof {
  /** Transaction hash or reference ID from the rail. */
  reference: string;
  /** Rail type that produced this proof. */
  railType: "fiat" | "protocol" | "direct_asset" | "orchestration";
  /** Network identifier (CAIP-2 for onchain, "stripe" for fiat, etc.). */
  network?: string;
  /** ISO timestamp of when the payment was confirmed. */
  confirmedAt: number;
}

/** Deposit result from a settlement rail. */
export interface DepositResult {
  /** Amount deposited in micro-units. */
  amount: number;
  /** Currency code (e.g., "USD", "USDC"). */
  currency: string;
  /** Payment proof for audit trail. */
  proof: PaymentProof;
}

/** Withdrawal result from a settlement rail. */
export interface WithdrawalResult {
  /** Amount withdrawn in micro-units. */
  amount: number;
  /** Currency code. */
  currency: string;
  /** Payment proof for audit trail. */
  proof: PaymentProof;
}

/**
 * Settlement rail — the external money-movement boundary, split by custody.
 *
 * Every rail is either a GuestRail (relay holds the money, rail moves it in/out)
 * or a SovereignRail (the agent holds the keys, the rail is the agent's own wallet).
 * The `custody` discriminant makes this a compile-time distinction.
 *
 * Doctrine: the relay's rail registry accepts only GuestRails. SovereignRails live
 * in the agent's runtime process and are never registered at the relay, because
 * sovereign means the agent signs its own transactions and the relay is not in
 * the signing path. The type system enforces the doctrine — not prose.
 *
 * See GuestRail and SovereignRail below for their respective contracts.
 */
export interface SettlementRail {
  /** Human-readable name for logging and config (e.g., "stripe", "solana-wallet"). */
  readonly name: string;

  /** Who holds the keys/funds this rail moves. Compile-time custody boundary. */
  readonly custody: "relay" | "agent";

  /** Whether this rail is currently available (provider reachable, config valid). */
  isAvailable(): Promise<boolean>;
}

/**
 * GuestRail — relay-custody settlement rail.
 *
 * The relay holds the user's money in a virtual account; a GuestRail moves it
 * across the relay's boundary to an external system and back. The rail is a
 * guest in the relay's economic loop — it doesn't hold the permanent ledger,
 * it just carries money through the membrane.
 *
 * Three rail types:
 * - "fiat" — traditional payment processor (Stripe Checkout)
 * - "protocol" — HTTP-native agent payment protocols (MPP, x402)
 * - "orchestration" — fiat↔crypto bridging (Bridge)
 *
 * There is no "direct_asset" GuestRail — direct onchain transfer is always
 * sovereign (the agent signs) and belongs in SovereignRail.
 *
 * Not all rails support deposits. Fiat rails accept proactive deposits.
 * Protocol rails (x402, MPP) are pay-per-request — money moves at the HTTP
 * boundary, not through the rail. Use `supportsDeposit` discriminant for
 * runtime narrowing: `if (rail.supportsDeposit) rail.deposit(...)`.
 *
 * The relay picks the rail at routing time based on what the counterparty accepts.
 */
export interface GuestRail extends SettlementRail {
  readonly custody: "relay";
  readonly railType: "fiat" | "protocol" | "orchestration";

  /** Whether this rail supports proactive deposits. False for pay-per-request rails (x402, MPP). */
  readonly supportsDeposit: boolean;

  /**
   * Whether this rail supports user-facing withdrawal — i.e., the relay
   * may invoke `rail.withdraw(...)` to transmit user funds to an
   * external destination on the user's behalf. When `false`, the rail
   * is registered for other purposes (treasury orchestration, deposit
   * intake, anchor submission) but NEVER appears in the user-withdrawal
   * dispatch path.
   *
   * `BridgeSettlementRail.supportsWithdraw = false` is the structural
   * embodiment of the off-ramp doctrine: Motebit is not a transmitter
   * of user funds. Bridge stays registered for own-account treasury
   * conversion via `BridgeOfframpAdapter`, but the rail itself cannot
   * be a withdrawal target — `withdraw()` is structurally absent from
   * the type (it lives on `WithdrawableGuestRail`, not on the base).
   *
   * Mirrors `supportsDeposit` + `DepositableGuestRail` and `supportsBatch`
   * + `BatchableGuestRail` as a discriminant narrowing to
   * `WithdrawableGuestRail`.
   */
  readonly supportsWithdraw: boolean;

  /**
   * Whether the rail exposes a single-call batch withdrawal primitive.
   * When true, `withdrawBatch` MUST be implemented. When false (the
   * default for every rail that ships in the reference relay today),
   * aggregation is still a win at the relay layer — the batch worker
   * defers sub-threshold items and fires serially once the policy
   * clears — but the rail itself settles one item per call.
   * Mirrors `supportsDeposit` + `DepositableGuestRail` as a
   * discriminant narrowing to `BatchableGuestRail`. Implies
   * `supportsWithdraw: true` — batch is a specialization of single
   * withdraw.
   */
  readonly supportsBatch: boolean;

  /**
   * Record a payment proof with a settlement (e.g., x402 tx hash, Stripe charge ID).
   * Called after settleOnReceipt() computes the settlement record.
   */
  attachProof(settlementId: string, proof: PaymentProof): Promise<void>;
}

/**
 * Single item within a batch withdrawal submission. Amounts are
 * micro-units (1_000_000 = 1 unit of asset). The relay constructs
 * one item per `relay_pending_withdrawals` row.
 */
export interface BatchWithdrawalItem {
  readonly motebit_id: string;
  readonly amount_micro: number;
  readonly currency: string;
  readonly destination: string;
  readonly idempotency_key: string;
}

/**
 * Per-item outcome of a batch withdrawal. Partial failure is
 * first-class: a rail MAY succeed on some items and fail on others.
 * `failed[i].reason` is a human-readable string — not part of the
 * signed proof, just operator telemetry.
 */
export interface BatchWithdrawalResult {
  readonly fired: ReadonlyArray<{ item: BatchWithdrawalItem; result: WithdrawalResult }>;
  readonly failed: ReadonlyArray<{ item: BatchWithdrawalItem; reason: string }>;
}

/**
 * A guest rail that supports user-facing withdrawal — the relay may
 * invoke `withdraw()` to transmit user funds to an external destination.
 *
 * Use the `supportsWithdraw` discriminant for runtime narrowing from
 * `GuestRail`. The marker exists so `BridgeSettlementRail` (orchestration,
 * treasury-only) is structurally distinct from `StripeSettlementRail`
 * (fiat, user-facing) and `X402SettlementRail` (protocol, user-facing).
 *
 * The doctrinal frame: Motebit is not a transmitter of user funds. User-
 * facing withdrawal is permitted only to user-held wallets (the sovereign
 * Solana path via `OperatorSolanaTransfer` on the operator side, or to
 * a user-held EVM wallet via x402 on a `WithdrawableGuestRail`). Bridge
 * is excluded structurally — the method does not exist on its type, so
 * the relay cannot orchestrate user-facing transfers through Bridge no
 * matter what env vars are set. The doctrine is enforced by absence.
 */
export interface WithdrawableGuestRail extends GuestRail {
  readonly supportsWithdraw: true;

  /**
   * Execute a withdrawal to an external destination.
   * Fail-closed: throws on any error.
   */
  withdraw(
    motebitId: string,
    amount: number,
    currency: string,
    destination: string,
    idempotencyKey: string,
  ): Promise<WithdrawalResult>;

  /**
   * Submit multiple withdrawals in one rail call when the rail
   * supports a native batch primitive (e.g., a future x402 multi-
   * authorization). Present only when `supportsBatch` is true — narrow
   * with `isBatchableRail`. A rail can be withdrawable without being
   * batchable, but the reverse is forbidden by the type hierarchy:
   * `BatchableGuestRail extends WithdrawableGuestRail`.
   */
  withdrawBatch?(items: readonly BatchWithdrawalItem[]): Promise<BatchWithdrawalResult>;
}

/**
 * A guest rail that supports batch withdrawal submission.
 * Use the `supportsBatch` discriminant for runtime narrowing from `GuestRail`.
 * Batchable implies withdrawable — batch is a specialization of single withdraw.
 */
export interface BatchableGuestRail extends WithdrawableGuestRail {
  readonly supportsBatch: true;
  withdrawBatch(items: readonly BatchWithdrawalItem[]): Promise<BatchWithdrawalResult>;
}

/**
 * A guest rail that supports proactive deposits (Stripe Checkout).
 * Use the `supportsDeposit` discriminant for runtime narrowing from `GuestRail`.
 */
export interface DepositableGuestRail extends GuestRail {
  readonly supportsDeposit: true;

  /**
   * Initiate a deposit. Returns a deposit result or a redirect URL
   * (for interactive flows like Stripe Checkout).
   */
  deposit(
    motebitId: string,
    amount: number,
    currency: string,
    idempotencyKey: string,
  ): Promise<DepositResult | { redirectUrl: string }>;
}

/** Type guard: narrows GuestRail to DepositableGuestRail. */
export function isDepositableRail(rail: GuestRail): rail is DepositableGuestRail {
  return rail.supportsDeposit;
}

/**
 * Type guard: narrows GuestRail to WithdrawableGuestRail.
 *
 * The relay's user-withdrawal dispatch (services/relay/src/budget.ts)
 * MUST narrow through this guard before calling `rail.withdraw(...)`.
 * Compile-time enforcement: `withdraw` does not exist on bare `GuestRail`,
 * so an un-narrowed call site fails to typecheck. Runtime defense-in-
 * depth: a rail with `supportsWithdraw: true` AND a non-function
 * `withdraw` property would shape-match the interface but fail this
 * guard, surfacing as "this rail does not support withdrawal" rather
 * than a `TypeError: rail.withdraw is not a function` at the dispatch.
 */
export function isWithdrawableRail(rail: GuestRail): rail is WithdrawableGuestRail {
  return (
    rail.supportsWithdraw === true &&
    typeof (rail as Partial<WithdrawableGuestRail>).withdraw === "function"
  );
}

/** Type guard: narrows GuestRail to BatchableGuestRail. */
export function isBatchableRail(rail: GuestRail): rail is BatchableGuestRail {
  return (
    rail.supportsBatch === true &&
    typeof (rail as Partial<BatchableGuestRail>).withdrawBatch === "function"
  );
}

/**
 * SovereignRail — agent-custody settlement rail.
 *
 * The agent's identity key signs; the rail is the agent's own wallet. There is
 * no third-party custodian and the relay is not in the signing path. Withdrawal
 * from a sovereign rail is just a transfer — the funds never left the agent.
 *
 * Reference implementation: `SolanaWalletRail` in `@motebit/wallet-solana`.
 * The Ed25519 identity public key is natively a valid Solana address, so the
 * wallet address equals the motebit's identity — no second key, no key-derivation
 * ceremony, no vendor. Future Ed25519-native chains (Aptos, Sui) implement the
 * same interface.
 *
 * SovereignRails MUST NOT appear in the relay's guest rail registry. The type
 * split is mechanical: `SettlementRailRegistry.register` accepts only `GuestRail`,
 * so the compiler rejects attempts to register a sovereign rail at the relay.
 * This is the sovereignty doctrine expressed as a type.
 */
export interface SovereignRail extends SettlementRail {
  readonly custody: "agent";
  /** Chain identifier (e.g., "solana"). Future: "aptos", "sui". */
  readonly chain: string;
  /**
   * Settlement asset this rail clears in. Closed union — see
   * `SettlementAsset` in `./settlement-asset.ts`. Sub-phase A: USDC
   * only at land; second-asset promotion lifts the registry to the
   * 8th registered registry per `registry-pattern-canonical.md`.
   */
  readonly asset: SettlementAsset;
  /** Agent's own address on this chain. Equals the motebit identity public key for Ed25519-native chains. */
  readonly address: string;
  /** Current balance in micro-units (1e6 = 1 unit of asset). */
  getBalance(): Promise<bigint>;
}

/**
 * Outcome of a sovereign-rail value transfer. Chain-neutral shape — a tx
 * identifier, the slot/height it landed in (0 if not yet confirmed), and
 * whether the configured commitment level was reached.
 */
export interface SovereignSendResult {
  /** Transaction identifier (base58 signature on Solana). */
  signature: string;
  /** Slot / block height the transaction landed in (0 if not yet confirmed). */
  slot: number;
  /** Whether the network reached the configured commitment level. */
  confirmed: boolean;
}

/**
 * The sovereign wallet rail as the interior CONSUMES it — the port the runtime
 * depends on, not the concrete rail. Extends `SovereignRail` (address +
 * getBalance) with the send + liveness operations the runtime invokes. A
 * concrete rail (`@motebit/wallet-solana`'s `SolanaWalletRail`) satisfies this
 * structurally; the runtime imports this port, never the provider. "The interior
 * defines the port; the provider implements it" — the adapter principle as a type.
 */
/**
 * A request to build a sovereign P2P payment proof — the delegator's atomic
 * multi-leg onchain settlement that lets a PAID direct delegation satisfy the
 * relay's P2P-proof gate (`requiresP2pProof`, Arc 3.5). The interior assembles
 * this from discovery (the worker's `settlement_address`, the relay's treasury
 * address) plus fee math (`computeGrossAmount` in `@motebit/market`); the rail
 * broadcasts the legs in ONE transaction and returns the verifiable
 * `P2pPaymentProof`.
 *
 * Single-operator P2P uses the worker + relay-fee legs only. Cross-operator
 * federated P2P adds the executor-relay (B) fee leg — see `P2pPaymentProof`'s
 * `b_fee_*` fields.
 */
export interface SovereignP2pPaymentRequest {
  /** Worker's declared settlement address (base58 for Solana). */
  workerAddress: string;
  /** Worker leg amount in micro-units — the listing unit_cost, what the worker earns net. */
  amountMicro: number;
  /** Relay treasury address (base58) — `deriveSolanaAddress(relayPublicKey)`. */
  treasuryAddress: string;
  /** Fee leg amount in micro-units — `computeGrossAmount(amountMicro) - amountMicro`. */
  feeAmountMicro: number;
  /** Executor-relay (B) treasury address (base58) — cross-operator federated P2P only. */
  executorTreasuryAddress?: string;
  /** Executor-relay (B) fee leg amount in micro-units — federated P2P only. */
  executorFeeAmountMicro?: number;
  /** CAIP-2 network identifier (defaults to the rail's chain mainnet). */
  network?: string;
}

export interface SovereignWalletRail extends SovereignRail {
  /** Send `microAmount` (micro-units) of the rail's asset to `toAddress`. */
  send(toAddress: string, microAmount: bigint): Promise<SovereignSendResult>;
  /** Whether the rail can currently reach its chain (RPC liveness). */
  isAvailable(): Promise<boolean>;
  /**
   * Build a P2P payment proof by broadcasting the delegator's atomic
   * multi-leg settlement (worker leg + relay-fee leg[s]) in a SINGLE
   * transaction and returning the verifiable `P2pPaymentProof`.
   *
   * OPTIONAL: a rail that cannot atomically pay multiple recipients omits
   * this, and the interior degrades honestly (paid direct delegation is
   * unavailable on that rail) — it MUST NOT split the legs across separate
   * transactions, because the relay verifier walks ONE `tx_hash`. The
   * reference `SolanaWalletRail` implements it via `buildP2pPaymentProof`.
   */
  buildP2pPayment?(request: SovereignP2pPaymentRequest): Promise<P2pPaymentProof>;
}

// === Collaborative Plan Proposals ===

export interface CollaborativePlanProposal {
  proposal_id: ProposalId;
  plan_id: PlanId;
  initiator_motebit_id: MotebitId;
  participants: ProposalParticipant[];
  status: ProposalStatus;
  created_at: number;
  expires_at: number;
  updated_at: number;
}

export interface ProposalParticipant {
  motebit_id: MotebitId;
  assigned_steps: number[]; // step ordinals
  response: ProposalResponseType | null;
  responded_at: number | null;
  counter_steps?: ProposalStepCounter[];
}

export interface ProposalStepCounter {
  ordinal: number;
  description?: string;
  prompt?: string;
  reason: string;
}

export interface ProposalResponse {
  proposal_id: ProposalId;
  responder_motebit_id: MotebitId;
  response: ProposalResponseType;
  counter_steps?: ProposalStepCounter[];
  signature: string;
}

export interface CollaborativeReceipt {
  proposal_id: ProposalId;
  plan_id: PlanId;
  participant_receipts: ExecutionReceipt[];
  content_hash: string;
  /**
   * Cryptosuite discriminator for `initiator_signature`. Always
   * `"motebit-jcs-ed25519-b64-v1"` today — JCS canonicalization of the
   * aggregate payload, Ed25519 primitive, base64url signature encoding.
   * Verifiers reject missing or unknown suite values fail-closed.
   */
  suite: "motebit-jcs-ed25519-b64-v1";
  initiator_signature: string;
}

export interface MarketConfig {
  weight_trust: number;
  weight_success_rate: number;
  weight_latency: number;
  weight_price_efficiency: number;
  weight_capability_match: number;
  weight_availability: number;
  latency_norm_k: number;
  max_candidates: number;
  settlement_timeout_ms: number;
  /** Exploration weight [0-1]: 0 = pure exploitation, 1 = pure exploration. Default 0. */
  exploration_weight?: number;
}

// === Verifiable Credential Subject Types ===

export const VC_TYPE_GRADIENT = "AgentGradientCredential";
export const VC_TYPE_REPUTATION = "AgentReputationCredential";
export const VC_TYPE_TRUST = "AgentTrustCredential";

export interface ReputationCredentialSubject {
  id: string;
  success_rate: number;
  avg_latency_ms: number;
  task_count: number;
  trust_score: number;
  availability: number;
  sample_size: number;
  measured_at: number;
}

export interface TrustCredentialSubject {
  id: string;
  trust_level: string;
  interaction_count: number;
  successful_tasks: number;
  failed_tasks: number;
  first_seen_at: number;
  last_seen_at: number;
  /**
   * Optional hardware-attestation claim. Present when the subject agent
   * demonstrated that its identity key lives inside a hardware keystore
   * (Secure Enclave, TPM, Android Keystore / Play Integrity, Apple
   * DeviceCheck). Consumed by `HardwareAttestationSemiring` in the
   * routing layer to rank hardware-attested agents above software-only
   * agents for sensitivity-aware delegation. See spec/credential-v1.md
   * §3.4 and `HardwareAttestationClaim`. Absence means "no claim"
   * (equivalent to `platform: "software"` for ranking purposes).
   */
  hardware_attestation?: HardwareAttestationClaim;
}

/**
 * Hardware attestation claim embedded in `TrustCredentialSubject`. One claim
 * describes the subject agent's key-custody posture on the device that issued
 * the credential.
 *
 * Wire format (foundation law) — see spec/credential-v1.md §3.4 for the
 * binding subsection. Every conformant implementation MUST emit these
 * field names and types; the claim is carried inside the existing
 * `AgentTrustCredential` VC envelope so the outer `suite` field already
 * covers the signature.
 *
 * `platform` enumerates the attestation surface; `"software"` is the
 * sentinel for "no hardware-backed key" and is explicitly part of the
 * enum so credentials can truthfully claim "we tried, there was no
 * hardware" rather than omit the field (which is ambiguous between
 * "unknown" and "software").
 *
 * `key_exported` matters because even a hardware-generated key can be
 * exported to software storage (e.g. backup, pairing, migration). When
 * `true`, the claim is weaker — the private material left the hardware,
 * so the binding between "this key is signing" and "this hardware held
 * it" is broken for the lifetime of the export.
 *
 * `attestation_receipt` is an opaque platform-specific blob (Apple
 * DeviceCheck assertion, Google Play Integrity token, TPM quote) that
 * a verifier with the matching platform adapter can independently
 * verify. Motebit does not parse these — adapters are glucose per the
 * metabolic principle; this field just reserves wire-format space for
 * them. Absence does not invalidate the claim; it just means the
 * verifier has no side-channel proof beyond the credential signature.
 */
export interface HardwareAttestationClaim {
  /**
   * Attestation surface identifier. `"software"` is the explicit
   * no-hardware sentinel — a credential that carries a claim with
   * `platform: "software"` is truthfully claiming "this key is not
   * hardware-backed", distinct from an absent claim ("unknown").
   */
  platform:
    | "secure_enclave"
    | "tpm"
    | "play_integrity"
    | "android_keystore"
    | "device_check"
    | "webauthn"
    | "software";
  /**
   * True when the private key was exported from hardware to software
   * storage (backup, pairing). Weakens the claim — the hardware no
   * longer uniquely holds the material. Default false; absent ≡ false
   * for backward compatibility when a minting tool forgets to set it
   * on a software-only platform.
   */
  key_exported?: boolean;
  /**
   * Opaque platform-specific attestation blob. Apple DeviceCheck
   * assertion, Google Play Integrity token, or TPM quote bytes encoded
   * as the platform expects (base64url by convention). Motebit does not
   * parse this — platform adapters at the verification boundary do.
   * Absent when no platform receipt is available.
   */
  attestation_receipt?: string;
}

export interface GradientCredentialSubject {
  id: string;
  gradient: number;
  knowledge_density: number;
  knowledge_quality: number;
  graph_connectivity: number;
  temporal_stability: number;
  retrieval_quality: number;
  interaction_efficiency: number;
  tool_efficiency: number;
  curiosity_pressure: number;
  measured_at: number;
}

// === Platform Storage Adapter Interfaces ===
//
// Pure adapter contracts for platform-specific persistence implementations.
// These live in SDK so that both the runtime (consumer) and persistence
// packages (implementors) can depend on them without layer violations.

export interface ConversationStoreAdapter {
  createConversation(motebitId: string): string;
  appendMessage(
    conversationId: string,
    motebitId: string,
    msg: {
      role: string;
      content: string;
      toolCalls?: string;
      toolCallId?: string;
      /**
       * Sensitivity tier the message was classified at on write.
       * Optional in v1: pre-classification messages and adapters that
       * haven't yet been migrated to the phase-5-ship column drop the
       * field, and the consolidation-cycle flush phase lazy-classifies
       * on read per docs/doctrine/retention-policy.md §"Decision 6b"
       * (operator manifest's `pre_classification_default_sensitivity`).
       */
      sensitivity?: SensitivityLevel;
    },
  ): void;
  loadMessages(
    conversationId: string,
    limit?: number,
  ): Array<{
    messageId: string;
    conversationId: string;
    motebitId: string;
    role: string;
    content: string;
    toolCalls: string | null;
    toolCallId: string | null;
    createdAt: number;
    tokenEstimate: number;
    sensitivity?: SensitivityLevel;
  }>;
  getActiveConversation(motebitId: string): {
    conversationId: string;
    startedAt: number;
    lastActiveAt: number;
    summary: string | null;
  } | null;
  updateSummary(conversationId: string, summary: string): void;
  updateTitle(conversationId: string, title: string): void;
  listConversations(
    motebitId: string,
    limit?: number,
  ): Array<{
    conversationId: string;
    startedAt: number;
    lastActiveAt: number;
    title: string | null;
    messageCount: number;
  }>;
  deleteConversation(conversationId: string): void;
  /**
   * Enumerate messages older than `beforeCreatedAt`. The
   * consolidation-cycle flush phase calls this per
   * docs/doctrine/retention-policy.md §"Consolidation flush" to find
   * candidates whose retention floor may have passed. Optional — when
   * absent, the flush phase is a no-op for this store on this surface.
   */
  enumerateForFlush?(
    motebitId: string,
    beforeCreatedAt: number,
  ): Array<{
    messageId: string;
    conversationId: string;
    role: string;
    content: string;
    createdAt: number;
    sensitivity?: SensitivityLevel;
  }>;
  /**
   * Erase a single message row — physical row removal, the storage
   * operation behind a `consolidation_flush` deletion certificate per
   * decision 7. Distinct from `deleteConversation` (whole-conversation
   * tombstone). Optional — paired with `enumerateForFlush`.
   */
  eraseMessage?(messageId: string): void;
}

export interface StateSnapshotAdapter {
  saveState(motebitId: string, stateJson: string, versionClock?: number): void;
  loadState(motebitId: string): string | null;
  /** Version clock at last snapshot — used to determine what's safe to compact. */
  getSnapshotClock?(motebitId: string): number;
}

export interface KeyringAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface AgentTrustStoreAdapter {
  getAgentTrust(motebitId: string, remoteMotebitId: string): Promise<AgentTrustRecord | null>;
  setAgentTrust(record: AgentTrustRecord): Promise<void>;
  listAgentTrust(motebitId: string): Promise<AgentTrustRecord[]>;
  updateTrustLevel(
    motebitId: string,
    remoteMotebitId: string,
    level: AgentTrustLevel,
  ): Promise<void>;
}

export interface ServiceListingStoreAdapter {
  get(motebitId: string): Promise<AgentServiceListing | null>;
  set(listing: AgentServiceListing): Promise<void>;
  list(): Promise<AgentServiceListing[]>;
  delete(listingId: string): Promise<void>;
}

export interface BudgetAllocationStoreAdapter {
  get(allocationId: string): Promise<BudgetAllocation | null>;
  create(allocation: BudgetAllocation): Promise<void>;
  updateStatus(allocationId: string, status: string): Promise<void>;
  listByGoal(goalId: string): Promise<BudgetAllocation[]>;
}

export interface SettlementStoreAdapter {
  get(settlementId: string): Promise<SettlementRecord | null>;
  create(settlement: SettlementRecord): Promise<void>;
  listByAllocation(allocationId: string): Promise<SettlementRecord[]>;
}

export interface LatencyStatsStoreAdapter {
  record(motebitId: string, remoteMotebitId: string, latencyMs: number): Promise<void>;
  getStats(
    motebitId: string,
    remoteMotebitId: string,
    limit?: number,
  ): Promise<{ avg_ms: number; p95_ms: number; sample_count: number }>;
}

export interface EventFilter {
  motebit_id?: string;
  event_types?: EventType[];
  after_timestamp?: number;
  before_timestamp?: number;
  after_version_clock?: number;
  limit?: number;
}

export interface EventStoreAdapter {
  append(entry: EventLogEntry): Promise<void>;
  /**
   * Atomically assign the next version_clock and append the event.
   * Eliminates the race condition in the getLatestClock() + clock+1 pattern.
   * Returns the assigned version_clock.
   */
  appendWithClock?(entry: Omit<EventLogEntry, "version_clock">): Promise<number>;
  query(filter: EventFilter): Promise<EventLogEntry[]>;
  getLatestClock(motebitId: string): Promise<number>;
  tombstone(eventId: string, motebitId: string): Promise<void>;
  /** Delete events with version_clock <= beforeClock. Returns count deleted. */
  compact?(motebitId: string, beforeClock: number): Promise<number>;
  /**
   * Erase events with `timestamp < horizonTs`. Returns count erased.
   * Distinct from `compact` (state-snapshot driven, version-clock-keyed):
   * `truncateBeforeHorizon` is the storage operation behind an
   * `append_only_horizon` deletion certificate per
   * docs/doctrine/retention-policy.md §"Decision 4". Whole-prefix
   * truncation only — entries before `horizonTs` are unrecoverable.
   *
   * Optional in phase 4a (local-only horizon advance ships first).
   * Phase 4b tightens to required once federation co-witness lands and
   * every operator's event log is expected to support horizon advance.
   */
  truncateBeforeHorizon?(motebitId: string, horizonTs: number): Promise<number>;
  /**
   * Erase the content of stored `memory_formed` events whose payload
   * `node_id` matches, replacing it with the `"[REDACTED]"` sentinel +
   * `redacted: true` + `redacted_reason: "deleted"`. Returns rows
   * changed. The storage operation behind deletion propagation: when a
   * `DeleteRequested` for a memory node syncs to a relay, the relay's
   * stored copy of that node's formation content must not outlive the
   * subject's signed deletion certificate
   * (docs/doctrine/retention-policy.md). Joins the sanctioned
   * deletion-shaped mutation family (`tombstone` / `compact` /
   * `truncateBeforeHorizon`); the `DeleteRequested` event itself is the
   * surviving audit record. Encrypted payloads (`_encrypted: true`)
   * are opaque and skipped by design — the client-side key lifecycle
   * is the erasure mechanism for ciphertext.
   */
  redactMemoryContent?(motebitId: string, nodeId: string): Promise<number>;
  /** Count total events for a motebit. */
  countEvents?(motebitId: string): Promise<number>;
}

export interface DeviceRegistration {
  device_id: string;
  motebit_id: string;
  device_token?: string; // Legacy — retained for DB compat, no longer used for auth
  public_key: string; // hex-encoded Ed25519 public key
  registered_at: number;
  device_name?: string;
  /**
   * Optional self-issued `AgentTrustCredential` (JSON-serialized signed
   * VC) bearing a `hardware_attestation` claim about this device's
   * identity key. Identity metadata, not a credential-index entry —
   * served via `GET /agent/:motebitId/capabilities` so peers can pull,
   * verify, and issue their own peer credentials about this subject.
   * The `/credentials/submit` self-issued rejection (spec §23) remains
   * unchanged. See `spec/identity-v1.md` §3 (device record) and
   * `docs/doctrine/promoting-private-to-public.md` companion.
   */
  hardware_attestation_credential?: string;
}

export interface IdentityStorage {
  save(identity: MotebitIdentity): Promise<void>;
  load(motebitId: string): Promise<MotebitIdentity | null>;
  loadByOwner(ownerId: string): Promise<MotebitIdentity | null>;
  // Device registration (optional — implementations that don't need device auth can omit)
  saveDevice?(device: DeviceRegistration): Promise<void>;
  loadDevice?(deviceId: string): Promise<DeviceRegistration | null>;
  loadDeviceByToken?(token: string): Promise<DeviceRegistration | null>;
  listDevices?(motebitId: string): Promise<DeviceRegistration[]>;
}

export interface AuditLogAdapter {
  record(entry: AuditRecord): Promise<void>;
  query(motebitId: string, options?: { limit?: number; after?: number }): Promise<AuditRecord[]>;
}

export interface AuditStatsSince {
  distinctTurns: number;
  totalToolCalls: number;
  succeeded: number;
  blocked: number;
  failed: number;
}

/**
 * audit-chain — single entry in the hash-linked tamper-evident
 * audit trail. Each entry's `hash` is `SHA-256(canonical({
 * previous_hash, entry_id, timestamp, event_type, actor_id, data
 * }))`; `previous_hash` references the prior entry's `hash` (or
 * `"genesis"` for the first entry). The runtime computes hashes on
 * append; verifiers recompute and compare.
 *
 * Lives in protocol (permissive-floor wire-format type) so
 * `StorageAdapters.auditChainStore` can reference it without sdk
 * importing the BSL `@motebit/policy` package. The concrete
 * primitives (`appendAuditEntry`, `verifyAuditChain`, the
 * `crypto.subtle` hashing) live in `@motebit/policy`'s
 * `audit-chain.ts` — that's where the algorithm runs.
 */
export interface AuditChainEntry {
  readonly entry_id: string;
  readonly timestamp: number;
  readonly event_type: string;
  readonly actor_id: string;
  readonly data: Record<string, unknown>;
  readonly previous_hash: string;
  readonly hash: string;
}

/**
 * audit-chain — minimal storage interface adapters implement.
 * Append-only — the chain breaks if entries are deleted or
 * reordered, which is the whole tamper-evidence point.
 */
export interface AuditChainStoreAdapter {
  append(entry: AuditChainEntry): Promise<void>;
  getEntries(from?: number, to?: number): Promise<AuditChainEntry[]>;
  getHead(): Promise<AuditChainEntry | undefined>;
  count(): Promise<number>;
}

export interface AuditLogSink {
  append(entry: ToolAuditEntry): void;
  query(turnId: string): ToolAuditEntry[];
  getAll(): ToolAuditEntry[];
  queryStatsSince(afterTimestamp: number): AuditStatsSince;
  /** Query tool audit entries by run_id (plan execution). Optional — returns [] if not implemented. */
  queryByRunId?(runId: string): ToolAuditEntry[];
  /**
   * Enumerate entries older than `beforeTimestamp`. The
   * consolidation-cycle flush phase calls this per
   * docs/doctrine/retention-policy.md §"Consolidation flush" to find
   * candidates whose retention floor may have passed. Optional — when
   * absent, the flush phase is a no-op for this store on this surface.
   */
  enumerateForFlush?(beforeTimestamp: number): ToolAuditEntry[];
  /**
   * Erase a single tool-audit entry — physical row removal, the storage
   * operation behind a `consolidation_flush` deletion certificate per
   * decision 7. Optional — paired with `enumerateForFlush`.
   */
  erase?(callId: string): void;
}

export interface PlanStoreAdapter {
  savePlan(plan: Plan): void;
  getPlan(planId: string): Plan | null;
  getPlanForGoal(goalId: string): Plan | null;
  updatePlan(planId: string, updates: Partial<Plan>): void;
  saveStep(step: PlanStep): void;
  getStep(stepId: string): PlanStep | null;
  getStepsForPlan(planId: string): PlanStep[];
  updateStep(stepId: string, updates: Partial<PlanStep>): void;
  getNextPendingStep(planId: string): PlanStep | null;
  /** List all active plans for a motebit. Optional — returns [] if not implemented. */
  listActivePlans?(motebitId: string): Plan[];
}

/** Stored credential record — JSON-serialized VC with metadata. */
export interface StoredCredential {
  credential_id: string;
  /** The agent the credential is about (credentialSubject.id). */
  subject_motebit_id: string;
  /** did:key of the issuer. */
  issuer_did: string;
  /** e.g. "AgentReputationCredential", "AgentTrustCredential", "AgentGradientCredential". */
  credential_type: string;
  /** Full JSON-serialized VerifiableCredential. */
  credential_json: string;
  issued_at: number;
}

export interface CredentialStoreAdapter {
  save(credential: StoredCredential): void;
  /** List credentials about a specific subject agent. */
  listBySubject(subjectMotebitId: string, limit?: number): StoredCredential[];
  /** List all credentials, optionally filtered by type. */
  list(motebitId: string, type?: string, limit?: number): StoredCredential[];
}

export interface ApprovalStoreAdapter {
  /** Collect a quorum approval vote. Returns whether threshold is met and collected voter IDs. */
  collectApproval(approvalId: string, approverId: string): { met: boolean; collected: string[] };
  /** Set quorum metadata on a pending approval item. */
  setQuorum(approvalId: string, required: number, approvers: string[]): void;
}

// ── Semiring Algebra (protocol-level) ──────────────────────────────
// The language of trust: algebra, graph, traversal, scoring constants.
// Any compatible implementation must use the same algebraic semantics.

export type { Semiring } from "./semiring.js";
export {
  TrustSemiring,
  CostSemiring,
  LatencySemiring,
  BottleneckSemiring,
  ReliabilitySemiring,
  BooleanSemiring,
  RegulatoryRiskSemiring,
  MaxProductLogSemiring,
  productSemiring,
  recordSemiring,
  mappedSemiring,
} from "./semiring.js";

export type { Edge } from "./graph.js";
export { WeightedDigraph } from "./graph.js";

export { optimalPaths, optimalPath, transitiveClosure, optimalPathTrace } from "./traversal.js";

export {
  TRUST_LEVEL_SCORES,
  trustLevelToScore,
  TRUST_ZERO,
  TRUST_ONE,
  trustAdd,
  trustMultiply,
  composeTrustChain,
  joinParallelRoutes,
  REFERENCE_TRUST_THRESHOLDS,
} from "./trust-algebra.js";

// ── Credential Anchoring (protocol-level) ────────────────────────────
// Self-verifiable Merkle inclusion proofs for onchain credential anchoring.
// motebit/credential-anchor@1.0.

export type {
  CredentialAnchorBatch,
  CredentialChainAnchor,
  CredentialAnchorProof,
  ChainAnchorSubmitter,
} from "./credential-anchor.js";

// ── Per-Agent Settlement Anchoring (protocol-level) ────────────────────────────
// Self-verifiable Merkle inclusion proofs for the per-agent settlement
// "ceiling" alongside the SettlementRecord signing "floor". Worker audit
// of relay-as-counterparty — distinct audience from federation peer audit
// (relay-federation-v1.md §7.6) and credential portability
// (credential-anchor-v1.md). Same Merkle primitive, different proof endpoint.
// motebit/agent-settlement-anchor@1.0.

export type {
  AgentSettlementAnchorBatch,
  AgentSettlementChainAnchor,
  AgentSettlementAnchorProof,
} from "./agent-settlement-anchor.js";

// ── Federation Settlement Anchoring (protocol-level) ────────────────────────────
// Inter-relay settlement anchoring — peer audit between federated relays. The
// signed `FederationSettlementRecord` is the verbatim-artifact leaf; the
// `FederationSettlementAnchorProof` is the self-verifiable Merkle inclusion
// proof (`@motebit/crypto`'s `verifyFederationSettlementAnchor`). The arc-closer
// of the RFC 6962 tree-hash migration — see agent-settlement-anchor-v1.md §9.1.
// motebit/relay-federation@1.2 §7.6.

export type {
  FederationSettlementRecord,
  FederationSettlementChainAnchor,
  FederationSettlementAnchorProof,
} from "./federation-settlement-anchor.js";

// ── Discovery (protocol-level) ────────────────────────────
// Relay metadata, DNS discovery, and agent resolution.
// motebit/discovery@1.0.

export type { RelayMetadata, RelayMetadataPeer, AgentResolutionResult } from "./discovery.js";

// Virtual-account balance read — the market-v1 §2 account state projected
// across the HTTP boundary (decimal USD; conversion happens only at the
// producer). See spec/market-v1.md §2.6–§2.7.
export type { AccountBalanceResult, AccountBalanceTransaction } from "./account-balance.js";

// Virtual-account withdrawal — the money-out request/response boundary
// (decimal USD; auto-settle-or-pending, transmitter surface structurally
// zero). See spec/market-v1.md §2.8–§2.9 + off-ramp-as-user-action.md.
export type {
  AccountWithdrawRequest,
  AccountWithdrawResult,
  AccountWithdrawalRecord,
  AccountWithdrawalStatus,
  WithdrawalReceiptPayload,
} from "./account-withdraw.js";

// ── Migration (protocol-level) ────────────────────────────
// Agent migration between relays with identity continuity and trust portability.
// motebit/migration@1.0.

export type {
  MigrationState,
  MigrationRequest,
  MigrationToken,
  DepartureAttestation,
  CredentialBundle,
  BalanceWaiver,
  MigrationPresentation,
} from "./migration.js";

// ── Dispute (protocol-level) ────────────────────────────
// Dispute resolution for agent-to-agent delegations.
// motebit/dispute@1.0.

export type {
  DisputeState,
  DisputeOutcome,
  DisputeCategory,
  DisputeFundAction,
  DisputeRequest,
  DisputeEvidence,
  DisputeEvidenceType,
  AdjudicatorVote,
  VoteRequest,
  DisputeResolution,
  DisputeAppeal,
  WitnessOmissionDispute,
  WitnessOmissionEvidence,
  WitnessOmissionInclusionProofEvidence,
  WitnessOmissionAlternativePeeringEvidence,
} from "./dispute.js";

// ── Settlement Mode (protocol-level) ────────────────────────────
// Relay-mediated vs peer-to-peer settlement selection.

export type {
  SettlementMode,
  WritableSettlementMode,
  P2pPaymentProof,
  PaymentVerificationStatus,
  SettlementEligibility,
  SolvencyProof,
} from "./settlement-mode.js";
export { ALL_SETTLEMENT_MODES, isSettlementMode } from "./settlement-mode.js";

// ── Memory Source (protocol-level) ──────────────────────────────
// Provenance classification for memory formation — who contributed a
// remembered fact. Tenth registered registry; assignment rule (source
// is forming-code-path-authored, never model- or peer-authored) is
// enforced by `check-memory-source-canonical`. Doctrine:
// `docs/doctrine/memory-provenance.md`.

export type { MemorySource } from "./memory-source.js";
export {
  ALL_MEMORY_SOURCES,
  isMemorySource,
  MEMORY_SOURCE_MARKERS,
  MEMORY_SOURCE_MARKER_UNKNOWN,
} from "./memory-source.js";

// ── Accrual basis (protocol-level) ──────────────────────────────
// The leverage register of the felt interior — the typed basis an act
// carries when it was shaped by ACCRUED state (thesis #2 made felt).
// PRODUCED by the accrual code path, never model-authored — the honesty
// floor enforced downstream by the Inc-5 gate `check-accrual-basis-canonical`.
// LOCAL (owner-facing, body-rendered, never synced) → structural-lock closed
// union, not a registered wire registry. Doctrine:
// `docs/doctrine/felt-accumulation.md`.

export type { AccrualKind, AccrualBasis, AccrualAttributed } from "./accrual.js";
export { ALL_ACCRUAL_KINDS, isAccrualKind, ACCRUAL_KIND_MARKERS } from "./accrual.js";

// ── Settlement Asset (protocol-level) ───────────────────────────
// The closed vocabulary of stablecoin assets the protocol clears
// settlement in. Sub-phase A: closed union with bespoke coverage;
// promotes to the 8th registered registry per
// `docs/doctrine/registry-pattern-canonical.md` when a second asset
// (PYUSD, USDP, etc.) arrives as a real consumer (sub-phase B).

export type { SettlementAsset } from "./settlement-asset.js";
export { ALL_SETTLEMENT_ASSETS, isSettlementAsset } from "./settlement-asset.js";
export { base58Encode } from "./base58.js";

// ── Commitment Bond (protocol-level) ────────────────────────────
// An agent's self-signed proof-of-funds at its OWN sovereign Solana
// address — an anti-sybil staked SIGNAL (phase 1: NOT collateral /
// escrow / recourse). The load-bearing binding (`bonded_address ===
// deriveSolanaAddress(bonded_public_key)`) is enforced by
// `@motebit/crypto`'s `verifyBondCommitment` and locked by
// `check-bond-address-binding`. Doctrine: `docs/doctrine/commitment-bond.md`.

export type { BondCommitment } from "./bond.js";
export { BOND_COMMITMENT_SPEC_ID, isBondCommitment } from "./bond.js";

// === Cryptosuite Registry ===
// Every signed wire-format artifact in motebit declares its verification
// recipe via a `suite: SuiteId` field. Missing or unknown values are
// rejected fail-closed. See `packages/protocol/src/crypto-suite.ts` for
// the registry and `packages/crypto/src/suite-dispatch.ts` for the
// verification hook. Post-quantum migration is a new registry entry,
// not a wire-format change.
export type {
  SuiteId,
  SuiteEntry,
  SuiteStatus,
  SuiteAlgorithm,
  SuiteCanonicalization,
  SuiteSignatureEncoding,
  SuitePublicKeyEncoding,
} from "./crypto-suite.js";
export { SUITE_REGISTRY, ALL_SUITE_IDS, isSuiteId, getSuiteEntry } from "./crypto-suite.js";
export type {
  DigestAlgorithm,
  DigestRef,
  ProjectionClass,
  EvidenceProvenance,
  EvidenceRef,
} from "./evidence-provenance.js";
export {
  ALL_DIGEST_ALGORITHMS,
  isDigestAlgorithm,
  ALL_PROJECTION_CLASSES,
  isProjectionClass,
} from "./evidence-provenance.js";

// Merkle tree-hash version registry — the agility axis for leaf/node domain
// separation (RFC 6962 §2.1). Separate from `SuiteId` (signature recipe): this
// names the tree-hash recipe that builds the root the signature commits to. A
// signed proof carries an optional `tree_hash_version`; absent ⇒ v1. See
// `packages/protocol/src/merkle-tree-hash.ts` for the registry and
// `docs/doctrine/merkle-tree-hash-versioning.md` for the migration.
export type {
  MerkleTreeVersion,
  MerkleTreeVersionEntry,
  MerkleTreeVersionStatus,
  MerkleHashFunction,
} from "./merkle-tree-hash.js";
export {
  MERKLE_TREE_VERSION_REGISTRY,
  ALL_MERKLE_TREE_VERSIONS,
  DEFAULT_MERKLE_TREE_VERSION,
  isMerkleTreeVersion,
  getMerkleTreeVersionEntry,
} from "./merkle-tree-hash.js";

// ── Retention policy (protocol-level) ────────────────────────────────
// Three retention shapes, one signed `DeletionCertificate` discriminated
// union, sensitivity ceilings as interop law + reference defaults,
// signed retention manifest. See docs/doctrine/retention-policy.md.

export {
  MAX_RETENTION_DAYS_BY_SENSITIVITY,
  REFERENCE_RETENTION_DAYS_BY_SENSITIVITY,
  RUNTIME_RETENTION_REGISTRY,
  EMPTY_FEDERATION_GRAPH_ANCHOR,
} from "./retention-policy.js";

export type {
  RetentionCeilingDays,
  RetentionShape,
  RetentionShapeDeclaration,
  RetentionStoreDeclaration,
  RetentionManifest,
  RuntimeStoreId,
  DeletionCertificate,
  DeletionReason,
  HorizonSubject,
  HorizonWitness,
  HorizonWitnessRequestBody,
  WitnessSolicitationRequest,
  WitnessSolicitationResponse,
  FederationGraphAnchor,
  MerkleAlgo,
  MerkleInclusionProof,
  SubjectSignature,
  OperatorSignature,
  DelegateSignature,
  GuardianSignature,
  SensitivityLevelString,
} from "./retention-policy.js";

// ── Memory event payloads (spec/memory-delta-v1.md) ───────────────
export type {
  MemoryDecayedPayload,
  MemoryFormedPayload,
  MemoryAccessedPayload,
  MemoryPinnedPayload,
  MemoryDeletedPayload,
  MemoryConsolidatedPayload,
  MemoryAuditPayload,
  MemoryPromotedPayload,
} from "./memory-events.js";

// ── Goal-lifecycle event payloads (spec/goal-lifecycle-v1.md) ────
export type {
  GoalCreatedPayload,
  GoalExecutedPayload,
  GoalProgressPayload,
  GoalCompletedPayload,
  GoalRemovedPayload,
} from "./goal-lifecycle.js";

// ── Plan-lifecycle event payloads (spec/plan-lifecycle-v1.md) ────
export type {
  PlanCreatedPayload,
  PlanStepStartedPayload,
  PlanStepCompletedPayload,
  PlanStepFailedPayload,
  PlanStepDelegatedPayload,
  PlanCompletedPayload,
  PlanFailedPayload,
} from "./plan-lifecycle.js";

// ── Computer-use payloads (spec/computer-use-v1.md) ──────────────
export type {
  ComputerPoint,
  ComputerTargetHint,
  ScreenshotAction,
  CursorPositionAction,
  ClickAction,
  DoubleClickAction,
  MouseMoveAction,
  DragAction,
  TypeAction,
  KeyAction,
  ScrollAction,
  NavigateAction,
  ClickElementAction,
  FocusElementAction,
  TypeIntoAction,
  ComputerAction,
  ComputerActionKind,
  ComputerActionRequest,
  ComputerObservationResult,
  ComputerRedaction,
  ScreenshotObservation,
  CursorPositionObservation,
  ReadPageResult,
  ReadPageHeading,
  ReadPageLink,
  ReadPageInput,
  ReadPageButton,
  ComputerSessionOpened,
  ComputerSessionClosed,
  ComputerFailureReason,
  ComputerSessionActionRecord,
  SignableComputerSessionReceipt,
  ComputerSessionReceipt,
  ScreencastFrame,
  ScreencastFrameSource,
} from "./computer-use.js";
export { COMPUTER_ACTION_KINDS, COMPUTER_FAILURE_REASONS } from "./computer-use.js";

// ── Co-browse — control state machine for the virtual_browser
// embodiment (Slice 0). Pure protocol surface here; runtime state
// machine lives in `@motebit/runtime`'s `co-browse-control.ts`.
export type {
  ControlHolder,
  ControlState,
  CoBrowseTransitionKind,
  CoBrowseControlChangedPayload,
  KeyModifiers,
  UserInputEvent,
  UserInputForwardOutcome,
  UserInputRejectionReason,
  CharacterClass,
  KeyRole,
  UserInputForwardedDetail,
  UserInputForwardedPayload,
} from "./co-browse.js";
export { CO_BROWSE_TRANSITION_KINDS } from "./co-browse.js";

export type { ToolMode } from "./tool-mode.js";
export { TOOL_MODES, toolModePriority } from "./tool-mode.js";

// ── Perception input (drag-drop substrate) ──────────────────────
// Closed categorical drop kinds; within-kind handlers register in-
// runtime per surface. Same agility-as-role pattern as ToolMode.
export type {
  DropPayloadKind,
  DropTarget,
  DropPayload,
  UserActionAttestation,
  SensitivityGateEntry,
  SensitivityElevationSource,
  SensitivityGateFiredPayload,
  SecretRedactedFromEgressPayload,
} from "./perception.js";
export { resolveDropTarget } from "./perception.js";

// Sensitivity ladder algebra — pure math over the closed
// `SensitivityLevel` enum. Single source of truth for ordering and
// composition: every consumer derives comparison decisions through
// `rankSensitivity` so a future tier insertion remains a one-file
// change at the protocol layer. Doctrine: see ./sensitivity.ts header.
export {
  rankSensitivity,
  maxSensitivity,
  sensitivityPermits,
  ALL_SENSITIVITY_LEVELS,
  isSensitivityLevel,
} from "./sensitivity.js";
export type { SensitivityCleared } from "./sensitivity.js";
export { ALL_EVENT_TYPES, isEventType } from "./event-type.js";

// Money primitives — interop law for integer-unit accounting. Pure
// algebra over numbers; the two reference precisions (micro-units for
// USDC-grade ledger work, cents for the fiat rail family) are the
// canonical converter family every consumer routes through. Inline
// `Math.round(amount * 100|1_000_000)` is a category error gated by
// `scripts/check-money-boundary.ts`.
export {
  MICRO,
  CENTS,
  toMicro,
  fromMicro,
  toCents,
  fromCents,
  computeP2pFeeMicro,
  computeFederatedFeeSplit,
} from "./money.js";
export type { FederatedFeeSplit } from "./money.js";

// Token audiences — closed registry of `aud` claim values for the
// Routing primitive — closed-registry types for the auto-router.
// `TaskShape` is the role (closed registry); the routing-policy
// is a consumer-side function in BSL `@motebit/policy`. Also
// lifts `InferenceHost`, `ModelLab`, `Jurisdiction` from the
// proxy's `validation.ts` (intelligence-source agility's
// anticipated landing site). Drift gate `check-routing-decision-
// coverage` enforces every registered consumer imports +
// dispatches through `dispatchRouting`. See `./routing.ts`
// header + `docs/doctrine/auto-routing-as-protocol-primitive.md`.
export type {
  InferenceHost,
  ModelLab,
  Jurisdiction,
  TaskShape,
  ProviderCapability,
  RoutingConstraint,
  RoutingDecision,
} from "./routing.js";
export {
  ALL_TASK_SHAPES,
  isTaskShape,
  QUICK_TASK_SHAPE,
  CHAT_TASK_SHAPE,
  REASONING_TASK_SHAPE,
  CODE_TASK_SHAPE,
  RESEARCH_TASK_SHAPE,
  CREATIVE_TASK_SHAPE,
  MATH_TASK_SHAPE,
} from "./routing.js";

// audience-bound signed-token primitive. Cross-endpoint replay
// prevention; every signed bearer carries `aud` and verifiers reject
// unexpected values fail-closed. Same closure pattern as `SuiteId`,
// `SettlementRail`, `ToolMode`. Drift gate `check-audience-canonical`
// scans `aud: "<literal>"` and `createSyncToken("<literal>")` against
// `ALL_TOKEN_AUDIENCES`. See `./audience.ts` header.
export type { TokenAudience } from "./audience.js";
export {
  ALL_TOKEN_AUDIENCES,
  isTokenAudience,
  SYNC_AUDIENCE,
  DEVICE_AUTH_AUDIENCE,
  PAIR_AUDIENCE,
  ROTATE_KEY_AUDIENCE,
  PUSH_REGISTER_AUDIENCE,
  TASK_SUBMIT_AUDIENCE,
  TASK_QUERY_AUDIENCE,
  TASK_RESULT_AUDIENCE,
  ADMIN_QUERY_AUDIENCE,
  PROPOSAL_AUDIENCE,
  MARKET_LISTING_AUDIENCE,
  MARKET_QUERY_AUDIENCE,
  CREDENTIALS_AUDIENCE,
  CREDENTIALS_PRESENT_AUDIENCE,
  ACCOUNT_BALANCE_AUDIENCE,
  ACCOUNT_DEPOSIT_AUDIENCE,
  ACCOUNT_WITHDRAW_AUDIENCE,
  ACCOUNT_WITHDRAWALS_AUDIENCE,
  ACCOUNT_CHECKOUT_AUDIENCE,
  BROWSER_SANDBOX_GRANT_AUDIENCE,
  BROWSER_SANDBOX_AUDIENCE,
  RUNTIME_ATTACH_AUDIENCE,
} from "./audience.js";

// Content-artifact types — closed registry of `artifact_type` claim
// values for the C2PA-shape content-provenance primitive
// (`ContentArtifactManifest` in `@motebit/crypto`). Producer-declared
// category for routing / audit / display; drift gate
// `check-artifact-type-canonical` scans every `artifact_type:
// "<literal>"` and `artifactType: "<literal>"` site against
// `ALL_CONTENT_ARTIFACT_TYPES`. Same closure pattern as `TokenAudience`,
// `SuiteId`, `SettlementRail`. See `./artifact-type.ts` header and
// `docs/doctrine/nist-alignment.md` §8.
export type { ContentArtifactType } from "./artifact-type.js";
export {
  ALL_CONTENT_ARTIFACT_TYPES,
  isContentArtifactType,
  STATE_SNAPSHOT_ARTIFACT,
  MEMORY_EXPORT_ARTIFACT,
  GOAL_LIST_ARTIFACT,
  CONVERSATION_LIST_ARTIFACT,
  CONVERSATION_MESSAGES_ARTIFACT,
  DEVICE_LIST_ARTIFACT,
  AUDIT_TRAIL_ARTIFACT,
  PLAN_LIST_ARTIFACT,
  PLAN_DETAIL_ARTIFACT,
  GRADIENT_HISTORY_ARTIFACT,
  SYNC_PULL_ARTIFACT,
  EXECUTION_LEDGER_ARTIFACT,
  GOAL_RESULT_ARTIFACT,
  SETTLEMENT_SUMMARY_ARTIFACT,
} from "./artifact-type.js";

export type {
  SettlementSummaryExport,
  SettlementSummaryPeer,
  SettlementSummaryUnattributed,
} from "./settlement-summary.js";

// Operator-transparency declaration — the trust-anchor primitive
// (spec/relay-transparency-v1.md, Stage 2b-i). The relay publishes a
// signed declaration at /.well-known/motebit-transparency.json; the
// declaration's `relay_public_key` is the trust anchor every motebit
// verifier pins for content-artifact manifests, settlement receipts,
// and federation handshakes. The optional onchain anchor (Solana memo
// `motebit:transparency:v1:{hash}`) closes the TOFU savant gap on the
// first fetch. See `./transparency.ts` header.
export type {
  SignedTransparencyDeclaration,
  TransparencySignedPayload,
  TransparencyAnchorRecord,
} from "./transparency.js";
export {
  TRANSPARENCY_SUITE,
  TRANSPARENCY_ANCHOR_MEMO_PREFIX,
  TRANSPARENCY_SPEC_ID,
  isSignedTransparencyDeclaration,
} from "./transparency.js";

// ── Agent revocation — operator de-list power, sovereign-verifiable ──
// The relay's hygiene tool for a permissionless registry. Each revocation
// (and reinstatement) is a signed, reasoned, publicly-fetchable record
// against the pinned relay key — de-list, never de-identify; post-hoc
// hygiene, never editorial curation. See `./agent-revocation.ts` header.
export type {
  AgentRevocationReason,
  AgentRevocationActor,
  AgentRevocationRecord,
  AgentRevocationSignedPayload,
  AgentRevocationFeed,
} from "./agent-revocation.js";
export {
  ALL_AGENT_REVOCATION_REASONS,
  isAgentRevocationReason,
  AGENT_REVOCATION_SUITE,
  AGENT_REVOCATION_SPEC_ID,
} from "./agent-revocation.js";

import type { ToolMode } from "./tool-mode.js";
import type { SettlementMode, P2pPaymentProof } from "./settlement-mode.js";
import type { SettlementAsset } from "./settlement-asset.js";

// ── Skill manifest + envelope (spec/skills-v1.md) ────────────────
export type {
  SkillSensitivity,
  SkillPlatform,
  SkillHardwareAttestationGate,
  SkillSignature,
  SkillManifestMetadata,
  SkillManifestMotebit,
  SkillManifest,
  SkillEnvelopeFile,
  SkillEnvelopeSkillRef,
  SkillEnvelope,
  SkillLoadPayload,
} from "./skills.js";
export { SKILL_SENSITIVITY_TIERS, SKILL_AUTO_LOADABLE_TIERS, SKILL_PLATFORMS } from "./skills.js";

// ── Skills registry (spec/skills-registry-v1.md) ────────────────
export type {
  SkillRegistryEntry,
  SkillRegistrySubmitRequest,
  SkillRegistrySubmitResponse,
  SkillRegistryListing,
  SkillRegistryBundle,
} from "./skills.js";
