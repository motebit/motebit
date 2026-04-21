# motebit/goal-lifecycle@1.0

**Status:** Stable
**Version:** 1.1
**Date:** 2026-04-19

---

## 1. Overview

A motebit does not merely respond to prompts — it owns intent over time. A **goal** is the unit of that intent: a natural-language prompt paired with scheduling metadata (one-shot or recurring), a terminal-completion semantics, and a replay-safe event history. Goals sync across a user's devices via the event log substrate — a second device replays the ledger and reconstructs the goal set without contacting the originating device directly. Federation will replicate goal events the same way.

This specification pins the **wire format** of each goal-lifecycle event payload so every conforming implementation emits and accepts the same shape. Without this, a device running a sibling implementation could consume a `goal_completed` event that carries `status` in one emitter's field name and `reason` in another's, and the divergence would be silent — the log accepts both, but the receiver's goal view loses information at the state transition that matters most.

Like `memory-delta-v1.md`, this spec extends motebit's type-surface pinning guarantee to event-shaped artifacts.

**Design principles:**

- **Append-only ledger.** Goal events are never mutated or removed. `goal_removed` is a fresh event that tombstones the goal; the original `goal_created` event persists. The full log must be replay-safe for any receiver.
- **Schema stability over payload completeness.** New fields are additive. Receivers MUST tolerate unknown fields. Renaming or repurposing a field is a wire break and requires a new spec version.
- **Payloads are locally verifiable.** A receiver with just the event log + the emitting motebit's identity key can fully reconstruct the goal view. No relay contact required for replay semantics.
- **The ledger is the semantic source of truth.** Storage projections (SQLite `goals` rows, IndexedDB objects) are rebuilt from the log on cold start. If a projected row and the event log disagree, the log wins.
- **Progress notes are events, not state.** `goal_progress` records narrative progress within a run; `goal_executed` records a run's terminal outcome (success or failure — see §5.2); `goal_completed` records the goal's terminal transition. The three have distinct sync semantics and MUST NOT be conflated.

---

## 2. Scope and Non-Scope

**In scope:**

- The foundation law every goal-lifecycle implementation must satisfy (§3).
- The event taxonomy — five event types covering the full lifecycle (§4).
- The wire format of every goal-lifecycle event payload (§5).
- Sensitivity handling notes (§6).
- Storage projection hints (§7, reference convention).
- Conformance requirements (§8).
- Known emitter gaps (§9 — empty as of v1.1).

**Out of scope:**

- The plan-execution event family (`plan_created`, `plan_step_started`, etc.). Distinct event family specified in `plan-lifecycle-v1.md`. A goal run MAY produce plan events; the correlation is via `goal_id` on the plan payloads.
- The scheduler's internal state machine (`@motebit/runtime/scheduler.ts`). Implementation layer, not wire.
- The `report_progress` and `complete_goal` tool surfaces (`@motebit/runtime/tools/*`). Implementation-layer shapes; the wire shape is defined by this spec, not by the tool contract.
- Yaml routine grammar (`motebit.yaml`). Source-of-authorship for routine-driven goals; the goal-lifecycle events record materialization, not authorship.

---

## 3. Foundation Law of Goal-Lifecycle Events

### §3.1 Append-only invariant

A conforming goal-lifecycle event log MUST be append-only. Events are identified by `event_id`. A receiver MUST reject any duplicate `event_id` from the same `motebit_id`. `goal_removed` is a fresh event, not a mutation of `goal_created`.

### §3.2 Replay-safe invariant

Given a complete event log in timestamp + `version_clock` order, a conforming implementation MUST reconstruct the same goal set (ids, prompts, scheduling metadata, terminal states) as the emitting motebit. Events MAY arrive out of order across sync paths; consumers MUST tolerate reordering up to `version_clock` resolution.

### §3.3 Identity binding

