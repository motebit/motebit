---
"@motebit/sdk": minor
---

Current Claude models in one canonical picker (#654). `ANTHROPIC_MODELS` gains `claude-opus-5-5`. New `ANTHROPIC_PICKER` (id, label, tier) — Opus 5.5 (most capable), Sonnet 5 (recommended, the default), Haiku 4.5 (fastest) — plus `pickerModelForTier(tier)` and `pickerOptionsWithStored(stored)`, which renders a stored non-picker id (e.g. a pre-existing `claude-sonnet-4-6`) as its own selected row and never migrates it. `DEFAULT_ANTHROPIC_MODEL` moves from `claude-sonnet-4-6` to `claude-sonnet-5` (the BYOK default for callers that name no model; an explicitly configured model is unaffected); `MODEL_DEFAULT_REVIEW_BY.anthropic` → 2026-12-31. `DEFAULT_PROXY_MODEL` / `PROXY_MODELS` (Motebit Cloud) are unchanged. Every other registry id, Fable 5.1 included, stays selectable by id.
