# @motebit/verify

The canonical `motebit-verify` command-line tool. A single binary that verifies any signed motebit artifact — identity files, execution receipts, credentials, presentations — including credentials carrying hardware-attestation claims under any of the four canonical sovereign-verifiable platforms (Apple App Attest, Android Hardware-Backed Keystore Attestation, TPM 2.0, WebAuthn).

Network-free. No relay contact, no external service, no cloud dependency. Every trust anchor is pinned in the installed package.

```bash
npm install -g @motebit/verify
motebit-verify cred.json
```

```
VALID (credential)
  issuer:   did:key:z6MkhaXgBZDvotDkL5257...
  subject:  did:key:z6MkhaXgBZDvotDkL5257...
  expired:  no
  hardware: secure_enclave ✓
```

## What it verifies

| Artifact                    | Detection                                                       |
| --------------------------- | --------------------------------------------------------------- |
| `motebit.md` identity files | YAML frontmatter + Ed25519 proof                                |
| Execution receipts          | Signed JSON, signer keys chain                                  |
| W3C VerifiableCredentials   | `eddsa-jcs-2022` proof, hardware-attestation channel if present |
| VerifiablePresentations     | Signed envelope + every embedded credential                     |

Hardware-attestation channel covers every currently-shipped platform:

| Platform                     | Adapter                            | Trust anchor                                                                                                                                                      |
| ---------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `secure_enclave`             | `@motebit/crypto` (built-in)       | ECDSA-P256 signature; self-asserted SE public key                                                                                                                 |
| `device_check`               | `@motebit/crypto-appattest`        | Pinned Apple App Attestation Root CA                                                                                                                              |
| `tpm`                        | `@motebit/crypto-tpm`              | Pinned Infineon / Nuvoton / STMicro / Intel PTT vendor roots                                                                                                      |
| `android_keystore`           | `@motebit/crypto-android-keystore` | Pinned Google Hardware Attestation roots (RSA + ECDSA P-384)                                                                                                      |
| `webauthn`                   | `@motebit/crypto-webauthn`         | Pinned Apple / Yubico / Microsoft FIDO roots                                                                                                                      |
| `play_integrity` _(removed)_ | _(no adapter wired)_               | Removed 2026-05-03. Credentials carrying this platform fail-closed. Use `@motebit/crypto-android-keystore` instead — see `docs/doctrine/hardware-attestation.md`. |

Unknown platform → named error, fail-closed. Missing adapter context → named error, fail-closed. Never silent acceptance.

## Usage

```bash
motebit-verify <file>                     # auto-detect, print human-readable
motebit-verify <file> --json              # structured JSON output
motebit-verify <file> --expect credential # pin expected artifact type
motebit-verify <file> --clock-skew 30     # allow N seconds of clock drift

# Platform overrides (defaults match motebit's canonical identifiers)
motebit-verify <file> \
  --bundle-id com.example.app \
  --android-attestation-application-id ./app-id.bin \
  --rp-id example.com
```

**Verifying `android_keystore` credentials requires `--android-attestation-application-id`.** The flag's value is a path to a binary file containing the raw bytes of the leaf cert's `attestationApplicationId` extension — operators capture this once at build time (deterministic from the registered Android package name + signing-cert SHA-256) and commit the file alongside other pinned config. Without the flag, the Android Keystore arm is intentionally unwired (passing a placeholder would false-reject every real claim); the dispatcher reports `"verifier not wired"`.

Exit codes:

- `0` — artifact verified (including hardware-attestation channel)
- `1` — artifact detected but signature / hardware channel invalid
- `2` — usage or I/O error

## Programmatic use

The CLI is a thin wrapper — every capability is available programmatically:

```ts
import { verifyFile } from "@motebit/verifier"; // Apache-2.0 library (file I/O + formatting)
import { buildHardwareVerifiers } from "@motebit/verify"; // Apache-2.0 CLI + programmatic adapter bundle

const result = await verifyFile("cred.json", {
  hardwareAttestation: buildHardwareVerifiers(),
});
```

