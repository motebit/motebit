---
"@motebit/crypto": minor
"@motebit/verifier": minor
---

Make the standing-delegation revocation check safe by default, and re-export the delegation family through `@motebit/verifier`.

`@motebit/crypto` adds **`findGrantRevocation(grant, revocations)`** — the consumer-side revocation check done correctly. A `DelegationRevocation` is authoritative over a grant only when it targets the `grant_id` **and** is signed by the grant's `delegator_public_key` **and** its signature verifies; matching `grant_id` alone is a foot-gun (a revocation signed by any other key is not authoritative). The helper does all three over a candidate set so a consumer builds the `verifyStandingDelegation` `isRevoked` seam without hand-rolling the key-binding. The `verifyStandingDelegation` docs now state plainly that it checks intrinsic validity (suite, signature, activation, expiry) and that **omitting `isRevoked` means a revoked grant verifies** — revocation is the caller's wired responsibility, not automatic (spec `standing-delegation-v1` §3.1 reframed to match).

`@motebit/verifier` re-exports the full delegation family so a consumer pinning the verification package validates a standing monitor's authorization root, every per-tick token, a revocation, and the grant↔revocation binding through one package: `verifyDelegation`, `verifyStandingDelegation`, `verifyTokenAgainstGrant`, `verifyDelegationRevocation`, `findGrantRevocation` (plus the `DelegationToken`, `StandingDelegation`, `DelegationRevocation` types). Like the existing `verifyApprovalDecision` re-export, these are **explicit** verifiers — a delegation's authority is its scope/chain (and, for a standing grant, the signed revocation set), not a `motebit_id → key` binding ladder resolvable from the artifact alone — so they are not auto-detected `verifyArtifact` types.
