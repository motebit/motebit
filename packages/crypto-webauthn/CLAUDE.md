# @motebit/crypto-webauthn

WebAuthn platform-authenticator attestation adapter. BSL-1.1, Layer 2. Sibling of `@motebit/crypto-appattest` — the BSL metabolic leaf that `@motebit/crypto`'s dispatcher calls when a `HardwareAttestationClaim` declares `platform: "webauthn"`.

## Why this package exists

WebAuthn's packed-attestation format is **X.509-shaped judgment**, not raw cryptography. A browser invocation of `navigator.credentials.create({ publicKey: { attestation: "direct", authenticatorSelection: { authenticatorAttachment: "platform" } }})` returns a CBOR-encoded attestation object whose `attStmt.x5c` (when present) chains to one of a handful of vendor-maintained FIDO roots: Apple Anonymous Attestation, Yubico, Microsoft, Feitian, Google. Verifying the object means:

1. Parsing the CBOR attestation object the browser emits — `{ fmt, attStmt, authData }`.
2. For `fmt: "packed"` with `x5c` present (full attestation): chain-verifying the leaf against the pinned FIDO root set — every non-leaf asserted to carry `basicConstraints.cA === true`, every signature verified, every cert within its validity window, terminal cert's DER byte-equal to one of the pinned roots. Then verifying `attStmt.sig` over `authData || clientDataHash` using the leaf's public key and `attStmt.alg`.
3. For `fmt: "packed"` without `x5c` (self attestation): verifying `attStmt.sig` over `authData || clientDataHash` using the public key carried IN `authData` (the credential public key itself). Self-attestation proves only that the credential's own key signed the challenge — not that any specific vendor minted it — and scores as hardware-exported-equivalent (0.5) in the semiring.
4. Confirming the attested body names the caller's Ed25519 identity key. Re-derived from `(attested_at, device_id, identity_public_key, motebit_id, platform: "webauthn", version: "1")` the caller threads in via `WebAuthnVerifyOptions`. SHA-256 of the reconstructed body must equal the transmitted `clientDataHash` — byte-identical to the App Attest identity-binding contract.

Step 2 is the reason this lives in BSL, not MIT. **Which roots to pin** is a policy judgment. **Which `fmt` values to accept** is a policy judgment (v1 accepts only `packed`; `tpm`, `android-key`, `android-safetynet`, `fido-u2f`, `apple` are rejected with a named error). `@motebit/crypto` stays dep-thin and pure; this package metabolizes `@peculiar/x509` + `cbor2` to produce a yes/no answer the sovereign verifier consumes.

## Rules

1. **The FIDO roots are pinned in `src/fido-roots.ts`.** Pinning is the self-attesting contract — a verifier that dynamically fetches the FIDO Metadata Service has no sovereign story. Starter set at landing: Apple Anonymous Attestation CA, Yubico FIDO Root CA, Microsoft TPM-like attestation root. Comment each with its source URL; rotations land as additive constants.
2. **The verifier never reaches the network.** Chain verification, clock checks, CBOR parsing are all synchronous and local. No MDS blob fetch; no FIDO Metadata endpoint contact. Full attestation (x5c present) requires one of the pinned roots; self attestation (no x5c) verifies the credential-public-key signature only.
3. **`fmt: "packed"` only in v1.** `tpm` / `android-key` / `android-safetynet` / `fido-u2f` / `apple` / `none` return a structured `fmt-not-supported` error. Additional fmts are additive policy extensions — new arm in `verify.ts`, new test fixture.
4. **Failures are structured `{ valid: false, errors: [...] }` — never thrown.** Matches the `@motebit/crypto::HardwareAttestationVerifyResult` contract so callers pattern-match one shape across all platform adapters.
5. **Dispatch is consumer-wired, not global.** Callers pass `webauthnVerifier(opts)` into `@motebit/crypto::verify` as `{ hardwareAttestation: { webauthn } }`. The MIT package stays pure.

## Consumers

- `apps/web/src/mint-hardware-credential.ts` — Web surface; produces a `platform: "webauthn"` claim.
- Any verifier (CLI `motebit verify`, relay's VC verification, third-party tools) that wants to accept WebAuthn-attested credentials wires `webauthnVerifier` into `verify()`.
