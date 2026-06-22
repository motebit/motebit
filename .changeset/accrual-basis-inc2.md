---
"@motebit/memory-graph": minor
"@motebit/ai-core": minor
---

Felt-accumulation Inc 2 — produce the `recalled_memory` leverage moment at the real memory-graph seam.

`@motebit/memory-graph`: `recalledMemoryBasis(queryEmbedding, nodes, opts?)` mints the `recalled_memory` `AccrualBasis` in the accrual source (produced-not-authored) — the single most-similar recalled memory whose cosine similarity clears the conservative `CONSEQUENTIAL_RECALL_SIMILARITY` (0.7) bar, or `undefined` (fail-closed: no strong recall → no attribution). Similarity is computed exactly as the retrieval lens (`dotProduct(queryEmbedding, node.embedding)`) so a basis never disagrees with what retrieval already judged relevant; tombstoned nodes and embeddings shorter than the query are skipped.

`@motebit/ai-core`: `runTurnStreaming` threads the basis onto `TurnResult.accrualBasis` (optional, additive) right after memory retrieval — produced by the memory-graph accrual source, never authored by the model; absent is the fail-closed default. `runTurn` inherits it (it consumes the streaming result). A surface renders the calm in-flow attribution at Inc 3; the produced-not-authored honesty floor is locked by the Inc-5 gate `check-accrual-basis-canonical`.
