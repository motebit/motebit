---
"@motebit/crypto-tpm": minor
---

Replace placeholder vendor EK root PEMs with real, vendor-published bytes for all four pinned TPM 2.0 vendors. Adds a fifth root: STMicroelectronics ships parallel RSA + ECC PKIs for the ST33 / STSAFE-TPM family, and both are now pinned.

## Why

The package shipped at 1.0.0 with motebit-fabricated placeholder PEMs in `tpm-roots.ts` — a "scaffolded but not wired" state explicitly noted in the file header as needing an "operator pass to swap in the real vendor bytes." The npm package description already claimed `pinned vendor EK roots (Infineon, Nuvoton, STMicro, Intel PTT)`. The placeholders made that description false: a TPM whose AK chained to any real Infineon/Nuvoton/STMicro/Intel root would be rejected by `DEFAULT_PINNED_TPM_ROOTS` because the placeholders were never the real bytes.

This pass closes that gap. Production-pinned roots now match what real TPMs actually emit. Real-fixture coverage (a captured TPM2_Quote against owned hardware) stays privacy-deferred per `docs/doctrine/hardware-attestation.md` §"Real TPM fixture coverage"; that's a separate concern from byte-pinning.

## What shipped

- `INFINEON_TPM_EK_ROOT_PEM` — real Infineon OPTIGA(TM) ECC Root CA from `https://pki.infineon.com/OptigaEccRootCA/OptigaEccRootCA.crt` (SHA-256 `cfeb02fe…`).
- `NUVOTON_TPM_EK_ROOT_PEM` — real Nuvoton TPM Root CA 2110 from `https://www.nuvoton.com/security/NTC-TPM-EK-Cert/Nuvoton%20TPM%20Root%20CA%202110.cer` (SHA-256 `4aebe77a…`).
- `INTEL_PTT_EK_ROOT_PEM` — real Intel TPM EK root from `https://upgrades.intel.com/content/CRL/ekcert/EKRootPublicKey.cer` (SHA-256 `2e1b3ba7…`).
- `STMICRO_TPM_EK_RSA_ROOT_PEM` and `STMICRO_TPM_EK_ECC_ROOT_PEM` — STSAFE RSA Root CA 02 and STSAFE ECC Root CA 02 from `https://sw-center.st.com/STSAFE/STSAFE{Rsa,Ecc}RootCA02.crt` (SHA-256 `c8f17994…` and `fd1e7b68…`). ST runs parallel RSA and ECC PKIs for currently-shipping ST33 / STSAFE-TPM chips; the EK template firmware decides which root issues a given device's chain. Both pinned.
- New test `__tests__/tpm-roots.test.ts` asserts every pinned root parses with `@peculiar/x509`, has the expected SHA-256 fingerprint committed inline as the audit anchor, has the expected vendor subject DN, is self-signed with `basicConstraints.cA=true`, and is currently within its validity window. Catches future drift before the verifier ever sees it.

## Compatibility

`STMICRO_TPM_EK_ROOT_PEM` is preserved as a deprecated alias for `STMICRO_TPM_EK_ECC_ROOT_PEM` (the modern default for most ST33 EK templates) for one minor release cycle; removed in 2.0.0. Existing imports continue to compile and now resolve to a real ST root rather than the previous placeholder.

`DEFAULT_PINNED_TPM_ROOTS` grows from 4 to 5 entries (Infineon, Nuvoton, STMicro RSA, STMicro ECC, Intel PTT). Consumers that iterate over the set need no code change. The change is `minor` because two new exports (`STMICRO_TPM_EK_RSA_ROOT_PEM`, `STMICRO_TPM_EK_ECC_ROOT_PEM`) are added and the production-pinned set expands; existing exports stay valid.
