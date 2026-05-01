# Retention policy

A droplet metabolizes contained matter through three legitimate motions: it prunes, it advances its horizon, it flushes surface flow into interior structure. Each motion has different physics. Each has different consequences for what an outside observer can verify after the matter is gone. A retention policy that treats them as one mechanism either over-constrains the audit ledger (delete-by-row breaks federation witness) or under-constrains the surface flow (no expiry on conversation history makes "fail-closed privacy" a marketing claim, not an enforced one).

Motebit's retention model is one typed contract with three legitimate shapes, registered per store, with one signed deletion-certificate format closed under additions. Same architectural pattern as `HardwareAttestationSemiring` across N platforms (`hardware-attestation.md`), `SettlementRail` split into `GuestRail` / `SovereignRail` at the type level (`settlement-rails.md`), and the `SuiteId` cryptosuite registry (`protocol-model.md` § "Cryptosuite agility"). New stores register against an existing shape or add a fourth — the verifier closes under additions; the algebra composes.

This document is the doctrine. `spec/retention-policy-v1.md` (when it lands — same staging as operator-transparency) will define the wire format. Stage 2 lands once a second store family forces the question of "what fields must we standardize."

## Why retention is plural

Today's enforcement asymmetry is the diagnosis:

| Store         | Sensitivity field                                | Retention enforcement                                                                                 |
| ------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Memory        | ✓ `MemoryContent.sensitivity`                    | ✓ `consolidation-cycle.ts:444-453` — `prune` phase calls `deleteMemory(..., "retention_enforcement")` |
| Conversations | ✗ `ConversationStoreAdapter` carries none        | ✗ `conversation-search.ts:38` — `ConversationMessageRecord` has no TTL                                |
| Events        | ✗ `EventLogEntry` (`protocol/index.ts:346-356`)  | ✗ `event-log/src/index.ts` is append-only by construction                                             |
| Tool audit    | ✗ `ToolAuditEntry` (`protocol/index.ts:429-440`) | ✗ `browser-persistence/src/tool-audit-store.ts` queries but never prunes                              |

`CLAUDE.md:77` claims "Retention enforced via deletion certificates" as the motebit privacy boundary. Today, only memory honors that claim. The fix is not to retrofit memory's prune phase onto the other three — they have different physics, and the prune phase isn't the right enforcement for any of them. The fix is to name the three shapes, type-system them at the protocol layer, and register each store against the shape its physics dictates.

## The three shapes

```ts
type RetentionShape =
  | {
      kind: "mutable_pruning";
      max_retention_days_by_sensitivity: Record<SensitivityLevel, number>;
      deletion_cert: true;
    }
  | {
      kind: "append_only_horizon";
      horizon_advance_period_days: number;
      horizon_cert: true;
      witness_required: boolean;
    }
  | {
      kind: "consolidation_flush";
      flush_to: "memory" | "expire";
      min_floor_resolver?: (record: unknown) => number;
      flush_cert: true;
    };
```

### Mutable pruning

