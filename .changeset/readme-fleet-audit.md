---
"motebit": patch
"@motebit/protocol": patch
"@motebit/crypto": patch
"@motebit/sdk": patch
"@motebit/verifier": patch
"@motebit/verify": patch
"@motebit/state-export-client": patch
"create-motebit": patch
"@motebit/crypto-appattest": patch
"@motebit/crypto-android-keystore": patch
"@motebit/crypto-tpm": patch
"@motebit/crypto-webauthn": patch
---

README fleet audit: correct every published-package README against the shipped bytes.

Highlights: the CLI README now documents the recovery arc (`motebit restore`, `motebit seed`), the `grant` standing-delegation family, `id`/`wallet`, and the `--sovereign`/`--pay-new-agents` delegate flags; `@motebit/state-export-client` fixes a wrong first parameter on `verifyManifestAgainstBytes` (raw header string, not a parsed manifest); `create-motebit`'s agent quick start adds the required `MOTEBIT_PASSPHRASE`; `@motebit/crypto-appattest` fixes a non-JCS canonical-body example that produced the wrong digest when reproduced; `@motebit/crypto` drops a function removed at 3.0.0 and documents the hardware-attestation leaf family; `@motebit/protocol`'s example now typechecks; false zero-dependency claims corrected (sdk, verifier); `@motebit/verifier` is consistently described as library-only with `@motebit/verify` as the CLI; all relative repo links replaced with absolute URLs that survive npm rendering.

An adversarial review pass then corrected two overstated scoring claims (android-keystore StrongBox, webauthn attestation_kind — both fields are surfaced but informational today), a wrong flag name (`skills audit --event-type`, also fixed in the CLI's own usage string), and an under-documented `deviceCheckContext` parameter on `verifyHardwareAttestationClaim`.
