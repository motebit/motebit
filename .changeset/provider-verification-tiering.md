---
"@motebit/sdk": minor
---

Provider surfaces state what has been **witnessed**, not just what resolves.

Two wire adapters cover the whole provider matrix — `AnthropicProvider` (native) and `OpenAIProvider` (the compat shape google / groq / deepseek / local-server all ride via `base_url`) — and both adapters are live-proven. Per **vendor** the picture is different: only `anthropic` and `local-server` have ever had a real turn run through them. The rest are wired, resolvable, and expected to work, but unwitnessed — and their model ids came from training-prior knowledge rather than a vendor listing endpoint, which is the exact class that already shipped 404-ing ids once (#474).

The surfaces implied parity that does not exist. This is the honest half of #518 — the half that needs no API keys.

New exports:

- `ProviderVerification` — `"verified" | "available"`. `available` is not a warning; it distinguishes _supported_ from _witnessed_, and conflating those is how a catalog of fabricated ids ships unnoticed.
- `VerifiableProvider` — the selectable vendor set the record covers.
- `PROVIDER_VERIFICATION` — the canonical per-vendor status.
- `PROVIDER_NOTE` — the one-line disambiguation each surface renders.

`PROVIDER_NOTE.groq` carries an explicit _"Not xAI's Grok."_ The names differ by one letter and denote unrelated things — Groq is inference hardware (LPU) hosting other labs' open weights; Grok is xAI's frontier model, which motebit does not support. A picker that says only "Groq" will be misread, permanently.

Consumed by the CLI's provider-validation error and by the web + desktop BYOK pickers, which render the note from this record rather than from prose in markup — so a surface cannot drift from what has actually been witnessed, and the Groq/Grok disambiguation lives in exactly one place.

Additive only; no existing export changed.
