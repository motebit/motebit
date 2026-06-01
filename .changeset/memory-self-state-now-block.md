---
"@motebit/sdk": minor
---

Add `MemorySelfState` and an optional `SessionStateSnapshot.memory` field — the typed memory self-state the runtime surfaces in the AI's `[Now]` block.

This extends the existing `[Now]`-block grounding (which already prevents browser-state confabulation) to the motebit's own memory. `MemorySelfState` carries `total` (non-tombstoned nodes held), `newestAgeMs` (age of the most recent memory, or `null` when empty), and `formedThisSession` (count since the runtime woke up). The runtime composes it in `getSessionStateSnapshot()`; `@motebit/ai-core` renders it as a `Memory:` line.

It closes the self-state sibling of the browser-state hallucination: asked "are you forming memories?", the AI would read its architecture description and answer "yes" even with zero formed this session. The typed count — `0 formed this session` — is the grounded truth it now reads instead of inferring. Additive and backward-compatible; the field is optional and the `[Now]` block omits the line when absent.
