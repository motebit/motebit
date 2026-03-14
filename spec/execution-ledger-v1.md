# motebit/execution-ledger@1.0

## Execution Ledger Specification

**Status:** Stable
**Version:** 1.0
**Date:** 2026-03-12

---

## 1. Overview

An execution ledger is a JSON document that records the complete execution timeline of a goal. It is cryptographically signed by the executing agent's Ed25519 keypair. Any party can verify the ledger's authenticity and completeness without trusting the agent.

The ledger proves which tools were called, what delegations occurred, what the outcomes were, and in what order. It does not reveal tool arguments or result content — only structural facts about execution.

**Design principles:**

- **Replayable.** The timeline is an ordered sequence of typed events. A verifier can reconstruct the execution flow.
- **Privacy-preserving.** Tool arguments are hashed, not included. Results record success/failure and duration, not content.
- **Composable.** Delegated steps produce their own ledgers. The parent ledger references them by content hash, forming a verifiable chain.
- **Self-contained.** The content hash, signature, and timeline are all in one document. Verification requires only the agent's public key.

---

## 2. Document Structure

A ledger is a JSON object with the following top-level fields:

| Field                 | Type                       | Required | Description                                                                                                                                                                     |
| --------------------- | -------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spec`                | string                     | yes      | MUST be `"motebit/execution-ledger@1.0"` for this version.                                                                                                                      |
| `motebit_id`          | string                     | yes      | The agent that executed the goal.                                                                                                                                               |
| `goal_id`             | string                     | yes      | The goal that was executed.                                                                                                                                                     |
| `plan_id`             | string                     | yes      | The plan used for execution.                                                                                                                                                    |
| `started_at`          | number                     | yes      | Epoch milliseconds when execution began.                                                                                                                                        |
| `completed_at`        | number                     | yes      | Epoch milliseconds when execution ended.                                                                                                                                        |
| `status`              | string                     | yes      | One of: `"completed"`, `"failed"`, `"paused"`, `"active"`.                                                                                                                      |
| `timeline`            | ExecutionTimelineEntry[]   | yes      | Ordered sequence of execution events (§3).                                                                                                                                      |
| `steps`               | StepSummary[]              | yes      | Per-step summaries (§4).                                                                                                                                                        |
| `delegation_receipts` | DelegationReceiptSummary[] | yes      | Receipt metadata from delegated steps (§4.1). MAY be empty.                                                                                                                     |
| `content_hash`        | string                     | yes      | SHA-256 hex digest of canonical timeline bytes (§5).                                                                                                                            |
| `signature`           | string                     | no       | Base64url Ed25519 signature of the content hash bytes (§6). Required for signed ledgers, omitted for relay-reconstructed ledgers (relay does not hold the agent's private key). |

---

## 3. Timeline Entry Types

Each timeline entry is a JSON object with three fields:

| Field       | Type   | Description                                 |
| ----------- | ------ | ------------------------------------------- |
| `timestamp` | number | Epoch milliseconds when the event occurred. |
| `type`      | string | Event type identifier (see below).          |
| `payload`   | object | Type-specific data.                         |

Entries MUST be ordered by `timestamp` (ascending). Entries with equal timestamps MUST preserve insertion order.

### 3.1 — Event Types

| Type             | Payload Fields                                     | Description                                                                                          |
| ---------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `goal_started`   | `goal_id`                                          | Goal execution begins.                                                                               |
| `plan_created`   | `plan_id`, `title`, `total_steps`                  | Plan was generated for the goal.                                                                     |
| `step_started`   | `plan_id`, `step_id`, `ordinal`, `description`     | A plan step begins execution.                                                                        |
| `tool_invoked`   | `tool`, `args_hash`, `call_id`                     | A tool was called. `args_hash` is SHA-256 hex of canonical JSON args. `call_id` links to tool audit. |
| `tool_result`    | `tool`, `ok`, `duration_ms`, `call_id`             | Tool returned. `ok` is boolean.                                                                      |
| `step_completed` | `plan_id`, `step_id`, `ordinal`, `tool_calls_made` | Step finished successfully.                                                                          |
| `step_failed`    | `plan_id`, `step_id`, `ordinal`, `error`           | Step finished with an error.                                                                         |
| `step_delegated` | `plan_id`, `step_id`, `ordinal`, `task_id`         | Step was delegated to another agent.                                                                 |
| `plan_completed` | `plan_id`                                          | All steps completed.                                                                                 |
| `plan_failed`    | `plan_id`, `reason`                                | Plan execution failed.                                                                               |
| `goal_completed` | `goal_id`, `status`                                | Goal execution ended.                                                                                |

All payload field values are strings unless otherwise noted. `ok` is boolean. `total_steps`, `ordinal`, `tool_calls_made`, and `duration_ms` are numbers.

---

## 4. Step Summary

The `steps` array contains one entry per plan step. Each entry is a JSON object:

| Field          | Type     | Required | Description                                       |
| -------------- | -------- | -------- | ------------------------------------------------- |
| `step_id`      | string   | yes      | Unique step identifier.                           |
| `ordinal`      | number   | yes      | Step position in the plan (0-indexed).            |
| `description`  | string   | yes      | Human-readable step description.                  |
| `status`       | string   | yes      | One of: `"completed"`, `"failed"`, `"delegated"`. |
| `tools_used`   | string[] | yes      | Distinct tool names invoked during this step.     |
| `tool_calls`   | number   | yes      | Total number of tool invocations in this step.    |
| `started_at`   | number   | yes      | Epoch milliseconds.                               |
| `completed_at` | number   | yes      | Epoch milliseconds.                               |
| `delegation`   | object   | no       | Present only for delegated steps. See §4.1.       |

### 4.1 — Delegation Field

When a step is delegated, the `delegation` object contains:

| Field            | Type   | Required | Description                                                         |
| ---------------- | ------ | -------- | ------------------------------------------------------------------- |
| `task_id`        | string | yes      | The task identifier sent to the delegated agent.                    |
| `receipt_hash`   | string | no       | The delegated agent's Ed25519 receipt signature (base64url). |
| `routing_choice` | object | no       | Routing provenance from scored delegation. See §4.1.1.              |

#### 4.1.1 — Routing Choice

The `routing_choice` field is present when the relay performed scored routing and returned provenance data. It records which agent was selected, the composite score that justified the selection, and the algebraic derivation paths from the semiring computation graph.

**Purpose:** Regulatory compliance audit trail. The routing choice proves the delegation decision was justified given the trust, cost, and capability state at delegation time. Because `routing_choice` is included in the step summary before the manifest's `content_hash` is computed and Ed25519-signed (§5, §6), it cannot be fabricated or altered post-hoc.

| Field                     | Type       | Description                                                                                   |
| ------------------------- | ---------- | --------------------------------------------------------------------------------------------- |
| `selected_agent`          | string     | MotebitId of the agent that was chosen for delegation.                                        |
| `composite_score`         | number     | Weighted composite score (0–1) combining all sub-scores.                                      |
| `sub_scores`              | object     | Individual scoring dimensions (see below).                                                    |
| `routing_paths`           | string[][] | Derivation paths from the semiring algebra — each path is an ordered list of node MotebitIds. |
| `alternatives_considered` | number     | Total number of candidate agents that were scored before selection.                           |

**Sub-scores object:**

| Field              | Type   | Description                                       |
| ------------------ | ------ | ------------------------------------------------- |
| `trust`            | number | Trust score from the semiring trust computation.  |
| `success_rate`     | number | Historical task success rate for the agent.       |
| `latency`          | number | Latency score (lower latency → higher score).     |
| `price_efficiency` | number | Cost efficiency relative to alternatives.         |
| `capability_match` | number | How well the agent's capabilities match the task. |
| `availability`     | number | Agent availability at routing time.               |

All sub-score values are numbers in the range 0–1.

### 4.2 — Delegation Receipt Summary

The top-level `delegation_receipts` array contains metadata for each delegated task. Full signed receipts are edge artifacts held by the delegating agent or relay — the ledger includes summaries for audit linkage.

| Field              | Type     | Description                                             |
| ------------------ | -------- | ------------------------------------------------------- |
| `task_id`          | string   | The task identifier.                                    |
| `motebit_id`       | string   | The delegated agent's motebit_id.                       |
| `device_id`        | string   | The device that executed the task.                      |
| `status`           | string   | Task outcome: `"completed"`, `"failed"`, `"denied"`.    |
| `completed_at`     | number   | Epoch milliseconds when the task completed.             |
| `tools_used`       | string[] | Tools the delegated agent invoked.                      |
| `signature_prefix` | string   | First 16 characters of the receipt's Ed25519 signature. |

---

## 5. Canonical Serialization

The `content_hash` is computed over a canonical serialization of the timeline:

1. Take the `timeline` array.
2. For each entry, serialize as canonical JSON: keys sorted lexicographically, no whitespace (no spaces after `:` or `,`).
3. Join the serialized entries with `\n` (U+000A).
4. Compute SHA-256 over the resulting UTF-8 bytes.
5. Encode the 32-byte digest as lowercase hexadecimal (64 characters).

This is the same deterministic serialization used in execution receipts. The canonical JSON of each entry includes all three fields (`payload`, `timestamp`, `type`) — keys sorted, nested objects also sorted.

**Example canonical entry:**

```
{"payload":{"goal_id":"goal-01","prompt":"Search for flights"},"timestamp":1710288000000,"type":"goal_started"}
```

---

## 6. Signing Algorithm

The signature is computed as follows:

1. Compute `content_hash` per §5.
2. Decode `content_hash` from hex to a 32-byte value.
3. Compute `signature = Ed25519_Sign(content_hash_bytes, private_key)` where `private_key` is the agent's Ed25519 private key corresponding to the public key registered in the agent's identity.
4. Encode the 64-byte signature as base64url (RFC 4648 §5, no padding).

The signature is over the raw 32-byte hash, not the 64-character hex string.

**Note:** The `signature` field is REQUIRED for device-produced ledgers (the agent signs with its private key). It is OPTIONAL for relay-reconstructed ledgers — relays reconstruct the timeline from synced events but do not hold the agent's private key. Unsigned ledgers can still be verified for content integrity (§7 steps 1-4) but not for authenticity (§7 steps 5-7).

---

## 7. Verification Algorithm

To verify an execution ledger:

```
function verify(ledger: object, public_key: bytes[32]) -> { valid: bool }

  1. Verify ledger.spec === "motebit/execution-ledger@1.0".
     If not, return { valid: false }.

  2. Verify ledger.timeline is an array with at least one entry.
     If not, return { valid: false }.

  3. Reconstruct content_hash from ledger.timeline using §5.

  4. If reconstructed hash !== ledger.content_hash,
     return { valid: false }.

  5. Decode ledger.signature from base64url to a 64-byte value.
     If decoding fails or length != 64, return { valid: false }.

  6. Decode ledger.content_hash from hex to a 32-byte value.
     If decoding fails or length != 32, return { valid: false }.

  7. Let valid = Ed25519_Verify(signature, content_hash_bytes, public_key).

  8. Return { valid }.
