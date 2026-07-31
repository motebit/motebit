---
"@motebit/sdk": minor
---

The local model registry catches up to 2026: `LOCAL_SERVER_SUGGESTED_MODELS` refreshes from its all-2024 table (`llama3.2`, `gemma2`, `phi3`, `qwen2`…) to the current families (`qwen3`, `gpt-oss`, `gemma3`, `llama4`, `phi4-mini`, `deepseek-r1`, `mistral-small3.2`), and `DEFAULT_LOCAL_SERVER_MODEL` moves `llama3.2` → `qwen3`. Two vendor-hint misroutes fixed (both open-weights families the prefix heuristics sent to hosted-API refusals: `gpt-oss` → openai, `deepseek-r1` → deepseek), locked by a new admissibility invariant over the whole suggested table. New export `MODEL_DEFAULT_REVIEW_BY`: every `DEFAULT_*_MODEL` carries a review-by date — defaults as perishable inventory; the scheduled drift gate goes red past a lapsed date, and the fix is a deliberate human review, never an auto-bump.
