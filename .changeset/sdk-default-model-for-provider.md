---
"@motebit/sdk": minor
---

One provider-default derivation for every surface (#654 cold review). New `defaultModelForProvider(provider)` — exhaustive over `anthropic | openai | google | groq | deepseek | local-server | ollama | proxy | motebit-cloud`, with the Motebit Cloud arms returning `DEFAULT_PROXY_MODEL` — replaces the per-surface ternary chains whose fall-through arm handed Cloud users the BYOK Anthropic default, which Motebit Cloud refuses. New `MOTEBIT_CLOUD_ACCEPTED_MODELS` (the exact set the Cloud proxy admits, which the proxy now consumes), `MOTEBIT_CLOUD_AUTO_MODEL` and `motebitCloudAdmitsModel(model)`. No existing export changes; `PROXY_MODELS` and `DEFAULT_PROXY_MODEL` are unchanged.
