---
"@motebit/sdk": minor
---

Add `motebitCloudPickerModels()` — the Motebit Cloud picker list (`PROXY_MODELS` filtered by `motebitCloudAdmission` for a funding tier), so every surface (web and desktop) renders the Cloud `<select>` from one source. `PROXY_MODELS` drops `claude-opus-4-7`, which Motebit Cloud refuses; it now lists no id the proxy refuses for a deposit-funded account.
