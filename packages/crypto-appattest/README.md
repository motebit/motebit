# @motebit/crypto-appattest

Offline Apache-2.0 verifier for Apple App Attest hardware-attestation credentials.

```bash
npm i @motebit/crypto-appattest
```

Plugs into [`@motebit/crypto`](https://www.npmjs.com/package/@motebit/crypto)'s `HardwareAttestationVerifiers` dispatcher as the `deviceCheck` verifier — called when a credential declares `platform: "device_check"`.

## Usage

```ts
import { verify } from "@motebit/crypto";
import { deviceCheckVerifier } from "@motebit/crypto-appattest";

const result = await verify(credential, {
  hardwareAttestation: {
    deviceCheck: deviceCheckVerifier({ expectedBundleId: "com.motebit.app" }),
  },
});
```

## What it verifies

1. The CBOR attestation object Apple emits from `DCAppAttestService.attestKey`.
2. The leaf + intermediate X.509 chain against the **pinned Apple App Attest root CA** — every non-leaf must carry `basicConstraints.cA === true`, every signature verified, every cert within its validity window, terminal cert DER byte-equal to the pinned root.
3. The receipt extension OID `1.2.840.113635.100.8.2` binds `SHA256(authData || clientDataHash)`.
4. `authData.rpIdHash === SHA256(bundleId)` (bundle binding).
5. **Identity binding.** The transmitted `clientDataHash` must equal `SHA-256(canonicalJson({ motebit_id, device_id, identity_public_key, attested_at, platform: "device_check", version: "1" }))` — the same body the iOS mint path signs over. A malicious native client that substitutes any other body fails here.

## Why pinned

A verifier that dynamically fetches CA certificates has no sovereign story. The pinned root is the self-attesting contract — third parties audit `APPLE_APPATTEST_ROOT_PEM` and know what chain this library accepts. Zero network; chain path, clock-skew, and OID extraction are all deterministic from Apple's published spec.

## Lower-level primitives

Beyond `deviceCheckVerifier`, the package exports a few primitives for advanced consumers (test harnesses, third-party verifiers that want to plug pieces of the chain into their own dispatcher):

- `verifyAppAttestReceipt(...)` — bare-metal entry: takes the parsed receipt + caller-supplied trust roots and returns the structured verification result. `deviceCheckVerifier` is a thin curry over this.
- `parseAppAttestCbor(bytes)` — parse the raw CBOR Apple emits from `DCAppAttestService.attestKey` into a typed `AppAttestReceipt`. Used internally; exposed for test fixtures and inspection tools.
- `APPLE_APPATTEST_FMT` — the canonical fmt-string constant (`"apple-appattest"`) used to dispatch by attestation format. Exported so other dispatchers can pattern-match without hardcoding.
- `APPLE_APPATTEST_ROOT_PEM` — the pinned Apple App Attestation Root CA, exported for audit and for `HardwareVerifierBundleConfig.appAttestRootPem` overrides in `@motebit/verify`.

## Related

- [`@motebit/crypto`](https://www.npmjs.com/package/@motebit/crypto) — dispatcher (pure permissive-floor; zero deps)
- [`@motebit/crypto-android-keystore`](https://www.npmjs.com/package/@motebit/crypto-android-keystore) — Android sibling (canonical sovereign-verifiable Android primitive)
- [`@motebit/crypto-tpm`](https://www.npmjs.com/package/@motebit/crypto-tpm) — TPM 2.0 sibling
- [`@motebit/crypto-webauthn`](https://www.npmjs.com/package/@motebit/crypto-webauthn) — browser sibling
- [`@motebit/verify`](https://www.npmjs.com/package/@motebit/verify) — canonical CLI bundling the platform leaves with motebit defaults

## License

Apache-2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

"Motebit" is a trademark. The Apache License grants rights to this software, not to any Motebit trademarks, logos, or branding. You may not use Motebit branding in a way that suggests endorsement or affiliation without written permission.
