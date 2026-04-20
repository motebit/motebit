# motebit/plan-lifecycle@1.0

**Status:** Stable
**Version:** 1.0
**Date:** 2026-04-19

---

## 1. Overview

A plan is a motebit's execution backbone for achieving a goal or answering a prompt: an ordered list of steps, each with its own description, status, and tool-call accounting. Plans cross device boundaries (multi-device sync replays plan history) and delegation boundaries (a delegated step is emitted against the worker motebit's own plan log; the result returns via `AgentTaskCompleted`). The plan-lifecycle event family records every state transition so the event log carries an append-only audit trail of every plan run.

This specification pins the **wire format** of each plan-lifecycle event payload so every conforming implementation emits and accepts the same shape. Without this, a device running a sibling implementation could consume a `plan_step_completed` event that carries `ordinal` in one emitter and `index` in another, and the divergence would be silent — the log accepts both, but the receiver's plan view loses step ordering at the moment it matters most.

Like `memory-delta-v1.md` and `goal-lifecycle-v1.md`, this spec extends motebit's type-surface pinning guarantee to event-shaped artifacts.

**Design principles:**

- **Append-only ledger.** Plan events are never mutated or removed. `plan_failed` is a fresh event that records a terminal transition; earlier `plan_step_started` events persist. The full log must be replay-safe for any receiver.
- **Schema stability over payload completeness.** New fields are additive. Receivers MUST tolerate unknown fields. Renaming or repurposing a field is a wire break and requires a new spec version.
- **Delegation is a step state, not a separate plan.** A delegated step emits `plan_step_delegated` and awaits a subsequent `plan_step_completed` or `plan_step_failed` on the delegator's plan log when the delegation result returns. The worker motebit maintains its own plan log for its own local execution; the two logs correlate via `task_id`.
- **Payloads are locally verifiable.** A receiver with just the event log + the emitting motebit's identity key can fully reconstruct the plan view. No relay contact required for replay semantics.
- **The ledger is the semantic source of truth.** Storage projections (SQLite `plans` / `plan_steps` rows) are rebuilt from the log on cold start. If a projected row and the event log disagree, the log wins.

---

## 2. Scope and Non-Scope

**In scope:**

- The foundation law every plan-lifecycle implementation must satisfy (§3).
- The event taxonomy — seven event types covering plan creation, per-step lifecycle, and plan termination (§4).
- The wire format of every plan-lifecycle event payload emitted by `@motebit/runtime`'s plan-execution orchestrator (§5).
- Storage projection hints (§6, reference convention).
- Conformance requirements (§7).

**Out of scope:**

- The goal-lifecycle event family (`goal_created`, `goal_executed`, etc.). Distinct event family specified in `goal-lifecycle-v1.md`. Correlation is via `goal_id` on plan payloads when the plan is materialized for a goal run.
- The agent-task family (`AgentTaskCompleted`, `AgentTaskFailed`) that carries a delegated step's result back to the delegator. Distinct event family; `plan_step_delegated` carries the `task_id` that identifies the eventual resolution event.
- Plan-generation strategy (how a plan is materialized from a prompt or goal). Implementation-layer concern; outside wire scope.
- Receipts for delegated work. The receipt chain is specified by `execution-ledger-v1.md`; `plan_step_completed` does not duplicate receipt content.

---

## 3. Foundation Law of Plan-Lifecycle Events

### §3.1 Append-only invariant

A conforming plan-lifecycle event log MUST be append-only. Events are identified by `event_id`. A receiver MUST reject any duplicate `event_id` from the same `motebit_id`.

### §3.2 Replay-safe invariant

Given a complete event log in timestamp + `version_clock` order, a conforming implementation MUST reconstruct the same plan state — total steps, each step's terminal status, `tool_calls_made` per step, and the plan's terminal state — as the emitting motebit. Events MAY arrive out of order across sync paths; consumers MUST tolerate reordering up to `version_clock` resolution.

### §3.3 Identity binding

Every plan-lifecycle event carries `motebit_id`. The event log substrate (`@motebit/event-log`) signs the log tail with the motebit's Ed25519 identity key; receivers verify the signed tail before accepting synced batches. The signing and verification primitives are in `@motebit/event-log` and `@motebit/crypto` respectively — this spec does not re-specify them.

### §3.4 Step-lifecycle ordering

For a given `step_id` within a plan, emission ordering MUST be one of:

- `plan_step_started` → `plan_step_completed`
- `plan_step_started` → `plan_step_failed`
- `plan_step_started` → `plan_step_delegated` → `plan_step_completed`
- `plan_step_started` → `plan_step_delegated` → `plan_step_failed`

After a terminal step event (`plan_step_completed` or `plan_step_failed`), the step MUST NOT emit further lifecycle events. A step MAY be delegated at most once; reassignment of delegated work requires a fresh `step_id` within the same or a successor plan.

### §3.5 Plan-termination convention

A plan reaches a terminal state via `plan_completed` (every step reached a terminal state and the plan engine chose to finish) or `plan_failed` (the plan engine could not continue). After a terminal plan event, no further step events for that plan MAY be emitted.

