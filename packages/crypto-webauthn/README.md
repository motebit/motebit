# @motebit/crypto-webauthn

Offline Apache-2.0 verifier for W3C WebAuthn packed-attestation hardware-attestation credentials.

```bash
npm i @motebit/crypto-webauthn
```

Plugs into [`@motebit/crypto`](https://www.npmjs.com/package/@motebit/crypto)'s `HardwareAttestationVerifiers` dispatcher as the `webauthn` verifier — called when a credential declares `platform: "webauthn"` (any browser platform authenticator).

## Usage

```ts
import { verify } from "@motebit/crypto";
import { webauthnVerifier } from "@motebit/crypto-webauthn";

const result = await verify(credential, {
  hardwareAttestation: { webauthn: webauthnVerifier({ expectedRpId: "motebit.com" }) },
});
```

## What it verifies

1. The CBOR attestation object the browser emits — `{ fmt, attStmt, authData }`.
2. **Full attestation** (`fmt: "packed"` with `x5c`): chain-verify the leaf against the **pinned FIDO root set** (Apple Anonymous Attestation, Yubico, Microsoft). Every non-leaf must carry `basicConstraints.cA === true`, terminal cert DER byte-equal to one of the pinned roots. Then `attStmt.sig` verifies over `authData || clientDataHash` using the leaf's public key and `attStmt.alg`.
3. **Self attestation** (`fmt: "packed"` without `x5c`): `attStmt.sig` verifies over `authData || clientDataHash` using the credential's own public key carried in `authData`. Scores as hardware-exported-equivalent — proves only that the credential's key signed the challenge, not that any specific vendor minted it.
4. **Identity binding.** The transmitted `clientDataHash` must equal `SHA-256(canonicalJson({ attested_at, device_id, identity_public_key, motebit_id, platform: "webauthn", version: "1" }))` — the same body the web mint path composes. A malicious page that substitutes any other body fails here.

## Scope

v1 accepts `fmt: "packed"` only. Other formats (`tpm`, `android-key`, `android-safetynet`, `fido-u2f`, `apple`, `none`) return a structured `fmt-not-supported` error. Additional formats land as additive arms + fixtures.

## Why pinned

A verifier that dynamically fetches the FIDO Metadata Service has no sovereign story. The pinned root set is the self-attesting contract — third parties audit `DEFAULT_FIDO_ROOTS` and know which vendor roots this library accepts. Rotations land as additive constants.

## Related

- [`@motebit/crypto`](https://www.npmjs.com/package/@motebit/crypto) — dispatcher (pure permissive-floor; zero deps)
- [`@motebit/crypto-appattest`](https://www.npmjs.com/package/@motebit/crypto-appattest) — iOS sibling
- [`@motebit/crypto-android-keystore`](https://www.npmjs.com/package/@motebit/crypto-android-keystore) — Android sibling (canonical sovereign-verifiable Android primitive)
- [`@motebit/crypto-tpm`](https://www.npmjs.com/package/@motebit/crypto-tpm) — TPM 2.0 sibling
- [`@motebit/verify`](https://www.npmjs.com/package/@motebit/verify) — canonical CLI bundling the platform leaves with motebit defaults

## License

Apache-2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

"Motebit" is a trademark. The Apache License grants rights to this software, not to any Motebit trademarks, logos, or branding. You may not use Motebit branding in a way that suggests endorsement or affiliation without written permission.
