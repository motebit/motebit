# motebit/memory-delta@1.0

**Status:** Stable
**Version:** 1.1
**Date:** 2026-04-19

---

## 1. Overview

A motebit's memory graph evolves as an append-only sequence of events: nodes are formed, pinned, accessed, consolidated, and eventually deleted. The event log is the ledger — the in-memory graph state is a projection of the log, not a source of truth. When a motebit runs across multiple devices (Link Device in `identity-v1.md`), those devices converge by replaying each other's memory events. When federation ships, peers will replicate memory events the same way.

This specification pins the **wire format** of each memory event payload so every conforming implementation emits and accepts the same shape. Without this, a device running a sibling implementation could consume `memory_formed` events that carry `content` in one emitter's field name and `text` in another's, and the divergence would be silent — the event log would accept both, but the receiver's graph would miss half the content.

Three existing gates pin the type surface of motebit artifacts (identity, receipts, credentials). This spec extends that guarantee to event-shaped artifacts.

**Design principles:**

- **Append-only ledger.** Memory events are never mutated or removed. A `memory_deleted` event tombstones a node; the original `memory_formed` event persists. The full log must be replay-safe for any receiver.
- **Sensitivity is a wire-layer concern.** `MemoryFormedPayload` carries `sensitivity`; sync engines MAY redact `content` above a consented threshold before forwarding. The emitter MUST NOT redact — redaction is a forwarding-time decision, not an authorship decision.
- **Schema stability over payload completeness.** New fields are additive. Receivers MUST tolerate unknown fields. Renaming or repurposing a field is a wire break and requires a new spec version.
- **Payloads are locally verifiable.** A receiver with just the event log + the emitting motebit's identity key can fully replay a memory graph. No relay contact required for replay semantics. Relay-mediated redaction is an extension of this contract, not a precondition.
- **The ledger is the semantic source of truth.** Storage adapters (SQLite, IndexedDB, Expo SQLite, Tauri) MUST reconstruct the live graph from events, not the other way around. If a projected storage row and the event log disagree, the event log wins.

---

## 2. Scope and Non-Scope

**In scope:**

- The foundation law every memory-event implementation must satisfy (§3).
- The event taxonomy — which events cross the wire, which stay local (§4).
- The wire format of every memory event payload emitted by `@motebit/memory-graph` (§5).
- Sensitivity handling and redaction convention (§6).
- Storage projection hints (§7, reference convention).
- Conformance requirements (§8).

**Out of scope:**

- The in-memory graph model (`MemoryGraph`, `MemoryNode`, `MemoryEdge` types) — these are implementation-layer shapes, not wire artifacts. They are specified in-code at `@motebit/memory-graph/src/index.ts`.
- Retrieval judgment (ranking, recall lenses). See `@motebit/memory-graph/retrieval.ts` and invariant #27.
- Notability ranking. See `@motebit/memory-graph/notability.ts` and invariant #29.
- Embeddings and the embedding service. Out of protocol scope — embeddings are a local concern.
- Reflection events (`reflection_completed`). Distinct event family; out of scope for this spec but tracked as a future event-shaped spec.

---

## 3. Foundation Law of Memory Events

### §3.1 Append-only invariant

A conforming memory-event log MUST be append-only. Events are identified by `event_id`. A receiver MUST reject any duplicate `event_id` from the same `motebit_id`. Tombstoning is in-log — `memory_deleted` is a fresh event, not a mutation of `memory_formed`.

### §3.2 Replay-safe invariant

Given a complete event log in timestamp + `version_clock` order, a conforming implementation MUST reconstruct the same live-node set and live-edge set as the emitting motebit. Events MAY arrive out of order across sync paths; consumers MUST tolerate reordering up to `version_clock` resolution.

### §3.3 Emitter-authored sensitivity invariant

`MemoryFormedPayload.sensitivity` is authored by the emitter at memory-formation time. It classifies the content, not the emission context. Forwarding decisions (relay, sync engine, federation peer) consult this field to decide whether to redact `content` before the payload crosses a trust boundary. The emitter MUST NOT self-redact.

### §3.4 Identity binding

