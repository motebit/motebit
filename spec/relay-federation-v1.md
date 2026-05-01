# motebit/relay-federation@1.2

## Relay Federation Specification

**Status:** Stable
**Version:** 1.2
**Date:** 2026-05-01

**Version history:**

- **1.2** (2026-05-01) — Additive: `/disputes/:disputeId/vote-request` endpoint (§16) for federation peer fan-out during execution-ledger dispute adjudication (`spec/dispute-v1.md` §6.2). Extends the route table from fourteen to fifteen entries. Backward-compatible — peers without §16 support continue to interoperate on §3–15; vote-request fan-out is opt-in (relays without peers self-adjudicate when not party, 503 when party per §6.5).
- **1.1** (2026-05-01) — Additive: `/horizon/witness` + `/horizon/dispute` endpoints (§15) for federation co-witness solicitation on `append_only_horizon` retention certs (`docs/doctrine/retention-policy.md` decision 4 + 9). Extends the route table from twelve to fourteen entries. Backward-compatible — peers without §15 support continue to interoperate on §3–14; horizon-cert co-witnessing is opt-in (relays without peers self-witness).
- **1.0** (2026-03-24) — Initial stable release. Peering handshake, heartbeat, federated discovery, cross-relay routing, settlement forwarding, Merkle anchor proofs.

---

## 1. Overview

Relay federation enables independent motebit relay instances to peer with each other, forming a decentralized network of relays that can discover agents, route tasks, and settle payments across organizational boundaries. Each relay maintains its own agent population, trust records, and budget ledgers — federation extends these capabilities across relay boundaries without centralizing control.

Federation is additive. A single relay operates identically whether or not it has peers. All federation features are backward-compatible: existing endpoints return federated results transparently, and agents need no awareness of whether their relay is federated.

**Design principles:**

- **Sovereignty preserved.** Each relay controls its own agent population, trust policy, and fee schedule. Federation does not override local governance.
- **Trust composes algebraically.** Cross-relay trust is computed by the existing semiring algebra — relay nodes are added to the `WeightedDigraph<RouteWeight>`, and `optimalPaths` handles the rest.
- **No new algorithms.** Federation reuses `evaluateTrustTransition`, `graphRankCandidates`, `WeightedDigraph`, and `RouteWeightSemiring`. The only new code is peering protocol, graph augmentation, and settlement chain.
- **Backward-compatible.** Existing `/api/v1/agents/discover` returns federated results. Existing task submission works. Agents do not know whether the relay forwarded their task.

---

## 2. Relay Identity

Each relay has a persistent cryptographic identity, independent of the agents it hosts.

### 2.1 — Relay Keypair

| Property       | Value                                                                                                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Algorithm**  | Ed25519                                                                                                                                                                                            |
| **Key size**   | 32-byte public key, 64-byte private key (seed + public)                                                                                                                                            |
| **Generation** | On first relay startup, if no keypair exists                                                                                                                                                       |
| **Storage**    | Private key encrypted at rest with AES-256-GCM using PBKDF2-derived key (100k iterations) when `MOTEBIT_RELAY_KEY_PASSPHRASE` env var is set. Plaintext hex fallback for dev mode (no passphrase). |
| **Identifier** | `motebit_id` (UUID v7, time-ordered) — distinct from any agent's `motebit_id`                                                                                                                      |

The relay's `motebit_id` and public key are published to peers during the peering handshake (§3). The private key MUST NOT leave the host machine.

### 2.2 — `relay_identity` Table

| Column         | Type    | Description                                               |
| -------------- | ------- | --------------------------------------------------------- |
| `motebit_id`   | TEXT PK | Relay's UUID v7 identifier.                               |
| `public_key`   | TEXT    | Hex-encoded Ed25519 public key (64 hex characters).       |
| `created_at`   | INTEGER | Epoch milliseconds when the relay identity was generated. |
| `display_name` | TEXT    | Human-readable relay name (e.g., `"us-east-1"`).          |
| `endpoint_url` | TEXT    | Public base URL of this relay (HTTPS).                    |

A relay has exactly one row in this table. The identity is generated once and persists across restarts.

### 2.3 — DID Representation

A relay's public key can be expressed as `did:key:z6Mk...` using the same derivation as agent identities (identity-v1.0 §10.1). This enables interoperability with W3C DID ecosystems.

### 2.4 — Public Identity Response

The `GET /federation/v1/identity` endpoint returns the relay's publicly-discoverable identity for cross-relay use. This is the canonical wire-format any peer (or third-party verifier) consumes when checking a relay's identity, supported spec version, and capability flags.

```text
RelayPublicIdentity {
  spec:                       string   // e.g., "motebit/relay-federation@1.2"
  relay_motebit_id:           string   // The relay's UUID v7 identifier (§2.1)
  public_key:                 string   // Hex-encoded Ed25519 public key
  did:                        string   // DID representation (§2.3)
  vote_policy_configured:     boolean  // True iff this relay has wired an operator vote callback for the §16 vote-request endpoint. Peers without configured policy are not eligible §6.2 adjudicators per §16.2; leaders MAY pre-filter them out of quorum enumeration. _Added in 1.2._
}
```

The response carries no signature; the discovery surface is unauthenticated by design (see §10.2). Peers that need authenticated identity claims use the peering handshake (§3).

---

## 3. Peering Protocol

Peering establishes a bilateral, authenticated relationship between two relays. Both relays must explicitly agree to peer — there is no unilateral discovery or implicit federation.

### 3.1 — Peering Handshake

#### Wire format (foundation law)

The three-step handshake message shape every implementation MUST emit. The propose/respond/confirm endpoints, payload fields, and signature construction below are binding — a peer that signs the wrong bytes cannot authenticate on a conformant federation.

The peering handshake is a 3-step mutual authentication protocol:

```
Relay A (initiator)                         Relay B (responder)
    │                                            │
    │  1. POST /federation/v1/peer/propose       │
    │  { relay_id, public_key, endpoint_url,     │
    │    display_name, nonce_a }                  │
    │ ──────────────────────────────────────────> │
    │                                            │
    │  2. 200 OK                                 │
    │  { relay_id, public_key, endpoint_url,     │
    │    display_name, nonce_b,                  │
    │    challenge: Sign(nonce_a, key_b) }       │
    │ <────────────────────────────────────────── │
    │                                            │
    │  3. POST /federation/v1/peer/confirm       │
    │  { relay_id,                               │
    │    challenge_response: Sign(nonce_b, key_a)│
    │  }                                         │
    │ ──────────────────────────────────────────> │
    │                                            │
    │  4. 200 OK { status: "active" }            │
    │ <────────────────────────────────────────── │
```

**Step 1 — Propose.** Relay A sends its identity and a 32-byte random nonce (`nonce_a`).

**Step 2 — Respond.** Relay B validates the proposal, stores A as a pending peer, generates its own nonce (`nonce_b`), and returns a challenge: the Ed25519 signature of `{relay_id}:{nonce_a}:{suite}` (proposer's relay_id, proposer's nonce, and the cryptosuite identifier `motebit-concat-ed25519-hex-v1`, UTF-8 encoded, colon-separated) using B's private key. This proves B holds the private key corresponding to the public key it advertises. The nonce is bound to the relay_id and suite to prevent cross-peering and cross-suite replay.

**Step 3 — Confirm.** Relay A verifies B's challenge signature against B's public key. If valid, A signs `{relay_id}:{nonce_b}:{suite}` (A's own relay_id, B's nonce, suite identifier) with its own private key and sends the response. Relay B verifies A's signature. Both relays transition the peer to `active` state.

The suite identifier for handshake challenges is `motebit-concat-ed25519-hex-v1` (see `SUITE_REGISTRY` in `@motebit/protocol`): UTF-8 concatenation of the template, Ed25519 primitive, hex signature encoding.

If any verification fails, the handshake is aborted and the peer record is discarded.

#### Storage (reference convention — non-binding)

The reference relay persists peer state in the `relay_peers` table (§3.4). Alternative implementations MAY keep peers in memory, in a config file, or in an external service registry — only the wire messages above cross the federation.

### 3.2 — Heartbeat

Active peers exchange heartbeats to confirm liveness and synchronize metadata.

| Parameter        | Value                                                        |
| ---------------- | ------------------------------------------------------------ |
| **Interval**     | 60 seconds                                                   |
| **Endpoint**     | `POST /federation/v1/peer/heartbeat`                         |
| **Payload**      | `{ relay_id, timestamp, agent_count, signature }`            |
| **Missed limit** | 3 consecutive missed heartbeats → `suspended`; 5 → `removed` |
| **Action**       | Peer state transitions to `suspended` at 3, `removed` at 5   |

