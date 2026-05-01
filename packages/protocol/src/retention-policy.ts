/**
 * Retention policy — three shapes, one signed deletion-certificate union,
 * sensitivity ceilings as interop law, reference defaults below them.
 *
 * Permissive floor (Apache-2.0). Type-only file — no I/O, no algorithms
 * that bind the runtime. Verifiers and signers live in `@motebit/crypto`;
 * runtime-validation schemas live in `@motebit/wire-schemas`; the
 * judgment of which retention shape a store registers under lives in the
 * BSL packages that hold those stores. Adding a new retention shape is
 * an additive `kind: "..."` entry here plus a new dispatch arm in
 * `verifyDeletionCertificate` — never a rename of an existing one.
 *
 * Doctrine: docs/doctrine/retention-policy.md.
 */

import type { MotebitId, NodeId } from "./index.js";
import type { SuiteId } from "./crypto-suite.js";

// ── Sensitivity ceilings — interop law vs reference default ──────────
//
// Two-axis split per protocol-model.md § "Naming: interop law vs
// reference default" (commit 9923185c precedent for `DEFAULT_` →
// `REFERENCE_` rename mechanics). The ceiling values are interop law —
// federation peers compare retention claims against them; an
// implementation that exceeds the ceiling for medical / financial /
// secret is non-conforming. The reference values are what the canonical
// motebit relay enforces today; alternative implementations MAY ship
// stricter, MUST NOT ship looser.

/** A ceiling for retention in days, or `Infinity` for "no upper bound." */
export type RetentionCeilingDays = number;

/**
 * Protocol-stated UPPER BOUND on retention, by sensitivity level.
 * Compliant implementations MUST enforce a finite ceiling for
 * `medical | financial | secret` and MAY enforce one for `personal`.
 * `none` is `Infinity` by law. Operators MAY ship a stricter policy.
 *
 * Federation peers compare retention claims against these values. An
 * operator manifest declaring retention beyond a ceiling is non-conforming.
 */
export const MAX_RETENTION_DAYS_BY_SENSITIVITY: Readonly<{
  none: RetentionCeilingDays;
  personal: RetentionCeilingDays;
  medical: RetentionCeilingDays;
  financial: RetentionCeilingDays;
  secret: RetentionCeilingDays;
}> = Object.freeze({
  none: Infinity,
  personal: 365,
  medical: 90,
  financial: 90,
  secret: 30,
});

/**
 * Reference defaults — what motebit's canonical relay enforces today.
 * At-or-below `MAX_RETENTION_DAYS_BY_SENSITIVITY` for every level. An
 * alternative implementation MAY override and remain interop-compliant
 * so long as its values are at-or-below the ceiling.
 *
 * `@motebit/privacy-layer` consumes these as the in-runtime defaults; a
 * parity test asserts `REFERENCE_RETENTION_DAYS_BY_SENSITIVITY[k] <=
 * MAX_RETENTION_DAYS_BY_SENSITIVITY[k]` for every key.
 */
export const REFERENCE_RETENTION_DAYS_BY_SENSITIVITY: Readonly<{
  none: RetentionCeilingDays;
  personal: RetentionCeilingDays;
  medical: RetentionCeilingDays;
  financial: RetentionCeilingDays;
  secret: RetentionCeilingDays;
}> = Object.freeze({
  none: Infinity,
  personal: 365,
  medical: 90,
  financial: 90,
  secret: 30,
});

// ── Retention shape — three legitimate motions, registered per store ──
//
// The `kind` discriminator strings are interop law — verifiers dispatch
// on these exact strings; alternative implementations cannot rename to
// semantic equivalents. Adding a new shape is additive registry growth.

/**
 * Retention shape registered by a store. Three legitimate motions
 * derived from the doctrine's droplet-physics framing:
 *
 *   - `mutable_pruning` — interior structure where individual deletion
 *     is sound (memory).
 *   - `append_only_horizon` — audit ledgers that admit only whole-prefix
 *     truncation (event-log, federation audit, settlement audit).
 *   - `consolidation_flush` — surface flow that consolidates into memory
 *     or expires (conversations, tool-audit).
 */
