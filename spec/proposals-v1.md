# motebit/proposals@1.0

**Status:** Draft
**Version:** 1.0
**Date:** 2026-04-24

---

## 1. Overview

A motebit can ask other motebits to share a plan: "I propose plan X with these step assignments — accept, reject, or counter." The negotiation that produces an agreed-upon plan is the **proposal protocol**. The plan that results runs through `plan-lifecycle-v1.md` — proposals are pre-execution; plan-lifecycle is execution. The two specs cross-reference via `plan_id`.

This specification pins the **wire format** of every proposal-protocol message so a sibling implementation negotiates against the same shapes. Without the pin, a non-TypeScript proposer that sends `assigned_steps` as `[1, 2]` to a relay that expects `[{ id: 1 }, { id: 2 }]` silently breaks the negotiation at the field-shape boundary.

**Design principles:**

- **Negotiation is a request/response handshake, not an event log.** Unlike memory-delta or plan-lifecycle, a proposal is not an append-only event sequence — it has a synchronous lifecycle (`pending → accepted | rejected | countered | withdrawn`) with explicit responder participation. The shape is closer to delegation-v1 §3 (task submission) than to memory-delta (event payloads).
- **Bound to a plan, not a free agreement.** Every proposal carries a `plan_id` that references the plan to be executed. The proposal's job is to nail down _who does which step_; the plan's existence and step structure are inputs, not outputs, of the negotiation.
- **All-or-nothing acceptance.** A proposal becomes `accepted` only when every named participant accepts. Any reject collapses the proposal to `rejected`. Counter responses pause the negotiation pending re-proposal — this spec does not pin the counter-loop semantics; v1.1 may.
- **Initiator-controlled withdrawal.** The proposer can withdraw a `pending` proposal at any time. Once a participant has responded, withdrawal still ends the proposal but the response is preserved in the audit trail.
- **Step-result reporting is collaborative-execution audit.** When a proposal is accepted and the named plan runs, each participant reports per-step results back to the relay so every counterparty sees progress without polling each other directly. Step-result events do not belong to plan-lifecycle (which records the plan's view of execution); they belong here because they're the negotiation's view of who did what under the agreement.

---

## 2. Scope and Non-Scope

**In scope:**

- The foundation law every proposal-protocol implementation must satisfy (§3).
- The proposal lifecycle states + transitions (§4).
- Wire format of every proposal-protocol message (§5).
- The relay routes carrying these messages (§6).
- Conformance requirements (§7).

**Out of scope:**

- Plan structure — `plan_id` is a reference to a plan whose shape is governed by `plan-lifecycle-v1.md`. The proposal carries an opaque `plan_snapshot` for participants to read, but does not pin its shape.
- Plan execution events — `plan_step_started`, `plan_step_completed`, etc. (See `plan-lifecycle-v1.md`.)
- Counter-proposal loop semantics — when a participant responds with `counter` and a proposed counter-step set, what the proposer does next is implementation-defined in v1. v1.1 may pin a counter-loop spec.
- Settlement / payment for collaborative-step results — the `receipt` carried in `step-result` is opaque to this spec. If it's an `ExecutionReceipt`, the consumer verifies it against `execution-ledger-v1.md`.
- Trust effects of accepting / rejecting / countering proposals. Trust attribution is governed by `credential-v1.md` and `delegation-v1.md` §9.
- Real-time delivery — the reference relay broadcasts proposal events to connected WebSocket peers, but conformance does not require WebSocket; pull-mode polling against §6.4 is equally conformant.

---

## 3. Foundation Law

### §3.1 Proposer-binding invariant

A proposal carries an `initiator_motebit_id`. The initiator is the only motebit authorized to withdraw the proposal (§5.5). A relay MUST reject a withdraw call from any other caller with HTTP 403.

### §3.2 Participant-binding invariant

A response (§5.3) is bound to the responding motebit's identity. A relay MUST reject a response from a `responder_motebit_id` not named in the proposal's `participants` array.

### §3.3 Terminal-state invariant

Once a proposal reaches a terminal state (`accepted | rejected | countered | withdrawn`), it MUST NOT transition. New responses from straggler participants MUST be accepted-and-stored for audit but MUST NOT change the proposal's status.

### §3.4 Acceptance-completeness invariant

A proposal transitions to `accepted` if and only if every participant in the `participants` array has responded with `accept`. Partial acceptance is `pending` (still awaiting responses) or `rejected` / `countered` (some participant said no).

### §3.5 Expiry invariant

Every proposal has an `expires_at`. After `expires_at`, the proposal MUST be treated as terminal-no-decision: relays MUST reject new responses with HTTP 410 (Gone) and MUST NOT change the proposal's status away from `pending`. Implementations MAY record an explicit `expired` state for audit; the wire-visible status remains `pending` until that point.

---

## 4. Lifecycle

```
pending → accepted     (every participant accepted)
        → rejected     (any participant rejected)
        → countered    (any participant countered AND every participant has responded)
        → withdrawn    (initiator withdrew while pending)

pending → expired      (after expires_at, no decision was reached)
```

Terminal states are irreversible. Implementations MAY rebuild the lifecycle state from the participant response set; the response set is the canonical input.

### 4.1 — ProposalStatus

The lifecycle state of a proposal is one of six values. Every wire message that carries `status` (§5.2 ProposalState, §5.4 ProposalListResult) uses one of these strings; no other values are valid.

#### Wire format (foundation law)

```
ProposalStatus = "pending" | "accepted" | "rejected" | "countered" | "withdrawn" | "expired"
```

The `ProposalStatus` enum in `@motebit/protocol` is the binding machine-readable form. `expired` is implementation-derived: emitters MAY return `pending` past `expires_at` (the wire status doesn't auto-advance) but MUST reject new responses. Persisting `expired` is implementation-defined.

### 4.2 — ProposalResponseType

The set of response values a participant may submit (§5.3 ProposalResponse). No other values are valid.

#### Wire format (foundation law)

```
ProposalResponseType = "accept" | "reject" | "counter"
```

The `ProposalResponseType` enum in `@motebit/protocol` is the binding machine-readable form.

---

## 5. Wire Format

Every payload is canonical JSON. Timestamps are Unix milliseconds.

### 5.1 — ProposalSubmission

The body of `POST /api/v1/proposals` (§6.1).

**Wire shape.**

```
ProposalSubmission {
  proposal_id:           string                          // ULID/UUID; unique within the relay
  plan_id:               string                          // References the plan the proposal commits to
  initiator_motebit_id:  string                          // Optional when caller identity is bound by signed token; required otherwise
  participants:          ProposalParticipantAssignment[] // Non-empty; the motebits being asked to commit
  plan_snapshot:         unknown                         // Optional; opaque snapshot of the plan as seen by the initiator
  expires_in_ms:         number                          // Optional; defaults to 600_000 (10 minutes)
}

ProposalParticipantAssignment {
  motebit_id:      string
  assigned_steps:  number[]      // Indices into the plan's step list
}
```

The relay's response on success is `201 Created`:

```
ProposalSubmissionResponse {
  proposal_id:  string
  status:       "pending"
  expires_at:   number
}
```

### 5.2 — ProposalState

The body of `GET /api/v1/proposals/:proposalId` (§6.3).

**Wire shape.**

```
ProposalState {
  proposal_id:           string
  plan_id:               string
  initiator_motebit_id:  string
  status:                "pending" | "accepted" | "rejected" | "countered" | "withdrawn"
  plan_snapshot:         unknown | null
  created_at:            number
  expires_at:            number
  updated_at:            number
  participants:          ProposalParticipantState[]
}

ProposalParticipantState {
  motebit_id:      string
  assigned_steps:  number[]
  response:        "accept" | "reject" | "counter" | null    // null while awaiting
  responded_at:    number | null
  counter_steps:   number[] | null                            // Set only when response === "counter"
}
```

### 5.3 — ProposalResponse

The body of `POST /api/v1/proposals/:proposalId/respond` (§6.2).

**Wire shape.**

```
ProposalResponse {
  responder_motebit_id:  string                    // Optional when caller identity is bound by signed token; required otherwise
  response:              "accept" | "reject" | "counter"
  counter_steps:         number[]                  // Required when response === "counter"; optional otherwise
  signature:             string                    // Optional Ed25519 hex; cryptographic non-repudiation. Implementations SHOULD include.
}
```

The relay's response on success is `200 OK`:

```
ProposalResponseAck {
  status:         "pending" | "accepted" | "rejected" | "countered"
  all_responded:  boolean
}
```

### 5.4 — ProposalListResult

The body of `GET /api/v1/proposals?status=<state>&limit=<n>&motebit_id=<id>` (§6.4).

**Wire shape.**

```
ProposalListResult {
  proposals: ProposalSummary[]
}

ProposalSummary {
  proposal_id:           string
  plan_id:               string
  initiator_motebit_id:  string
  status:                "pending" | "accepted" | "rejected" | "countered" | "withdrawn"
  created_at:            number
  expires_at:            number
  updated_at:            number
}
```

### 5.5 — ProposalWithdrawal

The body of `POST /api/v1/proposals/:proposalId/withdraw` (§6.5) is empty. The caller's identity (from signed bearer token) is the withdrawal authorization. Per §3.1, only the `initiator_motebit_id` may withdraw.

The relay's response on success is `200 OK`:

```
ProposalWithdrawalResponse {
  status: "withdrawn"
}
```

### 5.6 — CollaborativeStepResult

The body of `POST /api/v1/proposals/:proposalId/step-result` (§6.6). Reported by a participant after executing a step it was assigned to under an `accepted` proposal.

**Wire shape.**

```
CollaborativeStepResult {
  step_id:         string                       // From the underlying plan
  motebit_id:      string                       // Optional when caller identity is bound by signed token; required otherwise
  status:          "completed" | "failed"       // Implementations MAY allow additional values; "completed" / "failed" are foundation
  result_summary:  string                       // Optional human-readable summary
  receipt:         unknown                      // Optional; SHOULD be an ExecutionReceipt (execution-ledger-v1 §11) when the step produced one
}
```

The relay's response on success is `200 OK`:

```
CollaborativeStepResultAck {
  status: "recorded"
}
```

---

## 6. Relay Routes

#### Routes (foundation law)

The six routes below are the binding cross-implementation contract for the proposal protocol. Renaming or relocating any of them is a wire break.

- `POST /api/v1/proposals` — submit a new `ProposalSubmission` (§5.1).
- `GET /api/v1/proposals` — list proposals scoped to the caller's identity (initiated or participating) — `ProposalListResult` (§5.4).
- `GET /api/v1/proposals/:proposalId` — read full `ProposalState` (§5.2).
- `POST /api/v1/proposals/:proposalId/respond` — submit a `ProposalResponse` (§5.3).
- `POST /api/v1/proposals/:proposalId/withdraw` — initiator withdraws (§5.5).
- `POST /api/v1/proposals/:proposalId/step-result` — participant reports a `CollaborativeStepResult` (§5.6) under an accepted proposal.

### 6.1 Submission

`POST /api/v1/proposals` accepts a `ProposalSubmission` (§5.1). The relay:

1. Persists the proposal and the participant assignment rows.
2. Notifies each named participant via implementation-defined transport (the reference relay uses WebSocket if the participant is connected).
3. Returns `ProposalSubmissionResponse` with HTTP 201.

### 6.2 Response

`POST /api/v1/proposals/:proposalId/respond` accepts a `ProposalResponse` (§5.3). The relay:

1. Verifies §3.2 (responder is in `participants`).
2. Verifies the proposal is `pending` and not past `expires_at`.
3. Records the response.
4. Recomputes status per §3.4 / lifecycle (§4).
5. Notifies the initiator. If the proposal transitions to `accepted`, notifies all participants.

### 6.3 Read

`GET /api/v1/proposals/:proposalId` returns `ProposalState` (§5.2). Relays MAY scope-check the caller (only initiator + named participants) or expose to any authenticated caller; conformance does not pin the access policy.

### 6.4 List

`GET /api/v1/proposals` returns `ProposalListResult` (§5.4) for proposals where the caller is the initiator OR a named participant. Optional query parameters: `status` (filter by state), `limit` (1–200, default 50), `motebit_id` (override scope when caller identity is not bound by signed token; some implementations require it).

### 6.5 Withdraw

`POST /api/v1/proposals/:proposalId/withdraw` accepts an empty body. Per §3.1, only the initiator may withdraw. The relay MUST reject other callers with HTTP 403 and MUST reject withdraw on a non-`pending` proposal with HTTP 409.

### 6.6 Step result

`POST /api/v1/proposals/:proposalId/step-result` accepts a `CollaborativeStepResult` (§5.6). The relay MUST reject step-results from a caller who is neither the initiator nor a named participant (HTTP 403). The result is broadcast to every participant + the initiator so the negotiation's full set of counterparties sees progress.

---

## 7. Conformance

A motebit implementation is **proposal-conformant** if and only if:

1. Every wire-format field name and type in §5 is emitted and accepted on the binding endpoints in §6.
2. The lifecycle invariants in §3 hold against any sequence of submissions and responses.
3. `accepted` transitions are all-or-nothing per §3.4.
4. Withdrawal authorization is initiator-only per §3.1.
5. Expiry is honored per §3.5.

The reference implementation is `services/api/src/proposals.ts` in this repo.

---

## 8. Relationship to Other Specs

| Spec                  | Relationship                                                                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| identity-v1.0         | Every motebit_id field references identity. Signed responses use the responder's Ed25519 identity key.                                                           |
| plan-lifecycle-v1.0   | `plan_id` references a plan governed by plan-lifecycle. Proposals negotiate the assignment; the plan-lifecycle events record the execution.                      |
| execution-ledger-v1.0 | `CollaborativeStepResult.receipt` SHOULD be an `ExecutionReceipt` (§11) when the step produced one.                                                              |
| auth-token-v1.0       | Caller identity is typically bound by a signed bearer token; the spec supports unauthenticated submission with explicit `*_motebit_id` fields for compatibility. |

---

## Change Log

- **1.0 (2026-04-24)** — Initial draft. Pins the proposal-submission, response, withdrawal, and collaborative-step-result wire shapes plus the six relay routes that carry them. Replaces the `@experimental` annotations on `services/api/src/proposals.ts` that named this spec as their forcing function.
