# @motebit/crypto-play-integrity

Google Play Integrity JWT verifier. Apache-2.0 (permissive floor), Layer 2. Sibling of `@motebit/crypto-appattest` — the Android metabolic leaf that `@motebit/crypto`'s `HardwareAttestationClaim` dispatcher calls when a claim declares `platform: "play_integrity"`.

Permissive-floor because it answers "how is this artifact verified?" against Google's published Play Integrity JWKS. JWT parsing, algorithm dispatch (ES256 / RS256), nonce-rebinding, package binding, and the device-integrity floor are all deterministic from Google's published spec plus the pinned JWKS bytes. Apache-2.0 specifically — the patent grant matters in Google's Play Integrity domain. Motebit-canonical composition (default integrity floor, CLI shape) lives one layer up in `@motebit/verify` (BSL).

## Scope note — v1 is not-yet-production

Google's real Play Integrity tokens are **JWE (encrypted) + JWS (signed)**, not plain JWS. Two verification paths exist — neither matches the pinned-public-JWKS model this package was scaffolded under:

- **Google-side decryption.** The app POSTs the encrypted token to Google's Play Integrity API; Google returns the decoded claims. Network-bound, not self-verifying.
- **Local decryption.** The app decrypts with a per-app key downloaded from Play Console (private, never committable), then verifies the inner signature against Google's rotated signing keys.

The verifier in `src/verify.ts` is structurally sound (JWT parse → pinned-JWK sig-verify → cryptographic nonce-rebinding via `SHA256(canonical body)` → package binding → device-integrity floor → fail-closed result shape), and the full test suite exercises every branch against fabricated JWKS. But the production-key-acquisition layer is not wired. `GOOGLE_PLAY_INTEGRITY_JWKS` ships empty (fail-closed by default); no real-token verification happens until an operator picks a path and lands the keys.

See `src/google-jwks.ts` for the operator-pass checklist.

## Why this package exists

Google's Play Integrity API emits an encrypted, signed attestation token. Verifying it means:

1. Parsing the three-segment JWT (`header.payload.signature`).
2. Asserting `header.alg` ∈ `{ ES256, RS256 }` and `header.kid` selects a key from the **pinned Google JWKS**. Pinning the JWKS bytes is the self-attesting contract — a verifier that dynamically fetches Google's keys has no sovereign story, and a third party auditing our output could never reproduce the decision without trusting our fetch path.
3. Verifying the signature against the selected JWK's public key (P-256 for ES256 via `@noble/curves`; RSA for RS256 via `node:crypto` — Node-only since Play Integrity receipts are verified off-device, same as App Attest receipts).
4. Asserting `payload.nonce` byte-equals `base64url(SHA256(canonicalJson(body)))` where the body re-derives from the caller's `(attested_at, device_id, identity_public_key, motebit_id, platform, version)`. This is the cross-stack binding — without it, every other step would prove only that _some_ Android device did something, not that the Ed25519 key the credential subject claims is actually on that device.
5. Asserting `payload.packageName` equals the registered motebit Android package (the bundle-level binding).
6. Asserting `payload.deviceIntegrity` meets or exceeds the configured integrity level (default `MEETS_DEVICE_INTEGRITY` — the strict Play Integrity floor).

## Rules

1. **The Google Play Integrity JWKS is pinned in `src/google-jwks.ts`.** Same invariant as the App Attest pinned root: pinning is deliberate, audit-friendly, and is the only way a third party can reproduce our verification decision. When Google rotates keys (they do, on their published schedule), landing a new JWKS entry is a named commit — never a dynamic fetch.
2. **The verifier never reaches the network.** JWT parse, JWKS lookup, ES256/RS256 verify, nonce derivation, package-name check, and device-integrity gate are all synchronous (or purely-local-async for RS256's `node:crypto` path). Google's own attestation-refresh endpoint is out of scope for v1 — outer JWT signature + nonce binding + package binding + device-integrity level + motebit identity binding is enough for third-party self-verification.
3. **Failures are structured `{ valid: false, errors: [...] }` — never thrown.** Matches `@motebit/crypto::HardwareAttestationVerifyResult` so callers pattern-match one shape across SE / App Attest / Play Integrity / future TPM adapters.
4. **Dispatch is consumer-wired, not global.** Callers pass `playIntegrityVerifier(...)` into `@motebit/crypto::verify` as `{ hardwareAttestation: { playIntegrity } }`. The permissive-floor package stays pure — no implicit side-effect registration, no global mutable state.
5. **Identity binding is cryptographic, not name-based.** The nonce MUST be `base64url(SHA256(canonicalJson({ attested_at, device_id, identity_public_key, motebit_id, platform: "play_integrity", version: "1" })))` — byte-identical to the canonical body the Kotlin mint path composes in `apps/mobile/modules/expo-play-integrity/`. A malicious native client that substitutes any other body fails the nonce comparison here.

## Consumers

- `apps/mobile/src/mint-hardware-credential.ts` — Android Play Integrity path; produces a `platform: "play_integrity"` claim.
- Any verifier (CLI `motebit verify`, relay's VC verification, third-party tools) that wants to accept Play Integrity-attested credentials wires `playIntegrityVerifier` into `verify()`.
