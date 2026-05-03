---
"@motebit/crypto-play-integrity": patch
---

Final release before package removal.

`@motebit/crypto-play-integrity` was deprecated 2026-04-26 in favor of `@motebit/crypto-android-keystore` (the canonical sovereign-verifiable Android primitive). The structural reason — Google publishes no global Play Integrity JWKS, so the package can't satisfy motebit's third-party-verifiability invariant — is captured in `docs/doctrine/hardware-attestation.md` § "Three architectural categories".

This 1.1.3 ships only the corrected README and package description so the npm artifact accurately states the package is removed and points consumers at the replacement. No behavioral changes; no API changes. After 1.1.3 publishes, `npm deprecate '@motebit/crypto-play-integrity@*' "Removed; use @motebit/crypto-android-keystore"` applies registry-level deprecation across all versions, and the source directory is removed from the monorepo in a follow-up commit.

The wire-format invariant is preserved: `platform: "play_integrity"` stays in `@motebit/protocol`'s `HardwareAttestationClaim` union (per protocol/CLAUDE.md rule 4 — registry entries are never removed). Credentials carrying that platform now hit the canonical dispatcher's fail-closed "verifier not wired" branch. The `playIntegrity?` optional field on `HardwareAttestationVerifiers` also remains — purely additive optional, no canonical consumer wires it. Only the `@motebit/verify` aggregator drops the wiring.
