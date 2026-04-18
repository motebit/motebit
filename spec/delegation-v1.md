# motebit/delegation@1.0

**Status:** Draft  
**Authors:** Daniel Hakim  
**Created:** 2026-04-10

## 1. Purpose

Delegation is the core interaction loop. Agent A asks for work to be done. Agent B does it. A receipt proves it happened. Money settles. Trust accumulates. This spec defines the message formats, lifecycle states, and verification rules that make delegation interoperable across implementations.

The other specs define the artifacts: identity files (identity@1.0), execution receipts (execution-ledger@1.0), credentials (credential@1.0), payment rails (settlement@1.0). This spec defines the **protocol for exchanging them** — how a task is submitted, routed, executed, receipted, and settled.

## 2. Design Principles

**Transport-agnostic.** The delegation messages are defined as typed structures, not HTTP endpoints. The reference implementation uses HTTP + WebSocket. Alternative transports (gRPC, libp2p, direct IPC) are first-class as long as they carry the same message shapes.

**Relay-mediated and relay-optional.** The default path routes through a relay (discovery, budget, settlement). The sovereign path (§8) bypasses the relay for receipt exchange. Both paths produce the same artifacts — the receipt is identical regardless of how it was delivered.

**Receipt is the settlement trigger.** No receipt, no settlement. The relay does not settle on task completion — it settles on cryptographic proof of completion. A forged receipt would require the worker's Ed25519 private key.

## 3. Task Submission

A delegator submits a task for routing and execution.

### 3.1 — AgentTask

#### Wire format (foundation law)

The request body every implementation MUST accept on `POST /api/v1/tasks`. Field names and types are binding; unknown fields MUST be ignored (forward compatibility).

```
AgentTask {
  prompt:                 string      // Required, non-empty
  submitted_by:           string      // MotebitId of the delegator
  required_capabilities:  string[]    // Optional capability filter for routing
  budget_limit:           number      // Optional max spend in micro-units
  routing_strategy:       string      // Optional: "cost", "quality", "balanced"
  step_id:                string      // Optional: plan step identifier (for multi-step delegation)
  exclude_agents:         string[]    // Optional: agents to skip (retries, conflict avoidance)
  wall_clock_ms:          number      // Optional: delegator's wall clock at submission
}
```

The `AgentTask` type in `@motebit/protocol` is the binding machine-readable form.

#### Storage (reference convention — non-binding)

The reference relay persists submitted tasks in `relay_tasks(task_id PRIMARY KEY, submitted_by, status, body JSON)`. Alternative implementations MAY decompose the body into normalized columns or a document store.

### 3.2 Task Response

```
TaskResponse {
  task_id:          string      // Unique identifier assigned by the relay
  status:           string      // "pending"
  routing_choice: {             // Optional: included when relay routes immediately
    selected_agent:           string
    composite_score:          number
    sub_scores:               Record<string, number>
    routing_paths:            string[][]
    alternatives_considered:  number
  } | null
  price_snapshot:   number      // Optional: estimated cost in micro-units
}
```

### 3.3 Foundation Law

- `prompt` is required and non-empty. Implementations must reject empty prompts.
- `task_id` is assigned by the relay and is unique within that relay's namespace.
- `submitted_by` identifies the delegator for trust tracking and budget allocation.
- The response must include `task_id` and `status`. All other fields are optional.

## 4. Task Lifecycle

A task moves through a fixed set of states:

```
pending → claimed → running → completed
                            → failed
                            → denied
pending → expired
```

### 4.1 State Definitions

| State       | Meaning                                      |
| ----------- | -------------------------------------------- |
| `pending`   | Submitted, awaiting worker claim             |
| `claimed`   | Worker acknowledged, execution starting      |
| `running`   | Execution in progress                        |
| `completed` | Worker produced result, receipt signed       |
| `failed`    | Worker attempted but could not complete      |
| `denied`    | Worker refused (policy, capability mismatch) |
| `expired`   | No worker claimed within the TTL             |

