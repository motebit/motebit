---
"@motebit/crypto": minor
"@motebit/verifier": minor
---

VerificationVerdict arc, Phase A.2.2 — the token/grant/revocation verdict path, built against consumer #2's three contributed fixtures (additive).

Adds `verifyDelegationTokenVerdict(token, grant, options?)`, the structured verdict for a per-tick `DelegationToken` evaluated against its `StandingDelegation`. Re-exported from `@motebit/verifier`. The boolean verifiers (`verifyDelegation`, `verifyTokenAgainstGrant`, `verifyStandingDelegation`) are untouched and authoritative.

The path is built so the axes stay orthogonal — the heart of the reshape:

- A revoked-grant tick that is itself well-formed and in-TTL reads `authority: "valid"` + `revocation: "revoked"` (not `authority: "insufficient"`): the token genuinely was a valid tick, the only lie is the dead grant. A bare boolean would read a pass; the verdict makes that impossible.
- `temporalMode: "wall_clock" | "ordering"` selects `temporalBasis` (`local_clock` vs `clockless`). The SAME pre-minted future-slot token reads `authority: "valid"` under ordering (the wall-clock window is not consulted) and `authority: "not_yet_valid"` under wall-clock with a rolled-back clock — proving a consumer must branch on `temporalBasis`, never assume wall-clock.
- Revocation is checked over the caller's set via `findGrantRevocation`: `revoked` / `fresh` / `unchecked`, with the freshness `basis` (asserted/stapled/ledger) the consumer down-weights; no set supplied reads `unchecked`, never a silent `fresh`.

Adds `not_yet_valid` to the `AuthorityVerdict` enum and `VerdictSubject` (`ArtifactType | "delegation_token"`) as the verdict's `type` (both additive widenings). Ships with an executable conformance test: agency's three fixtures (revoked-tick-self-mint; clock-rollback ordering; clock-rollback wall-clock anti) plus supporting axis coverage (clean tick, unchecked, expired, scope-widened, unverified-identity, tampered).

`verifyDelegationTokenVerdict` added to PERMISSIVE_ALLOWED_FUNCTIONS and documented in both READMEs. The versioned `spec/` corpus and the call-site drift gate are the next increment.
