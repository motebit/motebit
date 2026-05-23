---
"@motebit/protocol": patch
"@motebit/sdk": patch
"@motebit/crypto": patch
---

Re-target five past-due deprecation sunsets from `removed in 2.0.0` to `removed in 3.0.0`. These symbols (sdk `OLLAMA_SUGGESTED_MODELS` / `OllamaSuggestedModel`, crypto's `VerifyResult` alias + the typed `verify` overload, protocol's trust-thresholds alias) were promised for removal in 2.0.0 but 2.0.0 shipped with them still present. 2.0.0 is immutable on npm and removing a public export is breaking (major-only), so the honest fix is to keep the trivial since-1.0.0 aliases through 2.x and remove them at the next real 3.0.0. Comment-only change — no API or behavior change.
