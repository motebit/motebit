---
"motebit": patch
---

Motebit Cloud gets a model it serves (#654 cold review). `--provider proxy` with no `--model`, and a config `default_provider: proxy` with no `default_model`, now run `DEFAULT_PROXY_MODEL` instead of falling through to the Anthropic BYOK default, which the Cloud proxy refused on the first turn. `motebit daemon` and `motebit serve` now apply the persisted provider/model exactly as the interactive CLI does (a provider flip re-derives an implicit model; a `default_model` from another provider yields). An explicit `--model` outside the Cloud catalog on `--provider proxy` is refused at startup with the repair, instead of failing at the first turn.
