# @motebit/crypto-tpm

Offline Apache-2.0 verifier for TPM 2.0 Endorsement-Key hardware-attestation credentials.

```bash
npm i @motebit/crypto-tpm
```

Plugs into [`@motebit/crypto`](https://www.npmjs.com/package/@motebit/crypto)'s `HardwareAttestationVerifiers` dispatcher as the `tpm` verifier — called when a credential declares `platform: "tpm"` (Windows 11 hosts, Linux-on-x86 with `/dev/tpm0`, Mac-with-T2 exposing a TPM interface).

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
3. The AK certificate chain against the **pinned vendor EK roots** — Infineon, Nuvoton, STMicroelectronics, Intel PTT. Every non-leaf must carry `basicConstraints.cA === true`, terminal cert DER byte-equal to one of the pinned roots.
4. **Identity binding.** The quote's `extraData` must byte-equal `SHA-256(canonicalJson({ attested_at, device_id, identity_public_key, motebit_id, platform: "tpm", version: "1" }))` — the same body the desktop mint path composes. A malicious client that substitutes any other body fails here.

## Why pinned

A verifier that dynamically fetched vendor CAs has no sovereign story. The pinned vendor roots are the self-attesting contract — third parties audit `DEFAULT_PINNED_TPM_ROOTS` and know which EK CAs this library accepts. Adding a vendor is additive (one PEM constant + one accept-set entry), not a policy rewrite.

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
