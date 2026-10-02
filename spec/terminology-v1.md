# motebit/terminology@1.0

**Status:** Draft (phase-1 vocabulary baseline)
**Created:** 2026-10-01

The normative glossary of motebit's public terms. Every other `spec/*.md` uses
these terms with the meanings defined here. A term that is not defined in this
document is not a public motebit term.

Naming law (how terms are formed, which layer may use metaphor, which words are
reserved): [`docs/doctrine/naming-by-layer.md`](../docs/doctrine/naming-by-layer.md).
Concept map (how the terms group into domains): [`docs/doctrine/primitive-vocabulary.md`](../docs/doctrine/primitive-vocabulary.md).

## 1. Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD",
"SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this
document are to be interpreted as described in BCP 14
([RFC 2119](https://www.rfc-editor.org/rfc/rfc2119),
[RFC 8174](https://www.rfc-editor.org/rfc/rfc8174)) when, and only when, they
appear in all capitals, as shown here.

Each entry has five fields:

- **Definition** — a literal statement of what the term denotes. No metaphor.
- **Layer** — the owning layer: `protocol` (Apache-2.0 types in `@motebit/protocol`), `crypto` (Apache-2.0 sign/verify law in `@motebit/crypto`), `relay` (the reference relay service), or `runtime` (the BSL agent runtime). The owning layer is where the canonical definition lives in code.
- **Wire** — the representation that crosses a process or network boundary (field name, type, value set, or JSON Schema under `spec/schemas/`). "None" means the term has no wire form of its own.
- **Standard** — the external standard the term conforms to, or "novel because …" when no standard covers it.
- **Forbidden synonyms** — words that MUST NOT be used for this term in exported identifiers, wire fields, registry values, error codes, CLI names, JSON-Schema descriptions, or any normative sentence of a spec.

Entries marked **[unconfirmed]** could not be fully confirmed against code when
this baseline was written; their definitions are the best reading of the
doctrine and MUST be re-checked before the vocabulary freeze.

#### Wire format (foundation law)

These rules bind every wire term defined below unless its entry records a deviation:

- Canonicalization is JCS ([RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)); signatures are Ed25519 ([RFC 8032](https://www.rfc-editor.org/rfc/rfc8032)) over the canonical bytes of the artifact minus its signature field(s), dispatched by `SuiteId` (§9.1). Two registered suites do not canonicalize with JCS: `motebit-jwt-ed25519-v1` (signed bearer tokens) signs the raw UTF-8 bytes of the JSON payload exactly as serialized (`JSON.stringify`, no JCS; [`auth-token-v1.md`](auth-token-v1.md) §3.1, §4.1), and `motebit-concat-ed25519-hex-v1` (federation handshake challenges and heartbeats) signs a UTF-8 concatenation of a fixed template.
- Public keys are 64 lowercase hex characters unless a suite says otherwise.
- Timestamps are integer milliseconds since the Unix epoch unless an entry notes a deviation.
- Money amounts are integer micro-units (1 USD = 1,000,000) in fields suffixed `_micro`, unless an entry notes a deviation. Recorded deviations: `CostAttestationV1.cost_nanos` (integer nano-USD, §6.6) and the `*_minor` amounts of `InvoiceV1` (integer minor units, e.g. cents, of the invoice `currency`; [`settlement-invoice-v1.md`](settlement-invoice-v1.md)).

## 2. Identity

### 2.1 motebit

- **Definition:** an agent whose identity is an Ed25519 key pair held by its owner, named by a `motebit_id`, and whose memory, trust records and policy persist across sessions and devices under that identity.
- **Layer:** protocol (identity), runtime (behaviour).
- **Wire:** none of its own; represented by its `motebit_id` and identity file.
- **Standard:** novel because no agent standard binds a persistent cryptographic identity to accumulated state and policy as one unit.
- **Forbidden synonyms:** bot, droplet, creature, account, user (in normative or wire text). "Droplet" and "creature" are doctrine/render vocabulary only.

### 2.2 motebit_id

- **Definition:** the stable identifier of a motebit. Three forms are accepted:
  1. **UUIDv8 self-certifying commitment (default for new motebits).** A UUID version 8 ([RFC 9562](https://www.rfc-editor.org/rfc/rfc9562) §5.8) whose 122 free bits are the first 16 bytes of `SHA-256(genesis_public_key)` with version nibble `8` and variant `10b`. A verifier recomputes it from the genesis key (`deriveSovereignMotebitId`, `verifySovereignBinding` in `@motebit/crypto`) without contacting any operator.
  2. **UUIDv7 (legacy form).** A random, time-ordered UUID ([RFC 9562](https://www.rfc-editor.org/rfc/rfc9562) §5.7). Clients minted it before sovereign-by-default minting, and the reference relay still mints one: its internal `POST /identity` route creates the id through the identity manager in the BSL `@motebit/core-identity` package, which mints a random UUIDv7. It does not commit to a key; its key binding needs an identity file, a succession chain or a transparency-log anchor (§10.1). A UUIDv7 can never equal a UUIDv8 commitment.
  3. **`did:key`.** A W3C `did:key` URI ([did:key method](https://w3c-ccg.github.io/did-method-key/)) whose multicodec payload is the Ed25519 public key; it is self-certifying by construction. Accepted as a `motebit_id` by verifiers; also derivable from any motebit key for interop ([`identity-v1.md`](identity-v1.md) §10).
- **Layer:** protocol (`MotebitId` branded string), crypto (derivation and binding checks).
- **Wire:** string field `motebit_id`; role-qualified as `<role>_motebit_id` in new artifacts (some existing artifacts use `<role>_id`, e.g. `delegator_id`, `issuer_id`).
- **Standard:** RFC 9562 (UUID), W3C DID Core + did:key.
- **Forbidden synonyms:** agent_id, account_id, user_id, handle, address.

### 2.3 identity file

- **Definition:** a `motebit.md` document: YAML frontmatter (`MotebitIdentityFile` in `@motebit/crypto`) signed by the motebit's identity key, followed by non-binding Markdown. It declares the `motebit_id`, current public key, guardian, devices, and governance settings, and carries the key succession history.
- **Layer:** protocol (format), `@motebit/identity-file` (reference parser/signer).
- **Wire:** the `motebit.md` text file; see [`identity-v1.md`](identity-v1.md).
- **Standard:** novel because it is a human-readable, self-signed agent descriptor; YAML 1.2 and Ed25519 are the only standards it uses.
- **Forbidden synonyms:** profile, manifest (reserved for `ContentArtifactManifest`), agent card, passport.

### 2.4 device_id

- **Definition:** the identifier of one device (process host with its own key) acting for a motebit. A motebit has one or more devices; each device key is authorized by the motebit's identity.
- **Layer:** protocol (`DeviceId` branded string).
- **Wire:** string field `device_id`.
- **Standard:** novel because the device is a sub-identity under a self-owned agent identity rather than a platform-assigned hardware id.
- **Forbidden synonyms:** host_id (a host is a machine-roster member, §2.6), node_id (reserved for memory graph nodes), instance_id.

### 2.5 key succession

- **Definition:** the replacement of a motebit's signing key by a `KeySuccessionRecord` signed by the outgoing key (or by the guardian on recovery), so authority flows forward from the genesis key to the current key.
- **Layer:** protocol, crypto.
- **Wire:** `KeySuccessionRecord`; see [`identity-v1.md`](identity-v1.md).
- **Standard:** novel; comparable to key-rotation chains in KERI, without KERI's event log format.
- **Forbidden synonyms:** key migration (reserved for `migration-v1`), rekey (informal only).

### 2.6 HostEnrollment / HostRetirement

- **Definition:** signed statements by a motebit that a machine is (enrollment) or is no longer (retirement) a member of the set of machines hosting its unattended work. The roster is a set, not a chain; each artifact's id is the hash of its signed body. A relay transports these and observes liveness; it never decides membership.
- **Layer:** protocol (`HostEnrollment`, `HostRetirement`), crypto (`verifyHostRoster`).
- **Wire:** `spec/schemas/host-enrollment-v1.json`, `spec/schemas/host-retirement-v1.json`; in-body `type` tags `motebit/host-enrollment@1` and `motebit/host-retirement@1`. See [`machine-roster-v1.md`](machine-roster-v1.md).
- **Standard:** novel because the membership set is owner-signed and the relay is excluded from deciding it.
- **Forbidden synonyms:** registration (reserved for device self-registration), host attestation, heartbeat.

## 3. Parties

### 3.1 relay

- **Definition:** a service that coordinates motebits: discovery, task routing, task admission (§5.4), receipt recording and settlement verification. A relay is the ledger of record for the settlements it coordinates. It is not a principal in delegation and holds funds only on the relay-custody settlement mode (§7.1).
- **Layer:** relay.
- **Wire:** HTTP API under `/api/v1/…`; relay-signed artifacts carry the relay's own key.
- **Standard:** novel because it combines registry, router and clearing-house roles under one signing key.
- **Forbidden synonyms:** server (unqualified), hub, broker, bank, custodian (custody is a property of a settlement mode, not of the relay).

### 3.2 operator **[unconfirmed]**

- **Definition:** the party that runs a relay (or another service in the reference deployment) and controls its keys and configuration. Operator-run components publish their posture through operator transparency.
- **Layer:** relay, doctrine.
- **Wire:** no single type; `operator_signature` on some `DeletionCertificate` arms; operator transparency documents. There is no `Operator` type in `@motebit/protocol`; this definition is taken from doctrine.
- **Standard:** novel; used in its ordinary service-operator sense.
- **Forbidden synonyms:** admin (reserved for the `admin:query` audience), owner (the owner is the motebit's human), platform.

### 3.3 delegator

- **Definition:** the motebit that signs authority over to another motebit (a `DelegationToken` or `StandingDelegation`) and, for priced work, pays for it.
- **Layer:** protocol.
- **Wire:** `delegator_id`, `delegator_public_key`.
- **Standard:** novel; matches the delegator role in OAuth 2.0 Token Exchange (RFC 8693) only informally.
- **Forbidden synonyms:** buyer (positioning only), client, requester, principal (unqualified).

### 3.4 worker

- **Definition:** the motebit that executes a task delegated to it and signs the resulting `ExecutionReceipt`. In a `DelegationToken` the worker is the delegate.
- **Layer:** protocol (delegate role), relay (worker selection).
- **Wire:** `delegate_id`, `delegate_public_key`; the `mid` claim of a `task:dispatch` token (§5.4).
- **Standard:** novel.
- **Forbidden synonyms:** provider (reserved for model/inference providers in routing), seller (positioning only), executor (informal only).

## 4. Execution

### 4.1 task

- **Definition:** one unit of work submitted to a motebit and resolved by exactly one terminal status (`completed`, `failed`, `denied`, `expired`). A task produces at most one `ExecutionReceipt`.
- **Layer:** protocol (`AgentTask`, `AgentTaskStatus`).
- **Wire:** `task_id`; status values `pending | claimed | running | completed | failed | denied | expired`.
- **Standard:** novel; the A2A protocol's "task" is the closest analogue.
- **Forbidden synonyms:** job, request, ticket, goal (§4.2).

### 4.2 goal

- **Definition:** a declared outcome (a natural-language `prompt`) with a schedule, pursued by runs; each run may create a plan and tasks. The schedule is a `mode` (`recurring | once` today; other values reserved) and, for a recurring goal, a cadence `interval_ms` in milliseconds. There is no strategy field. A goal is declared by the user, or by the motebit itself as a child of a goal it is running (the `create_sub_goal` tool, which sets `parent_goal_id`).
- **Layer:** protocol (`GoalId`, goal lifecycle events), runtime.
- **Wire:** `goal_id`; `goal_*` events; schedule fields `mode` (string) and `interval_ms` (integer, optional — the cadence of a recurring goal; MAY be absent, e.g. on a revision, and MAY be present on a `once` goal, where it does not make the goal repeat) on `goal_created`; see [`goal-lifecycle-v1.md`](goal-lifecycle-v1.md).
- **Standard:** novel.
- **Forbidden synonyms:** task, job, intent (reserved for `IntentOrigin`), objective.

### 4.3 plan

- **Definition:** an ordered decomposition of one goal run into steps, with a lifecycle status (`PlanStatus`).
- **Layer:** protocol (`Plan`, `PlanStatus`).
- **Wire:** `plan_id`; `plan_*` events; see [`plan-lifecycle-v1.md`](plan-lifecycle-v1.md).
- **Standard:** novel.
- **Forbidden synonyms:** workflow, pipeline, script.

### 4.4 step

- **Definition:** one element of a plan, executed locally or delegated as a task.
- **Layer:** protocol (`PlanStep`).
- **Wire:** `step_id` (also carried on `AgentTask.step_id` when a step is delegated).
- **Standard:** novel.
- **Forbidden synonyms:** task (a step becomes a task only when delegated), stage, phase (reserved for consolidation phases).

## 5. Authorization

### 5.1 DelegationToken

- **Definition:** a delegator-signed authorization for one delegate to act within a `scope` (comma-separated capability list or `*`) until `expires_at`, and not before `not_before` when present. `issued_at` is a signed field but `verifyDelegation` does not check it against the clock; a token without `not_before` is active as soon as it is signed. It authorizes one act and is short-lived: the RECOMMENDED lifetime is 1 h, and issuers SHOULD NOT issue lifetimes over 24 h ([`market-v1.md`](market-v1.md) §12), which no verifier enforces (a standing-delegation tick is bounded by the grant's `max_token_ttl_ms` instead). A token with `grant_id` is one tick of a standing delegation.
- **Layer:** protocol (`DelegationToken`), crypto (sign/verify).
- **Wire:** `spec/schemas/delegation-token-v1.json`; suite `motebit-jcs-ed25519-b64-v1`. See [`market-v1.md`](market-v1.md) §12 and [`delegation-v1.md`](delegation-v1.md).
- **Expiry note:** the existing verifier rejects when `expires_at < now`, i.e. the token is valid while `now <= expires_at` (inclusive). New artifacts use exclusive expiry (naming-by-layer § Time); this artifact is frozen as is, as is `StandingDelegation` (§5.2).
- **Standard:** novel; structurally comparable to a UCAN or a signed OAuth token, conforming to neither.
- **Forbidden synonyms:** permission (superseded), grant (reserved, §5.2), capability token, bearer token, API key.

### 5.2 StandingDelegation (grant)

- **Definition:** a delegator-signed, revocable, finite authorization that does not authorize a task itself; it authorizes per-tick `DelegationToken`s, each signed by the delegator, within a scope ceiling, a cadence, a maximum token TTL and an optional spend ceiling. **"Grant" means a `StandingDelegation` and nothing else.** A grant is terminated by a signed `DelegationRevocation`.
- **Layer:** protocol (`StandingDelegation`), crypto.
- **Wire:** `spec/schemas/standing-delegation-v1.json`; `grant_id`. See [`standing-delegation-v1.md`](standing-delegation-v1.md).
- **Expiry note:** `verifyStandingDelegation` rejects when `expires_at < now`, so a grant is valid while `now <= expires_at` (inclusive; standing-delegation-v1 §3.1). Frozen as is, like `DelegationToken` (§5.1). Signed bearer tokens ([`auth-token-v1.md`](auth-token-v1.md)) already expire exclusively: `verifySignedToken` rejects when `exp <= now`.
- **Standard:** novel because the standing authority is offline-verifiable and revocable without a server-side session.
- **Forbidden synonyms:** subscription, mandate, policy, permission, consent. Calling any other artifact a "grant" is forbidden.

### 5.3 TokenAudience

- **Definition:** the closed set of strings naming the single purpose a signed token may be presented for. A verifier MUST reject a token whose audience does not match the endpoint or handshake it is presented to.
- **Layer:** protocol (`TokenAudience`, `ALL_TOKEN_AUDIENCES`).
- **Wire:** the `aud` claim; values as listed in `packages/protocol/src/audience.ts` (e.g. `sync`, `device:auth`, `task:submit`, `task:dispatch`, `runtime:attach`, `mcp:call`). Existing values are frozen; new values use `<resource>:<action>`.
- **Standard:** conforms to the `aud` claim of JWT ([RFC 7519](https://www.rfc-editor.org/rfc/rfc7519) §4.1.3) in purpose.
- **Forbidden synonyms:** scope (reserved for delegation scope), role, permission.

### 5.4 task admission

- **Definition:** the relay's per-task authorization for a worker to execute priced work: a relay-signed token with audience `task:dispatch`, `mid` = the worker's `motebit_id`, `sub` = the relay task id, minted only after the submission cleared the relay's settlement gates. A worker configured for relay admission verifies it against the pinned relay key before running the task. One admission authorizes one presenter and one completed execution.
- **Layer:** relay (minting), protocol (audience), worker runtime (verification; `molecule-runner` with `taskAdmission: "relay"`). See [`docs/doctrine/task-admission.md`](../docs/doctrine/task-admission.md).
- **Wire:** a signed token under [`auth-token-v1.md`](auth-token-v1.md) §5 with `aud: "task:dispatch"`; field `dispatch_token` on submission responses.
- **Audience naming note:** the audience string `task:dispatch` is historical — the artifact is an admission, not a dispatch. The string is frozen; prose and new identifiers say "admission".
- **Standard:** JWT-shaped claims (RFC 7519); the admission semantics are novel.
- **Forbidden synonyms:** dispatch token (in new identifiers), ticket, voucher, pass.

### 5.5 SensitivityLevel

- **Definition:** the closed, ordered classification of data by harm-on-disclosure: `none < personal < medical < financial < secret`. `medical`, `financial` and `secret` data MUST NOT be sent to an external inference provider.
- **Layer:** protocol (`SensitivityLevel`, `ALL_SENSITIVITY_LEVELS`).
- **Wire:** string values `none | personal | medical | financial | secret`.
- **Standard:** novel; informed by GDPR special categories but not conforming to them.
- **Forbidden synonyms:** privacy level, classification, clearance.

## 6. Receipts and signed artifacts

### 6.1 ExecutionReceipt

- **Definition:** a worker-signed record of one task's execution: task id, status, prompt and result hashes, tools used, timestamps, and nested receipts of sub-delegations. Subject and signer are the same motebit.
- **Layer:** protocol (`ExecutionReceipt`), crypto.
- **Wire:** `spec/schemas/execution-receipt-v1.json`; see [`execution-ledger-v1.md`](execution-ledger-v1.md).
- **Standard:** novel; JCS + Ed25519.
- **Forbidden synonyms:** proof (unqualified), log entry, credential, attestation.

### 6.2 ToolInvocationReceipt

- **Definition:** a signed record of one tool call inside a task: invocation id, tool name, args and result hashes, status, timestamps, and `invocation_origin`. Signed by the motebit that made the call.
- **Layer:** protocol (`ToolInvocationReceipt`).
- **Wire:** suite `motebit-jcs-ed25519-b64-v1`; no spec section defines it yet — the canonical shape is the `ToolInvocationReceipt` type in `@motebit/protocol`, signed and verified by `signToolInvocationReceipt` / `verifyToolInvocationReceipt` in `@motebit/crypto`. (`execution-ledger-v1.md` §4 is the step summary, not this receipt.)
- **Standard:** novel.
- **Forbidden synonyms:** tool log, trace, span.

### 6.3 ContentArtifactManifest

- **Definition:** a producer-signed statement binding a content hash (`content_hash`, SHA-256 of the canonical bytes) to its producer key, artifact type and production time. It asserts provenance of content, not execution.
- **Layer:** crypto (`ContentArtifactManifest`), protocol (`ContentArtifactType` registry).
- **Wire:** suite `motebit-jcs-ed25519-hex-v1`; `produced_at` is an ISO-8601 string (a recorded deviation from the epoch-ms rule).
- **Standard:** modelled on C2PA (`claim_generator`) without conforming to the C2PA manifest format.
- **Forbidden synonyms:** receipt, certificate, attestation.

### 6.4 ConsolidationReceipt

- **Definition:** a motebit-signed record of one idle consolidation cycle: phases run and yielded, timing, and structural counts only — never memory content.
- **Layer:** protocol (`ConsolidationReceipt`).
- **Wire:** `spec/schemas/consolidation-receipt-v1.json`; see [`consolidation-receipt-v1.md`](consolidation-receipt-v1.md).
- **Standard:** novel.
- **Forbidden synonyms:** report, summary, dream log.

### 6.5 DeletionCertificate

- **Definition:** a signed, terminal statement that a record was deleted or flushed under the retention policy. Three arms: `mutable_pruning`, `append_only_horizon`, `consolidation_flush`. A certificate cannot be revoked; an error is corrected by a later certificate.
- **Layer:** protocol (`DeletionCertificate`).
- **Wire:** `spec/schemas/deletion-certificate-v1.json`; discriminator `kind`.
- **Standard:** novel; informed by GDPR Art. 17 erasure evidence.
- **Forbidden synonyms:** tombstone, deletion receipt, purge log.

### 6.6 attestation

- **Definition:** a signed statement **about a subject other than the signer** (subject ≠ signer). This distinguishes an attestation from a receipt (subject = signer). Exceptions, each named and closed:
  - **Hardware attestation** (`HardwareAttestationClaim`): a platform key (Secure Enclave, TPM, Android Keystore, WebAuthn authenticator, App Attest) vouches for the motebit's identity key. This is the RATS-class case ([RFC 9334](https://www.rfc-editor.org/rfc/rfc9334)): the attesting environment and the attested key share a device, but the attesting key is a distinct, vendor-rooted key. It is additive scoring, never an admission gate.
  - **`CostAttestationV1`** (documented exception): an issuer-signed declaration of the cost of one execution (integer **nano-USD**, a recorded deviation from `_micro`), referencing an `ExecutionReceipt` by id and digest. The issuer may be the party whose execution it prices, so subject ≠ signer does not always hold; the name is kept and the exception is recorded here. See [`settlement-invoice-v1.md`](settlement-invoice-v1.md).
  - **Self-issued `EvalAttestation`** (§6.7): the subject MAY equal the issuer (the self-issued floor), so subject ≠ signer does not hold for that case; the name is kept and the exception is recorded here.
- **Layer:** protocol, crypto.
- **Wire:** per artifact.
- **Standard:** RFC 9334 (RATS) for hardware attestation; otherwise novel.
- **Forbidden synonyms:** receipt (for subject ≠ signer), certification, endorsement (RATS reserves "endorsement" for manufacturer statements).

### 6.7 EvalAttestation

- **Definition:** an issuer-signed record of measurements of a subject motebit; each measurement embeds a full `VerificationVerdict`. The subject MAY equal the issuer (the self-issued floor); the truth of the measurements is out of scope of verification — only the envelope is verified.
- **Layer:** protocol (`EvalAttestation`, `EvalKind`), crypto.
- **Wire:** `spec/schemas/eval-attestation-v1.json`; see [`eval-attestation-v1.md`](eval-attestation-v1.md).
- **Standard:** novel.
- **Forbidden synonyms:** score, rating, review, benchmark result.

### 6.8 RoutingDecisionTranscript

- **Definition:** a delegator-signed record of one worker-selection decision: the frozen candidate set, per-candidate axis values (and Beta parameters and draw in explore mode), parameters, algorithm version and seed. Verification is recomputation of the decision. Subject = signer, so it is in the receipt family despite its suffix.
- **Layer:** protocol (`RoutingDecisionTranscript`).
- **Wire:** `spec/schemas/routing-transcript-v1.json`; see [`routing-transcript-v1.md`](routing-transcript-v1.md).
- **Standard:** novel.
- **Forbidden synonyms:** routing log, ranking, score.

### 6.9 BondCommitment

- **Definition:** an agent-signed statement that, at `issued_at`, it had committed `bond_amount_micro` of an asset at `bonded_address` on a chain, where `bonded_address` MUST be derived from `bonded_public_key`. The relay verifies the backing balance by RPC and never holds the funds. It is an eligibility signal, not collateral or escrow.
- **Layer:** protocol (`BondCommitment`).
- **Wire:** `spec/schemas/bond-commitment-v1.json`; spec id `motebit/bond@1.0`. See [`bond-v1.md`](bond-v1.md).
- **Standard:** novel.
- **Forbidden synonyms:** stake (in normative text — it is not slashable), collateral, escrow, deposit.

## 7. Settlement

### 7.1 SettlementMode

- **Definition:** the closed set of ways a priced task is paid:
  - `relay` — **relay-custody**: the delegator's funds are held in a relay-run virtual account; the relay debits the delegator, credits the worker and deducts its fee at the account boundary.
  - `p2p` — **agent-custody**: the delegator pays the worker directly on-chain; the relay's fee is a composed leg of the same atomic transaction; the relay verifies and records it but never transmits the principal.
    `WritableSettlementMode` restricts typed new worker-settlement writes to `p2p`. The reference relay still writes `relay` on its carve-out paths — self-delegation, zero-cost delegation, x402-paid submissions (the payment verified and settled to the relay treasury before admission; the row carries `x402_tx_hash`), legacy non-P2P paths that predate the submission gate, and paid sub-receipts nested in a parent receipt (multi-hop) — so `relay` appears on new records as well as existing ones.
- **Layer:** protocol (`SettlementMode`, `ALL_SETTLEMENT_MODES`).
- **Wire:** string values `relay | p2p`. See [`settlement-v1.md`](settlement-v1.md).
- **Standard:** novel.
- **Forbidden synonyms:** payment mode, rail (a rail is the transport, e.g. Solana, x402), escrow.

### 7.2 custody

- **Definition:** which party controls the keys to funds at a given moment. Under `relay` settlement the relay has custody of the virtual-account balance; under `p2p` the agent keeps custody throughout.
- **Layer:** doctrine, protocol (via `SettlementMode`).
- **Wire:** none of its own.
- **Standard:** ordinary financial meaning.
- **Forbidden synonyms:** ownership (custody is control, not title), escrow.

## 8. Trust and routing

### 8.1 AgentTrustLevel

- **Definition:** one motebit's first-person classification of another motebit, held in its own trust ledger and earned from receipts: `unknown`, `first_contact`, `verified`, `trusted`, `blocked`. It is never a global score.
- **Layer:** protocol (`AgentTrustLevel`).
- **Wire:** string values `unknown | first_contact | verified | trusted | blocked`.
- **Standard:** novel.
- **Forbidden synonyms:** reputation (global connotation), rating, karma, score.

### 8.2 trust-path semiring

- **Definition:** the semiring `(max, ×, 0, 1)` over trust values in [0, 1]: a path's trust is the product of its edge trusts; the best of alternative paths is the maximum. Other semirings (cost, latency, reliability, bottleneck) compose with it by product construction.
- **Layer:** protocol (`TrustSemiring`, `Semiring<T>`), BSL `@motebit/semiring` (ranking).
- **Wire:** none; numeric axis values appear in `RoutingDecisionTranscript`.
- **Standard:** algebraic path problems (Mohri 2002; Gondran–Minoux semirings).
- **Forbidden synonyms:** trust score, PageRank, web of trust (transitive-global connotation).

## 9. Verification

### 9.1 SuiteId

- **Definition:** the closed registry of cryptosuite identifiers; each names an algorithm, canonicalization, signature encoding and public-key encoding. Every signed artifact names its suite; verifiers reject unknown suites. Values: `motebit-jcs-ed25519-b64-v1`, `motebit-jcs-ed25519-hex-v1`, `motebit-jwt-ed25519-v1`, `motebit-concat-ed25519-hex-v1`, `eddsa-jcs-2022`.
- **Layer:** protocol (`SuiteId`, `SUITE_REGISTRY`), crypto (dispatch).
- **Wire:** field `suite`.
- **Standard:** `eddsa-jcs-2022` conforms to W3C VC Data Integrity EdDSA; the `motebit-*` suites are novel.
- **Forbidden synonyms:** algorithm, alg (JOSE `alg` is a different, narrower claim), cipher.

### 9.2 VerificationVerdict

- **Definition:** the multi-axis result of verifying a signed artifact: `integrity` (`verified | invalid`), `identityBinding` (§10.1), `authority` (`valid | expired | not_yet_valid | insufficient | unknown`), `revocation` (status `fresh | stale | unchecked | revoked`), `temporalBasis`, `evidenceBasis`, and `repair` when any axis is not passing. It has deliberately no top-level boolean; a consumer branches on the axis it depends on.
- **Layer:** protocol (`VerificationVerdict`), crypto (producers).
- **Wire:** camelCase TypeScript shape embedded in `EvalAttestation` (a recorded deviation from snake_case wire fields).
- **Standard:** novel.
- **Forbidden synonyms:** result (unqualified), status, `valid` (for the whole verdict).

### 9.3 EvidenceProvenance

- **Definition:** the optional re-checkable provenance on an `EvidenceRef`: a `digest` of independently obtainable raw bytes, an optional named projection recipe, and a `span` that MUST be an exact substring of the projection of those bytes. It establishes re-verifiable presence of the span, never its truth.
- **Layer:** protocol (`EvidenceProvenance`, `DigestRef`, `ProjectionClass`), crypto (`verifyEvidenceProvenance`).
- **Wire:** `spec/schemas/evidence-provenance-v1.json`; see [`evidence-provenance-v1.md`](evidence-provenance-v1.md).
- **Standard:** novel.
- **Forbidden synonyms:** citation (unqualified), source, proof.

### 9.4 MerkleTreeVersion

- **Definition:** the registry of Merkle tree-hash constructions: `merkle-sha256-plain-v1` (legacy, no domain separation) and `merkle-sha256-rfc6962-v2` (leaf prefix `0x00`, node prefix `0x01`). Absent `tree_hash_version` means v1.
- **Layer:** protocol (`MerkleTreeVersion`).
- **Wire:** field `tree_hash_version`.
- **Standard:** v2 conforms to [RFC 6962](https://www.rfc-editor.org/rfc/rfc6962) §2.1.
- **Forbidden synonyms:** hash version, tree format.

### 9.5 anchor

- **Definition:** **only** an on-chain commitment of a Merkle root (e.g. a Solana memo `motebit:anchor:v1:…`) over a batch of leaves, such that inclusion of a leaf is provable against the root and the root's existence at a time is provable from the chain. A public key that a verifier pins out of band is a **trust root**, not an anchor.
- **Layer:** protocol (anchor types), relay (anchoring loops).
- **Wire:** anchor records with `merkle_root`, `tx_hash`, `tree_hash_version`; see [`credential-anchor-v1.md`](credential-anchor-v1.md), [`relay-transparency-v1.md`](relay-transparency-v1.md).
- **Standard:** RFC 6962-style transparency log with blockchain timestamping.
- **Forbidden synonyms:** trust anchor (use "trust root"), checkpoint, notarization (unless the anchor itself is meant).

## 10. Identity binding

### 10.1 identity binding levels

- **Definition:** how strongly a signing key is bound to a claimed `motebit_id`, ordered strongest first:
  1. **self-certifying** — the `motebit_id` commits to the genesis key (UUIDv8 or `did:key`) and the signing key is reached from it by succession; verifiable offline with no operator. **Today's wire value is `"sovereign"`** (`IdentityBindingVerdict`). Planned successor value: `self_certifying`, to be introduced post-freeze by alias-first deprecation.
  2. **anchored** — the binding is included in a transparency log whose Merkle root is confirmed on-chain.
  3. **pinned** — the key is time-valid in a succession chain from an identity file the verifier supplies.
  4. **unverified** — signature integrity only; the key→id binding is not established.
     Plus **invalid** — a binding was claimed and failed. `invalid` is not a level; it is a failure.
- **Layer:** protocol (`IdentityBindingVerdict`), crypto, `@motebit/state-export-client`.
- **Wire:** `"sovereign" | "anchored" | "pinned" | "unverified" | "invalid"`.
- **Standard:** novel; the anchored level follows Key Transparency designs.
- **Forbidden synonyms:** trust level (reserved, §8.1), verified identity, KYC.

## 11. Memory

### 11.1 MemorySource

- **Definition:** the closed registry naming the code path that formed a memory: `user_stated`, `agent_inferred`, `tool_derived`, `peer_agent`, `consolidation_derived`. It is assigned by the forming code path, never by a model or a peer.
- **Layer:** protocol (`MemorySource`, `ALL_MEMORY_SOURCES`).
- **Wire:** field `source` on `MemoryFormedPayload`.
- **Standard:** novel; comparable to W3C PROV "wasGeneratedBy" without conforming.
- **Forbidden synonyms:** origin (reserved for `invocation_origin`), author, provenance (reserved for `EvidenceProvenance`).

### 11.2 EventType

- **Definition:** the closed registry of event names in a motebit's append-only event log (e.g. `identity_created`, `state_updated`, `memory_formed`). New values are `<noun>_<past_participle>`.
- **Layer:** protocol (`EventType`, `ALL_EVENT_TYPES`).
- **Wire:** field `event_type` on `EventLogEntry`; snake_case values.
- **Standard:** novel.
- **Forbidden synonyms:** action, message, signal.

## 12. Admission of new terms

A new public term (an exported type or identifier in a permissive-floor package, a
wire field with new meaning, a registry, a reserved word) MUST be admitted by adding
an entry to this document with all five fields, in the same change that introduces
it. Renaming an existing term follows alias-first deprecation per
[`docs/doctrine/deprecation-lifecycle.md`](../docs/doctrine/deprecation-lifecycle.md);
silent renames are forbidden.

## 13. Versioning

Additive entries are minor revisions. Changing a definition, removing a term, or
changing a wire value is a major revision of this document and of every spec that
uses the term.
