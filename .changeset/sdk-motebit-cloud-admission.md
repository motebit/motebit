---
"@motebit/sdk": minor
---

One Motebit Cloud admission rule for the proxy and every client (#654 cold review R2). New `motebitCloudAdmission(model, catalog?) → { admitted, resolved }` — the alias step (new `MOTEBIT_CLOUD_MODEL_ALIASES`, lifted from the Cloud proxy, which now calls this function and keeps no private copy) followed by membership in `MOTEBIT_CLOUD_ACCEPTED_MODELS`; `"auto"` admitted; non-string / empty refused; exact match. New `MOTEBIT_CLOUD_CATALOG` and the `MotebitCloudAdmission` / `MotebitCloudCatalog` types. `motebitCloudAdmitsModel` now resolves aliases (`claude-opus`, `gpt-4o`, … are admitted, as the proxy admits them). `providerAcceptsModel("proxy" | "motebit-cloud", model)` now returns exactly `motebitCloudAdmission(model).admitted` instead of a vendor-family guess — a fix aligning it with what Cloud serves: `true` → `false` for ids Cloud refuses (`claude-sonnet-5`, unknown ids), `false` → `true` for `llama-3.3-70b-versatile`. Other providers are unchanged.
