---
"@motebit/protocol": minor
"@motebit/crypto": minor
---

Add the `ConsolidationMutationManifest` artifact family — the felt-interior binding (`docs/doctrine/felt-interior.md`, `spec/consolidation-mutation-manifest-v1.md`).

A motebit's consolidation receipt commits to structural counts only; its privacy boundary is the type. The new mutation manifest is the owner-facing adjunct: a separately-signed commitment to the exact formed/refined mutations of a cycle, joined to its counts-only receipt by `receipt_id` + `receipt_digest`. Each commitment carries a one-way `content_sha256` (never the content), plus the committed `provenance` and `sensitivity`, so a surface can prove the sentences it displays are exactly the signed cycle's mutations — the receipt never carrying memory text. Two artifacts, two privacy boundaries.

- `@motebit/protocol` — new `ConsolidationMutationManifest` + `ConsolidationMutationCommitment` types. The receipt remains unchanged (counts-only). Domain separation is by a `manifest_type` discriminator inside the signed body, under the existing `motebit-jcs-ed25519-b64-v1` suite — no new `SuiteId`.
- `@motebit/crypto` — `signConsolidationMutationManifest` / `verifyConsolidationMutationManifest` (fail-closed on suite, `manifest_type`, decode, and primitive failure), plus the shared `consolidationReceiptDigest` and `consolidationContentDigest` helpers producer and verifier use so the binding is reproducible.