export type RetentionShape =
  | {
      readonly kind: "mutable_pruning";
      /** Per-sensitivity max retention days. Enforced ≤ `MAX_RETENTION_DAYS_BY_SENSITIVITY`. */
      readonly max_retention_days_by_sensitivity: Readonly<Record<string, RetentionCeilingDays>>;
      /** Always `true` — the shape commits to producing signed deletion certs. */
      readonly deletion_cert: true;
    }
  | {
      readonly kind: "append_only_horizon";
      /** How often the store may advance its horizon. */
      readonly horizon_advance_period_days: number;
      /** Always `true` — the shape commits to producing signed horizon certs. */
      readonly horizon_cert: true;
      /**
       * Whether co-witness signatures are required on horizon certs.
       * Decision 9: this value is DERIVED from federation state, not
       * declared. The store declares `false` for self-witnessed mode;
       * the manifest layer overrides to `true` when the operator
       * appears in any peer's federation graph.
       */
      readonly witness_required: boolean;
    }
  | {
      readonly kind: "consolidation_flush";
      readonly flush_to: "memory" | "expire";
      /**
       * Optional per-record min-floor resolver. Examines a record and
       * returns the minimum days before flush is permissible. Used for
       * settlement-floor obligations on tool-audit records (decision 3).
       *
       * Pure or async — phase 5 reads the resolver's return type and
       * picks accordingly. Stateful resolvers close over a context
       * passed at store registration; the resolver itself receives the
       * record and returns the floor.
       */
      readonly min_floor_resolver?: (record: unknown) => number | Promise<number>;
      /** Always `true` — the shape commits to producing signed flush certs. */
      readonly flush_cert: true;
    };

// ── Federation graph anchor (cert-format reservation, phase-1 shape) ──
//
// Phase 4 picks the quorum mechanism that consumes this. Phase 1
// commits the shape so phase 4 can land without a wire break. The algo
// identifier `merkle-sha256-v1` is a closed registry the same way
// `SuiteId` is closed; future Merkle algorithms ship as additive
// registry entries plus dispatch arms.
//
// Algorithm body: SHA-256 leaves, binary tree with odd-leaf promotion
// (no duplication) — same algorithm as `spec/credential-anchor-v1.md`
// §3-5 and `spec/relay-federation-v1.md` §7.6. Peer-set canonicalization:
// the operator's federation-peer Ed25519 public keys, hex-encoded,
// lowercase, sorted ascending, at the cert's `horizon_ts`.

/** The closed registry of Merkle algorithm identifiers. */
export type MerkleAlgo = "merkle-sha256-v1";

/**
 * Federation graph anchor — Merkle commitment over the operator's
 * federation peer set at `horizon_ts`. Phase 4 quorum verification
 * recomputes the root from the operator's published peer set or
 * verifies inclusion proofs against it.
 *
 * `leaf_count = 0` is the canonical self-witnessed encoding (no peers
 * at `horizon_ts`); see `EMPTY_FEDERATION_GRAPH_ANCHOR`.
 */
export interface FederationGraphAnchor {
  readonly algo: MerkleAlgo;
  /** Hex-encoded SHA-256 root. */
  readonly merkle_root: string;
  /** Number of peer pubkeys in the anchored set. */
  readonly leaf_count: number;
}

/**
 * Empty-tree federation graph anchor — the canonical self-witnessed
 * encoding when an operator has no federation peers at `horizon_ts`.
 *
 * `merkle_root` is the hex-encoded SHA-256 of the empty byte string
 * (`sha256(new Uint8Array(0))`). Verifiers in `@motebit/crypto` admit
 * `append_only_horizon` certs carrying this anchor as self-witnessed —
 * `witnessed_by[]` may be empty since there are no peers to solicit.
 *
 * Phase 4b-3 makes `federation_graph_anchor` mandatory on certs from
 * federation-aware deployments; pre-4b-3 certs without the field are
 * grandfathered self-witnessed (verifier policy enforces
 * presence-when-peered, not presence-always).
 */
