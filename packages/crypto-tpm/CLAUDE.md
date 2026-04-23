# @motebit/crypto-tpm

TPM 2.0 Endorsement-Key chain-verification adapter. Apache-2.0 (permissive floor), Layer 2. Sibling of `@motebit/crypto-appattest` — the leaf `@motebit/crypto` delegates to when a `HardwareAttestationClaim` declares `platform: "tpm"`. Covers Windows (TPM 2.0 is mandatory on Windows 11), Linux-on-x86 (via `/dev/tpm0`), and Mac-with-T2-chip hosts that expose a TPM-shaped interface even though macOS itself prefers Secure Enclave.

Permissive-floor because it answers "how is this artifact verified?" against the TCG's published TPM 2.0 spec (TPMS_ATTEST marshaling, TPM2_Quote structure) and each vendor's published Endorsement-Key CA. Chain-walking, binary-struct parsing, and `extraData` identity-binding are deterministic from those public specs plus the pinned vendor roots. Apache-2.0 specifically — the patent grant matters across the TPM vendor space (Infineon, Nuvoton, STMicro, Intel). Motebit-canonical composition (which vendors to enable by default, CLI shape) lives one layer up in `@motebit/verify` (BSL).

## Why this package exists

TPM 2.0 attestation is **X.509-shaped judgment plus a binary TPMS_ATTEST structure**, not raw cryptography. Verifying it means:

1. Parsing the TPM-marshaled `TPMS_ATTEST` structure emitted by the TPM's `TPM2_Quote` command — magic (`TPM_GENERATED_VALUE = 0xff544347`), type (`TPM_ST_ATTEST_QUOTE = 0x8018`), qualified signer, extraData, clock_info, firmware_version, and the attested quote body.
2. Verifying the P-256 (or RSA-2048, per vendor) signature over `SHA-256(TPMS_ATTEST)` using the TPM's Attestation Key (AK).
3. Verifying the AK certificate's chain to the TPM vendor's Endorsement-Key CA — `@peculiar/x509`'s `X509ChainBuilder` walks issuer→subject links; every non-leaf is asserted `basicConstraints.cA === true`; the terminal cert's DER must equal one of the **pinned vendor root CAs** in `src/tpm-roots.ts`.
4. Cryptographically binding the quote's `extraData` field to the motebit's Ed25519 identity: re-derive `SHA-256(canonicalJson({attested_at, device_id, identity_public_key, motebit_id, platform: "tpm", version: "1"}))` and byte-compare against the transmitted `extraData`. A malicious native client that substitutes any other body fails here.

The pinned vendor roots are each vendor's own published EK CA — Infineon, Nuvoton, STMicroelectronics, Intel PTT. Adding another vendor is additive (new PEM in `src/tpm-roots.ts`), not a policy rewrite. Chain-path validation, clock-skew handling, and identity-binding are deterministic from the TCG spec. `@motebit/crypto` stays dep-thin and permissive-floor-pure; this package metabolizes `@peculiar/x509` and hand-rolls a minimal TPM binary parser to produce a yes/no answer the sovereign verifier consumes.

## Rules

1. **Vendor roots are pinned in `src/tpm-roots.ts`.** Pinning is deliberate — a verifier that dynamically fetched vendor CAs has no sovereign story. The pinned constants are the self-attesting contract: third parties audit the exact PEMs and know which EK roots motebit accepts. Each PEM is commented with the vendor's published URL.
2. **The verifier never reaches the network.** Chain verification, clock checks, TPM binary parsing, and identity-binding are all synchronous and local. Vendor revocation lists are out of scope for v1 — outer chain + extraData binding is enough for third-party self-verification of TPM-attested identity.
3. **Failures are structured `{ valid: false, errors: [...] }` — never thrown.** Matches the `@motebit/crypto::HardwareAttestationVerifyResult` contract so callers pattern-match one shape across all platform adapters (SE, App Attest, TPM, future Play Integrity).
4. **Dispatch is consumer-wired, not global.** Callers pass `tpmVerifier(...)` into `@motebit/crypto::verify` as `{ hardwareAttestation: { tpm } }`. The permissive-floor package stays pure — no implicit side-effect registration, no global mutable state.
5. **Hand-rolled TPM parser over dep explosion.** TPM 2.0's `TPMS_ATTEST` structure is ~100 LOC of big-endian size-prefixed marshaling. Pulling `node-tpm2-pts` (or similar) for that would cross a larger surface area than the struct we actually parse. `src/tpm-parse.ts` is scoped to exactly what verification needs: magic + type + qualified_signer length-prefix + extraData length-prefix + the clock/firmware fields we skip deterministically.

## Consumers

- `apps/desktop/src/mint-hardware-credential.ts` — Windows / Linux TPM path; produces a `platform: "tpm"` claim when `apps/desktop/src-tauri/src/tpm.rs` reports `tpm_available() === true`, otherwise cascades to the existing software fallback. macOS delegates first to the Secure Enclave path unchanged.
- Any verifier (CLI `motebit verify`, relay's VC verification, third-party tools) that wants to accept TPM-attested credentials wires `tpmVerifier({...})` into `verify()`.