Every goal-lifecycle event carries `motebit_id`. The event log substrate (`@motebit/event-log`) signs the log tail with the motebit's Ed25519 identity key; receivers verify the signed tail before accepting synced batches. The signing and verification primitives are in `@motebit/event-log` and `@motebit/crypto` respectively — this spec does not re-specify them.

### §3.4 Terminal-state convention

A goal reaches a terminal state via `goal_completed` (agent-driven or one-shot auto-complete) or `goal_removed` (user-initiated or yaml-pruned). After a terminal event, the goal MUST NOT emit further `goal_executed`, `goal_progress`, or `goal_completed` events. Implementations MAY emit a second `goal_removed` defensively when reconciling yaml state with a log that already contains a `goal_removed`; receivers MUST tolerate the redundancy.

### §3.5 Correlation with plan events

A goal run MAY materialize a plan. When it does, the plan's `plan_created` event and every subsequent plan-lifecycle event (per `plan-lifecycle-v1.md`) carries the `goal_id` of the driving goal. This cross-spec correlation is the only coupling between the two families; neither spec mandates the other.

---

## 4. Event Taxonomy

Five goal-lifecycle event types exist in `EventType`. Each has a wire-format payload type in `@motebit/protocol` and is emitted through a single primitive — `runtime.goals` — exported by `@motebit/runtime` (`packages/runtime/src/goals.ts`). Surfaces (CLI, desktop, mobile, web) call `runtime.goals.{created, executed, progress, completed, removed}`; no surface constructs event payloads inline.

| EventType        | Payload type           | Emitter method            | Sync class |
| ---------------- | ---------------------- | ------------------------- | ---------- |
| `goal_created`   | `GoalCreatedPayload`   | `runtime.goals.created`   | wire       |
| `goal_executed`  | `GoalExecutedPayload`  | `runtime.goals.executed`  | wire       |
| `goal_progress`  | `GoalProgressPayload`  | `runtime.goals.progress`  | wire       |
| `goal_completed` | `GoalCompletedPayload` | `runtime.goals.completed` | wire       |
| `goal_removed`   | `GoalRemovedPayload`   | `runtime.goals.removed`   | wire       |

---

## 5. Wire Format

Every event payload is canonical JSON. Field ordering is not significant in JSON semantics, but canonicalization (JCS, RFC 8785) is required when any event is signed alongside a signed sync batch — see §3.3. All timestamps in the wrapping `EventLogEntry` are Unix milliseconds.

### 5.1 — GoalCreatedPayload

Emitted when a goal is declared. Two shapes:

- **Initial creation** — carries `prompt` and optional scheduling metadata.
- **Yaml-driven revision** — carries `update: true` alongside `goal_id` and updated routine metadata. `prompt` MAY be absent when only scheduling metadata changed.

The distinction is in-band via the `update` marker. A future spec version MAY split these (`goal_created` vs `goal_updated`); v1 keeps them merged to match shipping emitters.

#### Wire format (foundation law)

```json
{
  "goal_id": "550e8400-e29b-41d4-a716-446655440000",
  "prompt": "Summarize my inbox every hour.",
  "interval_ms": 3600000,
  "mode": "recurring",
  "wall_clock_ms": 1744052400000
}
```

Fields:

- `goal_id` (string, required) — UUID v4 of the goal; stable across yaml revisions.
- `prompt` (string, optional) — Natural-language goal text. REQUIRED on initial creation; MAY be absent on revision when only scheduling metadata changed.
- `interval_ms` (integer, optional) — Scheduling cadence in milliseconds. Absent for one-shot goals.
- `mode` (string, optional) — `"recurring"` or `"once"`. Future variants reserved.
- `wall_clock_ms` (integer, optional) — Wall-clock anchor for the first run (Unix milliseconds).
- `project_id` (string, optional) — User-facing project grouping. Opaque to the protocol.
- `routine_id` (string, optional) — Source routine id when materialized from a `motebit.yaml` routine.
- `routine_source` (string, optional) — Free-text source attribution (e.g. yaml file path).
- `routine_hash` (string, optional) — Canonical hash of the source routine. Used to detect yaml drift.
- `update` (`true`, optional) — Marker set on yaml-driven revisions; absent on initial creation.