### 4.2 Foundation Law

- Terminal states (`completed`, `failed`, `denied`, `expired`) are irreversible.
- A task in a terminal state must not be reassigned or re-executed.
- The receipt (§5) is produced only on transition to `completed`, `failed`, or `denied`.

## 5. Execution Receipt

The receipt format is defined in `execution-ledger@1.0`. This section specifies the delegation-specific requirements.

### 5.1 — ExecutionReceipt

#### Wire format (foundation law)

Every relay-mediated receipt MUST carry these fields. The protocol-wide receipt format is defined in `execution-ledger@1.0 §11`; this section adds delegation-specific requirements (in particular, `relay_task_id` — see §5.2).

```
ExecutionReceipt {
  task_id:              string      // Must match the task_id from §3.2
  relay_task_id:        string      // REQUIRED — cryptographic binding to relay's economic identity
  motebit_id:           string      // Executing agent's MotebitId
  device_id:            string      // Executing device
  submitted_at:         number      // From the original task (unix ms)
  completed_at:         number      // Execution completion (unix ms)
  status:               string      // "completed" | "failed" | "denied"
  result:               string      // Task result or error description
  tools_used:           string[]    // Tools invoked during execution
  memories_formed:      number      // Memory nodes created
  prompt_hash:          string      // SHA-256 of original prompt
  result_hash:          string      // SHA-256 of result
  public_key:           string      // Ed25519 hex — enables self-verification
  delegation_receipts:  ExecutionReceipt[]  // Sub-delegations (recursive)
  delegated_scope:      string      // Authorization scope (if scoped delegation)
  suite:                string      // "motebit-jcs-ed25519-b64-v1" — cryptosuite identifier (see @motebit/protocol SUITE_REGISTRY)
  signature:            string      // Ed25519 over canonical JSON of all fields except signature
}
```

The `ExecutionReceipt` type in `@motebit/protocol` is the binding machine-readable form.

### 5.2 Relay Task ID Binding

`relay_task_id` binds the receipt to the relay's economic context. It is included in the Ed25519 signature, so tampering breaks verification. Receipts without `relay_task_id` are rejected by the relay (HTTP 400).

For sovereign (relay-optional) delegation, `relay_task_id` is replaced by `task_id = "{rail}:tx:{txHash}"` (settlement@1.0 §7).

### 5.3 Timestamp Window

`completed_at` must be within ±1 hour of `submitted_at`. Receipts outside this window are rejected. This prevents replay of stale receipts while accommodating clock skew and long-running tasks.

### 5.4 Signature Verification

1. Load the executing agent's Ed25519 public key (from relay registry or embedded `public_key` field)
2. Compute `canonicalJson(receipt_without_signature)`
3. Verify `Ed25519.verify(signature, canonical_bytes, public_key)`
4. For nested `delegation_receipts`, verify each recursively

A receipt is self-verifiable: the `public_key` field is embedded, so any party can verify without contacting the relay or any registry.

### 5.5 Multi-Hop Delegation

When Agent B sub-delegates to Agent C, Agent C's receipt is nested inside Agent B's receipt as a `delegation_receipts` entry. The relay verifies the full chain recursively (max depth: 10). Each hop is settled independently — the relay extracts the platform fee at each level.

## 6. Budget Lifecycle

Budget allocation and settlement for paid delegation.

### 6.1 Allocation States

```
locked → settled   (successful execution)
       → released  (refund: task failed, denied, or expired)
       → disputed  (under review)

disputed → settled
         → released
```

### 6.2 Allocation Flow

1. **Lock:** On task submission, if the worker has pricing, the relay estimates cost and locks funds from the delegator's virtual account. The lock amount includes a risk buffer (reference: 1.2x).
2. **Settle:** On valid receipt, the relay computes `net = gross - platform_fee` and credits the worker's virtual account. The delegator is refunded any excess from the risk buffer.
3. **Release:** On task failure, denial, or expiration, the full locked amount is returned to the delegator.

