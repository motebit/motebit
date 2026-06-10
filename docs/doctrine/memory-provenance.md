# Memory provenance — source is assigned, never claimed

**Status:** shipped (tenth registered registry, 2026-06-10).
**Code:** `packages/protocol/src/memory-source.ts`, formation threading across `packages/memory-graph` / `packages/ai-core` / `packages/runtime` / `packages/reflection` / `packages/mcp-server`.
**Gate:** `check-memory-source-canonical` (drift-defenses #122).
**Siblings:** [`memory-architecture.md`](memory-architecture.md), [`typed-truth-perception.md`](typed-truth-perception.md), [`security-boundaries.md`](security-boundaries.md), [`registry-pattern-canonical.md`](registry-pattern-canonical.md).

## The problem this closes

Before this arc, `MemoryCandidate` was `{content, confidence, sensitivity, memory_type}`. A memory formed from a web page, a peer agent's message, or a tool result was **byte-indistinguishable** from one the user stated directly. That is two attack channels in one gap:

1. **Persistent prompt injection.** A one-turn injection that survives into memory becomes a standing belief — recalled across sessions and devices as unattributed fact, long after the injected turn is gone.
2. **Hallucinated authority.** "User trusts Alice with payments" reads identically whether the user said it or a web page did. Memory content then informs delegation and money movement with no way to weigh its origin.

The memory layer makes claims (_this is true about the user_) that were not attributable — a violation of [`self-attesting-system.md`](self-attesting-system.md) applied to the interior.

## The primitive

`MemorySource` — a closed registry of five provenance tiers:

| value                   | meaning                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------- |
| `user_stated`           | the user told the agent directly in conversation                                        |
| `agent_inferred`        | reflection synthesized it from observation patterns (`DerivedFrom` edges)               |
| `tool_derived`          | formed in a turn whose content came through tool results — an unverified external claim |
| `peer_agent`            | written by a remote agent through the MCP server                                        |
| `consolidation_derived` | synthesized by the idle consolidation cycle from an episodic cluster (`PartOf` edges)   |

`web_content` is deliberately deferred: today the loop cannot distinguish web tools from other tools at formation time, and a tier the producer cannot honestly assign is a lie in the schema. It splits out of `tool_derived` when the loop can (registry append — additive, one union entry + one marker + gate reference).

## The authorship rule (the load-bearing invariant)

**`source` is assigned by the forming code path — never the model, never the peer.**

- The model's `<memory>` tag carries **no** source attribute. `extractMemoryTags` has no source group; the gate scans `packages/ai-core/src` for any `<memory` pattern carrying `source=`. A model that could self-classify provenance could launder injected web content into `user_stated` — the exact self-escalation channel sensitivity tagging already has (and which the retrieval filter bounds); provenance does not repeat that mistake.
- The MCP server hard-codes `peer_agent` for remote writes and ignores any caller-supplied value (gate-scanned). A peer that could self-declare `user_stated` would mint trusted memories remotely.
- Inbound wire values (sync, replay) are validated with `isMemorySource`; unknown values degrade to `undefined` — rendered as provenance `unknown`, **never** failing open to a trusted tier, never rejecting the event (replay safety).
- Legacy nodes (formed before this arc) have no source and render as `unknown`. Do **not** backfill `user_stated` — pre-arc rows include peer- and MCP-formed memories. Honestly absent beats flatteringly wrong.

## The typed-truth triple

Per [`typed-truth-perception.md`](typed-truth-perception.md), the field ships as all three legs or it doesn't compose:

1. **Wire field** — `MemoryFormedPayload.source?` (optional, additive; `spec/memory-delta-v1.md`). `source_turn_id` stays **off the wire** — turn ids are local identifiers with no cross-device meaning.
2. **Prompt clause** — the system prompt teaches that only `[from:user]` records something the user told the agent directly; every other marker is an unverified absorbed claim, never to be presented back as user-said.
3. **Dispatch enforcement** — `AttributedMemoryCandidate = MemoryCandidate & { source: MemorySource }`. The formation entry points (`formMemory`, `consolidateAndForm`, `formMemoriesFromCandidates`) take the attributed type, so **every new formation call site is a compile error until it declares a source**. This is the asymmetric-typing shape from `WritableSettlementMode`: reads stay open (legacy nodes remain readable), writes are structurally closed.

## Rendering

Markers render **outside** the `[MEMORY_DATA]` boundary (`[from:user] [confidence=0.92] [MEMORY_DATA]…[/MEMORY_DATA]`), so memory content cannot spoof its own marker; the content escape additionally strips `[from:` inside memory bodies. The marker map is `MEMORY_SOURCE_MARKERS: Record<MemorySource, string>` in protocol — a registry append without a marker is a compile error, so the render surface cannot silently lag the registry. Both ai-core and memory-graph (memory index) consume the one map.

## What provenance is NOT

Provenance is epistemic standing, not authority. A `user_stated` memory is still memory — it informs, it never authorizes. Standing authority for money-moving and delegation actions is a signed artifact (standing-delegation grant, `ApprovalDecision`), which memory may _point to_ but never _be_. That invariant is the sibling arc: [`memory-never-confers-authority.md`](memory-never-confers-authority.md).

## Failure modes, named

- **Legacy NULL demotion**: a long-time user's genuine statements render `[from:unknown]`. Accepted — provenance cannot be retroactively attested.
- **Marker spoof in content**: handled by render-outside-boundary + `[from:` escape.
- **Peer sends future vocabulary**: degrade to `undefined`, never reject, never trust.
- **Multi-device skew**: an old device's projection drops the field; remotely-formed memories show `unknown` there until upgrade. Additive-optional is the correct trade.