Every memory event carries `motebit_id`. The event log substrate (`@motebit/event-log`) signs the log tail with the motebit's Ed25519 identity key; any receiver verifying a synced batch verifies the signed tail before accepting the batch. The signing and verification primitives are in `@motebit/event-log` and `@motebit/crypto` respectively — this spec does not re-specify them.

---

## 4. Event Taxonomy

Eight memory-shaped event types exist in `EventType`, emitted by `@motebit/memory-graph` (with one exception — §4.7 is emitted by `@motebit/ai-core`). Each has a wire-format payload type in `@motebit/protocol`. Implementations MAY emit additional event types that are not memory-shaped; this spec governs only the eight below.

| EventType             | Payload type                | Emitter                 | Sync class            |
| --------------------- | --------------------------- | ----------------------- | --------------------- |
| `memory_formed`       | `MemoryFormedPayload`       | `@motebit/memory-graph` | wire, redaction-aware |
| `memory_accessed`     | `MemoryAccessedPayload`     | `@motebit/memory-graph` | wire                  |
| `memory_pinned`       | `MemoryPinnedPayload`       | `@motebit/memory-graph` | wire                  |
| `memory_deleted`      | `MemoryDeletedPayload`      | `@motebit/memory-graph` | wire                  |
| `memory_consolidated` | `MemoryConsolidatedPayload` | `@motebit/memory-graph` | wire                  |
| `memory_audit`        | `MemoryAuditPayload`        | `@motebit/ai-core`      | local-only            |
| `memory_decayed`      | `MemoryDecayedPayload`      | (reserved)              | (reserved)            |
| `memory_promoted`     | `MemoryPromotedPayload`     | `@motebit/memory-graph` | wire                  |

`memory_audit` is emitted during ai-core's turn loop to record missed-sensitivity-tagging heuristic signals. It is local-only — implementations MUST NOT forward it across device boundaries because `turn_message` may contain unredacted user content that predates sensitivity classification.

`memory_decayed` is reserved for forward compatibility. No emitter today; receivers MUST accept events of this type without failing, but MUST NOT assume a payload shape until this spec adds one.

---

## 5. Wire Format

Every event payload is canonical JSON. Field ordering is not significant in JSON semantics, but canonicalization (JCS, RFC 8785) is required when any event is signed alongside a signed sync batch — see §3.4. All timestamps in the wrapping `EventLogEntry` are Unix milliseconds.

### 5.1 — MemoryFormedPayload

Emitted when `@motebit/memory-graph`'s `formMemory` completes node formation.

#### Wire format (foundation law)

```json
{
  "node_id": "550e8400-e29b-41d4-a716-446655440000",
  "content": "The user prefers TypeScript for monorepo work.",
  "sensitivity": "none"
}
```

Fields:

- `node_id` (string, required) — UUID v4 of the newly-formed node. Must be unique within the emitter's memory graph.
- `content` (string, required) — Textual content. MAY be replaced with `"[REDACTED]"` by a sync forwarder (§6). Implementations MUST NOT infer content from the hash of other fields.
- `sensitivity` (`SensitivityLevel`, required) — One of `"none" | "personal" | "medical" | "financial" | "secret"`. Emitter-authored. §3.3 governs forwarding policy.
- `redacted` (`true`, optional) — Present only after a sync forwarder has replaced `content`. Original events MUST NOT carry this field.
- `redacted_sensitivity` (`SensitivityLevel`, optional) — Present when `redacted === true` so downstream receivers retain the policy classification even without content.

### 5.2 — MemoryAccessedPayload

Emitted when a live node is read by recall, reflection, or consolidation.

#### Wire format (foundation law)