The `signature` field is the Ed25519 signature of `{relay_id}|{timestamp}|{suite}` (pipe-separated UTF-8 bytes, where `suite` is the cryptosuite identifier `motebit-concat-ed25519-hex-v1`). This prevents replay, spoofing, and cross-suite confusion.

A suspended peer is excluded from discovery and routing until heartbeats resume. After a single successful heartbeat, the peer transitions back to `active`. A peer that reaches 5 consecutive missed heartbeats is transitioned to `removed` and requires a full handshake to re-establish.

### 3.3 — Peer Removal

Either relay may unilaterally remove a peer by sending `POST /federation/v1/peer/remove` with a signed removal notice. The receiving relay transitions the peer to `removed` state. Removed peers require a full handshake to re-establish.

### 3.4 — `relay_peers` Table

| Column              | Type    | Description                                                                |
| ------------------- | ------- | -------------------------------------------------------------------------- |
| `peer_relay_id`     | TEXT PK | The peer relay's `motebit_id`.                                             |
| `public_key`        | TEXT    | Hex-encoded Ed25519 public key of the peer.                                |
| `endpoint_url`      | TEXT    | Base URL of the peer relay.                                                |
| `display_name`      | TEXT    | Human-readable name of the peer relay.                                     |
| `state`             | TEXT    | One of: `"pending"`, `"active"`, `"suspended"`, `"removed"`.               |
| `peered_at`         | INTEGER | Epoch milliseconds when the handshake completed.                           |
| `last_heartbeat_at` | INTEGER | Epoch milliseconds of the most recent successful heartbeat.                |
| `missed_heartbeats` | INTEGER | Count of consecutive missed heartbeats. Resets to 0 on successful receipt. |
| `agent_count`       | INTEGER | Number of agents the peer reports hosting. Updated on heartbeat.           |
| `trust_score`       | REAL    | Trust in this peer relay, managed by `evaluateTrustTransition`.            |

---

## 4. Federated Discovery

Discovery queries propagate across peered relays, enabling an agent on any relay to find agents on any federated relay.

### 4.1 — Query Forwarding

When the local relay's `/api/v1/agents/discover` endpoint receives a query, it:

1. Searches its own agent population (existing behavior, unchanged).
2. Forwards the query to all `active` peers via `POST /federation/v1/discover`.
3. Merges results, deduplicates by `motebit_id`, and returns a unified response.

The forwarding request includes:

| Field          | Type     | Description                                                     |
| -------------- | -------- | --------------------------------------------------------------- |
| `query`        | object   | The original discovery query (capabilities, constraints, etc.). |
| `hop_count`    | number   | Current hop depth. Starts at 0 on the originating relay.        |
| `max_hops`     | number   | Maximum forwarding depth. MUST NOT exceed 3.                    |
| `visited`      | string[] | Array of `relay_id` values already visited. Loop prevention.    |
| `query_id`     | string   | UUID v7 for deduplication across the federation.                |
| `origin_relay` | string   | `relay_id` of the relay that initiated the query.               |

### 4.2 — Hop Limit

The `hop_count` field is incremented at each relay. A relay MUST NOT forward a query if `hop_count >= max_hops`. The hard ceiling for `max_hops` is 3 — relays MUST reject queries with `max_hops > 3`.

This bounds the amplification factor. With a maximum of 3 hops and assuming each relay peers with at most _p_ relays, the worst-case fanout is _p^3_. The hop limit ensures federation scales predictably.

### 4.3 — Loop Prevention

The `visited` array contains the `relay_id` of every relay that has processed the query. A relay MUST NOT forward a query if its own `relay_id` is in the `visited` set. Before forwarding, the relay appends its own `relay_id` to the `visited` array.

### 4.4 — Query Deduplication

Relays MUST deduplicate queries by `query_id` within a 30-second TTL window. If a relay receives a query with a `query_id` it has already processed, it returns an empty result set immediately.

Implementation: an in-memory map of `query_id → timestamp`, pruned on a 30-second interval.

### 4.5 — Result Merging

Federated results include a `source_relay` field indicating which relay hosts the agent:

| Field          | Type   | Description                                   |
| -------------- | ------ | --------------------------------------------- |
| `source_relay` | string | `relay_id` of the relay that hosts the agent. |
| `relay_name`   | string | `display_name` of the source relay.           |
| `hop_distance` | number | Number of relay hops from the querying relay. |

Results from the local relay have `source_relay` set to the local relay's `motebit_id` and `hop_distance` of 0.

When multiple relays return the same agent (possible if an agent is registered on multiple relays), the result with the lowest `hop_distance` takes precedence.

### 4.6 — Backward Compatibility

The existing `/api/v1/agents/discover` endpoint returns federated results transparently. The response schema is extended with the optional `source_relay`, `relay_name`, and `hop_distance` fields. Clients that do not recognize these fields ignore them. No client changes are required.

---

## 5. Cross-Relay Task Routing

Task routing across relays reuses the existing semiring graph infrastructure. Relays are modeled as intermediate nodes in the `WeightedDigraph<RouteWeight>`.

### 5.1 — Graph Augmentation

The function `augmentGraphWithFederatedAgents()` adds relay nodes and edges to the existing agent graph:

```
self → relay:local → relay:remote → target_agent
```

For each active peer relay and each agent discovered on that peer:

1. **Edge: self → relay:local.** The originating agent's trust in the local relay. Weight: `RouteWeight` with trust from the agent's local trust record, zero cost, zero latency.

2. **Edge: relay:local → relay:remote.** The local relay's trust in the peer relay. Weight: `RouteWeight` with trust from `relay_peers.trust_score`, inter-relay latency (measured from heartbeat round-trip), inter-relay cost (peer's fee rate).

3. **Edge: relay:remote → target_agent.** The peer relay's trust in the target agent. Weight: `RouteWeight` with trust reported by the peer relay, agent's declared cost, agent's reported latency.

### 5.2 — Semiring Composition

Trust composes multiplicatively along the chain. Cost and latency compose additively. This is exactly `RouteWeightSemiring.mul`:

```
effective_trust = trust(self, relay_local) × trust(relay_local, relay_remote) × trust(relay_remote, agent)
effective_cost  = cost(self, relay_local) + cost(relay_local, relay_remote) + cost(relay_remote, agent)
effective_latency = latency(self, relay_local) + latency(relay_local, relay_remote) + latency(relay_remote, agent)
```

The `optimalPaths` function computes these automatically — no special-case code for federation. Cross-relay routes compete with local routes in the same graph, and the semiring algebra selects the optimal path regardless of whether it crosses relay boundaries.

### 5.3 — Task Forwarding

When the optimal path crosses a relay boundary, the local relay forwards the task to the peer relay via `POST /federation/v1/task/forward`:

| Field            | Type   | Required | Description                                              |
| ---------------- | ------ | -------- | -------------------------------------------------------- |
| `task_id`        | string | yes      | Unique task identifier (UUID v7).                        |
| `origin_relay`   | string | yes      | `relay_id` of the originating relay.                     |
| `target_agent`   | string | yes      | `motebit_id` of the target agent.                        |
| `task_payload`   | object | yes      | The task specification (prompt, tools, constraints).     |
| `budget`         | object | yes      | Allocated budget for the task (amount, currency).        |
| `routing_choice` | object | yes      | Routing provenance from `graphRankCandidates`.           |
| `signature`      | string | yes      | Ed25519 signature of canonical JSON of the above fields. |

The receiving relay verifies the signature, checks that the target agent is registered locally, allocates budget, and submits the task to the agent using the standard execution pipeline.

### 5.4 — Result Return

When the forwarded task completes, the peer relay returns the result via `POST /federation/v1/task/result` to the originating relay:

| Field         | Type   | Required | Description                                              |
| ------------- | ------ | -------- | -------------------------------------------------------- |
| `task_id`     | string | yes      | The task identifier from the forwarding request.         |
| `status`      | string | yes      | One of: `"completed"`, `"failed"`, `"denied"`.           |
| `receipt`     | object | yes      | The agent's signed `ExecutionReceipt`.                   |
| `attestation` | object | yes      | The peer relay's `RelayAttestation` (§8.2).              |
| `actual_cost` | object | yes      | Actual cost incurred (for settlement).                   |
| `signature`   | string | yes      | Ed25519 signature of canonical JSON of the above fields. |