Interior structure where individual deletion is sound. Memory has it today. The store can delete a single node, sign a `DeletionCertificate` referencing that node by id, and a third party can verify the node is gone (the tombstone is signed by the motebit's identity key; recompute confirms the node is unrecoverable).

Registers: memory.

### Append-only horizon

Audit ledgers cannot delete individual entries without breaking what they exist for. The event log is consulted by federation peers, by dispute resolution, and by settlement audit; deleting an entry retroactively means the other parties' references no longer resolve. The only sound retention motion is **horizon advance**: a signed certificate stating "all entries before timestamp T are unrecoverable, witnessed by these peers," after which the prefix can be truncated as a unit. Whole-prefix truncation only. The cert is the proof of deletion; entries before T are unrecoverable but their existence at the time the horizon advanced is permanently witnessed.

Registers: event-log, federation audit, settlement audit (under ledger-class).

### Consolidation flush

Surface flow that consolidates into memory or expires. Conversation turns and tool-audit entries are not interior structure — they are the surface motion through which the motebit metabolizes interaction. Every turn flows through `runtime.consolidationCycle()` (`docs/doctrine/proactive-interior.md` § "the four phases"). Some turns become memory nodes via the `consolidate` phase and inherit `mutable_pruning` from there. The rest expire on a sensitivity-tiered schedule, with an optional **min-floor resolver** for records carrying obligations (settlement window, regulatory floor) that defer the flush.

Registers: conversations, tool-audit.

### The `kind` discriminator is interop law

The discriminator strings `mutable_pruning`, `append_only_horizon`, `consolidation_flush` are interop law per `protocol-model.md` § "Naming: interop law vs reference default." Verifiers dispatch on these exact strings — alternative implementations cannot rename to semantic equivalents without breaking federation. Adding a new shape ships as an additive `kind: "..."` entry in `@motebit/protocol` plus a new dispatch arm in `@motebit/crypto`'s `verifyDeletionCertificate`, never a rename or replacement of an existing one.

## Pressure tests — the phase-1 decisions, settled

A doctrine that locks the wrong choice here forces phase 4's federation rewrite. Ten decisions in this section. The first four define the algebra. Decisions 5, 7, 8, 9 close cert-format and semantic axes a careful adversarial walk surfaced. Decisions 6a and 6b name the cert-type evolution path and the data-migration path the cert format alone cannot specify.

### Decision 1 — single discriminated union, not three sibling certificate types

**Scenario.** A third-party verifier receives a deletion certificate from an unknown source. They have only `@motebit/crypto` and the issuer's public key. Can they verify it without knowing the artifact class up front?

**Test.** With three sibling types (`MemoryDeletionCertificate`, `HorizonCertificate`, `FlushCertificate`), the verifier must dispatch on type at the call site — leaking store-internal vocabulary into a public verification API. With a discriminated union under `kind`, one `verifyDeletionCertificate(cert)` in `@motebit/crypto` dispatches internally by `kind`, additive on registry growth, identical pattern to `verifyBySuite` in `packages/crypto/src/suite-dispatch.ts`.

**Locked.** Single discriminated union. New deletion shapes are additive registry entries, the verifier closes under additions. Final cert shape — incorporating the signing-authority split (decision 5), the horizon-subject discriminator (decision 8), and the cert-format reservations (federation graph anchor + per-witness inclusion proof) — is below; later decisions reference back to the relevant arms.

```ts
type DeletionCertificate =
  | {
      kind: "mutable_pruning";
      target_id: string;
      sensitivity: SensitivityLevel;
      reason:
        | "user_request"
        | "retention_enforcement"
        | "operator_request"
        | "delegated_request"
        | "self_enforcement"
        | "guardian_request";
      deleted_at: number;
      subject_signature?: { motebit_id: MotebitId; suite: SuiteId; signature: string };
      operator_signature?: { operator_id: string; suite: SuiteId; signature: string };
      delegate_signature?: {
        motebit_id: MotebitId;
        delegation_receipt_id: string;
        suite: SuiteId;
        signature: string;
      };
      guardian_signature?: { guardian_public_key: string; suite: SuiteId; signature: string };
    }
  | {
      kind: "append_only_horizon";
      subject:
        | { kind: "motebit"; motebit_id: MotebitId }
        | { kind: "operator"; operator_id: string };
      store_id: string;
      horizon_ts: number;
      witnessed_by: {
        motebit_id: MotebitId;
        signature: string;
        inclusion_proof?: { siblings: string[]; leaf_index: number; layer_sizes: number[] };
      }[];
      federation_graph_anchor?: {
        algo: "merkle-sha256-v1";
        merkle_root: string;
        leaf_count: number;
      };
      issued_at: number;
      suite: SuiteId;
      signature: string;
    }
  | {
      kind: "consolidation_flush";
      target_id: string;
      sensitivity: SensitivityLevel;
      reason:
        | "user_request"
        | "retention_enforcement"
        | "retention_enforcement_post_classification"
        | "operator_request"
        | "delegated_request"
        | "self_enforcement"
        | "guardian_request";
      flushed_to: "memory_node" | "expire";
      memory_node_id?: MemoryNodeId;
      flushed_at: number;
      subject_signature?: { motebit_id: MotebitId; suite: SuiteId; signature: string };
      operator_signature?: { operator_id: string; suite: SuiteId; signature: string };
      delegate_signature?: {
        motebit_id: MotebitId;
        delegation_receipt_id: string;
        suite: SuiteId;
        signature: string;
      };
      guardian_signature?: { guardian_public_key: string; suite: SuiteId; signature: string };
    };
```

This closes the gap that today's `DeletionCertificate` (`packages/encryption/src/index.ts:158-164`) leaves open: it is currently `{ target_id, target_type, deleted_at, deleted_by, tombstone_hash }` — no `suite`, no `signature`, single-source-signing. A self-attesting privacy boundary requires every claim to clear the three-test check (`self-attesting-system.md`); a tombstone hash without a signature fails test 1 (structured artifact) by half. Phase 2 lands the union and the migration in the same PR (decision 6a); the existing field becomes the `mutable_pruning` arm, and the other two arms land additively.

### Decision 2 — sensitivity-tier ceiling is interop law; reference numbers are reference defaults

**Scenario.** A user migrates their motebit from operator A (medical retention 90 days) to operator B (claims medical retention "forever"). Per `spec/migration-v1.md`, the destination's posture must be at least as strict as the source's. What does "at least as strict" mean if the protocol doesn't constrain the upper bound?

**Test.** If the numbers are pure reference defaults that operators may freely override, federation between operators with incompatible retention floors is asymmetric — peer A's medical content reaches peer B and persists past peer A's policy. If the numbers are pure interop law, motebit cannot adapt a stricter floor for jurisdictions that mandate one. Both fail.

**Locked.** Two-axis split, exactly mirroring `protocol-model.md` § "Naming: interop law vs reference default":

- **`MAX_RETENTION_DAYS_BY_SENSITIVITY`** (interop law, no prefix). Protocol-stated ceiling. Compliant implementations MUST enforce a finite ceiling for `medical | financial | secret` and MAY enforce one for `personal`. `none` is Infinity by law. The specific ceiling numbers are protocol-law constants — federation peers compare retention claims against these.
- **`REFERENCE_RETENTION_DAYS_BY_SENSITIVITY`** (reference default, `REFERENCE_` prefix). What motebit's canonical relay enforces. At-or-below the ceiling. An operator MAY ship a stricter policy and remain interop-compliant; an operator MAY NOT ship a looser one.

Today's numbers in `packages/privacy-layer/src/index.ts:128-143` (`30/90/90/365/Infinity` for `secret/financial/medical/personal/none`) graduate from "hardcoded reference impl" to "named pair" — the ceiling values are exported from `@motebit/protocol`, the reference defaults from `@motebit/privacy-layer`, parity test asserts the reference is at-or-below the ceiling.

### Decision 3 — settlement floor is a per-record resolver on `consolidation_flush`, not a fourth shape

**Scenario.** A user asks the relay to flush a tool-audit record from 6 months ago. Settlement happened 5 months ago, dispute window closed at 90 days, regulatory floor for financial-related audit is N years (jurisdiction-dependent). What happens?

**Test.** A fourth `delayed_flush` shape forces every settlement-relevant record into a separate store class, even though the tool-audit store contains a mix (memory-search audits carry no settlement obligation; settlement-paying-with-credit audits do). Splitting one store into two by per-record property is structurally wrong: the obligation is a property of the **record**, not the store.

**Locked.** Parameter on `consolidation_flush`. The store registers the shape; the shape carries a `min_floor_resolver: (record) => number` that examines each record and returns the minimum days before flush is permissible. The flush phase iterates records, computes `max(sensitivity_floor, obligation_floor)`, flushes records past both. One shape, time-varying obligation per record. Same decomposition pattern as `requiresApproval` on `ToolDefinition` — a property of the record, classified by a resolver, not split across types.

### Decision 4 — horizon advance requires federation co-witness for the witnessed event log

**Scenario.** Operator A advances the event-log horizon, deleting all entries before T. Federation peer B has cached references to entries before T (heartbeat receipts, dispute evidence). Without coordination, peer B's references no longer resolve, and B has no way to distinguish "operator A advanced their horizon" from "operator A is hiding evidence."

**Test.** Without witness, horizon advance is structurally indistinguishable from selective tampering. With witness, the certificate carries signatures from federation peers attesting they observed the horizon at T and accept that pre-T entries are unrecoverable; B's references rely on the witness, not the entries themselves.

**Locked.** `append_only_horizon` shape carries `witness_required: boolean`. For the federation event log, true. For local-only event logs (single-device, no federation), false (the certificate is self-witnessed, single Ed25519 signature). The witness array on the certificate is part of the signed body — a forged witness fails verification. Phase 4 implements the federation handshake for horizon advance as an additive protocol message; peers without witness support gracefully degrade to a longer retention floor on the data they cache from non-supporting operators. Decision 9 closes the open question of how `witness_required` is computed.

### Decision 5 — signing authority is action-class-keyed, scaling across deployment modes

**Scenario.** A user uploads `secret`-tier content to operator A; A's manifest declares 30-day retention; at day 30 the user is offline (operator must produce the cert without the subject's key). Inverted: during the consolidation cycle the runtime on the user's device prunes a memory node (operator key isn't on the user's device). Sovereign mode: the motebit runs locally with no operator at all (relay-optional per delegation-v1.md §8). Enterprise mode: the user has lost their identity key and the organizational guardian (identity-v1.md §3.3) must issue deletion on their behalf. Multi-hop: a user delegates "manage my data" to a third party, who issues deletion under that scope (delegation-v1.md §5.5).

