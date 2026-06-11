---
"@motebit/crypto": minor
---

`verifyRequestEnvelope` now checks freshness **by default** — closing a fail-open replay window (agency-reported, same-day post-publish).

The bug: freshness ran only when the caller passed `now`. The obvious call — `verifyRequestEnvelope(env, key, { payload, expectedAud })` — silently skipped it, shipping a **forever** replay window to any consumer who didn't know to pass a clock. This was a code-vs-spec drift in the code's direction: `spec/signed-request-envelope-v1.md` §4 already lists the staleness check as Step 2, mandatory for every verifier, with `now = Date.now()` as the default. The code under-delivered the published contract.

Fix (additive API, conforms the code to the spec):

- `now` defaults to `Date.now()` and `windowMs` to 300s, so freshness is enforced even when neither is supplied.
- New `checkFreshness?: boolean` option (default `true`) — opt out explicitly for re-verifying a _historical_ envelope outside a live request path, mirroring `verifyDelegation`'s `checkExpiry`. A live request-auth verifier MUST NOT disable it (spec §4 foundation law + §10).

**Behavior change to note:** a caller relying on the old "freshness only when `now` is passed" behavior will now reject stale envelopes by default; pass `checkFreshness: false` to restore the old behavior where that is genuinely wanted. Unlike the I/O-free `isRevoked` seam (fail-open by architectural necessity), freshness is a pure clock comparison — there was no reason to leave it off.

Spec sharpening in the same change: §4 foundation law spells out the default-on + opt-out semantics; §10 conformance names freshness explicitly; §5 documents that `aud`'s host part is a stable service identifier (not the transport `Host:`); and `seed-escrow-v1.md` §5 gains a custodian foundation law — at placement, `identity_pubkey_check` MUST equal the registered key of the placing identity, so the field is load-bearing at rest, not only at restore (agency-reported).
