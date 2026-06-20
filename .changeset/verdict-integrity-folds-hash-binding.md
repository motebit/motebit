---
"@motebit/crypto": minor
"@motebit/verifier": minor
---

VerificationVerdict: `verifyReceiptVerdict` integrity now folds STRICT hash binding, not just the Ed25519 signature. Surfaced by consumer #2's parity run against the conformance corpus (their verifier enforces strict binding as load-bearing doctrine).

`integrity: "verified"` now requires BOTH a valid signature AND `result_hash == hex(SHA-256(result))`. A valid signature over a receipt whose `result_hash` does not bind `result` is a self-inconsistent receipt — a valid signature over a lie — exactly the silent-true this reshape exists to kill (the sovereign-check-was-theater failure mode). It now reads `integrity: "invalid"` with a distinct `integrity.hash_inconsistent` repair, separate from `integrity.signature_invalid` (a bad/altered signature) and `integrity.no_key` (no usable embedded key).

This refines the unreleased receipt-path producer (Phase A.2.1); the boolean verifiers are untouched (`verifyReceipt`'s strict hash binding stays opt-in via `strictHashBinding`). The conformance corpus is regenerated: valid cases carry real digests, and a new `receipt-signed-hash-inconsistent` vector exercises the hash-inconsistent-but-validly-signed case alongside the bad-signature case.
