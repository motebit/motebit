# motebit/memory-delta@1.0

**Status:** Stable
**Version:** 1.6
**Date:** 2026-09-28

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

### §3.5 Bi-temporal validity invariant

A memory carries two independent time dimensions, and a conforming implementation MUST NOT conflate them:

- **Recording time** — when the motebit learned the memory. Carried by the wrapping `EventLogEntry` timestamp (Unix ms); already mandatory under §3.1.
- **Validity time** — when the fact the memory asserts is true in the world. Carried by the OPTIONAL `valid_from` / `valid_until` fields on `MemoryFormedPayload` (§5.1).

Validity fields are optional. A node without them is valid from its recording time with an open upper bound (`valid_until = null`); 1.0/1.1 logs therefore replay identically (§3.2 preserved). This separation is what lets a **backdated** memory record a `valid_from` earlier than its recording time (e.g. a fact learned in 2026 that was true from 2024) without violating the append-only invariant.

Supersession is invalidation-with-provenance, never mutation. On a `memory_consolidated` event with `action: "supersede"` (§5.5), a conforming implementation MUST set the superseded node's `valid_until` to the validity-time at which its belief ceased to hold (the event's `superseded_valid_until`, defaulting to the superseding node's `valid_from`, or the event recording time if neither is given). It MUST NOT alter the superseded node's `content`, and the `Supersedes` relation (provenance) is retained. True removal remains `memory_deleted` (§5.4).

As-of reconstruction: given a query validity-time `T`, a conforming implementation resolves "what was believed valid at `T`" by selecting live nodes whose `[valid_from, valid_until)` interval contains `T`. "Current memory" is the special case `T = now`. A memory's validity is therefore an attestable, point-in-time property — the same `recorded time ≠ effective time` separation the identity layer uses for backdated key revocation (`compromised_at`).

### §3.6 Sync transport cursor

§3.2 assumes a **complete** event log. Across devices, completeness is a property of the sync transport, and it holds only if the pull cursor is right. This section applies to the whole synced event log that memory events travel in, not only to the types in §4.

