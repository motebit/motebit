---
"@motebit/ai-core": minor
---

OpenAI's gpt-5 family and o-series were 400-ing on every turn.

`OpenAIProvider` sent `max_tokens` unconditionally. The reasoning-era models reject it outright — `Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead` — so every BYOK turn against `gpt-5.4-mini`, the resolver's own default for the vendor, failed before a token was produced. They also accept only the default `temperature`, which a configured personality would have tripped independently.

This is the #476 class on the other adapter. `modelRejectsSamplingParams` was added to the Anthropic path after Opus 5 turns started 400-ing on a removed sampling parameter, and the same reasoning was never carried across the sibling boundary — so the fix existed in the repo, one file away, for the entire time OpenAI was broken.

Found by `probe-provider-live` on its first live dispatch, which is the difference between `available` and `verified` doing real work rather than describing it.

New exports:

- `OpenAiRequestShape` — `"classic" | "reasoning-era"`. A closed union rather than a boolean, because the two consequences differ in kind: one parameter is RENAMED, the other is OMITTED. A third family becomes a new member plus its branch, which the type checker then demands at both body-build sites.
- `openAiRequestShape(model)` — the classifier.

Classification is by model id, matching the Anthropic sibling, so it composes with proxies and gateways whose base URL is not the vendor's. The patterns are anchored, which matters more here than on the Anthropic path: this adapter also carries Gemini, Groq, DeepSeek and every local server, none of which accept `max_completion_tokens`. Groq's `openai/gpt-oss-120b` contains `gpt` and stays classic; a test covers each vendor so that fixing one cannot break four.

The two body-build sites (`generate`, `generateStream`) now share one builder. They had already drifted into separate copies of the same logic, so a fix applied to one would have left every streamed turn — which is every real turn — still failing.

A test asserting `max_tokens` on a `gpt-5.4-mini` config was pinning the broken shape in place; it now asserts the correct one, and the known id-dispatch limitation is pinned by its own named test rather than left undocumented.
