# @motebit/crypto-play-integrity

Offline Apache-2.0 verifier for Google Play Integrity hardware-attestation credentials.

```bash
npm i @motebit/crypto-play-integrity
```

Plugs into [`@motebit/crypto`](https://www.npmjs.com/package/@motebit/crypto)'s `HardwareAttestationVerifiers` dispatcher as the `playIntegrity` verifier — called when a credential declares `platform: "play_integrity"`.

## Usage

```ts
import { verify } from "@motebit/crypto";
import { playIntegrityVerifier } from "@motebit/crypto-play-integrity";

const result = await verify(credential, {
  hardwareAttestation: {
    playIntegrity: playIntegrityVerifier({ expectedPackageName: "com.motebit.mobile" }),
  },
});
```

## What it verifies

1. The three-segment JWT (`header.payload.signature`).
2. `header.alg` ∈ `{ ES256, RS256 }` and `header.kid` selects a key from the **pinned Google Play Integrity JWKS**.
3. The JWT signature against the selected JWK — P-256 via `@noble/curves` for ES256; RSA via Node's `crypto` for RS256.
4. **Identity binding.** `payload.nonce` must byte-equal `base64url(SHA-256(canonicalJson({ attested_at, device_id, identity_public_key, motebit_id, platform: "play_integrity", version: "1" })))` — the same body the Kotlin mint path composes. A malicious native client that substitutes any other body fails here.
5. `payload.packageName` matches the expected Android package.
6. `payload.deviceIntegrity` meets or exceeds the required floor (default `MEETS_DEVICE_INTEGRITY`).

## Scope note

This verifier is structurally sound but **not yet production-wired for real tokens.** Google's production Play Integrity tokens are JWE-encrypted + JWS-signed; unwrapping requires either (a) Google-side decryption via API, or (b) per-app decryption keys from Play Console. Neither is yet threaded into the verifier. `GOOGLE_PLAY_INTEGRITY_JWKS` ships empty (fail-closed by default); real-token verification lights up when an operator lands the keys. See [CLAUDE.md](./CLAUDE.md) for the operator-pass checklist. The full test suite exercises every branch against fabricated JWKS.

## Why pinned

A verifier that dynamically fetches Google's key set has no sovereign story. The pinned JWKS is the self-attesting contract — third parties audit the keys this library accepts. Zero network; all verification local.

## Related

- [`@motebit/crypto`](https://www.npmjs.com/package/@motebit/crypto) — dispatcher (pure permissive-floor; zero deps)
- [`@motebit/crypto-appattest`](https://www.npmjs.com/package/@motebit/crypto-appattest) — iOS sibling
- [`@motebit/crypto-tpm`](https://www.npmjs.com/package/@motebit/crypto-tpm) — TPM 2.0 sibling
- [`@motebit/crypto-webauthn`](https://www.npmjs.com/package/@motebit/crypto-webauthn) — browser sibling
- [`@motebit/verify`](https://www.npmjs.com/package/@motebit/verify) — canonical CLI bundling all four leaves with motebit defaults

## License

Apache-2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

"Motebit" is a trademark. The Apache License grants rights to this software, not to any Motebit trademarks, logos, or branding. You may not use Motebit branding in a way that suggests endorsement or affiliation without written permission.
