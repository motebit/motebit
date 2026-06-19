---
"@motebit/crypto": minor
"@motebit/verifier": minor
---

VerificationVerdict arc, Phase A.2.1 — the receipt-path verdict producer (additive).

Adds `verifyReceiptVerdict(receipt)`, which returns the structured `VerificationVerdict` for a signed `ExecutionReceipt`, and `isFullyVerified(verdict)`, the fail-closed collapse to a single boolean. Both are re-exported from `@motebit/verifier`. The existing boolean-returning verifiers are untouched and remain authoritative.

`verifyReceiptVerdict` composes the existing primitives (`verifyExecutionReceipt` + `verifySovereignBinding`) into axes that cannot silently read as a pass: integrity (verified/invalid), identityBinding (sovereign when the motebit_id commits to the embedded key, else unverified — the embedded-key footgun named honestly), authority (`unknown` — a bare receipt has no authority dimension; not manufactured "valid"), revocation (`unchecked` — no grant context; not manufactured "fresh"), temporalBasis (`clockless`), evidenceBasis, and a first-class `repair` instruction on any failing axis.

`isFullyVerified` returns `true` ONLY when every load-bearing axis passes (integrity verified, identity bound, authority valid, revocation fresh) — STRICTER than the legacy per-function booleans by design; `unchecked`/`stale`/`unknown`/`unverified`/`revoked` all derive `false`, never a silent `true`.

Also adds `asserted` to the `RevocationFreshness.basis` enum (the evidence-grade ladder is now `asserted` < `stapled` < `ledger`): holder-asserted freshness with no external anchor, which a consumer should down-weight.

Ships with an executable conformance test for the receipt path (sovereign-but-not-pinned, tampered, embedded-key-only, no-key, malformed-key, and the fail-closed collapse). The token/grant/revocation verdict path (authority + a real revocation basis) and the versioned `spec/` corpus land in the next increment.
