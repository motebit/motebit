---
"@motebit/protocol": minor
"@motebit/wire-schemas": minor
"@motebit/memory-graph": minor
"@motebit/tools": minor
---

The Memory Trinity — Layer-1 index + tentative→absolute promotion +
agent-driven rewrite. The sovereign, event-sourced answer to Claude
Code's leaked self-healing three-layer memory architecture.

**Layer-1 memory index (`@motebit/memory-graph/memory-index.ts`).**
New `buildMemoryIndex(nodes, edges, {maxBytes})` produces a compact
≤2KB list of `[xxxxxxxx] summary (certainty)` pointers over the live
graph, ranked by decayed confidence + pin bonus + connectivity. Designed
to be injected into every AI turn's system prompt at a stable offset
for prompt caching. Certainty labels: `absolute` ≥ 0.95, `confident` ≥
0.7, `tentative` otherwise. Tombstoned nodes excluded. Deterministic
ordering.

**`memory_promoted` event type (spec/memory-delta-v1.md §5.8).** Spec
bumps to v1.1. Additive event emitted when a confidence update crosses
`PROMOTION_CONFIDENCE_THRESHOLD` (0.95) from below. Paired with the
idempotency contract — no re-emission on subsequent reinforcement.
Wired into `MemoryGraph`'s REINFORCE + NOOP paths via a new private
`maybePromote` method using the pure heuristic in
`@motebit/memory-graph/promotion.ts`.

**`rewrite_memory` tool (`@motebit/tools`).** Agent-driven self-healing
path — when the motebit learns a stored claim is wrong, it corrects
the entry in-conversation by short node id (from the index) rather than
waiting for the consolidation tick. Handler emits
`memory_consolidated` with `action: "supersede"` — reuses existing wire
format, preserves the original `memory_formed` event for audit.
Sovereign-verifiability property autoDream's file rewrites can't offer.

## Protocol drift gates

- `check-spec-coverage` picks up `MemoryPromotedPayload` automatically
  (exported from `@motebit/protocol`).
- `check-spec-wire-schemas` picks up the new JSON Schema artifact at
  `packages/wire-schemas/schema/memory-promoted-payload-v1.json`.
- Additive `.passthrough()` envelope; v1.0 implementations still
  validate v1.1 payloads.

## Tests

- 12 new promotion tests in `@motebit/memory-graph/__tests__/promotion.test.ts`
- 12 new memory-index tests in `@motebit/memory-graph/__tests__/memory-index.test.ts`
- 11 new rewrite_memory tests in `@motebit/tools/__tests__/rewrite-memory.test.ts`
- All 205 memory-graph tests + 160 tools tests green
- 374 wire-schemas tests pass (184 drift cases, 4 new for memory-promoted)
