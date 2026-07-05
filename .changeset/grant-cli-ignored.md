---
"@motebit/encryption": minor
---

Standing-delegation surface re-exported through the product-vocabulary barrel (`check-app-primitives`: apps import `@motebit/encryption`, never `@motebit/crypto`): `signStandingDelegation`, `verifyStandingDelegation`, `verifyTokenAgainstGrant`, `signDelegationRevocation`, `verifyDelegationRevocation`, `findGrantRevocation` + `StandingDelegation`/`DelegationRevocation`/`SpendCeilingV1` types. First consumer: the `motebit grant` CLI (money-execution Inc 4).