**Test.** A single `signed_by` field collapses these five legitimate authorities into one. Each case must produce a verifiable cert, and the verifier must be able to confirm that the signer was permitted for the declared action class — not just that the signature is cryptographically valid.

**Locked.** Action class (`reason`) keys signer composition. Same shape as identity-v1.md §3.8.3 guardian-recovery succession, where `recovery: true` swaps `old_key_signature` for `guardian_signature` against the same canonical payload — the action class determines the permitted signer set. Adjacent precedent: identity-v1.md §3.3.2 dual-required signing for `guardian_revoked`. The retention table:

| `reason`                                    | Required signer                           | Optional signer(s)                         | Mode                                  |
| ------------------------------------------- | ----------------------------------------- | ------------------------------------------ | ------------------------------------- |
| `user_request`                              | `subject_signature`                       | `operator_signature` (acknowledgment)      | any                                   |
| `retention_enforcement`                     | `operator_signature`                      | `subject_signature` (co-signature)         | mediated                              |
| `retention_enforcement_post_classification` | `operator_signature`                      | `subject_signature`                        | mediated (consolidation_flush only)   |
| `operator_request`                          | `operator_signature`                      | none — `subject_signature` MUST be absent  | mediated                              |
| `delegated_request`                         | `delegate_signature` + delegation-receipt | `operator_signature`                       | mediated                              |
| `self_enforcement`                          | `subject_signature`                       | none — `operator_signature` MUST be absent | any (sovereign, mediated, enterprise) |
| `guardian_request`                          | `guardian_signature`                      | `operator_signature`                       | enterprise                            |