**Law: the transport cursor is the relay's ingest sequence. `version_clock` orders causality only.** A conforming implementation MUST NOT use `version_clock` as the pull cursor. Clocks are assigned by devices, and each device assigns them independently. If a device pulls "after my own highest clock N", then an event that a sibling device of the same identity published at a clock ≤ N after this device's last pull is skipped forever (#868).

- **Relay (producer).** A conforming relay stamps every event it stores with `seq`, an integer counted **per identity**. An identity's events are numbered in the order they became visible to readers, and nothing another identity writes changes those numbers. A per-identity count keeps a cursor from revealing any other identity's write volume or timing. The relay MUST assign `seq` inside the same atomic write that stores the event. It MUST NOT reuse a `seq`, even after the event is deleted. So the number comes from a counter that only ever increases, never from the largest `seq` still stored plus one. It MUST ensure that a reader who can see an identity's `seq` S can also see every smaller `seq` of that identity that will ever become visible. In the reference relay, a trigger inside the INSERT increments the identity's counter row, on a single-writer SQLite database, so commit order equals `seq` order (`services/relay/src/event-seq.ts`). An event that becomes visible again after it was deleted takes a new `seq`.
- **Pull.** `GET /sync/:motebitId/pull?after_seq=<n>[&limit=<m>]` returns the identity's events with `seq > n`, in `seq` order, at most `m` of them. `m` defaults to 1000, and so does its maximum; a larger value is served as 1000. Each event carries its `seq`. The response also carries `after_seq`, `next_seq` (the largest `seq` in the page, or `n` when the page is empty), `has_more` (more events follow `next_seq`) and `latest_seq`. `latest_seq` is the largest `seq` the relay has ever assigned the identity, so a retention delete never lowers it. The read is bound to the authenticated identity, like a push. A request without `after_seq` is answered exactly as before, by `after_clock`. This keeps clients from before this section working unchanged. A client MAY send both parameters. A relay from before this section ignores `after_seq`, and the client then reads the clock-shaped answer.
- **Client (consumer).** A conforming client keeps, for each local store, relay stream (relay origin plus `motebit_id`) and **mode** (raw or end-to-end encrypted), the largest `seq` it has **durably processed**. Keying by mode keeps a raw pull and an encrypted pull over the same store from advancing each other's cursor. The client processes each page in this order:
  1. It deduplicates by `event_id` against the local store, **before decrypting anything**. An event it already holds is never decrypted again; after a key rotation, that is the whole pre-rotation history.
  2. It decodes each remaining event **on its own**. An event the client cannot decrypt (a rotated-away key, an unknown key version, corrupt ciphertext) MUST NOT stop the stream. The client records it durably with its `event_id`, `seq` and reason, reports it, does not apply it, and moves past it. The record is **bounded**: after a key rotation, every pre-rotation event the device does not already hold lands there. A conforming client keeps at most a fixed number of the most recent rows per cursor (the reference implementation keeps 1000). It prunes the oldest in the same write that adds a row, and keeps a running total of every skip recorded.
  3. A raw path MUST NOT apply an end-to-end-encrypted payload. That ciphertext is useless there, and holding it under its `event_id` would make the encrypted path over the same store discard the real event as a duplicate. On a raw path this is expected, not an error. The client counts such events and moves past them, and it writes no row per event. The encrypted path over the same store applies them under its own cursor.
  4. It appends the remaining events. Only then does it advance the cursor.

  A missing, lost or lagging cursor costs a re-download and never loses an event, so pulling from `seq` 0 is always safe. A pull from 0 also re-appends events the client had compacted out of its local log (deduplication is against what the store holds); this regrows the log until the next compaction and has no state effect, because appended events never overwrite state. `seq` is transport metadata, and a client MUST NOT store it in the entry. If `latest_seq` is below the client's cursor, the relay's sequence went backwards (for example, a restored database), and the client restarts from 0.

- **Push (the client's own events).** A conforming client keeps, for each local store and relay stream, a **push cursor**: the largest `version_clock` such that the relay has **acknowledged** every local event at or below it. It MUST NOT set the push cursor from a local maximum read at any other moment — an event appended while a sync awaits its pull, or any event past the first batch of a backlog, would never leave the device (#914). It moves the cursor only after an acknowledgment, and only past a clock whose every local event was acknowledged (or pulled from that relay, which therefore holds it); it computes that from **every** local event above the cursor, never from a `limit`-bounded read (a store's `limit` need not be clock-ordered). A push drains the backlog batch by batch, bounded per sync, continuing on the next sync. The cursor is persisted after the acknowledgment, so a crash in between re-pushes and never loses. This rule is sound only when every local append takes a clock above every event already stored (an atomic clock assignment); a store that assigns clocks by a non-atomic read-then-insert can place a concurrent append at or below the cursor, where it is never pushed (tracked in #964). A re-push is harmless: the relay stores each `event_id` once and keeps the first write. An acknowledgment is an HTTP 2xx for the pushed events, or on the socket the `ack` frame answering a push frame. A push frame MAY carry a `push_id` (a string of at most 64 characters); a relay that receives one echoes it in that frame's `ack` (additive: a frame without one gets the unchanged `ack`). An `ack` that names no frame can be credited only to the oldest frame in flight, so a client MUST keep one push frame in flight until it has seen the relay echo `push_id`; after that it MAY overlap frames and credit each `ack` to the frame it names; it MUST NOT credit an `ack` that names no frame while more than one frame is in flight on that socket (a relay may be rolled back to a version that does not echo), and treats such an `ack` as losing every frame on the socket. An event a relay's own stream has served to the client (a pull page from that relay) is held by that relay and counts as acknowledged by it — never by another relay the client later pushes to. A `push refused` error, or a socket that closes first, is no acknowledgment for the frames in flight on it. A push MUST be bounded, so one push that never answers cannot hold back later syncs — but a deadline changes only ADAPTATION, never the fate of work that is progressing or could still complete (#914 round 7). A missed deadline MUST NOT close a live socket, fail a frame in flight, or end a request attempt: the reference client lets the next push overlap the slow one; it starts a second attempt beside a slow one only on evidence that the connection is dead — a small probe (the clock) answers while the request has had no byte (the one exception to never re-sending work in flight) — and sizes pull pages from measured answer times, so a relay that is merely slow to answer is waited on, never answered with ever-smaller requests. A sync that has waited its patience for a slow answer ends without failing it; the push or pull continues and a later sync joins it rather than repeating it. A connection the client retires (a token refresh) drains the frames still on it rather than abandoning them. The late answer still counts: a frame's `ack` moves the cursor whenever it arrives, even in a later sync, and a frame still in flight is never re-sent. Work is given up only on evidence that it cannot complete: the socket closes or errors, the relay refuses over its rate limit, or the link is silent — the reference client re-sends a socket frame when a frame sent after it on the same socket was answered and one more deadline passed (the relay dropped it), drops a socket that has answered no push frame for 64 ack deadlines — inbound events do not count — and ends a request attempt with no byte for 64 deadlines, never for its total time. A client that abandons a stalled sync MUST first ask the transport whether it has live work (an attempt within its silence cap, a frame in flight on the current socket) and MUST NOT abandon one that has; when it does abandon, it ends that sync's requests. An abort MUST be classified by who ordered it (the reference client sets its own flag before calling `abort()`), never by `AbortSignal.reason`, which some runtimes (React Native's `abort-controller`) do not carry. What a client learns about a link (page and frame sizes) belongs to the relay stream, not to one connection or adapter instance, so a client that reconnects every cycle still converges. A client SHOULD deliver its pushes in clock order, which a client still pulling by clock relies on, and SHOULD pace socket push frames under the relay's message limit, which the reference relay keys per device (100 messages per 10 s), sending a batch appended together as one frame.

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
- `source` (`MemorySource`, optional) — One of `"user_stated" | "agent_inferred" | "tool_derived" | "peer_agent" | "consolidation_derived"`. Provenance of the asserted fact — who contributed it. Emitter-authored by the FORMING CODE PATH: never parsed from model output (the `<memory>` tag carries no source attribute) and never accepted from a peer's self-declaration (remote writes are `"peer_agent"`, hard-coded). Forwarder-immutable. Absent ⇒ formed before provenance tracking; receivers MUST validate inbound values against the closed registry and treat unknown vocabulary as absent — never as a trusted tier, never as grounds to reject the event (§3.2 replay safety). `spec/schemas/memory-formed-payload-v1.json` carries the canonical JSON Schema. Doctrine: `docs/doctrine/memory-provenance.md`.
- `redacted` (`true`, optional) — Present only after a sync forwarder has replaced `content`. Original events MUST NOT carry this field.
- `redacted_sensitivity` (`SensitivityLevel`, optional) — Present when `redacted === true` so downstream receivers retain the policy classification even without content.
- `redacted_reason` (`"deleted"`, optional) — Discriminates WHY `content` is the `"[REDACTED]"` sentinel. Absent ⇒ sync-forwarder _sensitivity_ redaction (§6): the original content still exists on the emitter and MAY be re-requested over an authenticated path. `"deleted"` ⇒ a _deletion tombstone_ propagated by the forget path (§6.1): the content is gone for good and a conforming consumer MUST NOT re-form a node from it. Both mechanisms blank `content`; this field is the sole discriminator between "stripped, recoverable" and "erased, terminal".
- `valid_from` (number, optional) — Unix ms. Validity-time start of the asserted fact (§3.5) — when it became true in the world, which MAY predate the recording timestamp (backdated memory). Absent ⇒ the wrapping event's recording timestamp.
- `valid_until` (number | null, optional) — Unix ms, or `null`. Validity-time end of the asserted fact. Absent or `null` ⇒ an open interval (still true). A later `memory_consolidated` supersession (§5.5) is the normal way this transitions from open to closed.

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
- `superseded_valid_until` (number | null, optional) — Present only on `"supersede"` actions. Unix ms validity-time at which the superseded (`existing_node_id`) belief ceased to hold; a conforming consumer sets `valid_until` on that node to this value (§3.5). Absent ⇒ defaults to the superseding node's `valid_from`, or this event's recording time. This carries the value onto the existing node — it does NOT introduce a separate invalidation field on the wire.

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

**Tier 2 — sync forwarder.** A sync engine or relay forwarding the event to a peer device consults the forwarder's policy. Default policy: `"none"` and `"personal"` pass through; `"medical"`, `"financial"`, `"secret"` trigger redaction. Redaction replaces `content` with the sentinel string `"[REDACTED]"` and adds `redacted: true` + `redacted_sensitivity: <level>`. The reference implementation lives at `services/relay/src/sync-routes.ts:redactSensitiveEvents`.

**Tier 3 — receiver.** The receiver consuming the event stores it verbatim — redacted or not. Display layers MAY request the non-redacted event from the emitter device via a separate authenticated path, but MUST NOT attempt to reconstruct the content from other events.

Non-content events (§5.2–§5.5, §5.7) carry no sensitivity classification because they carry no content. `memory_audit` (§5.6) carries partial user content but is local-only by protocol — forwarders MUST NOT emit it across a device boundary under any sensitivity policy.

### 6.1 — Deletion tombstones

Sensitivity redaction (§6, Tier 2) and deletion are distinct mechanisms that both blank `content` to the `"[REDACTED]"` sentinel. They are told apart by the `redacted_reason` field (§5.1):

- **Sensitivity redaction** (`redacted: true` + `redacted_sensitivity`, no `redacted_reason`) strips content the forwarder is not permitted to relay. The original still exists on the emitter and MAY be re-requested over an authenticated path — the erasure is at the forwarding boundary, not at the source.
- **Deletion tombstone** (`redacted_reason: "deleted"`) propagates a user-initiated forget: when a `memory_deleted` (§5.4) is synced, a conforming store rewrites the matching `memory_formed` payload in place, blanking `content` and stamping `redacted_reason: "deleted"`. The content is terminally gone — a conforming consumer MUST NOT re-form a node from a `"deleted"`-tombstoned payload, and the rewrite is idempotent (re-applying it over an already-tombstoned row is a no-op). The reference producer is `EventStoreAdapter.redactMemoryContent`; the relay convergence point is `services/relay/src/deletion-propagation.ts`. Doctrine: `docs/doctrine/retention-policy.md`.

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
- **`memory_audit` forwarding** — MUST NOT occur. Detectable at the forwarder boundary by the event-type filter; the reference implementation in `services/relay/src/sync-routes.ts` does not forward this type.

---

## Change Log

| Version | Date       | Changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1.0     | 2026-04-19 | Initial spec.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 1.1     | 2026-04-19 | Additive: `memory_promoted` event type + `MemoryPromotedPayload` (§5.8) for the tentative→absolute state transition. Reference heuristic in `@motebit/memory-graph/promotion.ts`. Paired with the Layer-1 memory index (always-loaded projection).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 1.2     | 2026-05-23 | Additive: bi-temporal validity (§3.5). Optional `valid_from` / `valid_until` on `MemoryFormedPayload` (§5.1) and `superseded_valid_until` on `MemoryConsolidatedPayload` (§5.5) separate recording time from validity time — enabling backdated memory and as-of reconstruction. All fields optional; 1.0/1.1 logs replay identically. The in-store half (`valid_from`/`valid_until` on `MemoryContent`, set at formation + supersession, filtered in retrieval) already ships; this spec adds the **wire emission** so validity syncs across devices/federation. Doctrine: `docs/doctrine/memory-architecture.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 1.3     | 2026-06-10 | Additive: memory provenance. Optional `source` (`MemorySource`, the tenth registered closed registry) on `MemoryFormedPayload` (§5.1) — who contributed the asserted fact (`user_stated` / `agent_inferred` / `tool_derived` / `peer_agent` / `consolidation_derived`). Emitter-authored by the forming code path, never the model, never a peer's self-declaration; forwarder-immutable. Absent ⇒ pre-provenance; receivers degrade unknown vocabulary to absent — never to a trusted tier, never rejecting the event. 1.0–1.2 logs replay identically. Doctrine: `docs/doctrine/memory-provenance.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 1.4     | 2026-06-10 | Additive: deletion-tombstone discriminator. Optional `redacted_reason` (`"deleted"`) on `MemoryFormedPayload` (§5.1) + new §6.1. Distinguishes a user-initiated deletion tombstone (content terminally erased; consumers MUST NOT re-form) from sync-forwarder sensitivity redaction (original re-requestable). Already written + read by the forget path (`EventStoreAdapter.redactMemoryContent`, relay `deletion-propagation.ts`); this row brings the wire contract into line with shipped behavior. Absent ⇒ sensitivity redaction or no redaction; 1.0–1.3 logs replay identically. Doctrine: `docs/doctrine/retention-policy.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 1.5     | 2026-09-28 | Additive: the sync transport cursor law (new §3.6). The pull cursor is the relay's ingest sequence (`seq`); `version_clock` orders causality only. Clients pulled "after my own highest clock", so an event that a sibling device of the same identity published at an equal or lower clock was never pulled (#868). The relay now stamps every stored event with a per-identity `seq` in the same write that stores it, from a counter that is never decremented. `GET /sync/:id/pull?after_seq=&limit=` serves seq-ordered pages. Clients keep the largest seq they have processed for each relay stream and mode (raw or end-to-end encrypted), and deduplicate by `event_id` before decrypting. An event a client cannot decrypt is recorded (in a bounded record with a running total) and passed; it never stops the stream. A raw path never applies an encrypted payload; it counts such events and writes no row for them. A pull without `after_seq` is answered exactly as in 1.4, so every existing client keeps working. No payload changes; 1.0–1.4 logs replay identically. |
| 1.6     | 2026-09-28 | Additive: the push half of §3.6. A client's push cursor is the largest clock the relay ACKNOWLEDGED every local event at or below; it never moves to a local maximum read at another moment. Before this, the cursor was set to the local max clock after the pull, so an event appended while a sync awaited its pull, and every batch after the first of a backlog, never reached the relay (#914). The backlog drains batch by batch, bounded per sync; the cursor is persisted after the acknowledgment (a crash re-pushes, never loses); a re-push is stored once. On the socket, the `ack` answering a push frame is the acknowledgment. A deadline changes adaptation only, never the fate of work that could complete. One additive wire field: a push frame MAY carry `push_id`, echoed in its `ack`, so frames may overlap; the HTTP response is unchanged.                                                                                                                                                                                                                      |
