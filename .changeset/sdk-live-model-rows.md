---
"@motebit/sdk": minor
---

`ANTHROPIC_MODELS` now carries the full live catalog (11 ids, every one verified against `GET /v1/models` on 2026-07-30): adds `claude-fable-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-6`, `claude-sonnet-5`, and the dated legacy ids the provider still serves. Additive widening of the exported tuple — found by the new scheduled external drift gate (`check-model-catalog-drift`) on its first live run, which now keeps this snapshot honest weekly.
