# @motebit/crypto-webauthn

Offline Apache-2.0 verifier for W3C WebAuthn packed-attestation hardware-attestation credentials.

```bash
npm i @motebit/crypto @motebit/crypto-webauthn
```

Requirements: ESM-only; Node ≥ 20.

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
3. **Self attestation** (`fmt: "packed"` without `x5c`): `attStmt.sig` verifies over `authData || clientDataHash` using the credential's own public key carried in `authData`. Proves only that the credential's key signed the challenge, not that any specific vendor minted it. The result reports `attestation_kind: "self"`; the [hardware-attestation doctrine](https://github.com/motebit/motebit/blob/main/docs/doctrine/hardware-attestation.md) ranks self attestation below full attestation, and today the field is informational — nothing outside this package consumes it yet.
4. **Identity binding.** The transmitted `clientDataHash` must equal `SHA-256(canonicalJson({ attested_at, device_id, identity_public_key, motebit_id, platform: "webauthn", version: "1" }))` — the same body the web mint path composes. A malicious page that substitutes any other body fails here.

## What a passing verification proves — and what it does not

- **Proves** (full attestation) a vendor-rooted authenticator minted the credential, and (both kinds) that the attested body names the exact Ed25519 identity key the credential claims.
- **Does not prove** vendor origin under self attestation — only that the credential's own key signed the challenge; check `attestation_kind` on the result.
- **Vendor coverage is a deliberate cut**: only Apple, Yubico, and Microsoft roots are pinned. Full attestations chaining to other vendors (Feitian, Google Titan, SoloKey, …) fail BY DESIGN; new roots land as additive constants.
- **Does not prove** the authenticator is unrevoked today: no FIDO Metadata Service fetch, no revocation checking.
- A passing result raises the credential's hardware-attestation score — additive, never an admission gate. See the [hardware-attestation doctrine](https://github.com/motebit/motebit/blob/main/docs/doctrine/hardware-attestation.md).

## Scope

v1 accepts `fmt: "packed"` only. Other formats (`tpm`, `android-key`, `android-safetynet`, `fido-u2f`, `apple`, `none`) fail with a structured error in the standard `{ valid: false, errors: [...] }` shape whose message names the offending fmt — e.g. ``attestation fmt is `tpm`; only `packed` is supported in v1``. Additional formats land as additive arms + fixtures.

## Why pinned

A verifier that dynamically fetches the FIDO Metadata Service has no sovereign story. The pinned root set is the self-attesting contract — third parties audit `DEFAULT_FIDO_ROOTS` and know which vendor roots this library accepts. Rotations land as additive constants.

## Lower-level primitives

Beyond `webauthnVerifier`, the package exports the parser + pinned-root constants for advanced consumers:

- `verifyWebAuthnAttestation(claim, opts)` — bare-metal entry: takes the `HardwareAttestationClaim` plus `WebAuthnVerifyOptions` and returns the structured verification result. Parsing happens inside — the claim's attestation object is CBOR-decoded internally; the trust roots are injected via `opts.rootPems` (defaults to `DEFAULT_FIDO_ROOTS`). `webauthnVerifier` is a thin curry over this.
- `parseWebAuthnAttestationObjectCbor(bytes)` — parse the raw CBOR object the browser emits into a typed `{ fmt, attStmt, authData }` structure.
- `WEBAUTHN_FMT_PACKED` — the canonical fmt-string constant (`"packed"`) used to dispatch by attestation format.
- `APPLE_WEBAUTHN_ROOT_PEM`, `YUBICO_FIDO_ROOT_PEM`, `MICROSOFT_TPM_ROOT_PEM` — the pinned vendor roots, exported for audit and for `HardwareVerifierBundleConfig.webauthnRootPems` overrides in `@motebit/verify`.
- `DEFAULT_FIDO_ROOTS` — the default accept-set (all three pinned roots), exported for audit and as the `rootPems` default in `verifyWebAuthnAttestation`.
- `WebAuthnVerifyResult.attestation_kind` — `"full" | "self" | null`; which attestation kind the claim carried (`null` when parsing failed before the kind was known).

## Related

- [`@motebit/crypto`](https://www.npmjs.com/package/@motebit/crypto) — dispatcher (pure permissive-floor; zero deps)
- [`@motebit/crypto-appattest`](https://www.npmjs.com/package/@motebit/crypto-appattest) — iOS sibling
- [`@motebit/crypto-android-keystore`](https://www.npmjs.com/package/@motebit/crypto-android-keystore) — Android sibling (canonical sovereign-verifiable Android primitive)
- [`@motebit/crypto-tpm`](https://www.npmjs.com/package/@motebit/crypto-tpm) — TPM 2.0 sibling
- [`@motebit/verify`](https://www.npmjs.com/package/@motebit/verify) — canonical CLI bundling the platform leaves with motebit defaults

## License

Apache-2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

"Motebit" is a trademark. The Apache License grants rights to this software, not to any Motebit trademarks, logos, or branding. You may not use Motebit branding in a way that suggests endorsement or affiliation without written permission.
