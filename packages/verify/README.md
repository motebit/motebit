# @motebit/verify

The canonical motebit artifact verifier. A single `motebit-verify` command that verifies any signed motebit artifact — identity files, execution receipts, credentials, presentations — including credentials carrying hardware-attestation claims under any of the four platforms (Apple App Attest, Google Play Integrity, TPM 2.0, WebAuthn).

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

Hardware-attestation channel covers all four currently-shipped platforms:

| Platform         | Adapter                          | Trust anchor                                                 |
| ---------------- | -------------------------------- | ------------------------------------------------------------ |
| `secure_enclave` | `@motebit/crypto` (built-in)     | ECDSA-P256 signature; self-asserted SE public key            |
| `device_check`   | `@motebit/crypto-appattest`      | Pinned Apple App Attestation Root CA                         |
| `tpm`            | `@motebit/crypto-tpm`            | Pinned Infineon / Nuvoton / STMicro / Intel PTT vendor roots |
| `play_integrity` | `@motebit/crypto-play-integrity` | Pinned Google JWKS                                           |
| `webauthn`       | `@motebit/crypto-webauthn`       | Pinned Apple / Yubico / Microsoft FIDO roots                 |

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
  --android-package com.example.app \
  --rp-id example.com
```

Exit codes:

- `0` — artifact verified (including hardware-attestation channel)
- `1` — artifact detected but signature / hardware channel invalid
- `2` — usage or I/O error

## Programmatic use

The CLI is a thin wrapper — every capability is available programmatically:

```ts
import { verifyFile } from "@motebit/verifier"; // MIT library (file I/O + formatting)
import { buildHardwareVerifiers } from "@motebit/verify"; // BSL CLI (adapter bundle)

const result = await verifyFile("cred.json", {
  hardwareAttestation: buildHardwareVerifiers(),
});
```

## The three-package lineage

This package sits at the top of a deliberate three-layer split — the same shape long-lived tool lineages use (git / libgit2, cargo / tokio, npm / @npm/arborist):

```
@motebit/verify     BSL  the CLI motebit-verify + bundled adapters  (the tool — this package)
@motebit/verifier   MIT  library: verifyFile, verifyArtifact, formatHuman
@motebit/crypto     MIT  primitives: verify, sign, suite dispatch
```

- Install **`@motebit/verify`** when you want the command-line tool with every platform bundled. One install, verify anything offline.
- Install **`@motebit/verifier`** when you're writing MIT-only TypeScript code that needs to read + verify motebit artifacts programmatically without accepting the bundled adapters' BSL terms.
- Install **`@motebit/crypto`** when you want the primitives — the verify dispatcher, sign APIs, suite registry — to build your own verification tooling from scratch.

## Superseding the deprecated `@motebit/verify@0.x`

The original `@motebit/verify@0.7.0` was a zero-dep MIT library with a single `verify()` function. It was deprecated and split:

- **The `verify()` library primitive** moved to [`@motebit/crypto`](https://www.npmjs.com/package/@motebit/crypto). Same MIT license, same zero deps, same function shape, plus full sign / verify / cryptosuite support.
- **The file-reading + human-formatting helpers** live at [`@motebit/verifier`](https://www.npmjs.com/package/@motebit/verifier). MIT, thin layer above `@motebit/crypto`.
- **The `motebit-verify` CLI — the tool most users actually wanted when they typed `npm install @motebit/verify`** — is now this package, shipped at `1.0.0`. Runs offline. Verifies every motebit artifact. Bundles every hardware-attestation platform.

If you were on `@motebit/verify@^0.7.0`, migration depends on what you were using:

| You were using                                               | Migrate to                                                                          |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| The `verify()` function in TypeScript                        | `import { verify } from "@motebit/crypto"` — same shape, more features              |
| `verifyFile()` / `formatHuman()` / programmatic CLI wrappers | `import { ... } from "@motebit/verifier"`                                           |
| Running `motebit-verify` on the command line                 | `npm install -g @motebit/verify` at `^1.0.0` — same command, full platform coverage |

## Doctrine

See [`CLAUDE.md`](./CLAUDE.md) for the architectural reasoning — why the split is physical, why `@motebit/verify` is BSL while `@motebit/verifier` and `@motebit/crypto` stay MIT, and how the three-package lineage maps onto motebit's sovereignty invariant.
