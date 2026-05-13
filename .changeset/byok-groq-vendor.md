---
"@motebit/sdk": minor
---

**Groq lands as the fifth `ByokVendor` — American-hosted open-source counterpart to DeepSeek.** The closed-set additive registry `ByokVendor = "anthropic" | "openai" | "google" | "deepseek"` gains `"groq"`. Same closure pattern + dispatch shape as the prior DeepSeek slice (registry append + three exhaustive-switch arms + a `*_MODELS` constant + parallel surface UIs). Fifth instance of `agility-as-role`; the pattern is now demonstrably mechanical for future open-source-via-API additions.

**Why Groq specifically as the next vendor.** Two slices ago we added DeepSeek (open-source, Chinese-hosted, cheapest) to close the founding "intelligence is pluggable" doctrine contradiction. Groq is the natural sibling: open-source weights (Meta Llama 3.3 70B + OpenAI's GPT-OSS releases), American-hosted, fastest available inference (~280 tok/sec via Groq's LPU hardware). Cross-geography parity — users uncomfortable with Chinese hosting now have a comparable open-source option without falling back to the three closed-source Big Tech providers. Two distinct optimization targets surfaced via the same selector: DeepSeek for cheapest ($0.27/M input), Groq for fastest American ($0.59/M input). Both ~5–10× cheaper than American closed-source alternatives.

**What's in the SDK surface:**

- `ByokVendor` union extended to `"anthropic" | "openai" | "google" | "deepseek" | "groq"`
- `GROQ_MODELS = ["llama-3.3-70b-versatile", "openai/gpt-oss-120b"] as const` in `models.ts` (Llama 3.3 70B is the default tool-use workhorse; GPT-OSS 120B is OpenAI's open-weights release hosted competitively only via Groq, MoE architecture comparable to GPT-4 class on tool benchmarks)
- `DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile"`
- `GROQ_CANONICAL_URL = "https://api.groq.com/openai/v1"` in `provider-resolver.ts` (note the `/openai/v1` namespace — Groq explicitly versions the OpenAI-shape API)
- `defaultModelForVendor("groq")` returns `DEFAULT_GROQ_MODEL`
- `canonicalVendorBaseUrl("groq")` returns `GROQ_CANONICAL_URL`
- Resolver's `byok` arm: Groq dispatches as `wireProtocol: "openai"` (same arm as Google / DeepSeek — Groq's hosted API is OpenAI-compatible with minor caveats around logprobs / logit_bias / certain audio formats which don't affect motebit's tool-use loop)

**Notable industry context (preserved for doctrine fidelity).** In December 2025 NVIDIA entered a $20B _non-exclusive licensing agreement_ with Groq, paying $20B to license Groq's LPU inference chip architecture and hire founder Jonathan Ross + most of the engineering leadership. Groq remains operationally independent under new CEO Simon Edwards; the API service continues unchanged. The structure is reportedly a "reverse acqui-hire" designed to avoid antitrust filing requirements (licensing deals are exempt from Hart-Scott-Rodino premerger notification). For motebit's vendor-agnostic stance this is _exactly_ the kind of consolidation the `agility-as-role` pattern absorbs cleanly — the role (foundation-model vendor accessible via OpenAI-compatible wire protocol) survives the instance's corporate relationships. Today the Groq API works as a first-class BYOK option; tomorrow, if NVIDIA fully absorbs Groq into their inference stack, the registry pattern can swap or supplement it without touching consumer code. This is the structural value of the agility-as-role discipline.

**Tests.** New "byok groq" describe block in `provider-resolver.test.ts` covering: dispatch to `wireProtocol: "openai"` at the canonical URL; default model fallback; CORS-proxy substitution via `env.cloudBaseUrl`. `defaultModelForVendor` + `canonicalVendorBaseUrl` exhaustive-vendor tests extended (now 5 vendors). Type-invariants config array gets `{ mode: "byok", vendor: "groq", apiKey: "k" }`. 49/49 SDK tests green.

**API surface.** `sdk.api.md` baseline regenerated. Additive — `@public` exports (`ByokVendor` union extension, `GROQ_CANONICAL_URL`, `GROQ_MODELS`, `DEFAULT_GROQ_MODEL`) ship with the union extension. No removals.

**Doctrine.** `docs/doctrine/agility-as-role.md` updated — "four entries" → "five entries," with the cross-geography distinguishing-axis framing (DeepSeek = cheapest Chinese, Groq = fastest American) and the NVIDIA-licensing-agreement context preserved as a doctrinal example of how the role survives instance-level corporate shifts.

Mechanical template-match against the prior DeepSeek slice. Future open-source-via-API additions (OpenRouter as meta-vendor, Together, Fireworks, Mistral La Plateforme) follow the same shape.
