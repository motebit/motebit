---
"@motebit/crypto-webauthn": patch
---

Add a real captured-from-browser WebAuthn `packed` ceremony fixture and an end-to-end test that runs `verifyWebAuthnAttestation` against it under the production-pinned FIDO root accept-set.

## Why

The verifier shipped at 1.0.0 with comprehensive synthetic tests — every code path covered by in-process fabricated chains. That proves the LOGIC is correct. It does not, on its own, prove the verifier agrees with what real authenticator hardware emits in the wild. The trust-accumulation moat depends on hardware attestation actually working; closing the Phase 2 fixture deferral on the easiest of the four platform leaves makes the moat provable on at least one platform without further infrastructure.

## What shipped

- `src/__tests__/fixtures/yubico-packed-webauthn-rs.json` — real `packed` attestation captured from a YubiKey 5 series authenticator (AAGUID `2fc0579f-8113-47ea-b116-bb5a8db9202a`) during a registration ceremony against the `webauthn.firstyear.id.au` compatibility test site. Lifted from the kanidm/webauthn-rs reference impl's test suite with attribution; the captured bytes are real device output, not library source. The leaf chains directly to `Yubico U2F Root CA Serial 457200631` — the production root motebit already pins as `YUBICO_FIDO_ROOT_PEM`.
- `src/__tests__/verify-real-ceremony.test.ts` — three new tests that exercise the verifier against the captured ceremony:
  - validates chain + signature + RP binding against the production `DEFAULT_FIDO_ROOTS` (no test-only `rootPems` override);
  - rejects when the expected RP ID does not match the captured ceremony;
  - rejects when only a non-Yubico root is pinned (proves the pinning is load-bearing against real hardware bytes, not just synthetic ones).

Identity-binding (`clientDataJSON.challenge === SHA256(motebit canonical body)`) is by design unsatisfiable for a third-party-captured ceremony — it would require a SHA-256 preimage attack — so the real-ceremony test asserts `identity_bound: false`. The synthetic suite continues to cover identity-binding semantics.

Test-only addition. No public-API change. Patch.
