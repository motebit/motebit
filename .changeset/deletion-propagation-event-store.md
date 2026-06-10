---
"@motebit/protocol": minor
---

`EventStoreAdapter.redactMemoryContent?(motebitId, nodeId)` — the optional storage operation behind deletion propagation: erase the content of stored `memory_formed` events for a deleted memory node, replacing it with the `"[REDACTED]"` sentinel + `redacted: true` + `redacted_reason: "deleted"`. Joins the sanctioned deletion-shaped mutation family (`tombstone` / `compact` / `truncateBeforeHorizon`); the `DeleteRequested` event remains the surviving audit record. Encrypted payloads are opaque and skipped by design — the client-side key lifecycle is the erasure mechanism for ciphertext. Consumed by the relay: a synced `DeleteRequested` for a memory node now erases that node's relay-stored formation content, so a subject's signed deletion certificate is not outlived by the relay's copy.