export const EMPTY_FEDERATION_GRAPH_ANCHOR: FederationGraphAnchor = Object.freeze({
  algo: "merkle-sha256-v1",
  // SHA-256 of zero bytes — well-known constant.
  merkle_root: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  leaf_count: 0,
});

/**
 * Merkle inclusion proof — same wire shape as
 * `spec/credential-anchor-v1.md` §6 (siblings ordered leaf-to-root,
 * `layer_sizes` for odd-leaf-promotion detection, `leaf_index`
 * positional).
 */
export interface MerkleInclusionProof {
  readonly siblings: string[];
  readonly leaf_index: number;
  readonly layer_sizes: number[];
}

// ── Witness signature — append_only_horizon co-witness shape ─────────

export interface HorizonWitness {
  readonly motebit_id: MotebitId;
  /** Ed25519 signature over the cert's canonical signing payload. */
  readonly signature: string;
  /**
   * Optional Merkle inclusion proof for the witness's pubkey against
   * the cert's `federation_graph_anchor.merkle_root`. Phase 4 quorum
   * mechanisms either require this (Merkle-membership verification)
   * or accept signature-only witnesses. Reserved in phase 1 so phase
   * 4 lands without a wire break.
   */
  readonly inclusion_proof?: MerkleInclusionProof;
}

// ── Per-arm signature blocks ─────────────────────────────────────────

/** Subject (motebit) signature block. */
export interface SubjectSignature {
  readonly motebit_id: MotebitId;
  readonly suite: SuiteId;
  readonly signature: string;
}

/** Operator signature block. */
export interface OperatorSignature {
  readonly operator_id: string;
  readonly suite: SuiteId;
  readonly signature: string;
}

/**
 * Delegate signature block — multi-hop authorization per delegation-v1
 * §5.5. The delegate's identity key signs; the delegation_receipt_id
 * references the receipt that authorized the retention scope.
 */
export interface DelegateSignature {
  readonly motebit_id: MotebitId;
  readonly delegation_receipt_id: string;
  readonly suite: SuiteId;
  readonly signature: string;
}

/**
 * Guardian signature block — enterprise custody per identity-v1 §3.3.
 * Verifier MUST cross-check `guardian_public_key` against the motebit's
 * identity file `guardian.public_key` field.
 */
export interface GuardianSignature {
  /** Hex-encoded guardian Ed25519 public key. Matches `motebit.md` §3.3 `guardian.public_key`. */
  readonly guardian_public_key: string;
  readonly suite: SuiteId;
  readonly signature: string;
}

// ── Action class — what kind of deletion is being attested ───────────

/**
 * Reasons admitted by `mutable_pruning` and `consolidation_flush` arms.
 * Each reason constrains the permitted signer set per decision 5's
 * `reason × signer × mode` table. Verifiers reject certs whose
 * present signature(s) don't match the reason's permitted set.
 *
 * `retention_enforcement_post_classification` is admitted by
 * `consolidation_flush` only — it names the migration cohort under
 * decision 6b's lazy-classify-on-flush path.
 */
export type DeletionReason =
  | "user_request"
  | "retention_enforcement"
  | "retention_enforcement_post_classification"
  | "operator_request"
  | "delegated_request"
  | "self_enforcement"
  | "guardian_request";

// ── DeletionCertificate — single discriminated union ─────────────────

/**
 * Subject discriminator on `append_only_horizon`. Per decision 8, both
 * per-motebit and operator-wide horizons are first-class; effective
 * horizon for any given motebit's events is `max` of both.
 */
export type HorizonSubject =
  | { readonly kind: "motebit"; readonly motebit_id: MotebitId }
  | { readonly kind: "operator"; readonly operator_id: string };