```json
{
  "node_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

Fields:

- `node_id` (string, required) — UUID of the accessed node. Consumers MAY deduplicate access bursts (multiple accesses within a short window) at the storage projection layer; the event log itself MUST retain every access.

### 5.3 — MemoryPinnedPayload

Emitted when a node is pinned or unpinned.

#### Wire format (foundation law)

```json
{
  "node_id": "550e8400-e29b-41d4-a716-446655440000",
  "pinned": true
}
```

Fields:

- `node_id` (string, required) — UUID of the affected node.
- `pinned` (boolean, required) — `true` when the node is now pinned, `false` when unpinned. A conforming implementation MUST treat the most recent `memory_pinned` event as authoritative for the current pin state.

### 5.4 — MemoryDeletedPayload

Emitted when a node is deleted — by user action, housekeeping decay, or consolidation supersession.

#### Wire format (foundation law)

```json
{
  "node_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

Fields:

- `node_id` (string, required) — UUID of the deleted node. After this event, the node is tombstoned — it no longer contributes to retrieval, ranking, or reflection. The original `memory_formed` event persists in the log; storage adapters MUST retain it.

### 5.5 — MemoryConsolidatedPayload

Emitted when consolidation merges a candidate into an existing memory, supersedes an older memory, rejects a candidate as redundant, or accepts a candidate as a new node.

#### Wire format (foundation law)

```json
{
  "action": "merge",
  "existing_node_id": "550e8400-e29b-41d4-a716-446655440000",
  "new_node_id": null,
  "reason": "Semantic near-duplicate; cosine similarity 0.92"
}
```

Fields:

- `action` (string, required) — One of `"merge" | "supersede" | "reject" | "accept"`. These mirror the `ConsolidationDecision.action` taxonomy from `@motebit/memory-graph`.
- `existing_node_id` (string | null, required) — The UUID of the node being merged into or superseded. `null` for `"accept"` and `"reject"` actions.
- `new_node_id` (string | null, required) — The UUID of the newly-formed node. `null` for `"reject"` and `"supersede"`-in-place actions. When present, a corresponding `memory_formed` event MUST precede this event in the log.
- `reason` (string, required) — Free-text rationale. Consumers MUST NOT parse it semantically. Implementations MAY truncate to a bounded length over the wire.

### 5.6 — MemoryAuditPayload

Emitted by `@motebit/ai-core` when turn-loop heuristics detect missed sensitivity tags. **Local-only — MUST NOT cross device boundaries.**

#### Wire format (foundation law)

```json
{
  "missed_patterns": ["financial", "medical"],
  "turn_message": "My bank account balance is..."
}
```

Fields:

- `missed_patterns` (array of string, required) — Sensitivity classifications the ai-core heuristic believes apply to the turn but were not tagged on the resulting memory. Values are drawn from `SensitivityLevel`.
- `turn_message` (string, required) — Up to 200 characters of the triggering user message. Implementations MUST truncate to 200 characters at emission time. The 200-char cap keeps this event within sync-safe bounds even though the event itself is local-only today.

### 5.7 — MemoryDecayedPayload

Reserved for future use. No emitter in this version.

#### Wire format (foundation law)

```json
{}
```

Fields: none. Conforming receivers MUST accept this event type without error, but MUST NOT assume a payload shape until a future spec revision pins one.

### 5.8 — MemoryPromotedPayload

Emitted when a memory node crosses from tentative to absolute — enough reinforcement has accumulated that downstream consumers MAY treat the claim as ground truth rather than hypothesis.

Motebit's confidence is a continuous [0, 1] score updated by consolidation. The discrete question the UI and the AI loop actually want to answer is "am I sure?" This event records the state-change so the Layer-1 memory index can surface an "absolute" label and the agent can cite promoted memory as fact without hedging.

Promotion is emitter-authored. The reference heuristic in `@motebit/memory-graph/promotion.ts` promotes when a confidence update crosses the `PROMOTION_CONFIDENCE_THRESHOLD` (0.95) from below. Implementations MAY use their own heuristic; this spec only pins the payload shape.

#### Wire format (foundation law)

```json
{
  "node_id": "550e8400-e29b-41d4-a716-446655440000",
  "from_confidence": 0.85,
  "to_confidence": 0.95,
  "reinforcement_count": 3,
  "reason": "reinforced"
}
```

Fields:

- `node_id` (string, required) — UUID of the promoted node.
- `from_confidence` (number, required) — Confidence score before promotion, in [0, 1].
- `to_confidence` (number, required) — Confidence score after promotion, in [0, 1]. Typically 1.0.
- `reinforcement_count` (integer, required) — Count of consolidation reinforcement events observed against this node before the promotion fired. Informational; consumers MAY use it to calibrate their own promotion policy but MUST NOT rely on it as a precise audit count (use the event log for that).
- `reason` (string, required) — Free-text rationale from the promoter. Consumers MUST NOT parse it semantically.

Idempotency: once a node is promoted, subsequent reinforcement events MUST NOT re-emit `memory_promoted`. The emitter is responsible for the "cross from below" check; receivers MAY defensively deduplicate by `node_id` if they observe multiple promotions.

---

## 6. Sensitivity and Redaction

Memory events that carry content (§5.1) participate in the sensitivity-aware forwarding contract. The policy is three-tiered:

**Tier 1 — emitter.** The emitter tags each `memory_formed` event with the sensitivity of its content. Tagging is emitter-authored; the emitter MUST NOT redact.

**Tier 2 — sync forwarder.** A sync engine or relay forwarding the event to a peer device consults the forwarder's policy. Default policy: `"none"` and `"personal"` pass through; `"medical"`, `"financial"`, `"secret"` trigger redaction. Redaction replaces `content` with the sentinel string `"[REDACTED]"` and adds `redacted: true` + `redacted_sensitivity: <level>`. The reference implementation lives at `services/api/src/sync-routes.ts:redactSensitiveEvents`.

**Tier 3 — receiver.** The receiver consuming the event stores it verbatim — redacted or not. Display layers MAY request the non-redacted event from the emitter device via a separate authenticated path, but MUST NOT attempt to reconstruct the content from other events.

Non-content events (§5.2–§5.5, §5.7) carry no sensitivity classification because they carry no content. `memory_audit` (§5.6) carries partial user content but is local-only by protocol — forwarders MUST NOT emit it across a device boundary under any sensitivity policy.

---

## 7. Storage (reference convention — non-binding)

Storage adapters project the event log into efficient queryable shapes (nodes table, edges table, embedding vectors). This is a reference convention — a conforming implementation may use any storage that satisfies §3.2 (replay-safe). The in-monorepo reference adapters are:

- `@motebit/persistence` — SQLite (desktop, CLI, services).
- `@motebit/browser-persistence` — IndexedDB (web, identity).
- `apps/mobile/src/adapters/expo-sqlite.ts` — Expo SQLite (mobile).
- `apps/desktop/src/tauri-storage.ts` — Tauri SQLite bridge.

Each adapter projects `memory_formed` events into a `memories` row, applies `memory_pinned` / `memory_accessed` / `memory_deleted` as row updates or tombstones, and rebuilds the projection from the event log on cold start. The live graph is always a function of the log, never the inverse.

---

## 8. Conformance

An implementation is conformant with `motebit/memory-delta@1.1` if it:

1. Emits events of the types and shapes specified in §5.
2. Tolerates the `memory_decayed` event type at receive time (§5.7).
3. Emits `memory_audit` only locally and never across a device boundary (§5.6).
4. Applies sensitivity redaction at forwarding-time per §6 when acting as a sync forwarder.
5. Projects a replay-safe live graph from the event log (§3.2).
6. Signs the synced log tail via the primitives in `@motebit/event-log` + `@motebit/crypto`.
7. When emitting `memory_promoted` (§5.8), respects the idempotency contract — a node already above the promotion threshold MUST NOT re-emit the event on subsequent reinforcement.

Non-conformance modes and their consequences:

- **Divergent payload shape** — the receiver's live graph drifts from the emitter's. Detected in practice by cross-device state comparison tests; prevented at CI by `check-spec-coverage` (invariant #9) which asserts every type named here is exported from `@motebit/protocol`.
- **Missing sensitivity classification** — forwarders default to `"none"`, which MAY leak content above the emitter's intent. Emitters MUST set `sensitivity` on every `memory_formed` event; the type is required, not optional.
- **`memory_audit` forwarding** — MUST NOT occur. Detectable at the forwarder boundary by the event-type filter; the reference implementation in `services/api/src/sync-routes.ts` does not forward this type.

---

## Change Log

| Version | Date       | Changes                                                                                                                                                                                                                                            |
| ------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.0     | 2026-04-19 | Initial spec.                                                                                                                                                                                                                                      |
| 1.1     | 2026-04-19 | Additive: `memory_promoted` event type + `MemoryPromotedPayload` (§5.8) for the tentative→absolute state transition. Reference heuristic in `@motebit/memory-graph/promotion.ts`. Paired with the Layer-1 memory index (always-loaded projection). |