---

## 6. Trust Model

Cross-relay trust uses the same `evaluateTrustTransition` state machine that governs agent trust. Relay peers are trust subjects with their own trust records.

### 6.1 — Trust Accumulation

Relay trust is accumulated through:

- **Successful task forwarding.** A forwarded task that returns a valid, verified receipt increments `successful_tasks` on the peer's trust record.
- **Failed task forwarding.** A forwarded task that fails or returns an invalid receipt increments `failed_tasks`.
- **Heartbeat reliability.** Consistent heartbeats contribute to the peer's trust stability. Missed heartbeats do not directly demote trust, but sustained unreliability triggers `evaluateTrustTransition` thresholds.

Trust transitions follow the same state machine levels: `new → provisional → established → trusted → verified`, with demotion on failure patterns.

### 6.2 — Effective Trust

The effective trust for a cross-relay agent is the product of trust scores along the path:

```
effective_trust = trust(self, relay_local) × trust(relay_local, relay_remote) × trust(relay_remote, agent)
```

This is not a special formula — it is the result of `RouteWeightSemiring.mul` applied along the path edges by `optimalPaths`. The trust semiring's multiplicative composition (`Trust = max/×`) naturally yields this product.

### 6.3 — Trust Isolation

A relay's trust in a peer does not affect the relay's trust in its own local agents. Trust is per-subject. If a peer relay is demoted, only routes through that peer are affected — local agents and routes through other peers remain unchanged.

---

## 7. Settlement Chain

Federation introduces multi-relay settlement. Each relay in the forwarding chain extracts a platform fee before passing the remainder to the next hop.

### 7.1 — Fee Structure

Each relay applies its own `PLATFORM_FEE_RATE` (default: 5%) to the budget it receives.

**Example:** A $1.00 task forwarded from Relay A to Relay B, where Relay B dispatches to the agent:

| Step                      | Amount  | Recipient |
| ------------------------- | ------- | --------- |
| Task budget               | $1.0000 | —         |
| Relay A fee (5%)          | $0.0500 | Relay A   |
| Forwarded to Relay B      | $0.9500 | —         |
| Relay B fee (5% of $0.95) | $0.0475 | Relay B   |
| Agent receives            | $0.9025 | Agent     |

### 7.2 — Settlement Records

Each settlement record links upstream and downstream participants:

| Field                 | Type   | Required | Description                                                             |
| --------------------- | ------ | -------- | ----------------------------------------------------------------------- |
| `settlement_id`       | string | yes      | Unique settlement identifier (UUID v7).                                 |
| `task_id`             | string | yes      | The task that was settled.                                              |
| `upstream_relay_id`   | string | yes      | `relay_id` of the relay that forwarded the task.                        |
| `downstream_relay_id` | string | no       | `relay_id` of the relay that received the task. NULL for the final hop. |
| `agent_id`            | string | no       | `motebit_id` of the executing agent. Present on final hop only.         |
| `gross_amount`        | number | yes      | Amount received from upstream.                                          |
| `fee_amount`          | number | yes      | Platform fee extracted at this hop.                                     |
| `net_amount`          | number | yes      | Amount forwarded downstream (or paid to agent).                         |
| `fee_rate`            | number | yes      | Fee rate applied (e.g., 0.05).                                          |
| `settled_at`          | number | yes      | Epoch milliseconds when settlement was recorded.                        |
| `receipt_hash`        | string | yes      | SHA-256 hex of the execution receipt that triggered settlement.         |

### 7.3 — Settlement Forwarding

After a forwarded task completes and the receipt is verified, the originating relay sends a settlement record to the peer relay via `POST /federation/v1/settlement/forward`:

| Field           | Type   | Required | Description                                        |
| --------------- | ------ | -------- | -------------------------------------------------- |
| `task_id`       | string | yes      | The task being settled.                            |
| `settlement_id` | string | yes      | Settlement identifier for audit linkage.           |
| `gross_amount`  | number | yes      | Amount allocated for the peer's portion.           |
| `receipt_hash`  | string | yes      | Hash of the verified receipt.                      |
| `signature`     | string | yes      | Ed25519 signature of canonical JSON of the fields. |

The receiving relay verifies the signature, records its own settlement entry, and pays the agent via the standard `settleOnReceipt` flow.

### 7.4 — Settlement Retry

When a settlement forward fails (network error, peer timeout), the originating relay queues the settlement for exponential backoff retry rather than dropping it.

| Parameter        | Value                               |
| ---------------- | ----------------------------------- |
| **Max attempts** | 5                                   |
| **Backoff**      | 30s, 2min, 8min, 32min, 2h          |
| **Status**       | `pending` → `completed` or `failed` |
| **Storage**      | `relay_settlement_retries` table    |

After 5 failed attempts, the settlement is marked as `failed` and requires manual intervention. Successful retry clears the queue entry.

### 7.5 — Payment Proof (x402)

Settlement records may include optional on-chain payment proof fields:

| Field          | Type   | Required | Description                                         |
| -------------- | ------ | -------- | --------------------------------------------------- |
| `x402_tx_hash` | string | no       | Transaction hash for on-chain payment verification. |
| `x402_network` | string | no       | Network identifier (e.g., `"ethereum"`, `"base"`).  |

These fields flow through the settlement forwarding pipeline and are stored in both `relay_settlements` and `relay_federation_settlements` tables for audit linkage.

### 7.6 — Settlement Anchoring (Merkle Batch)

Inter-relay settlement requires a trustless verification layer. Neither relay trusts the other's database. On-chain Merkle root anchoring provides the clearing mechanism — both relays can independently verify that a settlement was included in an anchored batch without revealing the full settlement set.

#### 7.6.1 — Leaf Construction

Each settlement produces one Merkle leaf. The leaf hash is computed as:

```
leaf = SHA-256(canonicalJson({
  settlement_id,
  task_id,
  upstream_relay_id,
  downstream_relay_id,
  gross_amount,
  fee_amount,
  net_amount,
  receipt_hash,
  settled_at
}))
```

`canonicalJson` follows RFC 8785 (JCS) — deterministic key ordering, no whitespace — the same serialization used for Ed25519 signatures throughout the protocol. The leaf content is the subset of the settlement record needed for audit verification; it excludes `fee_rate` (derivable from `fee_amount / gross_amount`) and mutable fields.

#### 7.6.2 — Tree Construction

Leaves are sorted by `settled_at` ascending, then by `settlement_id` lexicographic ascending (tiebreaker). The tree is a binary Merkle tree:

1. If the leaf count is odd, the last leaf is promoted (not duplicated). This prevents second-preimage attacks from duplicated leaves.
2. Internal nodes: `SHA-256(left || right)` — raw concatenation of the 32-byte child hashes.
3. The root is the single remaining hash after recursive pairing.

A batch with one settlement has a tree of depth 0 (the leaf hash is the root).

#### 7.6.3 — Batch Trigger

A relay cuts a batch when **either** condition is met:

| Trigger   | Threshold | Rationale                                                 |
| --------- | --------- | --------------------------------------------------------- |
| **Count** | 100       | Bounds proof size. 100 leaves → depth ≤ 7 → 7-hash proof. |
| **Time**  | 1 hour    | Bounds settlement finality latency for low-volume relays. |

Batches are cut from `relay_federation_settlements` rows where `anchor_batch_id IS NULL` (not yet anchored). The relay assigns a `batch_id` (UUID v7) and stores the Merkle root before anchoring.

A relay with no unanchored settlements at the time trigger does nothing.

#### 7.6.4 — Anchor Record

Each anchored batch produces an `AnchorRecord`:

| Field              | Type   | Required | Description                                                     |
| ------------------ | ------ | -------- | --------------------------------------------------------------- |
| `batch_id`         | string | yes      | UUID v7 identifier for this batch.                              |
| `merkle_root`      | string | yes      | Hex-encoded SHA-256 Merkle root of the settlement batch.        |
| `leaf_count`       | number | yes      | Number of settlements in the batch.                             |
| `first_settled_at` | number | yes      | Earliest `settled_at` in the batch.                             |
| `last_settled_at`  | number | yes      | Latest `settled_at` in the batch.                               |
| `relay_id`         | string | yes      | `motebit_id` of the relay that produced the batch.              |
| `signature`        | string | yes      | Ed25519 signature of `canonicalJson` of the above fields.       |
| `tx_hash`          | string | no       | On-chain transaction hash after anchoring (populated async).    |
| `network`          | string | no       | Chain identifier (CAIP-2, e.g., `"eip155:8453"` for Base).      |
| `anchored_at`      | number | no       | Epoch milliseconds when the on-chain transaction was confirmed. |

