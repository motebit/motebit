---
"@motebit/state-export-client": minor
---

`verifyReceiptDocument` now accepts an optional `identity` (the producing motebit's identity file) and upgrades the result to the `"pinned"` binding rung when the receipt's signing key is time-valid for that identity's succession chain and the `motebit_id` matches. The binding status is now a trust-minimization ladder — `unverified` / `integrity-only` / `pinned` — replacing the placeholder `"bound"` with the rung vocabulary from `docs/doctrine/identity-binding-verification.md`. Composes `@motebit/crypto`'s `verifyKeyBindingAtTime`; the `anchored` and `sovereign` rungs layer operator non-equivocation on top in later slices.
