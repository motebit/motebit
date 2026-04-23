# @motebit/crypto-appattest

Apple App Attest chain-verification adapter. MIT, Layer 2. The second metabolic leaf in motebit's hardware-attestation platform lineup — sits beside `@motebit/encryption` / `@motebit/crypto` as the platform-specific verifier that `@motebit/crypto`'s `HardwareAttestationClaim` dispatcher calls when a claim declares `platform: "device_check"`.

MIT because it answers "how is this artifact verified?" against Apple's public App Attest root CA. Every step is deterministic from Apple's published spec plus the pinned public PEM. Motebit-canonical composition (default bundle IDs, CLI shape, integrity floor) lives one layer up in `@motebit/verify` (BSL), which bundles this leaf into the operator CLI.

## Why this package exists

Apple's App Attest attestation format is **X.509-shaped judgment**, not raw cryptography. Verifying it means:

1. Parsing the CBOR attestation object Apple emits from `DCAppAttestService.attestKey`.
2. Verifying the leaf + intermediate certificate chain against **the Apple App Attest root CA** (hard-pinned here — pinning the root is the self-attesting contract). The chain is built via `@peculiar/x509`'s `X509ChainBuilder`, every non-leaf is asserted to carry `basicConstraints.cA === true` (a misissued leaf presented as an intermediate is rejected even if its signature chains), every signature is verified, every cert is checked against its validity window, and the terminal cert's DER must equal the pinned root byte-for-byte.
3. Extracting the receipt extension OID `1.2.840.113635.100.8.2` and asserting it binds `SHA256(authData || clientDataHash)`.
4. Parsing the WebAuthn-shaped `authData` to assert `rpIdHash === SHA256(bundleId)`.
5. Confirming the attested body names the caller's Ed25519 identity key. Re-derived from `(motebit_id, device_id, identity_public_key, attested_at)` the caller threads in via `AppAttestVerifyOptions` / `DeviceCheckVerifierContext` — byte-identical to the Swift `CanonicalBody.encode` in `apps/mobile/modules/expo-app-attest/`. SHA-256 of the reconstructed body must equal the transmitted `clientDataHash`. A malicious native client that substitutes any other body fails here.

The pinned root is not judgment — it is Apple's published App Attest root CA, byte-identical to what every conformant Apple-attestation verifier pins. Chain-path validation, clock-skew handling, and OID extraction are deterministic from Apple's published spec. `@motebit/crypto` stays dep-thin and pure; this package metabolizes `@peculiar/x509` + `cbor2` to produce a yes/no answer the sovereign verifier consumes. Motebit-canonical composition (default bundle IDs, verifier CLI shape) stays in BSL one layer up, not here.

## Rules

1. **The Apple root is pinned in `src/apple-root.ts`.** Pinning is deliberate — a verifier that dynamically fetches CA certificates has no sovereign story. The pinned constant is the self-attesting contract: third parties audit this exact PEM and know what chain we accept.
2. **The verifier never reaches the network.** Chain verification, clock checks, OID extraction, and CBOR parsing are all synchronous and local. Apple's own receipt-refresh server is out of scope for v1 — outer chain + nonce binding + bundle binding is enough for third-party self-verification of device-attested identity.
3. **Failures are structured `{ valid: false, errors: [...] }` — never thrown.** Matches the `@motebit/crypto::HardwareAttestationVerifyResult` contract so callers pattern-match one shape across all platform adapters (SE, App Attest, future TPM / Play Integrity).
4. **Dispatch is consumer-wired, not global.** Callers pass `deviceCheckVerifier` into `@motebit/crypto::verify` as `{ hardwareAttestation: { deviceCheck } }`. The MIT package stays pure — no implicit side-effect registration, no global mutable state, no import-order dependency.
5. **Future platform adapters follow this same shape.** `@motebit/crypto-tpm` and `@motebit/crypto-play-integrity` become their own metabolic leaves with their own pinned roots and their own dispatch arms. Adding one is additive — a new leaf package plus a new `HardwareAttestationVerifiers.<platform>` optional field.

## Consumers

- `apps/mobile/src/mint-hardware-credential.ts` — iOS App Attest path; produces a `platform: "device_check"` claim.
- Any verifier (CLI `motebit verify`, relay's VC verification, third-party tools) that wants to accept device_check-attested credentials wires `deviceCheckVerifier` into `verify()`.
