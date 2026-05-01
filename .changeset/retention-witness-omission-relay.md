---
"@motebit/crypto": minor
---

Retention phase 4b-3 commit 4 — relay-side witness solicitation endpoints + horizon-advance flow.

Adds three additive primitives to `@motebit/crypto` consumed by `services/relay`'s new horizon-advance machinery:

`canonicalizeHorizonWitnessRequestBody(body)` — produces canonical signing bytes for the `HorizonWitnessRequestBody` wire shape. Byte-equal to `canonicalizeHorizonCertForWitness` over the corresponding full cert (since the latter strips `witnessed_by[]` + `signature`); exposed as a separate helper so call sites pass the wire-shaped request body directly without synthesizing a full cert.

`signHorizonWitnessRequestBody(body, privateKey)` — produces a base64url-encoded Ed25519 signature over the canonical bytes. Used by BOTH the issuer (for `WitnessSolicitationRequest.issuer_signature`) AND each peer witness (for `WitnessSolicitationResponse.signature`). Both roles sign byte-equal canonical bytes by design (session-3 sub-decision: issuer-signature payload IS witness-signature payload). The peer's verify-issuer + sign-as-witness paths share canonical-bytes derivation through this primitive — drift-impossible.

`verifyHorizonWitnessRequestSignature(body, signatureBase64Url, issuerPublicKey)` — peer-side fail-closed gate. Returns `false` on any malformed signature, suite mismatch, or hash failure — never throws. Same contract as `verifyBySuite`.

Why these land in `@motebit/crypto` rather than inline at the relay: the new wire shape `HorizonWitnessRequestBody` (commit 3) needed canonical-bytes machinery that didn't exist (`canonicalizeHorizonCertForWitness` operated on full certs, not the request body). Per relay rule 1 ("never inline protocol plumbing"), services consume primitives from the package layer. Adding the three primitives here is what the rule mandates, not creep around it.

Backwards-compatible. All three exports additive; no rename, no break.

The relay-side consumer (`services/relay/src/horizon.ts` orchestrator + two new federation endpoints + per-store ledger truncate adapters + revocation-events horizon loop replacing the old `cleanupRevocationEvents` informal-TTL purge) ships under `@motebit/relay` (in changeset-ignored list — private package).
