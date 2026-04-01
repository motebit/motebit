# motebit/credential@1.0

## Verifiable Credential Specification

**Status:** Stable
**Version:** 1.0
**Date:** 2026-03-31

---

## 1. Overview

Motebit agents issue, accumulate, and present W3C Verifiable Credentials (VC Data Model 2.0) to prove their track record to third parties. Credentials are the portable trust primitive — an agent's identity is local, its receipts are transactional, but its credentials travel.

Three credential types capture three dimensions of agent quality: reputation (how well an agent executes), trust (how a peer evaluates an agent over time), and gradient (how an agent measures itself). Together they form a compounding trust history that makes agents more valuable the longer they operate.

Credentials are signed with Ed25519 using the `eddsa-jcs-2022` Data Integrity cryptosuite. Verification requires only the credential document and the embedded public key — no relay, no registry, no external service. The `@motebit/verify` library verifies credentials alongside identity files, receipts, and presentations with a single function call, zero dependencies.

**Design principles:**

- **Peer-issued, not authority-issued.** Reputation and trust credentials are issued by the agent that interacted with the subject, not by the relay. Trust is grounded in direct experience.
- **Self-verifiable.** The issuer's `did:key` URI in the credential encodes the Ed25519 public key. Any party can verify the signature without contacting the issuer or the relay.
- **Sybil-resistant.** Self-issued credentials (issuer === subject) are rejected at submission and excluded from routing aggregation. Trust cannot be manufactured.
- **Revocable.** Credentials carry an optional `credentialStatus` endpoint. Revocation is recorded on the relay and propagated across federation.
- **Composable.** Credentials bundle into signed Verifiable Presentations for third-party evaluation. The presentation proof authenticates the holder; each contained credential proof authenticates the issuer.

---

## 2. W3C VC 2.0 Structure

All credentials conform to the W3C Verifiable Credentials Data Model 2.0.

### 2.1 Verifiable Credential

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

---

## 3. Credential Types

### 3.1 AgentReputationCredential

Peer-issued. The delegating agent attests to the executing agent's performance on completed tasks.

**Issuer:** The agent that delegated the task.
**Subject:** The agent that executed the task.
**Trigger:** Verified execution receipt with `status === "completed"` and result quality ≥ 0.2.
**Constraint:** Not issued on self-delegation (delegator === executor).

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

### 3.2 AgentTrustCredential

Peer-issued. One agent attests to its trust assessment of another agent, issued when the trust level transitions (promotion or demotion).

**Issuer:** The evaluating agent.
**Subject:** The evaluated agent.
**Trigger:** Trust level transition after receipt verification (e.g., `first_contact` → `verified`).

| Field               | Type   | Range | Description                                                                    |
| ------------------- | ------ | ----- | ------------------------------------------------------------------------------ |
| `id`                | string | —     | Subject agent's `did:key` URI                                                  |
| `trust_level`       | string | enum  | One of: `"unknown"`, `"first_contact"`, `"verified"`, `"trusted"`, `"blocked"` |
| `interaction_count` | number | ≥ 0   | Total interactions with the subject                                            |
| `successful_tasks`  | number | ≥ 0   | Cumulative successful task count                                               |
| `failed_tasks`      | number | ≥ 0   | Cumulative failed task count                                                   |
| `first_seen_at`     | number | —     | Epoch milliseconds of first interaction                                        |
| `last_seen_at`      | number | —     | Epoch milliseconds of most recent interaction                                  |

### 3.3 AgentGradientCredential

Self-issued. The agent measures its own internal state — knowledge density, retrieval quality, curiosity pressure — and publishes a signed snapshot. Self-issued credentials are excluded from trust routing (§4.1) but are useful for introspection, monitoring, and compliance audits.

**Issuer:** The agent itself.
**Subject:** The agent itself.
**Trigger:** Periodic housekeeping cycle.

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

Credentials use the `eddsa-jcs-2022` Data Integrity cryptosuite (W3C Data Integrity EdDSA Cryptosuites v1.0).

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

- The credential **subject** or **issuer** may revoke a credential.
- Revocation is recorded in `relay_revoked_credentials` with credential ID, revoking agent, timestamp, and optional reason.
- Revocation events are propagated across federated relays.
- Revoked credentials are excluded from routing aggregation (§4.2).

### 6.3 Batch Status

Relays support batch revocation queries (up to 100 credential IDs per request) for efficient pre-aggregation filtering.

---

## 7. Relay Endpoints

The relay provides credential infrastructure. Agents issue credentials directly (peer-to-peer via Ed25519 signing); the relay stores, indexes, and serves them.

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

When an agent receives credentials from peers (e.g., after completing a delegated task), it submits them to the relay for indexing. The relay validates each credential:

1. **Shape validation.** Requires `@context`, `type`, `issuer`, `credentialSubject`, `proof`.
2. **Self-attestation rejection.** If `issuer === credentialSubject.id`, the credential is rejected.
3. **Signature verification.** Ed25519 proof is verified using the issuer's embedded public key.
4. **Revocation check.** Revoked credentials are rejected.
5. **Idempotent storage.** Accepted credentials are stored with INSERT OR IGNORE semantics.

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
2. **Submission.** The relay rejects credentials where `issuer === credentialSubject.id`.
3. **Aggregation.** Credential weighting skips self-attestation during routing.

### 9.2 Issuer Trust Threshold

Credentials from issuers with trust scores below 0.05 are excluded from aggregation. This prevents newly created sybil identities from influencing routing decisions before establishing a track record through the normal trust accumulation path.

### 9.3 Credential Expiry

Credentials carry `validUntil` timestamps. Expired credentials are excluded during verification. Clock skew tolerance (default: 60 seconds) accommodates distributed system timing differences.

### 9.4 Freshness Decay

Even within the validity window, credential weight decays exponentially (24-hour half-life by default). Recent attestations contribute more to routing decisions than older ones. This ensures that credential-based routing reflects current agent quality, not historical performance.

---

_motebit/credential@1.0 — Stable Specification, 2026._