Three deployment modes the table covers, derived from identity-v1.md §3.3 + delegation-v1.md §8:

- **Sovereign personal** — no operator, no guardian. Permitted reasons: `user_request`, `self_enforcement`. The `_signature` fields admit only `subject_signature`.
- **Relay-mediated personal** — operator present, no guardian. Adds `retention_enforcement`, `retention_enforcement_post_classification`, `operator_request`, `delegated_request`. `self_enforcement` continues to apply when the subject's runtime drives policy locally (e.g., consolidation cycle on the user's device pruning by retention tier) — it is the subject's signing path, distinct from operator-driven `retention_enforcement`.
- **Enterprise** — operator + guardian (per `motebit.md` §3.3 `guardian` field). Adds `guardian_request` for cases where the subject's key is unavailable; the cert references the identity file's `guardian.public_key` so any verifier can confirm the signer is the motebit's declared guardian.

The cross-product `reason × signer × mode` is closed and verifier-checkable. The verifier reads the cert's `reason`, the operator's retention manifest (which declares the deployment mode), the motebit's identity file (for guardian presence), and admits the cert iff the present signature(s) match the table for the declared mode.

**Canonical signing payload — multi-signature certs.** Each signature in `mutable_pruning` and `consolidation_flush` covers `canonicalJson(cert_body)`, where `cert_body` is the entire cert object with every `*_signature` field removed (subject, operator, delegate, guardian — whichever are present). All present signers sign identical bytes; same shape as identity-v1.md §3.8.1's dual-signature canonical payload. Signing is commutative — any order produces identical bytes for every signer.

**Canonical signing payload — horizon certs.** The `append_only_horizon` arm splits the canonicalization to make federation co-witnessing operationally practical. The **issuer signature** covers `canonicalJson(cert minus signature)` — the full body including the assembled `witnessed_by` array. Each **witness signature** covers `canonicalJson(cert minus signature minus witnessed_by)` — the body without any witness data — so witnesses co-sign asynchronously without coordination. Security property is preserved: a forged or substituted witness fails verification at the issuer-signature step, because the body the issuer signed (with the original witness array) no longer matches the post-tampering body. The witness's own signature stays bound to that specific witness via the public key used at verification (resolved from `witnessed_by[i].motebit_id`); the cert body's other fields (subject, store_id, horizon_ts, issued_at, federation_graph_anchor) make two distinct horizon advances produce distinct signing bytes, so a witness signature cannot be relayed to a different cert.

JCS canonicalization throughout, suite-tagged via the cert's `suite` field; verification dispatches through `verifyBySuite` in `packages/crypto/src/suite-dispatch.ts`. Implementation: `canonicalizeMultiSignatureCert` and `canonicalizeHorizonCert` / `canonicalizeHorizonCertForWitness` in `@motebit/crypto/deletion-certificate.ts`.

