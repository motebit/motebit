---
"@motebit/crypto": major
"@motebit/protocol": major
---

Remove the API symbols deprecated for removal in 3.0.0.

- `@motebit/crypto`: removed `verifyIdentityFile` and `LegacyVerifyResult` (deprecated since 1.0.0). Use `verify(content, { expectedType: "identity" })`, which returns the typed `VerifyResult` discriminated union (`type` discriminator + structured `errors: Array<{ message }>`).
- `@motebit/protocol`: removed `DEFAULT_TRUST_THRESHOLDS` (deprecated since 1.0.1). Use `REFERENCE_TRUST_THRESHOLDS` — a bit-identical value; the `REFERENCE_` prefix signals "reference-implementation default, implementers MAY override," not interop law.

Internal consumers (`@motebit/semiring`, `@motebit/market`) were migrated to `REFERENCE_TRUST_THRESHOLDS` and no longer re-export the alias.

## Migration

- `@motebit/crypto`: replace `verifyIdentityFile(content)` with `verify(content, { expectedType: "identity" })`. The result is a `VerifyResult` discriminated union — gate on `result.type === "identity" && result.valid`, and read the first error via `result.errors?.[0]?.message` (the old flat `result.error` field is gone). Replace any `LegacyVerifyResult` type annotations with `VerifyResult`.
- `@motebit/protocol`: replace `DEFAULT_TRUST_THRESHOLDS` with `REFERENCE_TRUST_THRESHOLDS`. The value is bit-identical; only the name changed (reference-implementation default, not interop law).