/**
 * Signed retention deletion certificate. Single discriminated union by
 * `kind`. New deletion shapes ship as additive registry entries; the
 * verifier in `@motebit/crypto` closes under additions.
 *
 * Canonical signing payload (decision 5): each signature in
 * `mutable_pruning` and `consolidation_flush` covers
 * `canonicalJson(cert_body)` where `cert_body` is the cert with all
 * `*_signature` fields removed. All present signers sign identical
 * bytes — same shape as identity-v1.md §3.8.1 dual-signature succession.
 * The `append_only_horizon` arm covers `canonicalJson(cert minus
 * signature)`.
 *
 * Certificates are TERMINAL: there is no signed-revocation path. A cert
 * issued in error is corrected by a follow-up cert under a different
 * reason. Same foundation-law shape as delegation-v1.md §4.2 and
 * migration-v1.md §3.2 terminal-state irreversibility.
 */
export type DeletionCertificate =
  | {
      readonly kind: "mutable_pruning";
      readonly target_id: NodeId;
      readonly sensitivity: SensitivityLevelString;
      readonly reason: DeletionReason;
      readonly deleted_at: number;
      readonly subject_signature?: SubjectSignature;
      readonly operator_signature?: OperatorSignature;
      readonly delegate_signature?: DelegateSignature;
      readonly guardian_signature?: GuardianSignature;
    }
  | {
      readonly kind: "append_only_horizon";
      readonly subject: HorizonSubject;
      readonly store_id: string;
      readonly horizon_ts: number;
      readonly witnessed_by: HorizonWitness[];
      /**
       * Optional pre-4b-3, mandatory from 4b-3+. When present with
       * `leaf_count = 0` (`EMPTY_FEDERATION_GRAPH_ANCHOR`) the cert is
       * self-witnessed — `witnessed_by` may be empty.
       */
      readonly federation_graph_anchor?: FederationGraphAnchor;
      readonly issued_at: number;
      readonly suite: SuiteId;
      readonly signature: string;
    }
  | {
      readonly kind: "consolidation_flush";
      readonly target_id: string;
      readonly sensitivity: SensitivityLevelString;
      readonly reason: DeletionReason;
      readonly flushed_to: "memory_node" | "expire";
      readonly memory_node_id?: NodeId;
      readonly flushed_at: number;
      readonly subject_signature?: SubjectSignature;
      readonly operator_signature?: OperatorSignature;
      readonly delegate_signature?: DelegateSignature;
      readonly guardian_signature?: GuardianSignature;
    };

/**
 * Sensitivity expressed as the wire string. Mirrors
 * `SensitivityLevel` enum values without importing the enum (this file
 * stays minimal; the enum lives in index.ts).
 */
export type SensitivityLevelString = "none" | "personal" | "medical" | "financial" | "secret";

// ── Retention manifest — operator-published, signed, browser-verifiable

/**
 * Per-store retention declaration, embedded in the operator's signed
 * retention manifest. Names the registered shape and the parameters a
 * verifier needs to check the operator's claims against running code.
 */
export interface RetentionStoreDeclaration {
  /** Stable identifier for the store within the operator's deployment. */
  readonly store_id: string;
  /** Human-readable name for tooling display. */
  readonly store_name: string;
  /** The registered retention shape. */
  readonly shape: RetentionShapeDeclaration;
}

/**
 * Wire-format projection of `RetentionShape` — drops the resolver
 * function (a closure can't ride the wire) and surfaces declared
 * parameters only. The runtime registration in BSL carries the
 * resolver; the manifest declares its presence as a boolean.
 */
export type RetentionShapeDeclaration =
  | {
      readonly kind: "mutable_pruning";
      readonly max_retention_days_by_sensitivity: Readonly<Record<string, RetentionCeilingDays>>;
    }
  | {
      readonly kind: "append_only_horizon";
      readonly horizon_advance_period_days: number;
      readonly witness_required: boolean;
    }
  | {
      readonly kind: "consolidation_flush";
      readonly flush_to: "memory" | "expire";
      readonly has_min_floor_resolver: boolean;
    };