## The three-package lineage

This package sits at the top of a deliberate three-layer split — the same shape long-lived tool lineages use (git / libgit2, cargo / tokio, npm / @npm/arborist):

```
@motebit/verify     Apache-2.0  the CLI motebit-verify + bundled adapters  (the tool — this package)
@motebit/verifier   Apache-2.0  library: verifyFile, verifyArtifact, formatHuman
@motebit/crypto     Apache-2.0  primitives: verify, sign, suite dispatch
```

All three are Apache-2.0 with explicit patent grant — the full verification surface ships under the permissive floor. The BSL line stays at `motebit` (the operator console) and everything below it, where the motebit-proprietary judgment actually lives.

- Install **`@motebit/verify`** when you want the command-line tool with every platform bundled. One install, verify anything offline, no license friction in CI pipelines.
- Install **`@motebit/verifier`** when you're writing TypeScript code that needs to read + verify motebit artifacts programmatically and want the dep-thin library without the bundled platform adapters.
- Install **`@motebit/crypto`** when you want the primitives — the verify dispatcher, sign APIs, suite registry — to build your own verification tooling from scratch.

## Superseding the deprecated `@motebit/verify@0.x`

The original `@motebit/verify@0.7.0` was a zero-dep MIT library with a single `verify()` function. It was deprecated and split:

- **The `verify()` library primitive** moved to [`@motebit/crypto`](https://www.npmjs.com/package/@motebit/crypto). Now Apache-2.0 (upgraded from MIT — adds an explicit patent grant), same zero deps, same function shape, plus full sign / verify / cryptosuite support.
- **The file-reading + human-formatting helpers** live at [`@motebit/verifier`](https://www.npmjs.com/package/@motebit/verifier). Apache-2.0, thin layer above `@motebit/crypto`.
- **The `motebit-verify` CLI — the tool most users actually wanted when they typed `npm install @motebit/verify`** — is now this package, shipped at `1.0.0`. Runs offline. Verifies every motebit artifact. Bundles every hardware-attestation platform.

If you were on `@motebit/verify@^0.7.0`, migration depends on what you were using:

| You were using                                               | Migrate to                                                                          |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| The `verify()` function in TypeScript                        | `import { verify } from "@motebit/crypto"` — same shape, more features              |
| `verifyFile()` / `formatHuman()` / programmatic CLI wrappers | `import { ... } from "@motebit/verifier"`                                           |
| Running `motebit-verify` on the command line                 | `npm install -g @motebit/verify` at `^1.0.0` — same command, full platform coverage |

## Related

- [`@motebit/verifier`](https://www.npmjs.com/package/@motebit/verifier) — Apache-2.0 library underneath this CLI (`verifyFile`, `verifyArtifact`, `formatHuman`)
- [`@motebit/crypto`](https://www.npmjs.com/package/@motebit/crypto) — Apache-2.0 primitives (`verify`, `sign`, suite dispatch; zero monorepo deps)
- [`@motebit/crypto-appattest`](https://www.npmjs.com/package/@motebit/crypto-appattest) — Apple App Attest adapter bundled into this CLI
- [`@motebit/crypto-android-keystore`](https://www.npmjs.com/package/@motebit/crypto-android-keystore) — Android Hardware-Backed Keystore Attestation adapter bundled into this CLI
- [`@motebit/crypto-tpm`](https://www.npmjs.com/package/@motebit/crypto-tpm) — TPM 2.0 EK chain adapter bundled into this CLI
- [`@motebit/crypto-webauthn`](https://www.npmjs.com/package/@motebit/crypto-webauthn) — WebAuthn packed-attestation adapter bundled into this CLI
- [`motebit`](https://www.npmjs.com/package/motebit) — reference runtime and operator console

## License

Apache-2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

"Motebit" is a trademark. The Apache License grants rights to this software, not to any Motebit trademarks, logos, or branding. You may not use Motebit branding in a way that suggests endorsement or affiliation without written permission.
