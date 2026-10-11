---
"@motebit/memory-graph": minor
"@motebit/ai-core": patch
"motebit": patch
---

Embedding model loads fail fast, and no unit test loads the real model.

`@motebit/memory-graph`: the local embedding pipeline loads single-flight behind an injectable `setEmbeddingModelLoader` seam, bounded by `MODEL_LOAD_TIMEOUT_MS` (hash fallback past it), with onnxruntime's threaded-wasm fallback pinned off (it busy-waited the event loop when two loads overlapped after a corrupt cached model). The on-disk model cache now writes atomically (temp file + rename, same layout as transformers' FileCache), and a model that fails to load is evicted so it is re-fetched instead of failing forever. `formMemoriesFromCandidates` accepts an `embed` dependency.

`@motebit/ai-core`: loop memory formation embeds with the loop's own `embedText`.

`motebit`: test-only — the CLI's vitest config installs the shared real-model guard, and three scheduler tests inject a no-model loader.
