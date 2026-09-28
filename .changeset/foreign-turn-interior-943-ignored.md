---
"@motebit/runtime": patch
"@motebit/ai-core": patch
---

A foreign principal's turn is served none of the owner's interior (#943). Sibling: `foreign-turn-interior-943.md` (the `motebit` package that bundles this runtime).

- `@motebit/ai-core`: `runTurnStreaming` reads the per-turn mark (`deps.foreignPrincipal`) once. Every owner-store read of the loop (memory probe, pinned memories, similarity recall, the Layer-1 memory index, recent events) moved into one function, `recallOwnerInterior`, which a foreign turn skips. So a foreign turn embeds nothing against the owner's graph and writes no retrieval back to it. The turn's options are floored once by `floorForeignTurnOptions` (new `foreign-turn.ts`), which drops every `owner_interior` field and projects the `[Now]` snapshot to its substrate alone. `TURN_OPTION_FOREIGN_CLASS` classifies every `TurnOptions` field, so adding a field without deciding whether it is the owner's is a compile error.
- `@motebit/runtime`: both `sendMessage*` doors build the owner's blocks in one helper, `ownerInteriorForTurn`. For a foreign turn it reads and selects nothing: no trust-graph read, no self-model, no curiosity hints, no skill selection, and no `SkillLoaded` event. It passes only the session snapshot. `recallMemoriesForTool` (the `recall_memories` backend) returns `[]` on a foreign turn. The private `buildSelfAwareness` wrapper is inlined.
- `check-memory-source-canonical` gains scan (e), which locks both chokepoints and the runtime helper textually.