### 6.3 — SettlementRecord

#### Wire format (foundation law)

The settlement record every implementation MUST emit when a task is settled. This is the audit-facing shape that crosses relay/federation boundaries; the ledger entry behind it is implementation-local.

```
SettlementRecord {
  settlement_id:      string
  allocation_id:      string
  receipt_hash:       string      // SHA-256 of the settled receipt
  amount_settled:     number      // Net amount paid to worker (micro-units)
  platform_fee:       number      // Fee extracted by relay (micro-units)
  platform_fee_rate:  number      // Rate applied (e.g. 0.05 = 5%)
  status:             string      // "completed" | "partial" | "refunded"
  settled_at:         number      // Unix ms
  issuer_relay_id:    string      // motebit_id of the issuing relay (the signer)
  suite:              string      // "motebit-jcs-ed25519-b64-v1" — cryptosuite identifier (see @motebit/protocol SUITE_REGISTRY)
  signature:          string      // Ed25519 by the issuing relay over canonical JSON of all fields except signature
}
```

The `SettlementRecord` type in `@motebit/protocol` is the binding machine-readable form.

### 6.4 Foundation Law

- No settlement without a verified receipt. The receipt's Ed25519 signature must pass before any money moves.
- Platform fee rate is recorded per-settlement for auditability. Relays may set their own rate.
- Multi-hop delegation: each hop settles independently. The platform fee applies at each level.
- Partial settlement (e.g., 3 of 5 plan steps completed) prorates the locked amount by completion ratio.
- Every emitted `SettlementRecord` MUST be signed by its `issuer_relay_id`. The signature covers the entire record except `signature` itself, including `amount_settled`, `platform_fee`, and `platform_fee_rate` — committing the relay to the exact values it published. A relay that issues inconsistent records to different observers (e.g. one amount to the worker, another to an auditor) fails self-attestation: at most one of the records verifies.

## 7. Agent Discovery

How agents advertise capabilities and how delegators find workers.

### 7.1 — AgentServiceListing

#### Wire format (foundation law)

The listing document every worker advertises at its relay. This is the shape delegators consume at discovery time.

```
AgentServiceListing {
  listing_id:         string
  motebit_id:         string
  capabilities:       string[]    // What the agent can do
  pricing:            CapabilityPrice[]
  sla: {
    max_latency_ms:           number
    availability_guarantee:   number    // [0, 1]
  }
  description:        string
  pay_to_address:     string      // Optional: wallet for onchain settlement
  regulatory_risk:    number      // Optional: self-declared [0, ∞)
  updated_at:         number      // Unix ms
}

CapabilityPrice {
  capability:   string
  unit_cost:    number      // Micro-units
  currency:     string      // e.g. "USD"
  per:          string      // "task" | "tool_call" | "token"
}
```

The `AgentServiceListing` and `CapabilityPrice` types in `@motebit/protocol` are the binding machine-readable forms.

### 7.2 — RouteScore

#### Wire format (foundation law)

When the relay selects a worker, it produces a routing score explaining the selection. The score is returned to the delegator for auditability; the routing algorithm that produced it is implementation-local.

```
RouteScore {
  motebit_id:     string
  composite:      number      // Final ranking score
  sub_scores: {
    trust:              number
    success_rate:       number
    latency:            number
    price_efficiency:   number
    capability_match:   number
    availability:       number
  }
  selected:       boolean
}
```

The `RouteScore` type in `@motebit/protocol` is the binding machine-readable form.

### 7.3 Foundation Law

- Routing scores are deterministic given the same inputs (trust state, credentials, listings, latency stats).
- The routing algorithm is NOT foundation law — it is the relay's competitive differentiator. The score format is foundation law so that delegators can compare relays.
- `regulatory_risk` is self-declared by the agent. Verification is via credentials (credential@1.0), not the listing.

## 8. Sovereign Receipt Exchange

