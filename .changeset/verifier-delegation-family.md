---
"@motebit/verifier": minor
---

Re-export the delegation family so a consumer pinning `@motebit/verifier` can verify a standing monitor's full authorization path without adding `@motebit/crypto` as a second dependency: `verifyDelegation`, `verifyStandingDelegation`, `verifyTokenAgainstGrant`, and `verifyDelegationRevocation` (plus the `DelegationToken`, `StandingDelegation`, and `DelegationRevocation` types).

Like the existing `verifyApprovalDecision` re-export, these are **explicit** verifiers, not auto-detected `verifyArtifact` artifact types: a delegation's authority is its scope/chain (and, for a standing grant, the signed revocation feed), not a `motebit_id → key` binding ladder resolvable from the artifact alone. A consumer that knows it is holding a grant, a per-tick token, or a revocation calls the matching verifier directly. Closes the standing-delegation@1.0 consumption path through the verification package external consumers already pin.
