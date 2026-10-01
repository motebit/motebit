# motebit/credential@1.0

## Verifiable Credential Specification

**Status:** Stable
**Version:** 1.0
**Date:** 2026-03-31

---

## 1. Overview

Motebit agents issue, accumulate, and present W3C Verifiable Credentials (VC Data Model 2.0) to prove their track record to third parties. Credentials are the portable trust primitive — an agent's identity is local, its receipts are transactional, but its credentials travel.

Three credential types capture three dimensions of agent quality: reputation (how well an agent executes), trust (how a peer evaluates an agent over time), and gradient (how an agent measures itself). Together they form a compounding trust history that makes agents more valuable the longer they operate.

Credentials are signed with Ed25519 using the `eddsa-jcs-2022` Data Integrity cryptosuite. Verification requires only the credential document and the embedded public key — no relay, no registry, no external service. The `@motebit/crypto` library verifies credentials alongside identity files, receipts, and presentations with a single function call, zero dependencies.

**Design principles:**

- **Peer-issued, not authority-issued.** Reputation and trust credentials are issued by the agent that interacted with the subject, not by the relay. Trust is grounded in direct experience.
- **Self-verifiable.** The issuer's `did:key` URI in the credential encodes the Ed25519 public key. Any party can verify the signature without contacting the issuer or the relay.
- **Sybil-resistant.** Self-issued credentials (issuer === subject) are rejected at submission and excluded from routing aggregation. Trust cannot be manufactured.
- **Revocable.** Credentials carry an optional `credentialStatus` endpoint. Revocation is recorded on the relay and propagated across federation.
- **Composable.** Credentials bundle into signed Verifiable Presentations for third-party evaluation. The presentation proof authenticates the holder; each contained credential proof authenticates the issuer.

---

## 2. W3C VC 2.0 Structure

All credentials use the W3C Verifiable Credentials Data Model 2.0 envelope, with the deviations listed in §2.3.

### 2.1 Verifiable Credential

#### Wire format (foundation law)

Motebit credentials are W3C VC 2.0 JSON documents. Every conformant implementation MUST emit this exact envelope. The type-specific fields inside `credentialSubject` are specified in §3 (and each type is named in `@motebit/protocol` as a `*Subject` interface so subject shape stays aligned across implementations).

```json
{
  "@context": ["https://www.w3.org/ns/credentials/v2"],
  "type": ["VerifiableCredential", "<CredentialType>"],
  "issuer": "did:key:z6Mk...",
  "credentialSubject": {
    "id": "did:key:z6Mk...",
    ...
  },
  "validFrom": "2026-03-31T12:00:00.000Z",
  "validUntil": "2026-03-31T13:00:00.000Z",
  "credentialStatus": {
    "id": "https://relay.example/api/v1/credentials/{id}/status",
    "type": "RevocationList2024"
  },
  "proof": {
    "type": "DataIntegrityProof",
    "cryptosuite": "eddsa-jcs-2022",
    "created": "2026-03-31T12:00:00.000Z",
    "verificationMethod": "did:key:z6Mk...#z6Mk...",
    "proofPurpose": "assertionMethod",
    "proofValue": "z3hY9..."
  }
}
```