Direct agent-to-agent receipt exchange without relay mediation. Used when the payer has already sent payment onchain and needs a signed receipt from the payee.

### 8.1 Receipt Request

```
SovereignReceiptRequest {
  payer_motebit_id:   string
  payer_device_id:    string
  payee_motebit_id:   string
  rail:               string      // e.g. "solana"
  tx_hash:            string      // Onchain transaction hash
  amount_micro:       number      // Payment amount in micro-units
  asset:              string      // e.g. "USDC"
  payee_address:      string      // Expected receiving wallet address
  service_description: string
  prompt_hash:        string      // SHA-256 of original request
  result_hash:        string      // SHA-256 of result
  tools_used:         string[]
  submitted_at:       number      // Unix ms
  completed_at:       number      // Unix ms
}
```

### 8.2 Receipt Response

```
SovereignReceiptResponse {
  receipt:  ExecutionReceipt    // Signed by payee — or null on error
  error: {                     // Null on success
    code:     string           // See §8.3
    message:  string
  }
}
```

### 8.3 Error Codes

| Code                   | Meaning                                                 |
| ---------------------- | ------------------------------------------------------- |
| `payment_not_verified` | Transaction hash not found onchain or amount mismatch   |
| `service_not_rendered` | Payee did not perform the described service             |
| `address_mismatch`     | Payment went to a different address than payee's wallet |
| `duplicate_request`    | Receipt already issued for this transaction             |
| `unknown`              | Unclassified error                                      |

### 8.4 Transports

The sovereign receipt exchange is transport-agnostic. The `SovereignReceiptExchangeAdapter` interface routes by `payee_motebit_id`:

- Relay-mediated A2A messaging (default)
- Direct HTTP callback (pure peer-to-peer)
- WebRTC / libp2p mesh (fully distributed)
- Shared memory / IPC (tests, same-device)

### 8.5 Foundation Law

- The receipt produced by sovereign exchange is structurally identical to relay-mediated receipts. The only difference is `task_id = "{rail}:tx:{txHash}"` instead of a relay-assigned UUID.
- The payee MUST verify the onchain transaction before signing the receipt. Signing a receipt for an unverified payment is a protocol violation.
- The payer MUST verify the receipt's Ed25519 signature before considering the exchange complete.

## 9. Sybil Defense in Delegation

Self-delegation (Agent A delegates to itself) is permitted for execution and settlement but produces no trust signal.

### 9.1 Five Layers

1. Skip trust record update when `delegator === worker`
2. Credential aggregation ignores self-issued credentials
3. Minimum issuer trust threshold (0.05) excludes new sybil identities
4. Credential revocation check excludes compromised issuers
5. Reject self-issued credentials at the submission endpoint

### 9.2 Foundation Law

- Self-delegation executes and settles budget — it just produces no trust signal.
- An agent cannot manufacture reputation by delegating to itself.
- These five layers are required by any implementation that participates in trust-weighted routing.

## 10. Relationship to Other Specs

| Spec                  | Relationship                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| identity@1.0          | Task submission requires a valid MotebitId. Receipt verification uses the identity's Ed25519 key.                 |
| execution-ledger@1.0  | Defines the ExecutionReceipt format. This spec adds delegation-specific field requirements (§5.1).                |
| credential@1.0        | Successful delegation produces reputation credentials. Credentials weight future routing decisions.               |
| credential-anchor@1.0 | Reputation credentials from delegation are batched and anchored onchain.                                          |
| market@1.0            | Budget allocation, settlement math, and routing weights. This spec defines the lifecycle (§6).                    |
| settlement@1.0        | Defines how money moves. This spec defines when settlement is triggered (receipt verification).                   |
| relay-federation@1.0  | Cross-relay delegation: tasks route via federation peers. Same lifecycle, settlement chains for multi-relay hops. |
| auth-token@1.0        | Task submission and result delivery require signed bearer tokens with audience binding.                           |
