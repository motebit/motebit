# Primitive vocabulary — the concept map

This is the single canonical map of motebit's concepts. It answers "what are motebit's primitives, and how do they relate?" once. Every other primitive list in the repo — README hero table, positioning lines, pitch decks, architecture pages — is a narrative compression of this map and MUST link here rather than restate it as if it were a separate taxonomy.

The terms named below are defined normatively in [`spec/terminology-v1.md`](../../spec/terminology-v1.md). How terms are formed and which layer may use metaphor is [`naming-by-layer.md`](naming-by-layer.md). This map adds only the grouping and the relationships.

## The eight domains

Each domain is a set of artifacts, types and roles that share one concern. Membership is by what the member _is about_, not by which package holds it.

### 1. Identity — who is acting

`motebit`, `motebit_id` (UUIDv8 self-certifying commitment by default; legacy UUIDv7; `did:key`), identity file (`motebit.md`), `device_id`, key succession (`KeySuccessionRecord`), guardian, machine roster (`HostEnrollment` / `HostRetirement`), hardware attestation (`HardwareAttestationClaim`, additive scoring).

### 2. Authorization — what an actor may do

`DelegationToken` (one act, short-lived), `StandingDelegation` (the grant; per-tick tokens), `DelegationRevocation`, delegation scope, `TokenAudience`, task admission (relay-signed `task:dispatch`), policy gate and risk levels, `SensitivityLevel` (what data may cross which boundary), spend ceiling.

### 3. Execution — what is done

goal, plan, step, task (`AgentTask` and its status), tools and `ToolDefinition` modes (`api` / `ax` / `pixels`), `invocation_origin`, the consolidation cycle (idle-time execution).

### 4. Routing — who is chosen to do it

`TaskShape × ProviderCapability × Constraints → RoutingDecision` (model selection), worker selection from the delegator's own trust ledger, the trust-path semiring and its product with cost / latency / reliability semirings, Pareto ranking, Thompson exploration, `RoutingDecisionTranscript`.

### 5. Settlement — how value moves

`SettlementMode` (`relay` = relay-custody virtual account; `p2p` = agent-custody on-chain with a composed fee leg), custody, settlement rails, settlement assets, micro-unit money, `BondCommitment` (eligibility signal, never custodied), `CostAttestation` and `Invoice` (the bill format).

### 6. Verification — how a third party checks any of it

`SuiteId` and suite dispatch, JCS canonicalization, `VerificationVerdict` (multi-axis, no single bit), identity binding levels (self-certifying > anchored > pinned > unverified; plus invalid), `EvidenceProvenance`, `MerkleTreeVersion`, anchor (on-chain Merkle-root commitment only), trust root (a pinned key), operator transparency.

### 7. Trust — what has been earned

`AgentTrustLevel` (first-person, per pair, never global), the trust ledger built from receipts, `EvalAttestation` (third-party measurement), dispute outcomes.

### 8. Memory — what is retained

memory graph nodes and edges, `MemorySource` (forming-path provenance), `EventType` and the append-only event log, retention policy, `ConsolidationReceipt`, `DeletionCertificate`.

### Receipts sit across domains

The receipt family — `ExecutionReceipt`, `ToolInvocationReceipt`, `ContentArtifactManifest` — is produced by Execution, consumed by Trust and Settlement, and checked by Verification. Receipts are not a ninth domain; they are the record each act leaves, unified by JCS + Ed25519 + suite dispatch ([`receipts-unified.md`](receipts-unified.md)).

## Delegation: the authority edge

Delegation is not a ninth domain and not a peer bullet beside the others. It is the edge that carries authority from one identity to another, and every other domain is reached along it:

```
 Identity ──(delegator signs)──► Authorization ──(scope bounds)──► Execution
     ▲                               │                                 │
     │                          policy gate                       receipt signed
     │                               ▼                                 ▼
  Trust ◄──(receipts update)── Verification ◄──(checks chain)── Settlement
```

- **Identity → delegation:** only an identity key can sign a `DelegationToken` or `StandingDelegation`; the delegator and delegate are named by `motebit_id` and public key.
- **Delegation → policy:** policy is the scope of a delegation, not a separate authority. The policy gate enforces the delegated scope and sensitivity ceilings at the boundary.
- **Delegation → execution:** a task executes under a token; its `ExecutionReceipt` carries `delegated_scope` and nests the receipts of sub-delegations (chain depth ≤ 10).
- **Delegation → settlement:** priced work is admitted only after settlement gates clear (task admission), and the money movement references the delegated task.
- **Delegation → verification:** a third party verifies the whole chain offline: token signatures, scope narrowing, expiry, revocation, and the receipts produced under it.

See [`delegation.md`](delegation.md) for the doctrine of the edge.

## Narrative layers

The repo also uses shorter primitive lists for communication. They are legitimate **narrative layers** (doctrine/product layer per [`naming-by-layer.md`](naming-by-layer.md)): each compresses the map for one audience. None is a separate taxonomy, and none may be used in a normative sentence or a wire name.