### Decision 6a — cert migration: required fields, single-PR cutover

**Scenario.** Phase 2 ships the new union. Existing callers in `runtime/src/consolidation-cycle.ts:449` and `privacy-layer/src/index.ts:163` construct `DeletionCertificate` values without `kind`, without signatures.

**Test.** Optional `suite` + `signature` admits non-self-attesting certs into the type, breaking the three-test check at every receiver. A `legacy_unsigned` arm in the union poisons every consumer with "is this cert actually signed" filtering. Required fields with a single-PR cutover breaks compile in every caller — but compile failures are the migration tracker.

**Locked.** Required fields. Single-PR cutover. Same shape as the cryptosuite-agility migration (commit `9923185c`). The legacy `tombstone_hash` value can survive as a non-cryptographic "what was deleted" hint inside the `mutable_pruning` arm body, but does not satisfy the signature contract on its own. Apply the appropriate `@deprecated` shape to the legacy `DeletionCertificate` type alias, parameterized by the package's publication status — drift-defense #39 (`since` / `removed in` / replacement / reason four-field contract) for published packages, `check-private-deprecation-shape` (replacement pointer + `Reason:` block, no semver fields) for `0.0.0-private` packages. The host package today (`@motebit/encryption`) is private, so the no-semver shape applies. Phase 2 lands the type-level union, primitives, schemas, and the legacy deprecation; phase 3 lands the actual call-site cutover (memory's `deleteMemory` constructing signed certs) — which is the same pass that delivers decision 7's tombstone→erase semantics.

### Decision 6b — data migration: lazy-classify-on-flush, manifest-declared default

**Scenario.** Phase 5 lands `consolidation_flush` for the conversation store. Existing `ConversationMessageRecord` rows have no `sensitivity` field. The flush phase iterates them; what's their floor?

**Test.** Retroactive bulk-classify at deploy is expensive (a classifier pass over the entire conversation backlog), opens a "classifier sees historical content" surface, and produces a deploy-time cost spike. Permanent grandfather (pre-deploy records never flush) drifts toward a shadow store and structurally invalidates the doctrine's fail-closed claim. Lazy-classify-on-flush amortizes cost across normal operation and bounds the classifier's exposure to records being processed anyway.

**Locked.** Lazy-classify-on-flush. The retention manifest declares `pre_classification_default_sensitivity` (default `personal` if omitted); pre-deploy records carry that default until the flush phase classifies them. Classification runs as part of flush; if classification produces a higher tier, the record is flushed under the higher tier's floor immediately. Migration-cohort flushes use the dedicated `reason: "retention_enforcement_post_classification"` so the audit trail visibly distinguishes the cohort. No retroactive deploy-time pass; no permanent grandfather. Phase 5 wires the classifier hook into the flush phase before the per-record floor check.

### Decision 7 — `mutable_pruning` attests erase, not tombstone

**Scenario.** A receiver verifies a `mutable_pruning` cert and acts on the assumption that the bytes are unrecoverable. The local store implements deletion as tombstone — the `tombstoned: true` pattern that's correct for the event log (`event-log/src/index.ts`) and currently extends incorrectly to memory (the cycle's prune phase calls `deleteMemory`, but a tombstone-not-erase implementation would silently weaken the cert's claim).

**Test.** If `mutable_pruning` attests "no future retrieval" (the weak reading), the operator's signed cert can hold while the bytes persist on disk indefinitely — the doctrine's privacy claim is structurally weaker than receivers assume. If it attests "bytes unrecoverable" (the strong reading), tombstone-as-implementation is wrong and phase 3 must deliver actual erase.

**Locked.** Erase, not tombstone. `mutable_pruning` attests the bytes are unrecoverable from the store at certificate issuance. Phase 3 changes `deleteMemory` semantics from tombstone to erase; a phase-3 unit test asserts `deleteMemory(id)` followed by `getMemory(id)` returns `not_found`, never `tombstoned`. Tombstone semantics survive correctly on the event log (where they belong — the log is `append_only_horizon`, individual rows are never erased) but not on memory. The cert format thus encodes a substantive privacy guarantee, not a soft commitment. Same posture as `operator-transparency.md` § "Anti-patterns": the cert format does not invent disk-level erasure proof, but the doctrine forbids cert paths the implementation knowingly contradicts.

### Decision 8 — horizon subject is both, with `max` precedence

**Scenario.** Operator A advances its event-log horizon (operator-wide compaction). Motebit X hosted at A wants its own per-motebit horizon advanced earlier — the user requested early deletion of X's data ahead of the operator-wide policy. Both certs must be representable; the effective horizon must be unambiguous.

