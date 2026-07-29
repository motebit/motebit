# @motebit/crypto-tpm

Offline Apache-2.0 verifier for TPM 2.0 Endorsement-Key hardware-attestation credentials.

```bash
npm i @motebit/crypto @motebit/crypto-tpm
```

Requirements: ESM-only; Node ≥ 20.

Plugs into [`@motebit/crypto`](https://www.npmjs.com/package/@motebit/crypto)'s `HardwareAttestationVerifiers` dispatcher as the `tpm` verifier — called when a credential declares `platform: "tpm"` (Windows 11 hosts, Linux-on-x86 with `/dev/tpm0`).

## Usage

```ts
import { verify } from "@motebit/crypto";
import { tpmVerifier } from "@motebit/crypto-tpm";

const result = await verify(credential, {
  hardwareAttestation: { tpm: tpmVerifier() },
});
```

## What it verifies

1. The TPM-marshaled `TPMS_ATTEST` structure (magic `0xff544347`, type `TPM_ST_ATTEST_QUOTE = 0x8018`, qualified_signer, extraData, clock_info, firmware_version, attested quote body) — hand-rolled binary parser in `src/tpm-parse.ts`.
2. The TPM Attestation Key signature over `SHA-256(TPMS_ATTEST)`.
3. The AK certificate chain against the **pinned vendor EK roots** — Infineon, Nuvoton, STMicroelectronics, Intel PTT. Every non-leaf must carry `basicConstraints.cA === true`, every signature verified under its issuer's public key, every cert within its validity window, terminal cert DER byte-equal to one of the pinned roots.
4. **Identity binding.** The quote's `extraData` must byte-equal `SHA-256(canonicalJson({ attested_at, device_id, identity_public_key, motebit_id, platform: "tpm", version: "1" }))` — the same body the desktop mint path composes. A malicious client that substitutes any other body fails here.

## What a passing verification proves — and what it does not

- **Proves** a vendor-rooted TPM 2.0 Attestation Key signed the quote, and that the quote's `extraData` names the exact Ed25519 identity key the credential claims.
- **Proves** it offline — every check is deterministic from the pinned vendor roots plus the claim bytes; no network.
- **Does not prove** the certificate is unrevoked today: vendor revocation lists are out of scope in v1 — a chain that passed once keeps passing.
- **EK privacy consideration.** The EK is a stable per-chip identity — verifiers see a durable hardware identifier; weigh what chains you share, and with whom.
- A passing result raises the credential's hardware-attestation score — additive, never an admission gate. See the [hardware-attestation doctrine](https://github.com/motebit/motebit/blob/main/docs/doctrine/hardware-attestation.md).

## Why pinned

A verifier that dynamically fetched vendor CAs has no sovereign story. The pinned vendor roots are the self-attesting contract — third parties audit `DEFAULT_PINNED_TPM_ROOTS` and know which EK CAs this library accepts. Adding a vendor is additive (one PEM constant + one accept-set entry), not a policy rewrite.

## Lower-level primitives

Beyond `tpmVerifier`, the package exports the parser internals + pinned-root constants for advanced consumers (test fabrications, third-party verifiers wiring custom dispatchers):

- `verifyTpmQuote(claim, opts)` — bare-metal entry: takes the `HardwareAttestationClaim` plus `TpmVerifyOptions` and returns the structured verification result. Parsing happens inside — the claim's `attestation_receipt` (four base64url parts: `TPMS_ATTEST`, signature, AK cert, intermediates) is split and binary-parsed internally; the trust roots are injected via `opts.rootPems` (defaults to `DEFAULT_PINNED_TPM_ROOTS`). `tpmVerifier` is a thin curry over this.
- `parseTpmsAttest(bytes)` — parse the raw TPM-marshaled binary into a typed `TpmsAttest`. Hand-rolled per TCG spec.
- `composeTpmsAttestForTest(...)` — inverse of the parser; emits canonical bytes for test fixtures so the round-trip is observable.
- `TPM_GENERATED_VALUE` (`0xff544347`) — the magic constant TPM-emitted quotes carry; format dispatchers use this to detect the structure.
- `TPM_ST_ATTEST_QUOTE` (`0x8018`) — the attestation-type tag a `TPM2_Quote` structure must carry.
- `TPM_PLATFORM` — the canonical platform-string constant (`"tpm"`) used to route by claim platform.
- `INFINEON_TPM_EK_ROOT_PEM`, `NUVOTON_TPM_EK_ROOT_PEM`, `STMICRO_TPM_EK_RSA_ROOT_PEM`, `STMICRO_TPM_EK_ECC_ROOT_PEM`, `INTEL_PTT_EK_ROOT_PEM` — the pinned vendor EK roots, exported for audit and for `HardwareVerifierBundleConfig.tpmRootPems` overrides in `@motebit/verify`.
- `DEFAULT_PINNED_TPM_ROOTS` — the default accept-set (all pinned vendor roots above), exported for audit and as the `rootPems` default in `verifyTpmQuote`.
- `STMICRO_TPM_EK_ROOT_PEM` — **deprecated** since 1.1.0, removed in 2.0.0; an alias for the ECC root. Migrate to the explicit `STMICRO_TPM_EK_RSA_ROOT_PEM` / `STMICRO_TPM_EK_ECC_ROOT_PEM` constants.

## Why a hand-rolled parser

TPM 2.0's `TPMS_ATTEST` structure is ~100 lines of big-endian length-prefixed marshaling. Pulling a full TPM library for that would cross a larger surface area than the struct we actually parse. Scoped to exactly what verification needs.

## Related

- [`@motebit/crypto`](https://www.npmjs.com/package/@motebit/crypto) — dispatcher (pure permissive-floor; zero deps)
- [`@motebit/crypto-appattest`](https://www.npmjs.com/package/@motebit/crypto-appattest) — iOS sibling
- [`@motebit/crypto-android-keystore`](https://www.npmjs.com/package/@motebit/crypto-android-keystore) — Android sibling (canonical sovereign-verifiable Android primitive)
- [`@motebit/crypto-webauthn`](https://www.npmjs.com/package/@motebit/crypto-webauthn) — browser sibling
- [`@motebit/verify`](https://www.npmjs.com/package/@motebit/verify) — canonical CLI bundling the platform leaves with motebit defaults

## License

Apache-2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

"Motebit" is a trademark. The Apache License grants rights to this software, not to any Motebit trademarks, logos, or branding. You may not use Motebit branding in a way that suggests endorsement or affiliation without written permission.