| Field               | Type               | Required | Description                                                                   |
| ------------------- | ------------------ | -------- | ----------------------------------------------------------------------------- |
| `@context`          | string[]           | Yes      | Must be `["https://www.w3.org/ns/credentials/v2"]`                            |
| `type`              | string[]           | Yes      | `["VerifiableCredential", "<CredentialType>"]`                                |
| `issuer`            | string             | Yes      | `did:key` URI of the signing agent                                            |
| `credentialSubject` | object             | Yes      | Type-specific fields (§3). Must include `id` (subject's `did:key`)            |
| `validFrom`         | string             | Yes      | ISO 8601 datetime when the credential becomes valid                           |
| `validUntil`        | string             | No       | ISO 8601 datetime when the credential expires. Default: 1 hour after issuance |
| `credentialStatus`  | object             | No       | Revocation status endpoint (§6)                                               |
| `proof`             | DataIntegrityProof | Yes      | Ed25519 signature over canonical content (§5)                                 |

#### Storage (reference convention — non-binding)

The reference relay stores the raw signed JSON string in `relay_credentials.credential_json TEXT` along with indexed columns for issuer, subject, type, and revocation status. Alternative implementations MAY normalize `credentialSubject` into per-type tables, store as JSONB, or use a triple store. The wire document above is what crosses every HTTP boundary.

### 2.2 Verifiable Presentation

Presentations bundle multiple credentials for third-party evaluation. The holder signs the presentation envelope; each contained credential retains its original issuer proof.

```json
{
  "@context": ["https://www.w3.org/ns/credentials/v2"],
  "type": ["VerifiablePresentation"],
  "holder": "did:key:z6Mk...",
  "verifiableCredential": [ ... ],
  "proof": {
    "type": "DataIntegrityProof",
    "cryptosuite": "eddsa-jcs-2022",
    "created": "2026-03-31T12:00:00.000Z",
    "verificationMethod": "did:key:z6Mk...#z6Mk...",
    "proofPurpose": "authentication",
    "proofValue": "z3hY9..."
  }
}
```

| Field                  | Type                   | Required | Description                                                                    |
| ---------------------- | ---------------------- | -------- | ------------------------------------------------------------------------------ |
| `holder`               | string                 | Yes      | `did:key` URI of the presenting agent                                          |
| `verifiableCredential` | VerifiableCredential[] | Yes      | Bundled credentials, each with its own proof                                   |
| `proof`                | DataIntegrityProof     | Yes      | Holder's proof. `proofPurpose` is `"authentication"` (not `"assertionMethod"`) |

### 2.3 Deviations from VC Data Model 2.0 (normative)

The wire format below is fixed for this version. A verifier built only to the W3C specifications will disagree with a motebit credential at each of these points:

1. **Unregistered status type.** `credentialStatus.type` is `"RevocationList2024"`, which is not a status type registered for VC 2.0 (the W3C status mechanism is `BitstringStatusListEntry`). It carries no `statusPurpose`, `statusListIndex` or `statusListCredential`. `credentialStatus.id` is a per-credential HTTP endpoint that returns `{ "revoked": … }` (§6.1), not an entry in a status list credential.
2. **Proof configuration without `@context`.** `eddsa-jcs-2022` sets the proof configuration's `@context` to the secured document's `@context`. Motebit proof options are exactly `{ type, cryptosuite, created, verificationMethod, proofPurpose }` with no `@context` (§5.1), so `proofHash` differs from the one a conforming `eddsa-jcs-2022` implementation computes, and the two do not verify each other's proofs.
3. **No motebit JSON-LD context.** `@context` is only `https://www.w3.org/ns/credentials/v2`. The credential types (`AgentReputationCredential`, `AgentTrustCredential`, `AgentGradientCredential`) and the `credentialSubject` properties (§3) are not defined by any published context; under JSON-LD processing they fall to the base context's issuer-dependent vocabulary. Verification never performs JSON-LD processing: canonicalization is JCS (RFC 8785) over the JSON as written.

---

## 3. Credential Types

### 3.1 — ReputationCredentialSubject

Peer-issued. The delegating agent attests to the executing agent's performance on completed tasks.

**Issuer:** The agent that delegated the task.
**Subject:** The agent that executed the task.
**Trigger:** Verified execution receipt with `status === "completed"` and result quality ≥ 0.2.
**Constraint:** Not issued on self-delegation (delegator === executor).

**Credential type token (in VC `type` array):** `AgentReputationCredential`.

#### Wire format (foundation law)

The `credentialSubject` object for an `AgentReputationCredential`. Every implementation MUST emit these fields with these names and types; the VC wrapper from §2.1 applies.

| Field            | Type   | Range  | Description                                        |
| ---------------- | ------ | ------ | -------------------------------------------------- |
| `id`             | string | —      | Subject agent's `did:key` URI                      |
| `success_rate`   | number | [0, 1] | Proportion of tasks completed successfully         |
| `avg_latency_ms` | number | ≥ 0    | Average execution duration in milliseconds         |
| `task_count`     | number | ≥ 1    | Total tasks in the measurement sample              |
| `trust_score`    | number | [0, 1] | Overall quality/reliability assessment             |
| `availability`   | number | [0, 1] | Recency-weighted uptime                            |
| `sample_size`    | number | ≥ 1    | Deduplicated task count for statistical confidence |
| `measured_at`    | number | —      | Epoch milliseconds of measurement                  |

The `ReputationCredentialSubject` type in `@motebit/protocol` is the binding machine-readable form.

### 3.2 — TrustCredentialSubject

Peer-issued. One agent attests to its trust assessment of another agent, issued when the trust level transitions (promotion or demotion).

**Issuer:** The evaluating agent.
**Subject:** The evaluated agent.
**Trigger:** Trust level transition after receipt verification (e.g., `first_contact` → `verified`).
**Credential type token (in VC `type` array):** `AgentTrustCredential`.

#### Wire format (foundation law)

| Field               | Type   | Range | Description                                                                    |
| ------------------- | ------ | ----- | ------------------------------------------------------------------------------ |
| `id`                | string | —     | Subject agent's `did:key` URI                                                  |
| `trust_level`       | string | enum  | One of: `"unknown"`, `"first_contact"`, `"verified"`, `"trusted"`, `"blocked"` |
| `interaction_count` | number | ≥ 0   | Total interactions with the subject                                            |
| `successful_tasks`  | number | ≥ 0   | Cumulative successful task count                                               |
| `failed_tasks`      | number | ≥ 0   | Cumulative failed task count                                                   |
| `first_seen_at`     | number | —     | Epoch milliseconds of first interaction                                        |
| `last_seen_at`      | number | —     | Epoch milliseconds of most recent interaction                                  |

The `TrustCredentialSubject` type in `@motebit/protocol` is the binding machine-readable form.

#### Subject-field extension: `hardware_attestation`

`TrustCredentialSubject` carries an optional `hardware_attestation` field of type `HardwareAttestationClaim` (§3.4). Credentials that omit the field assert nothing about the subject's key custody; consumers that ignore the field observe the same wire format they did before the extension landed. The extension is strictly additive — no break to existing trust credentials in flight.

### 3.4 — HardwareAttestationClaim

Peer-issued or self-issued. Captures whether the subject agent's identity key lives inside a hardware keystore (Secure Enclave, TPM, Android Keystore, Apple DeviceCheck) or in software storage. Carried as the optional `hardware_attestation` field on `TrustCredentialSubject` (§3.2); does not carry its own signature — the outer `AgentTrustCredential` VC envelope's `eddsa-jcs-2022` proof covers the full subject body including this claim.

**Issuer:** Any agent issuing an `AgentTrustCredential` about the subject — typically a peer that observed the subject produce hardware-attested signatures over a delegation chain. Self-attestation is permitted (the subject signs a credential about itself) but, per §4.2, self-issued credentials are excluded from routing aggregation regardless.

**Trigger:** Same as `TrustCredentialSubject` (§3.2) — trust-level transition — with an added claim field.

**Credential type token (in VC `type` array):** `AgentTrustCredential` (unchanged — the extension is inside the existing credential's subject body).

#### Wire format (foundation law)

| Field                 | Type    | Required | Description                                                                                                                                                                                                                                                              |
| --------------------- | ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `platform`            | string  | Yes      | One of: `"secure_enclave"`, `"tpm"`, `"play_integrity"`, `"device_check"`, `"webauthn"`, `"software"`. `"software"` is the explicit no-hardware sentinel (distinct from an absent claim).                                                                                |
| `key_exported`        | boolean | No       | `true` when the private key was exported from hardware to software storage (backup, pairing, migration). Weakens the claim. Default `false`; absent is equivalent to `false`.                                                                                            |
| `attestation_receipt` | string  | No       | Opaque platform-specific attestation blob (Apple DeviceCheck assertion, Google Play Integrity token, TPM quote) encoded as the platform expects. Verifiers with the matching platform adapter MAY verify it as a side channel; motebit itself does not parse this field. |

The `HardwareAttestationClaim` type in `@motebit/protocol` is the binding machine-readable form; the `HardwareAttestationClaimSchema` in `@motebit/wire-schemas` is the runtime-validatable zod + JSON Schema artifact third-party implementers consume.

**Signature coverage.** The claim does not declare its own `suite` field. The outer `AgentTrustCredential` VC envelope carries the proof (§5.1 `eddsa-jcs-2022`), and JCS canonicalization of the credential body includes the full `credentialSubject` object — so tampering with any claim field breaks the outer signature. Adding new attestation platforms (ARM TrustZone, Intel SGX, future post-quantum hardware) is a registry-like update to the `platform` enum; the wire shape does not change.

**Ranking.** `HardwareAttestationSemiring` in `@motebit/semiring` consumes the claim to rank candidate agents in the routing graph. Agents with a `secure_enclave` / `tpm` / `device_check` / `play_integrity` / `webauthn` claim and `key_exported: false` rank strictly above agents with an absent claim or a `"software"` claim; agents with `key_exported: true` sit between hardware-attested and software. This is algebraic ranking (one graph, one algorithm, a different semiring) per the motebit semiring doctrine — no new routing algorithm is introduced.

### 3.5 — GradientCredentialSubject

Self-issued. The agent measures its own internal state — knowledge density, retrieval quality, curiosity pressure — and publishes a signed snapshot. Self-issued credentials are excluded from trust routing (§4.1) but are useful for introspection, monitoring, and compliance audits.

**Issuer:** The agent itself.
**Subject:** The agent itself.
**Trigger:** Periodic housekeeping cycle.
**Credential type token (in VC `type` array):** `AgentGradientCredential`.

#### Wire format (foundation law)

| Field                    | Type   | Range  | Description                                       |
| ------------------------ | ------ | ------ | ------------------------------------------------- |
| `id`                     | string | —      | Agent's own `did:key` URI                         |
| `gradient`               | number | [0, 1] | Composite knowledge-action alignment score        |
| `knowledge_density`      | number | [0, 1] | Compressed memory graph size relative to capacity |
| `knowledge_quality`      | number | [0, 1] | Semantic coherence of stored memories             |
| `graph_connectivity`     | number | [0, 1] | Internal memory graph clustering coefficient      |
| `temporal_stability`     | number | [0, 1] | Consistency across retention windows              |
| `retrieval_quality`      | number | [0, 1] | Relevance of memory retrieval results             |
| `interaction_efficiency` | number | [0, 1] | Delegation and interaction success rate           |
| `tool_efficiency`        | number | [0, 1] | Tool call success rate and latency                |
| `curiosity_pressure`     | number | [0, 1] | Tendency to seek novel experiences                |
| `measured_at`            | number | —      | Epoch milliseconds of snapshot                    |

The `GradientCredentialSubject` type in `@motebit/protocol` is the binding machine-readable form.

---

## 4. Credential Weighting in Routing

When agents are candidates for delegated tasks, the relay aggregates their peer-issued credentials into a composite reputation score. This score feeds into the semiring routing graph (see `motebit/market@1.0`).

### 4.1 Weight Computation

Each credential's contribution is weighted by three factors:

```
weight = issuerTrust × freshness × confidence
```

| Factor        | Formula                           | Default        | Description                                                                                 |
| ------------- | --------------------------------- | -------------- | ------------------------------------------------------------------------------------------- |
| `issuerTrust` | Trust closure score of the issuer | —              | How much the network trusts the credential issuer. Looked up from the trust graph           |
| `freshness`   | `exp((-age × ln2) / halfLife)`    | halfLife = 24h | Exponential decay. A 24-hour-old credential contributes half the weight of a fresh one      |
| `confidence`  | `min(taskCount, K) / K`           | K = 50         | Saturating function. An agent with 50+ tasks has full confidence; fewer tasks reduce weight |

### 4.2 Filters

Before aggregation, credentials are filtered:

1. **Self-attestation exclusion.** If `issuer === credentialSubject.id`, the credential is skipped. Self-issued credentials produce no trust signal.
2. **Minimum issuer trust.** If the issuer's trust score is below the threshold (default: 0.05), the credential is skipped. This excludes new sybil identities.
3. **Revocation check.** If the credential has been revoked (§6), it is skipped.

### 4.3 Aggregation

Surviving credentials are aggregated into a `CredentialReputation`:

| Field                  | Aggregation                   | Description                                               |
| ---------------------- | ----------------------------- | --------------------------------------------------------- |
| `success_rate`         | Weighted average              | Proportion of successful tasks across all attesting peers |
| `avg_latency_ms`       | Weighted average              | Execution speed across all attesting peers                |
| `effective_task_count` | Sum of weighted task counts   | Deduplicated by weight to avoid double-counting           |
| `trust_score`          | Weighted average              | Overall quality assessment across peers                   |
| `availability`         | Weighted average              | Uptime across peers                                       |
| `issuer_count`         | Count of distinct issuers     | Diversity of attestation sources                          |
| `total_weight`         | Sum of all credential weights | Zero means no usable credentials                          |

### 4.4 Blending with Static Trust

The credential-derived trust is blended with the agent's static trust score (from direct interaction history):

```
credentialTrust = success_rate × 0.7 + trust_score × 0.3
blendFactor = min(issuerDiversity / 5, 1) × min(totalWeight / 3, 1) × 0.5
finalTrust = staticTrust × (1 - blendFactor) + credentialTrust × blendFactor
```

The blend factor caps at 0.5 — credentials can contribute at most half of the final trust score. Direct interaction always dominates. Diversity (distinct issuers) and weight (total evidence) both contribute to how much credential evidence is trusted.

---

## 5. Cryptographic Proof

### 5.1 eddsa-jcs-2022

Credentials use the `eddsa-jcs-2022` Data Integrity cryptosuite (W3C Data Integrity EdDSA Cryptosuites v1.0), with the proof-configuration deviation in §2.3.

**Signing algorithm:**

1. Construct proof options: `{ type, cryptosuite, created, verificationMethod, proofPurpose }` (without `proofValue`)
2. `proofHash = SHA-256(canonicalJson(proofOptions))` where `canonicalJson` is JCS (RFC 8785)
3. `docHash = SHA-256(canonicalJson(documentWithoutProof))`
4. `combined = proofHash || docHash` (concatenation)
5. `signature = Ed25519.sign(combined, privateKey)`
6. `proofValue = "z" + base58btc(signature)`

**Verification algorithm:**

1. Extract `did:key` from `proof.verificationMethod` → derive Ed25519 public key
2. Reconstruct proof options (strip `proofValue`)
3. Recompute `proofHash` and `docHash` as above
4. `combined = proofHash || docHash`
5. Decode signature: strip `"z"` prefix, base58btc-decode
6. `Ed25519.verify(signature, combined, publicKey)`

### 5.2 Verification Method

The `verificationMethod` field is a DID URL: `did:key:z6Mk...#z6Mk...`. The fragment is the same multicodec-encoded key as the DID. The public key is extracted from the DID using the `did:key` method (multicodec prefix `0xed01` for Ed25519).

### 5.3 Proof Purpose

- **Credentials** use `proofPurpose: "assertionMethod"` — the issuer asserts a claim about the subject.
- **Presentations** use `proofPurpose: "authentication"` — the holder proves they control the presenting identity.

### 5.4 Verification (foundation law)

A verifier MUST reject a credential unless ALL of the following hold. The checks are fail-closed; a credential that omits the relevant field skips only that field's check.

1. **Signature.** The `eddsa-jcs-2022` Data Integrity proof verifies against the key resolved from `proof.verificationMethod` (§5.1, §5.2).
2. **Not expired.** If `validUntil` is present, `now ≤ validUntil` (with deployment clock-skew tolerance).
3. **Active.** If `validFrom` is present, `now ≥ validFrom` (with the same skew). A credential dated to activate in the future is **not yet valid** and MUST be rejected — the temporal sibling of the expiry check. (`validFrom` is REQUIRED per §2.1, so this check applies to every conformant credential.)

**Revocation is a separate, source-dependent step.** A credential carrying a `credentialStatus` (§6) is revocable, but revocation lives on the relay/federation and CANNOT be derived from the credential bytes. An offline verifier (no revocation source) therefore proves only "validly signed and within its validity window" — it MUST NOT report a revocable credential as unconditionally valid; it surfaces that revocation was unchecked. A verifier with a revocation source MUST consult it for any credential bearing a `credentialStatus` and reject a revoked credential. The reference implementation exposes this as an injected `isRevoked` revocation-check seam on `verifyVerifiableCredential` and a `revocation_unchecked` flag on the offline aggregator's result.

---

## 6. Revocation

### 6.1 Status Endpoint

Credentials MAY include a `credentialStatus` field pointing to a revocation status endpoint:

```json
{
  "credentialStatus": {
    "id": "https://relay.example/api/v1/credentials/{credentialId}/status",
    "type": "RevocationList2024"
  }
}
```

The status endpoint returns:

```json
{ "revoked": false }
```

or:

```json
{
  "revoked": true,
  "revoked_at": "2026-03-31T12:00:00.000Z",
  "reason": "Key compromise"
}
```

### 6.2 Revocation Rules

- The credential **subject** or **issuer** may revoke a credential. The subject is the identity the credential's own `credentialSubject.id` names — which is why submission binds it (§7.1 step 4): a relay that filed a credential under whatever identity the submission path named would let that identity revoke someone else's credential as its "subject".
- Revocation is recorded in `relay_revoked_credentials` with credential ID, revoking agent, timestamp, and optional reason.
- Revocation events are propagated across federated relays.
- Revoked credentials are excluded from routing aggregation (§4.2).

### 6.3 Batch Status

Relays support batch revocation queries (up to 100 credential IDs per request) for efficient pre-aggregation filtering.

---

## 7. Relay Endpoints

The relay provides credential infrastructure. Agents issue credentials directly (peer-to-peer via Ed25519 signing); the relay stores, indexes, and serves them.

#### Routes (foundation law)

The eight routes below are the binding cross-implementation contract for credential infrastructure. Renaming or relocating any of them is a wire break.

- `POST /api/v1/credentials/:motebitId/reputation` — compute and issue a ReputationCredential from settlement records.
- `POST /api/v1/credentials/verify` — verify a credential's Ed25519 signature.
- `POST /api/v1/agents/:motebitId/revoke-credential` — revoke a credential (subject or issuer only).
- `POST /api/v1/credentials/batch-status` — check revocation status of up to 100 credentials.
- `GET /api/v1/credentials/:credentialId/status` — public revocation status for a single credential.
- `GET /api/v1/agents/:motebitId/credentials` — list credentials for an agent (filterable by type, limit 200).
- `POST /api/v1/agents/:motebitId/presentation` — bundle credentials into a signed Verifiable Presentation.
- `POST /api/v1/agents/:motebitId/credentials/submit` — submit peer-collected credentials for relay indexing.

| Endpoint                                       | Method | Description                                                      |
| ---------------------------------------------- | ------ | ---------------------------------------------------------------- |
| `/api/v1/credentials/:motebitId/reputation`    | POST   | Compute and issue a ReputationCredential from settlement records |
| `/api/v1/credentials/verify`                   | POST   | Verify a credential's Ed25519 signature                          |
| `/api/v1/agents/:motebitId/revoke-credential`  | POST   | Revoke a credential (subject or issuer only)                     |
| `/api/v1/credentials/batch-status`             | POST   | Check revocation status of up to 100 credentials                 |
| `/api/v1/credentials/:credentialId/status`     | GET    | Public revocation status for a single credential                 |
| `/api/v1/agents/:motebitId/credentials`        | GET    | List credentials for an agent (filterable by type, limit 200)    |
| `/api/v1/agents/:motebitId/presentation`       | POST   | Bundle credentials into a signed Verifiable Presentation         |
| `/api/v1/agents/:motebitId/credentials/submit` | POST   | Submit peer-collected credentials for relay indexing             |

### 7.1 Credential Submission

Credentials are submitted for relay indexing by any party that holds them — typically the issuer, about the agent it delegated to, or the subject itself. The route takes no bearer token: the issuer's signature is the authentication. What the relay binds is the TARGET: a credential is stored only under the identity it is about. The relay validates each credential:

1. **Shape validation.** Requires `@context`, `type`, `issuer`, `credentialSubject`, `proof`.
2. **Self-attestation rejection.** If `issuer === credentialSubject.id`, or the issuer's `did:key` names a key PROVEN to be the path identity's (`:motebitId`) own — by the step 4 evidence — the credential is rejected — the same party under two spellings carries no trust signal.
3. **Signature verification.** Ed25519 proof is verified using the issuer's embedded public key.
4. **Subject binding.** `credentialSubject.id` MUST name the path identity `:motebitId`: a `did:motebit:<id>` subject MUST have `<id> === :motebitId`; a `did:key` subject MUST name a key PROVEN to be `:motebitId`'s, by evidence only: either `:motebitId` is the sovereign commitment to that key (`deriveSovereignMotebitId(key) === :motebitId` — the id commits to its genesis key), or the key is the identity's proven holder key (the relay's evidence-written identity-key state: first-key proof, a verified succession, a verified migration, an operator service registration). A key the relay merely has on file — a registry column or a device row, which registration doors may write without proof of possession — neither binds a subject nor prevents another identity's binding. A key rotated away from binds only if it is the genesis key a sovereign id commits to. A non-sovereign identity with no proven holder key is named by `did:motebit:<id>` only; its `did:key` credentials are rejected. A credential with no subject id, or any other DID method, is rejected. The stored subject is therefore always an identity the credential provably names, never merely the identity the request named. A rejection carries its reason code in the response's `errors` entry. Known residual in the reference relay: its registration routes accept a key without proof of possession, so before a sovereign identity `deriveSovereignMotebitId(K_V)` registers, another party can register that id under its own key and — until V arrives — file and revoke V's `did:key` credentials under it. Proof of possession at registration closes it.
5. **Revocation check.** Revoked credentials are rejected.
6. **Idempotent storage.** Accepted credentials are stored with INSERT OR IGNORE semantics. Re-submitting the same credential under the same subject is accepted (compared by JCS canonical form, so key order does not matter); a DIFFERENT credential under a `credential_id` already held is rejected, never reported as accepted.

Submissions accept up to 50 credentials per request.

---

## 8. Storage

### 8.1 Relay Storage

```
relay_credentials
  credential_id       TEXT PRIMARY KEY
  subject_motebit_id  TEXT NOT NULL
  issuer_did          TEXT NOT NULL
  credential_type     TEXT NOT NULL
  credential_json     TEXT NOT NULL
  issued_at           TEXT NOT NULL

relay_revoked_credentials
  credential_id       TEXT PRIMARY KEY
  motebit_id          TEXT NOT NULL
  revoked_at          TEXT DEFAULT (datetime('now'))
  reason              TEXT
  revoked_by          TEXT
```

### 8.2 Local Storage

Agents store credentials locally via `CredentialStoreAdapter`:

| Method                             | Description                                   |
| ---------------------------------- | --------------------------------------------- |
| `save(credential)`                 | Persist a credential                          |
| `listBySubject(motebitId, limit?)` | List credentials about a specific agent       |
| `list(motebitId, type?, limit?)`   | List credentials, optionally filtered by type |

---

## 9. Security Considerations

### 9.1 Sybil Defense

Self-issued credentials are excluded at three layers:

1. **Issuance.** Reputation and trust credentials skip self-delegation (delegator === executor).
2. **Submission.** The relay rejects credentials where `issuer === credentialSubject.id`, or where the issuer's key is proven to be the subject identity's own (§7.1 steps 2 and 4).
3. **Aggregation.** Credential weighting skips self-attestation during routing.

### 9.2 Issuer Trust Threshold

Credentials from issuers with trust scores below 0.05 are excluded from aggregation. This prevents newly created sybil identities from influencing routing decisions before establishing a track record through the normal trust accumulation path.

### 9.3 Credential Expiry

Credentials carry `validUntil` timestamps. Expired credentials are excluded during verification. Clock skew tolerance (default: 60 seconds) accommodates distributed system timing differences.

### 9.4 Freshness Decay

Even within the validity window, credential weight decays exponentially (24-hour half-life by default). Recent attestations contribute more to routing decisions than older ones. This ensures that credential-based routing reflects current agent quality, not historical performance.

---

_motebit/credential@1.0 — Stable Specification, 2026._