### §3.6 Correlation with goal events

When a plan is materialized for a goal run, every plan-lifecycle event MAY carry `goal_id` referencing the driving goal (from `goal-lifecycle-v1.md`). Plans materialized for direct prompts (no goal) omit `goal_id`. This cross-spec correlation is the only coupling between the two families.

### §3.7 Correlation with delegation

`plan_step_delegated` carries `task_id`, the relay-issued identifier for the delegated work. The eventual `plan_step_completed` or `plan_step_failed` for that step MUST correlate to the same `task_id` (carried in the wrapping event envelope or by joining against the delegator's task tracking) so a receiver can reconstruct the delegation chain.

---

## 4. Event Taxonomy

Seven plan-lifecycle event types exist in `EventType`, all emitted by `@motebit/runtime`'s plan-execution orchestrator (`packages/runtime/src/plan-execution.ts`). Each has a wire-format payload type in `@motebit/protocol`.

| EventType             | Payload type               | Emitter            | Sync class |
| --------------------- | -------------------------- | ------------------ | ---------- |
| `plan_created`        | `PlanCreatedPayload`       | `@motebit/runtime` | wire       |
| `plan_step_started`   | `PlanStepStartedPayload`   | `@motebit/runtime` | wire       |
| `plan_step_completed` | `PlanStepCompletedPayload` | `@motebit/runtime` | wire       |
| `plan_step_failed`    | `PlanStepFailedPayload`    | `@motebit/runtime` | wire       |
| `plan_step_delegated` | `PlanStepDelegatedPayload` | `@motebit/runtime` | wire       |
| `plan_completed`      | `PlanCompletedPayload`     | `@motebit/runtime` | wire       |
| `plan_failed`         | `PlanFailedPayload`        | `@motebit/runtime` | wire       |

---

## 5. Wire Format

Every event payload is canonical JSON. Field ordering is not significant in JSON semantics, but canonicalization (JCS, RFC 8785) is required when any event is signed alongside a signed sync batch — see §3.3. All timestamps in the wrapping `EventLogEntry` are Unix milliseconds.

### 5.1 — PlanCreatedPayload

Emitted when the plan engine materializes a plan.

#### Wire format (foundation law)

```json
{
  "plan_id": "550e8400-e29b-41d4-a716-446655440000",
  "title": "Daily inbox triage",
  "total_steps": 4,
  "goal_id": "6ba7b810-9dad-11d1-80b4-00c04fd430c8"
}
```

Fields:

- `plan_id` (string, required) — UUID v4 of the plan.
- `title` (string, required) — Human-readable title summarizing the plan's goal.
- `total_steps` (integer, required) — Total number of steps the plan was materialized with. Receivers MAY use this to detect loss-of-sync (more than `total_steps` distinct `step_id`s observed ⇒ receiver has drifted from emitter).
- `goal_id` (string, optional) — Owning goal. See §3.6.

### 5.2 — PlanStepStartedPayload

Emitted when a step transitions from pending to running.

#### Wire format (foundation law)

```json
{
  "plan_id": "550e8400-e29b-41d4-a716-446655440000",
  "step_id": "7ba8c921-aebe-22e2-91c5-11d15fe541d9",
  "ordinal": 0,
  "description": "Scan inbox for unread threads from the last 24 hours."
}
```

Fields:

- `plan_id` (string, required) — UUID of the parent plan.
- `step_id` (string, required) — UUID of this step; unique within the plan.
- `ordinal` (integer, required) — Zero-based position of the step within its plan.
- `description` (string, required) — Human-readable description of what the step does.
- `goal_id` (string, optional) — Owning goal. See §3.6.

### 5.3 — PlanStepCompletedPayload

Emitted when a step reaches terminal success.

#### Wire format (foundation law)

```json
{
  "plan_id": "550e8400-e29b-41d4-a716-446655440000",
  "step_id": "7ba8c921-aebe-22e2-91c5-11d15fe541d9",
  "ordinal": 0,
  "tool_calls_made": 3
}
```

Fields:

- `plan_id` (string, required) — UUID of the parent plan.
- `step_id` (string, required) — UUID of the completed step.
- `ordinal` (integer, required) — Zero-based position of the step within its plan.
- `tool_calls_made` (integer, required) — Number of tool calls the step performed. Consumers MAY reconstruct execution cost from this field without replaying every `tool_used` event.
- `goal_id` (string, optional) — Owning goal. See §3.6.

### 5.4 — PlanStepFailedPayload

Emitted when a step reaches terminal failure.

#### Wire format (foundation law)

```json
{
  "plan_id": "550e8400-e29b-41d4-a716-446655440000",
  "step_id": "7ba8c921-aebe-22e2-91c5-11d15fe541d9",
  "ordinal": 1,
  "error": "Timeout waiting for remote worker response"
}
```

Fields:

- `plan_id` (string, required) — UUID of the parent plan.
- `step_id` (string, required) — UUID of the failed step.
- `ordinal` (integer, required) — Zero-based position of the step within its plan.
- `error` (string, required) — Error message. Consumers MUST NOT parse it semantically. Implementations MAY truncate over the wire.
- `goal_id` (string, optional) — Owning goal. See §3.6.

### 5.5 — PlanStepDelegatedPayload

Emitted when a step is handed off to a remote agent. The delegator logs this event and waits for the corresponding `AgentTaskCompleted` / `AgentTaskFailed` event from the delegation substrate before emitting the step's terminal `plan_step_completed` or `plan_step_failed`.

#### Wire format (foundation law)

```json
{
  "plan_id": "550e8400-e29b-41d4-a716-446655440000",
  "step_id": "7ba8c921-aebe-22e2-91c5-11d15fe541d9",
  "ordinal": 2,
  "task_id": "d290f1ee-6c54-4b01-90e6-d701748f0851",
  "routing_choice": {
    "agent_id": "did:motebit:z6MkrA...",
    "trust_score": 0.87,
    "rail": "guest.x402"
  }
}
```

Fields:

- `plan_id` (string, required) — UUID of the parent plan.
- `step_id` (string, required) — UUID of the delegated step.
- `ordinal` (integer, required) — Zero-based position of the step within its plan.
- `task_id` (string, required) — Relay-issued task identifier. Matches the subsequent `AgentTaskCompleted.task_id` (out-of-scope event family). See §3.7.
- `routing_choice` (object, optional) — Routing provenance picked by the semiring. Opaque to this spec; the motebit semiring module defines the field set. Consumers MAY read known fields (agent id, trust score, rail hint) but MUST tolerate additional fields for forward compatibility.
- `goal_id` (string, optional) — Owning goal. See §3.6.

### 5.6 — PlanCompletedPayload

Emitted when every step has reached a terminal state and the plan engine considers the plan done.

#### Wire format (foundation law)

```json
{
  "plan_id": "550e8400-e29b-41d4-a716-446655440000",
  "goal_id": "6ba7b810-9dad-11d1-80b4-00c04fd430c8"
}
```

Fields:

- `plan_id` (string, required) — UUID of the completed plan.
- `goal_id` (string, optional) — Owning goal. See §3.6.

### 5.7 — PlanFailedPayload

Emitted when a plan terminates before completion — a step failed unrecoverably, the plan was cancelled, or a policy gate rejected further execution.

#### Wire format (foundation law)

```json
{
  "plan_id": "550e8400-e29b-41d4-a716-446655440000",
  "reason": "step 1 exhausted retries; plan cannot continue"
}
```

Fields:

- `plan_id` (string, required) — UUID of the failed plan.
- `reason` (string, required) — Free-text failure rationale. Consumers MUST NOT parse it semantically.
- `goal_id` (string, optional) — Owning goal. See §3.6.

---

## 6. Storage (reference convention — non-binding)

Storage adapters project the plan-lifecycle log into live `plans` + `plan_steps` row sets. This is a reference convention — any storage that satisfies §3.2 (replay-safe) conforms. The in-monorepo reference adapters are:

- `@motebit/persistence` — SQLite (desktop, CLI, services).
- `@motebit/browser-persistence` — IndexedDB (web).
- `apps/mobile/src/adapters/expo-sqlite.ts` — Expo SQLite (mobile).
- `apps/desktop/src/tauri-storage.ts` — Tauri SQLite bridge.

Each adapter projects `plan_created` into a `plans` row and `total_steps` step placeholders, advances per-step state on `plan_step_started` / `plan_step_completed` / `plan_step_failed` / `plan_step_delegated`, and tombstones the plan on `plan_completed` / `plan_failed`. The live plan view is always a function of the log, never the inverse.

---

## 7. Conformance

An implementation is conformant with `motebit/plan-lifecycle@1.0` if it:

1. Emits events of the types and shapes specified in §5.
2. Preserves append-only semantics (§3.1).
3. Projects a replay-safe live plan view from the event log (§3.2).
4. Honors step-lifecycle ordering (§3.4) and plan-termination convention (§3.5) — no out-of-order or post-terminal emission.
5. Binds every event to `motebit_id` and signs synced batches via `@motebit/event-log` + `@motebit/crypto`.
6. When a plan serves a goal run, tags every plan-lifecycle event with `goal_id` (§3.6).
7. Correlates delegated-step termination with `task_id` (§3.7).

Non-conformance modes and their consequences:

- **Divergent payload shape** — the receiver's plan view drifts from the emitter's. Detected in practice by cross-device state comparison tests; prevented at CI by `check-spec-coverage` (invariant #9) which asserts every type named here is exported from `@motebit/protocol`, and by `check-spec-wire-schemas` (invariant #23) which asserts every wire-format type has a zod schema.
- **Out-of-order step events** — receivers cannot distinguish a `plan_step_completed` before a `plan_step_started` from a bug versus out-of-order sync. Emitters MUST respect §3.4.
- **Missing delegation correlation** — `plan_step_delegated` without `task_id`, or a `plan_step_completed` that cannot be joined back to its delegation. Receivers lose the delegation audit trail; prevented at emission in `@motebit/runtime/plan-execution.ts`.

---

## Change Log

| Version | Date       | Changes       |
| ------- | ---------- | ------------- |
| 1.0     | 2026-04-19 | Initial spec. |