### 5.2 — GoalExecutedPayload

Emitted when a goal run finishes, successfully or in failure. Recurring goals emit this repeatedly. Distinct from `goal_completed`: `goal_executed` records one run's outcome; `goal_completed` records the goal's terminal transition.

The presence of the optional `error` field distinguishes the two variants: a successful run carries `summary`, `tool_calls`, and `memories`; a failed run carries only `error` (plus any future additive fields). Receivers MUST NOT assume both shapes are mutually exclusive at the schema level — the wire envelope is `.passthrough()` — but emitters in the reference implementation keep them disjoint.

#### Wire format (foundation law) — success variant

```json
{
  "goal_id": "550e8400-e29b-41d4-a716-446655440000",
  "summary": "Found 3 urgent threads; drafted replies to two.",
  "tool_calls": 7,
  "memories": 2
}
```

#### Wire format (foundation law) — failure variant

```json
{
  "goal_id": "550e8400-e29b-41d4-a716-446655440000",
  "error": "tool budget exhausted at step 4"
}
```

Fields:

- `goal_id` (string, required) — UUID of the executed goal.
- `summary` (string, optional) — Up to ~200 characters of the agent's response text. Present on success.
- `tool_calls` (integer, optional) — Number of tool calls performed during the run. Present on success.
- `memories` (integer, optional) — Number of memory nodes formed during the run. Present on success.
- `error` (string, optional) — Error message. Present iff the run terminated in failure. Consumers MUST NOT parse it semantically.

### 5.3 — GoalProgressPayload

Emitted by the `report_progress` tool during a goal run. Narrative progress note that arrives before the run's terminal `goal_executed` event.

#### Wire format (foundation law)

```json
{
  "goal_id": "550e8400-e29b-41d4-a716-446655440000",
  "note": "Scanned inbox; processing labeled threads next."
}
```

Fields:

- `goal_id` (string, required) — UUID of the goal.
- `note` (string, required) — Free-text progress narration. Consumers MUST NOT parse it semantically. Implementations MAY truncate over the wire; no canonical limit is specified in v1.

### 5.4 — GoalCompletedPayload

Emitted when a goal reaches its terminal state. Two paths today:

- Agent-driven: the `complete_goal` tool is invoked with a `reason`.
- One-shot auto-complete: a one-shot goal finishes its single run without the agent invoking the tool; the scheduler emits the event with `reason: "one-shot auto-complete"`.

Recurring goals do not emit `goal_completed` until the user removes them (→ `goal_removed`).

#### Wire format (foundation law)

```json
{
  "goal_id": "550e8400-e29b-41d4-a716-446655440000",
  "reason": "inbox cleared; nothing urgent remains"
}
```

Fields:

- `goal_id` (string, required) — UUID of the completed goal.
- `reason` (string, optional) — Free-text rationale. Consumers MUST NOT parse it semantically.

### 5.5 — GoalRemovedPayload

Emitted when a goal is deleted. Sources include the `motebit goal remove` CLI command and yaml re-apply operations that prune goals no longer declared in the source routine.

#### Wire format (foundation law)

```json
{
  "goal_id": "550e8400-e29b-41d4-a716-446655440000",
  "routine_id": "daily-inbox",
  "reason": "yaml_pruned"
}
```

Fields:

- `goal_id` (string, required) — UUID of the removed goal.
- `routine_id` (string, optional) — Source routine id when the removal was yaml-pruned.
- `reason` (string, optional) — Free-text rationale (e.g. `"yaml_pruned"` or a user-supplied reason).

After this event, the goal is tombstoned — it no longer emits `goal_executed` or `goal_progress`. The original `goal_created` event persists in the log; storage adapters MUST retain it.

---

## 6. Sensitivity

