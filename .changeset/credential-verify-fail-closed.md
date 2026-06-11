---
"@motebit/crypto": minor
---

Close fail-open gaps in the credential verifier and make `suite-dispatch` fail-closed on an unknown suite (cold-audit remediation).

The credential verify path under-delivered `spec/credential-v1.md`: it checked `validUntil` (expiry) but not `validFrom`, and it ignored `credentialStatus` entirely — a revoked or not-yet-valid trust/reputation credential verified as valid. Same class as the freshness fix; the spec already mandated the behavior (§2.1 makes `validFrom` REQUIRED; §6 makes credentials revocable).

- `verifyVerifiableCredential(vc, options?)` now checks `validFrom` (not-yet-valid → reject) and accepts an injected `isRevoked(statusId) => boolean` seam — mirroring the standing-delegation `isRevoked` pattern. With no seam wired the JSDoc states plainly that a `true` means "validly signed and within its validity window", NOT "not revoked". `now` defaults to the wall clock.
- The offline aggregator result (`CredentialVerifyResult`) gains `not_yet_valid?` and `revocation_unchecked?` flags: the I/O-free `verify()` cannot consult a revocation source, so it surfaces that honestly rather than implying "not revoked".
- `spec/credential-v1.md` §5.4 adds the verification foundation law (signature + expiry + `validFrom`; revocation as a source-dependent step).

`suite-dispatch` now has explicit `default:` arms: `verifyBySuite` returns `false` on an unknown suite (fail-closed, matching its doc), and `signBySuite` / `getPublicKeyBySuite` THROW (`unsupported cryptosuite: …`) rather than returning `undefined` — honoring the contract their own JSDoc promised and preventing a signer from silently shipping an unsigned artifact when a new `SuiteId` lands without a dispatch arm.

**Behavior change:** a not-yet-valid credential (future `validFrom`) and an unknown signing suite now reject/throw where they previously passed/returned undefined; both were latent fail-open/fail-silent bugs. Pass `now` to control the clock; wire `isRevoked` to enforce revocation.
