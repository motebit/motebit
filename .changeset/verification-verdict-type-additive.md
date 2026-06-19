---
"@motebit/crypto": minor
"@motebit/verifier": minor
---

Add the `VerificationVerdict` structured-verdict type family (additive, no runtime change). This is Phase A of the VerificationVerdict arc (docs/doctrine/verify-family-fail-closed.md): the API contract that the verify family's bare booleans will eventually become, landing ahead of the coordinated major so a consumer can type its integration against it now.

The verdict carries independent axes — `integrity`, `identityBinding` (the sovereign/anchored/pinned rung), `authority`, `revocation` (a freshness _basis_ object, not a bare label), `temporalBasis`, `evidenceBasis`, and a first-class `repair` instruction — and deliberately has **no top-level `valid` boolean**, so no unknown/unchecked/stale/integrity-only result can silently read as a pass. Co-designed with consumer #2 (agency.computer): revocation freshness carries `asOf` (wall-clock + deterministic chain anchor) and `basis`; `repair` is machine-readable (code + canonical + fix).

Types exported from `@motebit/crypto` and re-exported from `@motebit/verifier`. The verify functions that return the verdict, and the fail-closed back-compat adapter, ship in the next increment; the existing boolean-returning verifiers remain authoritative until then.
