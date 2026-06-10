---
"@motebit/protocol": minor
---

`MemorySource` — the memory-provenance closed registry (tenth registered registry per `docs/doctrine/registry-pattern-canonical.md`).

Memory candidates carried no provenance: a memory formed from a web page, a peer agent's message, or a tool result was byte-indistinguishable from one the user stated directly — the persistent-prompt-injection and hallucinated-authority channel (absorbed third-party content reads as durable user intent on recall, then informs delegation and policy).

New exports:

- `MemorySource` — `"user_stated" | "agent_inferred" | "tool_derived" | "peer_agent" | "consolidation_derived"`. `web_content` deliberately deferred until the loop can honestly distinguish web tools from other tools at formation time (registry append when it can).
- `ALL_MEMORY_SOURCES` (frozen iteration array), `isMemorySource` (type guard — inbound wire values degrade to `undefined` on mismatch, never fail open to a trusted tier).
- `MEMORY_SOURCE_MARKERS` / `MEMORY_SOURCE_MARKER_UNKNOWN` — the canonical `[from:X]` render-marker map, `Record<MemorySource, string>` so a registry append without a marker is a compile error.
- `MemoryContent.source?` / `MemoryContent.source_turn_id?` and `MemoryCandidate.source?` / `source_turn_id?` — optional on reads (legacy nodes render as provenance `unknown`, honestly absent, never fabricated). `source_turn_id` is local provenance only and never rides the wire.
- `AttributedMemoryCandidate = MemoryCandidate & { source: MemorySource | undefined }` — the asymmetric-typing enforcement (same shape as `WritableSettlementMode`): formation entry points take the attributed type, so every formation call site is a compile error until it declares a source. The key is required but the value admits explicit `undefined` — a deliberate declaration of unknown provenance for the one legitimate case (supersede inheriting from a pre-provenance legacy node); declared-unknown beats fabricated, omission stays impossible.

Wire: `MemoryFormedPayload.source?` (memory-delta@1.3, additive and replay-compatible; forwarder-immutable; canonical JSON Schema regenerated at `spec/schemas/memory-formed-payload-v1.json`).

Authorship rule (interop law, gate-enforced by `check-memory-source-canonical`, drift-defenses #122): `source` is assigned by the forming code path — never parsed from model output (no `source` attribute on `<memory>` tags) and never accepted from a peer's self-declaration (MCP writes are `peer_agent` only). Doctrine: `docs/doctrine/memory-provenance.md`.
