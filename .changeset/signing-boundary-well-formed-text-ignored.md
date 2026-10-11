---
"@motebit/encryption": patch
---

Re-exports the signing boundary from `@motebit/crypto` for product-vocabulary consumers: `canonicalJsonForSigning` (canonical JSON that throws `UnpairedSurrogateError` on an unpaired UTF-16 surrogate), `UnpairedSurrogateError`, and the strict readers' predicate `hasUnpairedSurrogate`.