```

### 7.1 — Delegation Verification

For each entry in `delegation_receipts`, the verifier SHOULD:

1. Obtain the delegated agent's public key (from identity file or trust store).
2. Verify the delegated ledger using the same algorithm.
3. Verify the delegated ledger's `content_hash` matches the `receipt_hash` in the parent step summary.

Delegation verification is recursive. A ledger is fully verified when all nested delegations are also verified.

---

## 8. Privacy Considerations

- **Tool arguments are hashed.** The `args_hash` field records the SHA-256 of canonical JSON arguments. This allows a party who knows the original arguments to verify they match, without exposing arguments to parties who do not.
- **Result content is excluded.** Only `ok` (boolean) and `duration_ms` are recorded. The ledger proves _what happened_, not _what was said_.
- **Prompts are excluded.** The `goal_started` event records the `goal_id` but not the prompt text. Goal prompts may contain sensitive user instructions; they are available through the goal store, not the ledger.

---

## 9. Delegation Chain

When a step is delegated to another agent, the delegated agent produces its own execution receipt signed with its own keypair. The parent ledger records the delegation in three places:

1. **Timeline:** A `step_delegated` event with the `task_id` and `ordinal`.
2. **Step summary:** The `delegation.receipt_hash` field contains the delegated agent's Ed25519 receipt signature (linkage to the full receipt held by the relay or delegating agent).
3. **Delegation receipts:** The `delegation_receipts` array includes a `DelegationReceiptSummary` (§4.2) with task_id, motebit_id, device_id, status, tools_used, and signature_prefix. Full signed receipts are edge artifacts — the delegating agent or relay retains them for full verification.

This creates a verifiable chain: the parent ledger references delegated execution by receipt metadata, and the full receipt can be retrieved from the relay for independent signature verification.

---

## 10. Security Considerations

### 10.1 — Ordering Guarantees

Timestamps are agent-reported and not externally attested. A malicious agent can fabricate timestamps. The ledger guarantees the agent _claims_ events occurred in this order — it does not guarantee the timestamps are accurate. Applications requiring trusted timestamps SHOULD use an external timestamping authority.

### 10.2 — Completeness

The ledger proves that the recorded events are authentic (signed by the agent) and unmodified (hash-verified). It does NOT prove the record is complete — an agent could omit events before signing. Completeness is a trust property, not a cryptographic one.

### 10.3 — Argument Privacy

The `args_hash` construction is one-way under SHA-256. However, tool arguments with low entropy (e.g., boolean flags, small enumerations) may be brute-forceable. Implementations SHOULD be aware of this when recording arguments to sensitive tools.

### 10.4 — Threat Model

| Threat                    | Mitigation                                                              | Residual Risk                         |
| ------------------------- | ----------------------------------------------------------------------- | ------------------------------------- |
| **Timeline tampering**    | SHA-256 content hash + Ed25519 signature; any edit invalidates          | None — cryptographic guarantee        |
| **Event omission**        | Not mitigated cryptographically                                         | Trust in agent required               |
| **Timestamp fabrication** | Not mitigated; timestamps are self-reported                             | External timestamping if needed       |
| **Delegation forgery**    | Each delegated ledger is independently signed by the delegated agent    | Delegated agent's key must be trusted |
| **Argument recovery**     | Arguments hashed, not included                                          | Low-entropy args may be brute-forced  |
| **Replay**                | `goal_id` + `started_at` provide uniqueness; applications define policy | Verifier must enforce uniqueness      |

---

## 11. Versioning

The `spec` field declares which version of this specification the ledger conforms to. Implementations SHOULD reject ledgers with unrecognized spec versions rather than attempting best-effort parsing.

Future versions will use semantic versioning: `motebit/execution-ledger@{major}.{minor}`. Minor versions add optional fields and are backward-compatible. Major versions may change required fields, timeline event types, or signature mechanics and are not backward-compatible.

---

_motebit/execution-ledger@1.0 — Stable Specification, 2026._