**Test.** Operator-wide-only blocks user-driven early deletion — a sovereignty failure. Per-motebit-only blocks operator-side log compaction (the operator owns the storage). Both with no precedence rule produces ambiguity when motebit X's horizon is later than operator A's about-to-fire horizon: which wins?

**Locked.** Both. The `append_only_horizon` arm carries a discriminated `subject` field — `{ kind: "motebit"; motebit_id }` for per-motebit certs (signed by the motebit's identity key) or `{ kind: "operator"; operator_id }` for operator-wide certs (signed by the operator key). Federation peers track per-motebit and per-operator horizons independently; an entry is unrecoverable when EITHER horizon has passed (`max` precedence). When motebit X's per-motebit horizon is later than operator A's operator-wide horizon, A's horizon wins — the operator owns the storage and cannot be blocked from compaction. Per-motebit horizon is purely additive; it can advance the effective horizon for X earlier than A would, never delay it past A.

### Decision 9 — witness trigger is structural, not self-declared

**Scenario.** A federated relay declares `witness_required: false` on its event-log `RetentionShape`, claiming "I'm local-only." The relay is in fact federated — Motebit A's events are referenced by federation peer B's heartbeat receipts. The self-declaration is structurally false but the manifest accepts it.

**Test.** Operator self-declaration of "local-only" is unverifiable — there is no enforceable property tying the declaration to the federation graph. A peer that accepts an unwitnessed horizon cert from a federated operator silently admits selective tampering. The federation graph itself is a verifiable structural property: "is this event log's owner present in any peer's federation manifest at horizon_ts."

**Locked.** `witness_required` is derived from federation state, not declared. Rule: an event log requires witness if, at `horizon_ts`, the log's owner appears in any peer's federation manifest (per `relay-federation-v1.md`). The retention manifest exposes `witness_required` as a derived value computed per-store, with the federation graph as input. Single-operator deployments with no peers naturally compute `witness_required = false` until they peer; once peered, the value flips and subsequent horizon certs MUST carry witness. Verifiers checking a horizon cert against an operator's manifest cross-reference the federation discovery surface (`spec/discovery-v1.md`) at the cert's `issued_at`. The operator cannot suppress the witness requirement by manifest edit alone; the federation graph is the binding input.

## Cert-format reservations — phase-1 shape, phase-4 mechanism

Two fields ride along the `append_only_horizon` arm from phase 1 even though their consumption mechanism is phase 4 work. Reserving the shape now prevents phase 4 from wire-breaking the cert when it picks the quorum policy.

**`federation_graph_anchor`** anchors the federation peer set the cert was witnessed against:

```ts
federation_graph_anchor?: {
  algo: "merkle-sha256-v1";
  merkle_root: string;   // hex SHA-256
  leaf_count: number;
}
```

`merkle-sha256-v1` is the registered identifier for the Merkle algorithm specified in `spec/credential-anchor-v1.md` §3-5 (SHA-256 leaves; binary tree with odd-leaf promotion, no duplication; same algorithm referenced from `relay-federation-v1.md` §7.6) composed with this doctrine's peer-set canonicalization rule: the Merkle leaves are the operator's federation-peer Ed25519 public keys, hex-encoded, lowercase, sorted ascending, at the cert's `horizon_ts`. The identifier is a closed string-literal union the same way `SuiteId` is closed-union; future Merkle algorithms (post-quantum hash, e.g.) ship as additive registry entries plus dispatch arms, never as silent rebindings of an existing identifier. Phase 1 commits the field shape; phase 4 picks the quorum policy that consumes it (1-of-N, M-of-N threshold, all-known-peers, etc.).

**`inclusion_proof`** on each entry of `witnessed_by` carries a Merkle-membership proof for the witness's pubkey against the graph anchor:

```ts
witnessed_by: {
  motebit_id: MotebitId;
  signature: string;
  inclusion_proof?: { siblings: string[]; leaf_index: number; layer_sizes: number[] };
}[]
```

Shape mirrors `credential-anchor-v1.md` §6's Merkle inclusion-proof type exactly — same `siblings` ordering (leaf-to-root), same `layer_sizes` for odd-leaf-promotion detection, same `leaf_index` semantics. Reusing the existing motebit Merkle wire shape (rather than inventing a `string[]` alternative) means every motebit Merkle verifier already speaks the encoding. Phase 4 quorum mechanisms either require populated inclusion proofs (Merkle-membership verification at quorum-check time) or accept signature-only witnesses (membership confirmed by trusted-peer-set lookup) — both compose with the reserved shape without a wire break.

## Sensitivity and obligation are orthogonal

Sensitivity (`SensitivityLevel`) is **what** the data is. Obligation (settlement window, dispute window, regulatory floor) is **why** it must persist. They compose under `max`: the effective minimum-retention floor for a record under `consolidation_flush` is `max(sensitivity_floor(record), obligation_floor(record))`. A `secret`-sensitive tool-audit entry that is also settlement-relevant retains for at least the regulatory floor regardless of the 30-day sensitivity ceiling — the obligation always wins because flushing too early breaks audit, while flushing too late breaks privacy only as a quantity question on already-narrowly-scoped records.

This is a `RetentionSemiring` candidate: `(max, min, 0, ∞)` on `[0, ∞]`. ⊕ over alternative obligations selects the longest floor; ⊗ over chained obligations (record carries multiple) bottlenecks at the longest. The semiring lives in `@motebit/semiring` if a third consumer arrives; until then the `max` reduction in the resolver is enough.

## Self-attesting transparency

Every operator publishes `/.well-known/motebit-retention.json`, signed under `motebit-jcs-ed25519-hex-v1` (sibling to `motebit-transparency.json`, see `operator-transparency.md`). The manifest enumerates every store the operator runs, the registered `RetentionShape`, the parameters (sensitivity ceiling values, obligation resolver descriptions, witness requirements). A user verifies the manifest under the operator's published key and checks the values against `MAX_RETENTION_DAYS_BY_SENSITIVITY`; a federation peer reads the manifest before accepting horizon-advance witness requests. The manifest is browser-side re-verifiable through the same primitive pattern that `87e2f174` established for `verifySkillBundle` — `verifyRetentionManifest` lives in `@motebit/crypto`, callable from `apps/web` with no relay contact.

The disappearance test applies as elsewhere: anchored manifests survive operator deletion. Stage 2 makes the anchor mandatory; stage 1 ships with anchor optional and an `honest_gaps` field naming the deferral, mirroring the operator-transparency staging pattern.

## Drift defense

`scripts/check-retention-coverage.ts` (drift-defense #52). Enumerate every store in the monorepo that holds records with a `sensitivity` field or a settlement obligation; assert each has registered a `RetentionShape` with the central registry in `@motebit/protocol`; fail CI on omissions. Negative-proof test: removing a registration breaks the typed store-shape lookup at the consolidation cycle's flush call site. Same enforcement pattern as `check-consolidation-primitives` (#34) and `check-suite-declared` (cryptosuite agility).

## Non-goals in v1

- **Per-record cryptographic deletion of event-log entries.** The append-only-horizon shape is the answer; per-row signed deletion of a witnessed audit ledger is structurally unsound. Phase 4 makes this explicit in the federation protocol.
- **User-controllable sensitivity ceilings.** The ceiling is doctrinal floor; operators may be stricter, never looser. A user who wants stricter retention than the operator's manifest declares migrates (per `spec/migration-v1.md`) to a stricter operator.
- **Cross-operator retention reconciliation during federation.** Each operator's manifest is independently verifiable; federation does not negotiate a unified policy. The strictness ordering on manifests is what migrations consume; federation only consumes horizon-advance witness signals.
- **Cryptographic proof that a record was actually deleted from underlying storage.** Same posture as `operator-transparency.md` § "Anti-patterns / Operator-side memory inspection": the doctrine forbids retention paths the operator could secretly extend; it does not provide cryptographic proof of disk-level erasure (which is unobservable from outside the OS). The `DeletionCertificate` is the operator's signed claim; the source-being-public is the second layer.
- **Certificate revocation or rescindment.** Certificates are terminal once issued. Same foundation-law shape as delegation-v1.md §4.2 (terminal task states are irreversible) and migration-v1.md §3.2 (terminal migration states are irreversible). A cert that turns out to have been issued in error is corrected by issuing a new cert under a different `reason` (e.g., a `user_request` follow-up) and recording both in the audit ledger; the original cert remains valid as a signed claim about what was attested at `deleted_at`. No `kind: "rescind_deletion"` arm; no signed-revocation flow. The semantic of "the cert was wrong" is handled at the audit layer, not at the cert format.
- **Guardian-authorized horizon advance.** The `append_only_horizon` arm signs by the subject discriminator (motebit or operator) only. A guardian-recovery analogue for horizon advance — where the guardian advances the horizon on behalf of a key-compromised motebit — is not specified in v1. If the case arises, it lands as an additive variant of decision 8's subject discriminator; deferral is honest because no current consumer needs it.

## Where it lands — phased

| Phase        | Deliverable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 (this doc) | Doctrine + ten decisions locked + cert-format reservations (`federation_graph_anchor`, per-witness `inclusion_proof`). No code.                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2            | `@motebit/protocol`: `RetentionShape` + `DeletionCertificate` discriminated unions + `MAX_RETENTION_DAYS_BY_SENSITIVITY` + `RetentionManifest`. `@motebit/crypto`: per-arm sign helpers + `verifyDeletionCertificate` dispatcher + canonicalization (multi-sig + horizon-issuer + horizon-witness). `@motebit/wire-schemas`: `DeletionCertificateSchema` + `RetentionManifestSchema` + emitted JSON schemas. `@motebit/encryption`: legacy unsigned `DeletionCertificate` marked `@deprecated` per the package's publication-status shape. |
| 3            | Memory registers under `mutable_pruning`. Call-site cutover: `privacy-layer`'s `deleteMemory` constructs the signed `mutable_pruning` cert (subject signature via runtime-injected signer); consolidation cycle's prune phase consumes the typed contract. Decision 7's tombstone→erase delivers in the same pass — `deleteMemory(id)` followed by `getMemory(id)` returns `not_found`, never `tombstoned`. Negative proof test added.                                                                                                     |
| 4            | Event-log horizon. Horizon certificate format, federation co-witness handshake, signed truncation protocol. Structurally the hard one — federation protocol bump (additive).                                                                                                                                                                                                                                                                                                                                                               |
| 5            | Conversations + tool-audit register under `consolidation_flush`. Per-turn sensitivity inheritance, flush phase added to consolidation cycle, settlement-floor resolver for tool-audit. Operator-panel "what's expiring" affordance — same five-step pattern as the latency-surface ship, this time over flush events.                                                                                                                                                                                                                      |
| 6            | `/.well-known/motebit-retention.json` signed manifest + browser-side re-verifier. `check-retention-coverage` lands hard. `docs/drift-defenses.md` updated to #52.                                                                                                                                                                                                                                                                                                                                                                          |

Phase 4 is the variance source. Phases 2–3 and 5–6 are tightly bounded.

## Cross-references

- `docs/doctrine/operator-transparency.md` — sibling rail; retention manifest sits beside transparency manifest, same pattern, same staging.
- `docs/doctrine/self-attesting-system.md` — three-test check that signed `DeletionCertificate` + signed retention manifest must clear by construction.
- `docs/doctrine/protocol-model.md` § "Naming: interop law vs reference default" — the rule decision 2 follows.
- `docs/doctrine/proactive-interior.md` — the consolidation cycle that owns the flush phase for `consolidation_flush` stores.
- `docs/doctrine/security-boundaries.md` — sensitivity gating at the content boundary that this doctrine extends to the time axis.
- `docs/doctrine/hardware-attestation.md` — sibling pattern: one canonical body format, one verifier, one algebra, closed under additions.
- `docs/doctrine/settlement-rails.md` — sibling pattern: typed-level shape distinction at the protocol layer.
- `spec/credential-anchor-v1.md` §3-5, §6 — the Merkle algorithm `merkle-sha256-v1` references, and the inclusion-proof wire shape `witnessed_by[].inclusion_proof` reuses.
- `spec/relay-federation-v1.md` §7.6 — sibling Merkle algorithm reference; same odd-leaf-promotion rule.
- `spec/discovery-v1.md` — federation graph the witness-trigger rule (decision 9) consumes as binding input.
- `spec/identity-v1.md` §3.8.3 — guardian-recovery succession; the direct precedent for decision 5's action-class-keyed signer composition. §3.3 + §3.3.2 — guardian custody and dual-required revocation; the precedent for `guardian_request` and the adjacent dual-required pattern.
- `spec/delegation-v1.md` §5.5 — multi-hop delegation pattern that `delegated_request` rides; §4.2 — terminal-state irreversibility (paired with migration-v1.md §3.2) cited by the cert-irreversibility non-goal; §8 — sovereign mode that `self_enforcement` covers.
- `spec/migration-v1.md` §3.2 — terminal-state irreversibility, second precedent for the cert-irreversibility non-goal.
- `docs/drift-defenses.md` — `#39 @deprecated four-field contract` (decision 6a migration); `#52 check-retention-coverage` lands with phase 6.
- `spec/retention-policy-v1.md` _(stage 2, deferred until a second operator forces field standardization)_ — wire format.
