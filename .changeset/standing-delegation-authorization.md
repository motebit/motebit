---
"@motebit/protocol": minor
"@motebit/crypto": minor
---

Add the standing-delegation authorization primitive (standing-delegation@1.0): a `StandingDelegation` grant that authorizes minting short-lived per-tick `DelegationToken`s within a fixed scope ceiling and cadence, for a long-but-finite, revocable lifetime — the missing shape for cadence-scoped standing work ("daily research on subject S until revoked"). Unlike a `DelegationToken`, which authorizes one act and is short-lived by invariant, the standing authority lives only on the grant; each minted token stays 1h/task-scoped; revocation lives on the grant.

`@motebit/protocol` (Apache-2.0, types only): `StandingDelegation`, `DelegationRevocation`, and an optional `grant_id?` on `DelegationToken` (absent ⇒ today's standalone semantics — backward compatible).

`@motebit/crypto` (Apache-2.0): `signStandingDelegation` / `verifyStandingDelegation` (signature + `not_before` + expiry + an injected `isRevoked` seam mirroring `isAgentRevoked`), `verifyTokenAgainstGrant` (a per-tick token is a valid tick iff its own signature/expiry verify, `grant_id` matches, the grant verifies, parties match, scope narrows within the grant ceiling, and TTL ≤ `max_token_ttl_ms`), and `signDelegationRevocation` / `verifyDelegationRevocation`. Same suite (`motebit-jcs-ed25519-b64-v1`), JCS + Ed25519 + base64url conventions as `signDelegation`. Self-verifiable per crypto rule 4 — a third party verifies a standing monitor's authorization root, every per-tick token, and a revocation with only this package and the signer's public key, no relay contact.

Forced by a real external consumer (agency's standing-monitor vertical) and closes a gap that exists independently: delegation previously had no published revocation story. Revocation is terminal in v1; the canonical source of truth is the signed, offline-verifiable revocation (a relay deny-list is a cache, not the authority). Cadence is a mint/relay-side rate limit, not checked by single-token verify.

Follow-ups (separate): the committed `spec/standing-delegation-v1.md` + wire-schemas, `@motebit/verifier` integration, and the relay-side revocation feed + scheduler seam.