// ── Canonical runtime retention registry ─────────────────────────────
//
// The central registry of well-known runtime-side stores that hold
// records subject to retention doctrine. Each entry pins one store to
// its registered `RetentionShapeDeclaration` (the wire-format projection
// without closures). The drift gate `check-retention-coverage` asserts
// every store with a `sensitivity` field or settlement obligation
// appears here, and that no entry registers a shape inconsistent with
// the doctrine.
//
// Runtime-scoped: every entry below lives on the user's device, not in
// the relay's deployment. The relay's retention manifest declares
// `out_of_deployment:` for these stores by design — server-side
// single-tenant deployments don't host them. Each per-motebit runtime
// publishes its own retention manifest projecting over this registry.
//
// Adding a runtime-side store with sensitivity-classified records is an
// additive entry here; the gate fires on omission. Removing a registered
// shape requires a doctrine update — operators that have published a
// manifest committing to that shape can't silently drop the
// commitment.

/**
 * Stable string identifier for each canonical runtime store. The
 * discriminator is interop law — verifiers and tooling cross-reference
 * these exact strings with the manifest's `RetentionStoreDeclaration.store_id`.
 */
export type RuntimeStoreId = "memory" | "event_log" | "conversation_messages" | "tool_audit";

/**
 * Canonical registry: `RuntimeStoreId` → declared `RetentionShape`.
 *
 *   - `memory` registers under `mutable_pruning` per phase 3 — the
 *     privacy-layer's `deleteMemory` constructs and signs the cert at
 *     each erase call site.
 *   - `event_log` registers under `append_only_horizon` per phase 4a —
 *     `EventStore.advanceHorizon` signs the horizon cert and truncates.
 *     `witness_required: false` is the no-peer-deployment derivation
 *     per decision 9; the manifest layer overrides to `true` once the
 *     operator appears in any peer's federation graph (phase 4b-3).
 *   - `conversation_messages` and `tool_audit` register under
 *     `consolidation_flush` per phase 5-ship — the consolidation cycle's
 *     flush phase enforces, lazy-classifying on read per decision 6b.
 *     Tool-audit's settlement-floor resolver per decision 3 is wired at
 *     runtime; the manifest projection surfaces only its presence.
 *
 * Reference defaults below come from `REFERENCE_RETENTION_DAYS_BY_SENSITIVITY`;
 * an alternative implementation MAY ship stricter ceilings and remain
 * interop-compliant.
 */
export const RUNTIME_RETENTION_REGISTRY: Readonly<
  Record<RuntimeStoreId, RetentionShapeDeclaration>
> = Object.freeze({
  memory: {
    kind: "mutable_pruning",
    max_retention_days_by_sensitivity: REFERENCE_RETENTION_DAYS_BY_SENSITIVITY,
  },
  event_log: {
    kind: "append_only_horizon",
    horizon_advance_period_days: 365,
    witness_required: false,
  },
  conversation_messages: {
    kind: "consolidation_flush",
    flush_to: "expire",
    has_min_floor_resolver: false,
  },
  tool_audit: {
    kind: "consolidation_flush",
    flush_to: "expire",
    has_min_floor_resolver: true,
  },
});

/**
 * Signed retention manifest published at
 * `/.well-known/motebit-retention.json`. Sibling to the operator
 * transparency manifest (`docs/doctrine/operator-transparency.md`),
 * same suite and same browser-side re-verification pattern.
 *
 * Decision 6b's lazy-classify-on-flush path declares its default tier
 * via `pre_classification_default_sensitivity`.
 */
export interface RetentionManifest {
  /** Always `motebit/retention-manifest@1`. */
  readonly spec: "motebit/retention-manifest@1";
  /** The operator publishing this manifest. */
  readonly operator_id: string;
  readonly issued_at: number;
  /** Per-store declarations. Drift gate enumerates against the registry. */
  readonly stores: RetentionStoreDeclaration[];
  /**
   * Default sensitivity for un-classified pre-deploy records under
   * `consolidation_flush` (decision 6b). Defaults to `"personal"` if
   * absent.
   */
  readonly pre_classification_default_sensitivity?: SensitivityLevelString;
  /**
   * Honest gaps the operator declares — same pattern as
   * `operator-transparency.md` § "Reference implementation". Stage 1
   * ships with the chain anchor in `honest_gaps` until stage 2.
   */
  readonly honest_gaps?: string[];
  readonly suite: SuiteId;
  readonly signature: string;
}