Goal-lifecycle events are the user's declared intent expressed to the motebit. Prompts MAY contain personal context ("summarize my inbox", "draft a reply to my doctor"). Progress notes, summaries, and reasons MAY similarly leak user context. Unlike memory events, the goal-lifecycle wire format does not carry a `sensitivity` field in v1 — goals are treated as `"personal"` by default for forwarding policy.

Implementations that need stricter policy MAY:

- Redact `prompt`, `summary`, `note`, or `reason` fields at a sync forwarder before crossing a trust boundary, replacing the value with `"[REDACTED]"` and passing through the event envelope.
- Emit goals with a policy-tagged envelope at the event-log layer (out of wire-format scope for v1).

A future spec revision MAY add an emitter-authored `sensitivity` field to one or more of these payloads; that would be a minor, additive wire change.

---

## 7. Storage (reference convention — non-binding)

Storage adapters project the goal-lifecycle log into a live `goals` row set. This is a reference convention — any storage that satisfies §3.2 (replay-safe) conforms. The in-monorepo reference adapters are:

- `@motebit/persistence` — SQLite (desktop, CLI, services).
- `@motebit/browser-persistence` — IndexedDB (web).
- `apps/mobile/src/adapters/expo-sqlite.ts` — Expo SQLite (mobile).
- `apps/desktop/src/tauri-storage.ts` — Tauri SQLite bridge.

Each adapter projects `goal_created` into a row (or merges a revision marked `update: true`), appends `goal_executed` and `goal_progress` into a per-goal activity timeline, and tombstones on `goal_completed` / `goal_removed`. The live goal view is always a function of the log, never the inverse.

---

## 8. Conformance

An implementation is conformant with `motebit/goal-lifecycle@1.0` if it:

1. Emits events of the types and shapes specified in §5.
2. Preserves append-only semantics (§3.1).
3. Projects a replay-safe live goal view from the event log (§3.2).
4. Honors the terminal-state convention (§3.4) — no post-terminal emission.
5. Binds every event to `motebit_id` and signs synced batches via `@motebit/event-log` + `@motebit/crypto`.
6. When materializing a plan for a goal run, tags every plan-lifecycle event with the driving `goal_id` (§3.5).

Non-conformance modes and their consequences:

- **Divergent payload shape** — the receiver's goal view drifts from the emitter's. Detected in practice by cross-device state comparison tests; prevented at CI by `check-spec-coverage` (invariant #9) which asserts every type named here is exported from `@motebit/protocol`, and by `check-spec-wire-schemas` (invariant #23) which asserts every wire-format type has a zod schema.
- **Post-terminal emission** — receivers will observe ghost `goal_executed` events for tombstoned goals. Emitters MUST respect the terminal-state convention.
- **Missing plan correlation** — plan events without a `goal_id` for a plan that was materialized from a goal. Receivers lose the goal → plan correlation; prevented at emission in `@motebit/runtime/plan-execution.ts`.

---

## 9. Known Emitter Gaps

None. The three convergence items tracked by v1.0 as §9.1 (failed-run emission), §9.2 (runtime.goals.\* primitive), and §9.3 (terminal-state guard) all landed in v1.1 alongside the additive `error` field on `GoalExecutedPayload`. The authoritative emitter now lives at `packages/runtime/src/goals.ts` (`createGoalsEmitter` → `runtime.goals`); every in-tree surface calls it instead of constructing event payloads inline. The terminal-state guard fires via an optional `getGoalStatus` resolver that the CLI scheduler registers on start. See the 2026-04-19 line in the Change Log.

---

## Change Log

| Version | Date       | Changes                                                                                                                                                                                                                                       |
| ------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.0     | 2026-04-19 | Initial spec.                                                                                                                                                                                                                                 |
| 1.1     | 2026-04-19 | Additive: `error` field on `GoalExecutedPayload` distinguishes failed runs from successful ones. Convergence: `runtime.goals.*` primitive lands in `@motebit/runtime`; terminal-state guard enforced in-runtime. Closes 1.0's §9.1/§9.2/§9.3. |
