---
"@motebit/sdk": minor
---

**Foundation-model agility — DeepSeek lands as the fourth `ByokVendor`.** The closed-set additive registry `ByokVendor = "anthropic" | "openai" | "google"` gains `"deepseek"`. Fourth instance of `agility-as-role` (alongside cryptosuite agility, permissive-floor, settlement-rail custody split); the role is "foundation-model vendor accessible via OpenAI-compatible (or Anthropic's) wire protocol." Same closure pattern as `SuiteId` — additive at the registry, exhaustive-switch enforced at the dispatch, baseline-locked at the api-extractor surface.

**Why this fourth instance.** Motebit's founding doctrine claim from `CLAUDE.md` — _"A motebit is a droplet of intelligence under surface tension. You own the identity. The intelligence is pluggable."_ — was structurally contradicted by a 3-vendor BYOK registry of exclusively-expensive Big Tech providers (Anthropic, OpenAI, Google). Adding DeepSeek restores the doctrinal claim: the registry stays closed at the wire-vocab boundary (per `protocol/CLAUDE.md` rule 5) but the additive shape demonstrates "pluggable" is real. DeepSeek V3 (`deepseek-chat`) is roughly Claude-Sonnet-class on tool-use benchmarks at ~10× cheaper pricing ($0.27/M input · $1.10/M output vs Claude Sonnet's $3/$15), served via DeepSeek's OpenAI-compatible API at `https://api.deepseek.com`. The affordability path lands NOW for capital-constrained users.

**What's in the SDK surface:**

- `ByokVendor` union extended to `"anthropic" | "openai" | "google" | "deepseek"`
- `DEEPSEEK_MODELS = ["deepseek-chat"] as const` in `models.ts` (single-entry today; expandable when `deepseek-reasoner` / R1 tool-use support is verified)
- `DEFAULT_DEEPSEEK_MODEL = "deepseek-chat"` for the default-tier convention
- `DEEPSEEK_CANONICAL_URL = "https://api.deepseek.com"` in `provider-resolver.ts`
- `defaultModelForVendor("deepseek")` returns `DEFAULT_DEEPSEEK_MODEL`
- `canonicalVendorBaseUrl("deepseek")` returns `DEEPSEEK_CANONICAL_URL`
- Resolver's `byok` arm: DeepSeek dispatches as `wireProtocol: "openai"` (same arm as Google — DeepSeek's hosted API exposes the OpenAI chat-completions schema)

**Important conceptual note for integrators.** DeepSeek is _open-source weights_ served via DeepSeek's hosted API. It belongs in BYOK (cloud inference, API key) not on-device (sovereign local inference). The on-device path stays for smaller open models that fit on consumer hardware (Llama 3.2, Qwen 7B-32B, Phi-4); the BYOK-DeepSeek path is for affordable cloud access to a Sonnet-class open-source model. Two distinct affordability/sovereignty paths, both real, both shipping.

**Tests.** New "byok deepseek" describe block in `provider-resolver.test.ts` covering: dispatch to `wireProtocol: "openai"` at the canonical URL; default model fallback; CORS-proxy substitution via `env.cloudBaseUrl`. `defaultModelForVendor` + `canonicalVendorBaseUrl` exhaustive-vendor tests extended. Type-invariants config array gets `{ mode: "byok", vendor: "deepseek", apiKey: "k" }`.

**API surface.** `sdk.api.md` baseline regenerated. Additive — `@public` exports (`ByokVendor`, `DEEPSEEK_CANONICAL_URL`, `DEEPSEEK_MODELS`, `DEFAULT_DEEPSEEK_MODEL`) ship with the union extension. No removals; closed-set additive entry.

**Doctrine.** `docs/doctrine/agility-as-role.md` updated — fourth named instance ("Foundation-model agility") with full role/instance/migration/defense notes. The doctrine memo now closes the asymmetry it carried before this slice (the "intelligence is pluggable" doctrine claim ↔ "vendors are a closed additive registry" protocol shape now structurally aligned).

Closed-registry discipline holds. The next vendor add (OpenRouter as meta-vendor, Groq, Together, Fireworks, or any sibling) is a registry append + three dispatch arms + a default model entry + parallel surface UIs. Mechanical template-match against this slice.