The relay signs the `AnchorRecord` before submitting to the chain. This binds the batch to the relay's identity — a peer can verify the signature without waiting for on-chain confirmation.

#### 7.6.5 — On-Chain Submission

The Merkle root is anchored by calling a minimal contract on Base (or other EVM chain):

```solidity
event SettlementBatchAnchored(
    bytes32 indexed merkleRoot,
    bytes32 indexed relayId,
    uint64 leafCount,
    uint64 batchTimestamp
);

function anchor(bytes32 merkleRoot, bytes32 relayId, uint64 leafCount) external;
```

The contract is append-only — it emits an event and stores nothing. Verification happens off-chain by checking the event log. Gas cost is constant regardless of batch size (~45K gas, ~$0.001 on Base).

On-chain submission is **asynchronous**. The relay signs the `AnchorRecord` immediately, populates `tx_hash`, `network`, and `anchored_at` after confirmation. Settlement is not blocked on anchoring — the relay's Ed25519 signature provides immediate verifiability, and the on-chain anchor provides non-repudiability.

#### 7.6.6 — Verification

A peer relay verifies a settlement was included in an anchored batch using a Merkle inclusion proof:

1. **Reconstruct the leaf** from the settlement record using the canonical construction (§7.6.1).
2. **Obtain the proof** — the list of sibling hashes along the path from the leaf to the root — via `GET /federation/v1/settlement/proof?settlement_id=<id>`.
3. **Recompute the root** by iteratively hashing the leaf with each sibling.
4. **Compare** the computed root against the `AnchorRecord.merkle_root` (verified via the relay's Ed25519 signature) and optionally against the on-chain event log.

The proof endpoint returns:

| Field           | Type     | Description                                              |
| --------------- | -------- | -------------------------------------------------------- |
| `settlement_id` | string   | The settlement being proved.                             |
| `leaf_hash`     | string   | SHA-256 hex of the settlement leaf.                      |
| `proof`         | string[] | Ordered array of sibling hashes (hex) from leaf to root. |
| `leaf_index`    | number   | Position of the leaf in the sorted batch.                |
| `merkle_root`   | string   | Root hash for comparison.                                |
| `batch_id`      | string   | Batch identifier for cross-reference.                    |
| `anchor`        | object   | The signed `AnchorRecord` (§7.6.4).                      |

#### 7.6.7 — Failure and Retry

| Failure                                       | Response                                                                                                          |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| On-chain submission fails                     | Retry with exponential backoff (30s, 2m, 8m, 32m, 2h). Max 5 attempts.                                            |
| On-chain submission exhausted                 | Batch marked `anchor_failed`. Ed25519 signature remains valid for verification. Manual intervention to re-anchor. |
| Peer requests proof for unknown settlement    | HTTP 404. Settlement may be on a different relay or not yet batched.                                              |
| Peer requests proof for unanchored settlement | HTTP 202. Batch is pending; `retry_after` header indicates expected anchor time.                                  |

Anchoring failure does NOT invalidate the settlements. The relay's Ed25519 signature on the `AnchorRecord` is the primary trust mechanism between peers. The on-chain anchor is additive non-repudiability — it proves the relay cannot later deny having produced the batch. Settlements proceed regardless.

#### 7.6.8 — `relay_anchor_batches` Table

| Column             | Type    | Description                                               |
| ------------------ | ------- | --------------------------------------------------------- |
| `batch_id`         | TEXT PK | UUID v7 batch identifier.                                 |
| `merkle_root`      | TEXT    | Hex-encoded Merkle root.                                  |
| `leaf_count`       | INTEGER | Number of settlements in the batch.                       |
| `first_settled_at` | INTEGER | Earliest `settled_at` timestamp in the batch.             |
| `last_settled_at`  | INTEGER | Latest `settled_at` timestamp in the batch.               |
| `signature`        | TEXT    | Relay's Ed25519 signature of the anchor record.           |
| `tx_hash`          | TEXT    | On-chain transaction hash (NULL until confirmed).         |
| `network`          | TEXT    | CAIP-2 chain identifier (NULL until submitted).           |
| `anchored_at`      | INTEGER | Epoch ms of on-chain confirmation (NULL until confirmed). |
| `status`           | TEXT    | `"signed"`, `"submitted"`, `"confirmed"`, `"failed"`.     |
| `created_at`       | INTEGER | Epoch ms when the batch was created.                      |

The `relay_federation_settlements` table gains one column:

| Column            | Type | Description                                                |
| ----------------- | ---- | ---------------------------------------------------------- |
| `anchor_batch_id` | TEXT | FK to `relay_anchor_batches.batch_id`. NULL until batched. |

---

## 8. Receipt Verification

Cross-relay receipts involve two signatures: the agent's execution receipt signature and the forwarding relay's attestation.

### 8.1 — Agent Receipt

The agent signs its `ExecutionReceipt` as specified in the execution-ledger-v1.0 specification. This signature is produced by the agent's Ed25519 keypair and covers the canonical receipt content hash. No changes to the existing receipt format are required.

### 8.2 — Relay Attestation

The forwarding relay adds a co-signature — a `RelayAttestation` — that attests to the receipt's delivery context:

| Field                | Type   | Required | Description                                                  |
| -------------------- | ------ | -------- | ------------------------------------------------------------ |
| `relay_id`           | string | yes      | `motebit_id` of the attesting relay.                         |
| `task_id`            | string | yes      | The task this attestation covers.                            |
| `agent_receipt_hash` | string | yes      | SHA-256 hex of the agent's signed receipt.                   |
| `received_at`        | number | yes      | Epoch milliseconds when the relay received the receipt.      |
| `forwarded_at`       | number | yes      | Epoch milliseconds when the relay forwarded the attestation. |
| `signature`          | string | yes      | Ed25519 signature of canonical JSON of the above fields.     |

### 8.3 — Verification at Origin

The originating relay verifies a cross-relay receipt in two steps:

1. **Agent signature verification.** Verify the agent's Ed25519 signature on the receipt using the agent's public key (obtained from the peer relay or cached from discovery).
2. **Relay attestation verification.** Verify the forwarding relay's Ed25519 signature on the `RelayAttestation` using the peer relay's public key (from `relay_peers.public_key`).

Both signatures must be valid for the receipt to be accepted. On acceptance:

- Trust is updated for both the agent (via `evaluateTrustTransition`) and the forwarding relay.
- Settlement is triggered (§7).
- If relay credential issuance is enabled (`MOTEBIT_RELAY_ISSUE_CREDENTIALS=true`), the relay co-signs an `AgentReputationCredential`. By default, reputation credentials are peer-issued by the delegating agent at the runtime layer.

---

## 9. Failure Modes

### 9.1 — Peer Down

| Condition                     | Detection                                   | Response                                                                        |
| ----------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------- |
| Peer stops sending heartbeats | 3 consecutive missed heartbeats (3 minutes) | Peer state transitions to `suspended`. At 5 missed, transitions to `removed`.   |
| Peer resumes heartbeats       | 1 successful heartbeat                      | Peer state transitions back to `active`.                                        |
| Peer down during task         | HTTP timeout or connection error            | Task fails locally; originating relay retries via alternate route if available. |

A suspended peer is excluded from discovery forwarding and task routing. The local relay's own agents and routes through other peers are unaffected.

### 9.2 — Malicious Relay

| Threat                        | Detection                                       | Response                                                             |
| ----------------------------- | ----------------------------------------------- | -------------------------------------------------------------------- |
| Fabricated receipts           | Agent signature verification fails              | Receipt rejected; relay trust demoted via `evaluateTrustTransition`. |
| Inflated costs                | Settlement audit trail shows discrepancy        | Manual investigation; relay can be blocked.                          |
| Discovery result manipulation | Agents not reachable or misrepresented          | Trust demotion on failed task forwarding.                            |
| Replay attacks                | Nonce/timestamp verification in signed payloads | Request rejected.                                                    |

Administrators can manually block a peer relay by transitioning its state to `removed` in the `relay_peers` table.

### 9.3 — Stale Data

| Data Type          | Freshness Source        | Staleness Threshold | Action                           |
| ------------------ | ----------------------- | ------------------- | -------------------------------- |
| Peer liveness      | Heartbeat               | 3 minutes (3 × 60s) | Suspend peer (remove at 5 × 60s) |
| Agent availability | Heartbeat `agent_count` | 5 minutes           | Re-query on next discovery       |
| Trust scores       | Task completion events  | None (event-driven) | No expiry; accumulates over time |
| Discovery cache    | Query deduplication TTL | 30 seconds          | Cache eviction                   |

---

## 10. Federation API Surface

All federation endpoints are under the `/federation/v1/` path prefix. All requests MUST include an Ed25519 signature in the `X-Relay-Signature` header, computed over the canonical JSON request body using the sending relay's private key.

#### Routes (foundation law)

The fifteen routes below are the binding cross-relay contract. Renaming or relocating any of them is a wire break.

- `GET /federation/v1/identity` — return this relay's public identity.
- `POST /federation/v1/peer/propose` — initiate peering handshake (step 1).
- `POST /federation/v1/peer/confirm` — complete peering handshake (step 3).
- `POST /federation/v1/peer/heartbeat` — send heartbeat to peer.
- `POST /federation/v1/peer/remove` — remove a peer relationship.
- `GET /federation/v1/peers` — list current federation peers.
- `POST /federation/v1/discover` — forward a discovery query.
- `POST /federation/v1/task/forward` — forward a task to a peer relay.
- `POST /federation/v1/task/result` — return a task result to origin relay.
- `POST /federation/v1/settlement/forward` — forward settlement to peer relay.
- `GET /federation/v1/settlements` — list inbound forwarded settlements.
- `GET /federation/v1/settlement/proof` — Merkle inclusion proof (§7.6.6).
- `POST /federation/v1/horizon/witness` — co-witness a peer's `append_only_horizon` retention cert (§15.2). _Added in 1.1._
- `POST /federation/v1/horizon/dispute` — file a `WitnessOmissionDispute` against a horizon cert (§15.3). _Added in 1.1._
- `POST /federation/v1/disputes/:disputeId/vote-request` — receive a vote request from a leader during §6.2 federation adjudication (§16.2). _Added in 1.2._

### 10.1 — Endpoints

| Method | Path                                              | Description                                                                       | Rate Limit      | Since |
| ------ | ------------------------------------------------- | --------------------------------------------------------------------------------- | --------------- | ----- |
| POST   | `/federation/v1/peer/propose`                     | Initiate peering handshake (step 1).                                              | 30/min per peer | 1.0   |
| POST   | `/federation/v1/peer/confirm`                     | Complete peering handshake (step 3).                                              | 30/min per peer | 1.0   |
| POST   | `/federation/v1/peer/heartbeat`                   | Send heartbeat to peer.                                                           | 30/min per peer | 1.0   |
| POST   | `/federation/v1/peer/remove`                      | Remove a peer relationship.                                                       | 30/min per peer | 1.0   |
| POST   | `/federation/v1/discover`                         | Forward a discovery query.                                                        | 30/min per peer | 1.0   |
| POST   | `/federation/v1/task/forward`                     | Forward a task to a peer relay.                                                   | 30/min per peer | 1.0   |
| POST   | `/federation/v1/task/result`                      | Return a task result to origin relay.                                             | 30/min per peer | 1.0   |
| POST   | `/federation/v1/settlement/forward`               | Forward settlement to peer relay.                                                 | 30/min per peer | 1.0   |
| GET    | `/federation/v1/settlement/proof`                 | Merkle inclusion proof (§7.6.6).                                                  | 30/min per peer | 1.0   |
| GET    | `/federation/v1/identity`                         | Return this relay's public identity.                                              | 30/min per peer | 1.0   |
| POST   | `/federation/v1/horizon/witness`                  | Co-witness a peer's `append_only_horizon` retention cert (§15.2).                 | 30/min per peer | 1.1   |
| POST   | `/federation/v1/horizon/dispute`                  | File a `WitnessOmissionDispute` against a horizon cert (§15.3).                   | 30/min per peer | 1.1   |
| POST   | `/federation/v1/disputes/:disputeId/vote-request` | Receive a vote request from a leader during §6.2 federation adjudication (§16.2). | 30/min per peer | 1.2   |

### 10.2 — Authentication

Every request to a federation endpoint MUST include:

| Header              | Value                                                                   |
| ------------------- | ----------------------------------------------------------------------- |
| `X-Relay-Id`        | The sending relay's `motebit_id`.                                       |
| `X-Relay-Signature` | Base64url-encoded Ed25519 signature of the canonical JSON request body. |
| `X-Relay-Timestamp` | ISO 8601 timestamp. Requests older than 5 minutes MUST be rejected.     |
| `Content-Type`      | `application/json`                                                      |

The receiving relay:

1. Looks up the sender's public key from `relay_peers` (or from the proposal payload for initial handshake).
2. Verifies the signature against the request body.
3. Checks the timestamp is within 5 minutes of the relay's clock.
4. Rejects the request if any check fails (HTTP 401).

### 10.3 — Rate Limiting

Federation endpoints use a dedicated rate limit tier: **30 requests per minute per peer relay**. This is separate from the existing 5-tier rate limiting on agent-facing endpoints. Rate limits are keyed by `X-Relay-Id`, not by IP address.

---

## 11. Migration Path

Federation is deployed in 5 phases. Each phase is independently deployable and backward-compatible with the previous state.

### 11.1 — Phase 1: Relay Identity

- Generate Ed25519 keypair on relay startup.
- Create `relay_identity` table.
- Store private key in OS keychain.
- Expose `GET /federation/v1/identity` endpoint.

**Prerequisite:** None.
**Impact:** None — relay operates identically. Identity is generated but unused until Phase 2.

### 11.2 — Phase 2: Peering

- Implement peering handshake (propose → respond → confirm).
- Create `relay_peers` table.
- Implement heartbeat loop (60s interval).
- Implement peer removal.
- Add federation authentication middleware.

**Prerequisite:** Phase 1.
**Impact:** Relay can establish peer relationships. No functional change for agents.

### 11.3 — Phase 3: Federated Discovery

- Implement query forwarding with hop count, visited set, and deduplication.
- Extend `/api/v1/agents/discover` to include federated results.
- Add `source_relay`, `relay_name`, `hop_distance` to discovery response.

**Prerequisite:** Phase 2.
**Impact:** Discovery returns agents from peer relays. Task routing still local-only.

### 11.4 — Phase 4: Cross-Relay Routing

- Implement `augmentGraphWithFederatedAgents()`.
- Implement task forwarding and result return.
- Implement settlement chain.
- Add `RelayAttestation` to receipt verification.

**Prerequisite:** Phase 3.
**Impact:** Tasks can be routed to agents on peer relays. Full federation is operational.

### 11.5 — Phase 5: Trust and Reputation

- Extend `evaluateTrustTransition` to relay peers.
- Implement cross-relay trust accumulation.
- Relay co-signs `AgentReputationCredential` for cross-relay task completions (when `issueCredentials` is enabled; peer-issued by default).
- Expose federation trust metrics in operator dashboard.

**Prerequisite:** Phase 4.
**Impact:** Trust accumulates across relay boundaries. Routing improves over time as trust data compounds.

---

## 12. Configuration

Federation behavior is controlled by relay configuration. All settings have sensible defaults — federation is opt-in.

| Setting                         | Type     | Default | Description                                               |
| ------------------------------- | -------- | ------- | --------------------------------------------------------- |
| `federation.enabled`            | boolean  | false   | Whether federation is active.                             |
| `federation.max_peers`          | number   | 10      | Maximum number of active peer relationships.              |
| `federation.heartbeat_interval` | number   | 60000   | Heartbeat interval in milliseconds.                       |
| `federation.heartbeat_timeout`  | number   | 5       | Number of missed heartbeats before suspension.            |
| `federation.max_hops`           | number   | 3       | Maximum query forwarding depth.                           |
| `federation.query_dedup_ttl`    | number   | 30000   | Query deduplication TTL in milliseconds.                  |
| `federation.platform_fee_rate`  | number   | 0.05    | Platform fee rate applied to forwarded tasks.             |
| `federation.auto_accept_peers`  | boolean  | false   | If true, automatically accept incoming peer proposals.    |
| `federation.allowed_peers`      | string[] | []      | Allowlist of relay `motebit_id` values permitted to peer. |

When `federation.enabled` is `false`, all `/federation/v1/` endpoints return HTTP 404. The relay operates as a standalone instance.

---

## 13. Security Considerations

### 13.1 — Amplification Prevention

The 3-hop maximum on query forwarding bounds the worst-case amplification factor. With _p_ peers per relay and 3 hops, the maximum number of relays contacted per query is _p_ + _p_^2 + _p_^3. For the default `max_peers` of 10, this is 1,110 relays — a practical upper bound. The `visited` set and `query_id` deduplication prevent redundant processing within this bound.

### 13.2 — Relay Impersonation

Relay impersonation is prevented by:

- **Ed25519 mutual authentication** during the peering handshake. Both relays prove possession of their private keys.
- **Key pinning.** After the handshake, each relay stores the peer's public key. All subsequent requests are verified against the pinned key. A MITM cannot forge signatures without the private key.
- **Timestamp validation.** Signed requests include a timestamp; requests older than 5 minutes are rejected. This limits replay windows.

### 13.3 — Fee Manipulation

The settlement chain creates a per-settlement audit trail. Each settlement record includes the `receipt_hash` linking it to a verified execution receipt, the `fee_rate` applied, and the `gross_amount` / `net_amount` / `fee_amount` breakdown. Discrepancies between declared and actual fees are detectable by comparing settlement records across relays.

### 13.4 — Privacy

Agent metadata includes an optional `federation_visible` flag:

| Value   | Behavior                                                                                            |
| ------- | --------------------------------------------------------------------------------------------------- |
| `true`  | Agent appears in federated discovery results. Default for services.                                 |
| `false` | Agent is hidden from federation. Only discoverable on the local relay. Default for personal agents. |

Agents control their federation visibility. A relay MUST NOT include agents with `federation_visible: false` in responses to federated discovery queries.

### 13.5 — Data Minimization

Federated discovery responses include only the information necessary for routing decisions: `motebit_id`, capabilities, trust level, cost, and availability. Agent prompts, conversation history, memory graphs, and other interior state are never transmitted across relay boundaries.

### 13.6 — Threat Model

| Threat                            | Mitigation                                                              | Residual Risk                              |
| --------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------ |
| **Relay impersonation**           | Ed25519 mutual auth + key pinning + timestamp validation                | Key compromise on peer relay               |
| **Query amplification**           | 3-hop maximum + visited set + query deduplication (30s TTL)             | None within bounds                         |
| **Fee manipulation**              | Per-settlement audit trail with receipt hash linkage                    | Requires manual audit for detection        |
| **Agent privacy leakage**         | `federation_visible` flag; data minimization in responses               | Metadata (existence, capabilities) visible |
| **Stale routing data**            | Heartbeat-based freshness; suspended peers excluded from routing        | Up to 5-minute window of stale data        |
| **Receipt forgery**               | Dual verification: agent signature + relay attestation                  | Both agent and relay keys must be valid    |
| **Replay of federation requests** | Timestamp in signed headers; 5-minute validity window                   | Clock skew between relays                  |
| **Peer enumeration**              | Peer list not exposed publicly; only authenticated peers see each other | Relay operators know their own peers       |

---

## 14. Versioning

The `spec` identifier for this specification is `motebit/relay-federation@1.1`. Federation endpoints include the version in the URL path (`/federation/v1/`).

Versions use semantic versioning: `motebit/relay-federation@{major}.{minor}`. Minor versions add optional fields and routes; existing endpoints stay byte-compatible. Major versions may change the peering protocol, authentication scheme, or settlement mechanics and are not backward-compatible.

Relays SHOULD advertise their supported federation version in the `GET /federation/v1/identity` response. Peering between relays with incompatible major versions MUST be rejected during the handshake. Minor-version drift is admitted: a 1.0 peer and a 1.1 peer MUST interoperate on §3–14; the 1.1 peer's §15 routes are unavailable when the other end is 1.0 (404), and a 1.0 peer never solicits witnesses or files witness-omission disputes (the cert it issues is structurally self-witnessed under decision 9 of `docs/doctrine/retention-policy.md`).

---

## 15. Horizon Co-Witness Solicitation

_Added in 1.1._ Operationalizes Path A quorum from `docs/doctrine/retention-policy.md` decisions 4 + 9. When an operator advances the horizon on an `append_only_horizon` retention cert, federation peers co-witness the cert by signing the same canonical bytes as the issuer; a peer who believes they were wrongly omitted from `witnessed_by[]` files a `WitnessOmissionDispute` within 24 hours of the cert's `issued_at`.

Wire-format protocol types live in `@motebit/protocol::{HorizonWitnessRequestBody, WitnessSolicitationRequest, WitnessSolicitationResponse, WitnessOmissionDispute}`; zod runtime schemas in `@motebit/wire-schemas`; emitted JSON Schemas at `spec/schemas/witness-{omission-dispute,solicitation-request,solicitation-response}-v1.json`. Verifier primitives in `@motebit/crypto::{verifyHorizonWitnessRequestSignature, verifyWitnessOmissionDispute}`.

Cert remains TERMINAL per `docs/doctrine/retention-policy.md` decision 5 — a sustained dispute is a reputation hit on the issuer, not a cert invalidation. There is no signed-revocation path on horizon certs.

### 15.1 — Solicitation Flow

1. **Issuer** snapshots its federation peer set at `horizon_ts` (filter: `peered_at <= horizon_ts AND state IN ('active', 'suspended') AND last_heartbeat fresh within 5 min`). Mirrors the heartbeat suspension threshold (§3.2).
2. **Issuer** computes the `federation_graph_anchor` — Merkle root over the peer set's hex-encoded Ed25519 public keys, lowercase, sorted ascending. Same algorithm as §7.6 (`merkle-sha256-v1`, binary tree with odd-leaf promotion). Empty peer set → `EMPTY_FEDERATION_GRAPH_ANCHOR` (`leaf_count: 0`, `merkle_root` = hex SHA-256 of zero bytes).
3. **Issuer** constructs a `HorizonWitnessRequestBody` (the witness-canonicalization shape of the cert minus `witnessed_by[]` minus top-level `signature`), signs it under `motebit-jcs-ed25519-b64-v1` to produce the `issuer_signature`, and POSTs `WitnessSolicitationRequest` in parallel to every peer with a per-request timeout (default 10 seconds).
4. **Each peer** parses the request, verifies the issuer is a known active/suspended peer, verifies `issuer_id` matches the id projected from `cert_body.subject`, verifies `issuer_signature` against `canonicalJson(cert_body)`, signs the same bytes with its own federation key, and returns `WitnessSolicitationResponse`.
5. **Issuer** assembles the responses into `cert.witnessed_by[]`, signs the FINAL cert (which now includes the witness array), persists, and truncates the ledger prefix.
6. **Quorum failure** (zero valid witnesses despite ≥1 peer) triggers a fresh attempt — re-snapshotted peer set, fresh `issued_at`, fresh signatures. Three attempts with 1s/3s/9s exponential backoff; sustained failure throws.

The issuer's `issuer_signature` and each peer's response signature are over byte-equal canonical bytes by design — the verify-issuer + sign-as-witness paths share canonical-bytes derivation through one primitive (`canonicalizeHorizonWitnessRequestBody`), making issuer/witness-body divergence structurally impossible.

### 15.2 — `POST /federation/v1/horizon/witness`

**Request body — `WitnessSolicitationRequest`:**

```text
WitnessSolicitationRequest {
  cert_body: HorizonWitnessRequestBody  // The cert body the witness will sign
  issuer_id: string                     // MUST equal the id projected from cert_body.subject
  issuer_signature: string              // Base64url Ed25519 over canonicalJson(cert_body)
}

HorizonWitnessRequestBody {
  kind: "append_only_horizon"           // Discriminator
  subject: HorizonSubject               // { kind: "motebit", motebit_id } | { kind: "operator", operator_id }
  store_id: string                      // Stable identifier for the audit log within the operator's deployment
  horizon_ts: number                    // Unix ms; entries with timestamp < horizon_ts will be unrecoverable
  issued_at: number                     // Unix ms when the issuer signs; load-bearing for the 24h dispute window
  federation_graph_anchor?: FederationGraphAnchor  // Mandatory from 1.1+ when peers exist
  suite: SuiteId                        // "motebit-jcs-ed25519-b64-v1" today
}

FederationGraphAnchor {
  algo: "merkle-sha256-v1"              // Closed registry; see §7.6
  merkle_root: string                   // Hex-encoded SHA-256 root over canonical peer-set leaves
  leaf_count: number                    // Number of peer pubkeys in the anchored set
}
```

**Response body — `WitnessSolicitationResponse`:**

```text
WitnessSolicitationResponse {
  motebit_id: string                    // The witnessing peer's motebit identity
  signature: string                     // Base64url Ed25519 over canonicalJson(cert_body); SAME bytes the issuer signed
  inclusion_proof?: MerkleInclusionProof  // Optional Merkle proof against cert_body.federation_graph_anchor.merkle_root
}
```

**Fail-closed gates** (peer-side, in order):

1. Schema validation via `WitnessSolicitationRequestSchema` — malformed bodies → 400.
2. Issuer must be a known peer in `relay_peers` with `state IN ('active', 'suspended')` — unknown issuer → 403.
3. `issuer_id` must equal `subject.motebit_id` (per-motebit) or `subject.operator_id` (operator-wide) — disagreement → 400. This binding stops a relay from soliciting witnesses for a cert it doesn't own.
4. `issuer_signature` verifies under `motebit-jcs-ed25519-b64-v1` against `canonicalJson(cert_body)` using the issuer's federation pubkey — invalid → 403.

The peer's `signature` does NOT cover `witnessed_by[]` — witnesses are portable across compositions of the same body. The issuer's eventual final cert.signature binds the assembled witness array; witness substitution / forgery fails at the issuer-signature step (§5.10 of `docs/doctrine/retention-policy.md`, decision 5).

### 15.3 — `POST /federation/v1/horizon/dispute`

**Request body — `WitnessOmissionDispute`:**

```text
WitnessOmissionDispute {
  dispute_id: string                    // UUID v7, generated by disputant
  cert_issuer: string                   // Operator id of the cert issuer
  cert_signature: string                // Base64url signature of the disputed cert (opaque pointer)
  disputant_motebit_id: string          // Disputant peer's motebit identity
  evidence: WitnessOmissionEvidence     // Discriminated union — see below
  filed_at: number                      // Unix ms; bounded to [cert.issued_at, cert.issued_at + 24h]
  suite: SuiteId                        // "motebit-jcs-ed25519-b64-v1"
  signature: string                     // Base64url Ed25519 by disputant over canonicalJson(dispute minus signature)
}

WitnessOmissionEvidence =
  | { kind: "inclusion_proof"; leaf_hash: string; proof: MerkleInclusionProof }
  | { kind: "alternative_peering"; peering_artifact: object }
```

**Two evidence shapes:**

- **`inclusion_proof`** — disputant proves their peer pubkey is committed in `cert.federation_graph_anchor.merkle_root` via a Merkle inclusion proof; verifier reconstructs the root and asserts equality.
- **`alternative_peering`** — disputant supplies a signed peering artifact from the cert issuer covering `cert.horizon_ts`; verifier dispatches on the artifact's self-described shape. Today the canonical shape is a federation Heartbeat (§3.2) — `{ relay_id, timestamp, signature }` under `motebit-concat-ed25519-hex-v1`, signing payload `${relay_id}|${timestamp}|${suite}`, freshness window ±5 min around `cert.horizon_ts` (mirrors the heartbeat suspension threshold). Future arms (e.g. `PeeringConfirm`) land as additive registry growth without a wire break — the dispatch is closed-but-additive.

**Two clock gates** (verifier-side, both fail-closed):

1. **Wall clock vs `cert.issued_at`** (load-bearing): receiver's `now <= cert.issued_at + 24h`. Beyond 24h, no dispute is admissible.
2. **`filed_at` sanity bound**: `dispute.filed_at ∈ [cert.issued_at, cert.issued_at + 24h]`. Disputant-attested `filed_at` outside the window is rejected — disputant cannot widen the window via attested timestamp. The cert's `issued_at` is the authoritative clock; `filed_at` exists for audit display, not window derivation.

**Verifier ladder** (in order; short-circuit on failure): window → cert binding (`cert_signature` and `cert_issuer` match the resolved cert) → disputant signature → evidence dispatch by `kind`. See `@motebit/crypto::verifyWitnessOmissionDispute`.

**Dispute window:** 24 hours post-`cert.issued_at`. Inherits the convention from `spec/dispute-v1.md` §7.5 (24h dispute filing, 24h withdrawal hold, 24h appeal window).

**Lifecycle integration:** witness-omission disputes flow through the existing `DisputeResolution` adjudication path in `spec/dispute-v1.md` (state machine: opened → evidence → arbitration → resolved → final). The same 24h/48h/72h ladder applies; same federation-quorum requirement when the issuer relay is the defendant.

### 15.4 — Configuration

| Setting                                      | Type   | Default | Description                                                                                                                                                                                      |
| -------------------------------------------- | ------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `federation.witness_solicitation_timeout_ms` | number | 10000   | Per-request timeout for outbound `/horizon/witness` solicitations. Per-request timeout IS the overall solicitation deadline (parallel `Promise.allSettled` fan-out), not per-attempt cumulative. |
| `federation.revocation_horizon_interval_ms`  | number | 3600000 | Periodic interval (1h default) for the relay's `relay_revocation_events` horizon advance loop. Operational tuning knob, not a doctrinal commitment.                                              |

---

## 16. Federation Adjudication Vote Request

_Added in 1.2._ Operationalizes `spec/dispute-v1.md` §6.2 — federation peer fan-out for execution-ledger dispute adjudication. When a dispute names the local relay as filer or respondent, §6.5 forbids self-adjudication; the relay must route resolution to its federation peers. This section defines the wire surface that fan-out uses.

Wire-format protocol types live in `@motebit/protocol::{VoteRequest, AdjudicatorVote, DisputeResolution}`; zod runtime schemas in `@motebit/wire-schemas::{VoteRequestSchema, AdjudicatorVoteSchema, DisputeResolutionSchema}`; emitted JSON Schemas at `spec/schemas/{vote-request,adjudicator-vote,dispute-resolution}-v1.json`. Verifier primitives in `@motebit/crypto::{signAdjudicatorVote, verifyAdjudicatorVote, signDisputeResolution, verifyDisputeResolution}`.

Round semantics for appeals are defined in `spec/dispute-v1.md` §8.3; `VoteRequest` and `AdjudicatorVote` both carry `round` (1 for original adjudication, 2 for §8.3 appeal), and the signature binds round so cross-round vote replay is cryptographically rejected.

### 16.1 — Vote Solicitation Flow

1. **Leader** (the relay receiving the resolve request AND named in the dispute as `filed_by` or `respondent`) enumerates active federation peers from `relay_peers WHERE state IN ('active', 'suspended') AND peer_relay_id != self`. The self-exclusion enforces §6.5 at the enumeration boundary.
2. If active peer count < 3, leader returns 503 with `error_code: "insufficient_federation_peers"`. The `dispute-v1.md` §6.6 minimum-mesh-size derivation requires ≥3 OTHER active peers for a single-operator fleet (so ≥4 total relays); fewer means the orchestrator cannot reach a §6.2 quorum. (This 503 IS transient — restart on a larger mesh and the request would succeed; cf. the `policy_not_configured` 501 below which is non-transient.)
3. **Leader** constructs a `VoteRequest` carrying the dispute artifact + collected evidence bundle + the current `round`, signs under `motebit-jcs-ed25519-b64-v1`, and POSTs in parallel to every active peer with a per-request timeout (default 10 seconds). Leaders MAY pre-filter the enumeration by checking each peer's `identity.vote_policy_configured` (§2.4) to avoid wasted fan-out, but the responder-side 501 (gate 6 below) is the load-bearing enforcement.
4. **Each peer** runs the gate ladder in §16.2; on pass, calls its operator-configured vote callback, signs an `AdjudicatorVote` over `canonicalJson(body minus signature)` (which binds `dispute_id`, `round`, `peer_id`, and `vote` per §6.5 + §8.3), returns it.
5. **Leader** verifies each `AdjudicatorVote` signature against the responding peer's stored federation pubkey, persists the vote to its local `relay_dispute_votes` table (PK on `(dispute_id, round, peer_id)`), aggregates by majority outcome (ties → `split` per §6.4), and signs a `DisputeResolution` with the votes embedded in `adjudicator_votes[]`.
6. **Quorum failure** (valid vote count < 3 OR no majority by §6.6's 72h deadline): resolution = `split`, `split_ratio: 0.5`, `rationale: "federation quorum not met within 72h adjudication window"`. The leader does NOT synthesize per-peer votes for absent peers (timeout, 5xx, malformed, or sig-fail) — the §6.5 independent-review property is preserved by under-counting, not by fabrication.

The reference implementation (`services/relay/src/disputes.ts`) collapses per-peer fan-out timeout into the spec timeout — single sync `Promise.allSettled` window, no retries within 72h. Async retry-within-72h is a future arc; see `memory/section_6_2_orchestrator_async_deferral.md` for the trade-off.

### 16.2 — `POST /federation/v1/disputes/:disputeId/vote-request`

**Request body — `VoteRequest`:**

```text
VoteRequest {
  dispute_id:        string                 // The dispute being adjudicated; MUST equal :disputeId
  round:             number                 // 1 for original adjudication, 2 for §8.3 appeal. Signature-bound; cross-round replay is cryptographically rejected.
  dispute_request:   DisputeRequest         // Original signed dispute artifact (§4.2)
  evidence_bundle:   DisputeEvidence[]      // All evidence collected during the window (§5.2). For round=2, MUST carry the original round-1 evidence bundle plus any new evidence per §8.4.
  requester_id:      string                 // Leader relay's motebit_id; MUST be a known peer to the receiver
  requested_at:      number                 // Unix ms when the leader signed; used by gate 5 freshness check
  suite:             SuiteId                // "motebit-jcs-ed25519-b64-v1"
  signature:         string                 // Base64url Ed25519 by leader over canonicalJson(body minus signature). Signature binds dispute_id, round, requester_id, and the evidence bundle so request-tampering and cross-round replay both fail-closed.
}
```

**Response body — `AdjudicatorVote`** (defined in `spec/dispute-v1.md` §6.4):

```text
AdjudicatorVote {
  dispute_id:  string                       // MUST equal request.dispute_id
  round:       number                       // MUST equal request.round
  peer_id:     string                       // The signing peer's motebit identity
  vote:        "upheld" | "overturned" | "split"
  rationale:   string                       // Per-peer explanation
  suite:       SuiteId                      // "motebit-jcs-ed25519-b64-v1"
  signature:   string                       // Base64url Ed25519 by the voting peer over canonicalJson(body minus signature). The signature covers dispute_id, round, peer_id, and vote per §6.5 + §8.3 — votes are not portable across disputes, rounds, peers, or outcomes.
}
```

**Error response shape (all 4xx + 5xx responses on this route):**

```text
{
  error_code: string   // Stable machine-readable identifier; see gate ladder below
  message:    string   // Human-readable explanation; SHOULD NOT be relied on for control flow
}
```

The `error_code` is the canonical wire-format signal; `message` is operator-facing context. Leaders consuming this route MUST switch on `error_code`, not `message`, for any branching logic. (The rest of `relay-federation-v1` currently returns plain `{message}`; aligning §3–15 with the `{error_code, message}` shape is a follow-up arc.)

**Fail-closed gates** (peer-side, in order; each lists its HTTP status AND `error_code`):

1. **Schema validation** via `VoteRequestSchema` — malformed bodies → **400** `schema_invalid`.
2. **Known peer** — requester must be in `relay_peers` with `state IN ('active', 'suspended')` — unknown requester → **403** `unknown_peer`.
3. **Requester-id binding** — body's `requester_id` MUST match the resolved peer row — disagreement → **400** `requester_id_mismatch`. Stops a malicious peer from impersonating another relay's vote-request.
4. **Signature verify** — `signature` verifies under `motebit-jcs-ed25519-b64-v1` against `canonicalJson(body minus signature)` using the requester's federation pubkey — invalid → **403** `signature_invalid`.
5. **Freshness** — `now - requested_at <= FEDERATION_VOTE_REQUEST_MAX_AGE_MS` (default 60000ms, 60s). Stale or future-dated requests → **400** `request_stale`. Mirrors the heartbeat clock-drift check in §3 but tighter: vote-requests are short-lived and have no legitimate reason to delay >60s.
6. **Operator policy configured** — peer MUST have an operator vote callback wired (§2.4 `vote_policy_configured: true`). When no callback is configured → **501** `policy_not_configured`. **501 Not Implemented**, not 503: the missing callback is a deliberate operator-configuration gap, not a transient outage; retry-with-backoff is wasted effort. Leaders MAY pre-filter unconfigured peers via `identity.vote_policy_configured` to avoid the round-trip.

**Default vote callback semantics.** The peer's vote callback is operator-configurable at relay construction. There is **no built-in default callback that produces binding votes**: a relay deployed without operator-wired policy returns 501 on every vote-request. Operator-defined callbacks may forward to a human review queue, run an automated rule engine, or apply policy-based logic; the wire shape is unchanged.

**Peer-side simplification (v1).** The peer is a stateless responder — it does NOT persist its own vote in a peer-side `relay_dispute_votes` table. Only the leader persists. A peer asked "what did I vote on dispute Y three months ago?" cannot answer from its own state; the leader's stored vote (with the peer's signature) is the auditable record. Peer-side audit persistence is a future arc.

### 16.3 — Configuration

| Setting                              | Type   | Default | Description                                                                                                                                                                                 |
| ------------------------------------ | ------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `federation.vote_request_timeout_ms` | number | 10000   | Per-request timeout for outbound `/disputes/:disputeId/vote-request` calls. Per-request timeout IS the fan-out deadline (parallel `Promise.allSettled`); see §6.6 for the 72h spec timeout. |
| `FEDERATION_VOTE_REQUEST_MAX_AGE_MS` | number | 60000   | Peer-side gate-5 freshness window. Requests with `requested_at` older than this (or future-dated by more than this) → 400 `request_stale`.                                                  |

---

## Appendix A. Implementation Deviations

The reference implementation (`services/relay/`) deviates from this specification in the following ways. These are intentional design choices, not bugs. They are documented here so that independent implementors can interoperate correctly.

### A.1 — Authentication: JSON Body vs. Headers

**Spec (§10.2):** Requires `X-Relay-Id`, `X-Relay-Signature`, `X-Relay-Timestamp` headers on every federation request.

**Implementation:** Authenticating fields (`origin_relay`, `signature`, `timestamp`) are included in the JSON request body. The signature covers the canonical JSON of all body fields except `signature` itself. Functionally equivalent — the signed payload is the same canonical JSON either way — but the transport layer differs.

**Interop note:** An independent relay MUST accept both styles (header-based and body-based) to peer with the reference implementation.

### A.2 — Graph Augmentation

**Spec (§5.1):** Describes explicit relay-to-relay edges in the `WeightedDigraph<RouteWeight>` via an `augmentGraphWithFederatedAgents()` function.

**Implementation:** Federated candidates are fetched at query time via `fetchFederatedCandidates()` and merged into the ranking with a pre-computed `chain_trust = peerTrust × agentTrust`. This is algebraically equivalent to a single-hop product semiring computation but does not model relay nodes as explicit graph vertices.

**Consequence:** Multi-hop routing (relay A → relay B → relay C) uses chain_trust composition at each hop rather than a single graph traversal. Results are identical for the current 1-hop federation topology. Graph-based routing becomes necessary when multi-hop chains are common.

### A.3 — Configuration Settings Not Yet Enforced

**Spec (§12):** Defines 9 configuration settings including `federation.enabled`, `federation.max_peers`, `federation.auto_accept_peers`, and `federation.allowed_peers`.

**Implementation:** The following settings are not yet enforced:

| Setting                        | Status                                                                      |
| ------------------------------ | --------------------------------------------------------------------------- |
| `federation.enabled`           | Federation is always available when the relay starts. No toggle to disable. |
| `federation.max_peers`         | No upper bound on peer count.                                               |
| `federation.auto_accept_peers` | Peering always requires the bilateral handshake (propose → confirm).        |
| `federation.allowed_peers`     | No allowlist filtering. Any relay can propose peering.                      |

These are governance knobs for production deployments. The protocol mechanics (handshake, heartbeat, routing, settlement) are fully implemented regardless.

### A.4 — Version Compatibility Check

**Spec (§14):** Peering between relays with incompatible major versions MUST be rejected during the handshake.

**Implementation:** The `POST /federation/v1/peer/propose` endpoint accepts an optional `spec_version` field. When provided, the relay extracts the major version and rejects peering if the major versions differ (HTTP 403). The peer's protocol version is stored in the `peer_protocol_version` column of `relay_peers`. Pre-version peers (no `spec_version` in propose body) are accepted for backward compatibility.

---

_motebit/relay-federation@1.1 — Stable Specification, 2026._