| Narrative layer                   | Words                                                                                                                     | Audience / question                                | Maps onto the eight domains                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Positioning (5)                   | identity, trust, delegation, receipts, settlement                                                                         | external — "what does motebit let an agent do?"    | Identity; Trust; the delegation edge; the receipt family (Execution → Verification); Settlement                        |
| Architectural (5 static + 1 edge) | identity, trust, receipts, settlement, policy + delegation                                                                | contributors — "what surfaces does it expose?"     | Identity; Trust; receipt family; Settlement; Authorization (policy) — joined by the delegation edge                    |
| Comparative — "one layer up" (5)  | identity, memory, capability, autonomous execution, governance ([`the-stack-one-layer-up.md`](the-stack-one-layer-up.md)) | "how does it differ from a hosted agent platform?" | Identity; Memory; Execution (tools/capability); Execution (consolidation cycle); Authorization                         |
| Hero (3)                          | identity, trust, governance (CLAUDE.md "three things")                                                                    | the one-breath pitch                               | Identity; Trust (plus Memory as accumulated state); Authorization                                                      |
| Metabolic enzymes (4)             | identity, memory, trust, governance ([`THE_METABOLIC_PRINCIPLE.md`](../../THE_METABOLIC_PRINCIPLE.md))                    | build vs absorb                                    | Identity; Memory; Trust; Authorization. Routing, Settlement and Verification are built too, but are not called enzymes |

"Governance" in every narrative layer means the Authorization domain enforced at the boundary (policy gate, sensitivity, delegated scope). "Capability" and "autonomous execution" are Execution-domain members, not domains of their own.

## Translation table

Translate when crossing layers; keep a single document's own words for register consistency.

| Concept                                   | Words in use                                                                      | Canonical literal term                                                                         |
| ----------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| The boundary that decides what may happen | policy, governance, policy gate, boundary policy gate, membrane (doctrine only)   | Authorization domain; policy gate                                                              |
| The authority relationship                | delegation (canonical); `permissions` is superseded and not used in new artifacts | `DelegationToken`, `StandingDelegation`                                                        |
| Signed record of an act                   | receipts, signed-receipt trust ledger                                             | receipt family (`ExecutionReceipt`, …)                                                         |
| Self-owned identity                       | sovereign identity (doctrine/product only)                                        | `motebit_id` + identity key; binding level `self_certifying` (wire value today: `"sovereign"`) |
| Earned standing                           | trust, reputation (positioning only, never global)                                | `AgentTrustLevel`, trust ledger                                                                |
| Value resolution                          | settlement                                                                        | `SettlementMode`, settlement rails                                                             |

**Receipts, proofs and verifiable credentials are different artifact families. They are not synonyms.**

- A **receipt** is signed by the party that performed the act it records (signer = subject): `ExecutionReceipt`, `ToolInvocationReceipt`, `ConsolidationReceipt`. It proves _that this key claims to have done this_; its value is integrity plus identity binding.
- A **proof** is evidence that something holds independently of any one signer's word: a Merkle inclusion proof against an anchored root, an on-chain settlement transaction, an `EvidenceProvenance` span re-checked against raw bytes. It is verified by recomputation against external state, not by trusting a signer. "Proof" is not a name for a receipt.
- A **verifiable credential** is a W3C VC Data Model document in which an issuer makes claims about a subject (issuer ≠ subject), verified under a Data Integrity suite (`eddsa-jcs-2022`). In motebit's vocabulary a credential is an attestation-shaped artifact ([`credential-v1.md`](../../spec/credential-v1.md)), and it conforms to the W3C model rather than to the receipt family.

The previous version of this table equated `receipts ≡ proof ≡ verifiable credentials`; that equation is withdrawn.

## Where other primitive lists must link

The lists below restate primitives for their own audience. Each should carry a link to this map; this doc does not edit them.

- `README.md` hero comparison table (identity, memory, trust, governance, proof).
- `CLAUDE.md` "The three things no one else is building together" and the Metabolic principle.
- `DOCTRINE.md` opening paragraph (shipped capabilities list).
- `THE_METABOLIC_PRINCIPLE.md` (identity, memory, trust, governance).
- `apps/docs/content/docs/operator/architecture.mdx` hero caption and enzyme list.
- [`delegation.md`](delegation.md) § "The spine".
- [`the-stack-one-layer-up.md`](the-stack-one-layer-up.md) (the comparative five).
- [`panel-temporal-registers.md`](panel-temporal-registers.md) ("the five primitives").
- `docs/droplet-surface-tension.md` (definition sentence).
- `packages/self-knowledge` corpus (regenerated from the above, not edited by hand).

The spatial "five primitives" (creature, satellite, environment, attractor, presentation) in [`spatial-as-endgame.md`](spatial-as-endgame.md) are render primitives of one surface, not concept primitives, and are out of scope of this map.

## Cross-cuts

- [`spec/terminology-v1.md`](../../spec/terminology-v1.md) — normative term entries.
- [`naming-by-layer.md`](naming-by-layer.md) — the naming laws.
- [`delegation.md`](delegation.md) — the authority edge.
- [`receipts-unified.md`](receipts-unified.md) — the receipt family.
- [`registry-pattern-canonical.md`](registry-pattern-canonical.md) — typed vocabularies for wire values; orthogonal to this map.
