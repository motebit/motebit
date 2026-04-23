---
"@motebit/protocol": major
"@motebit/sdk": major
"@motebit/crypto": major
"@motebit/verifier": major
"@motebit/verify": major
"create-motebit": major
"motebit": major
---

**@motebit/verify resurrected as the canonical CLI, three-package lineage locked in.**

The entire published protocol surface bumps to 1.0.0 in a coordinated release. What changes at npm:

- **`@motebit/verify@1.0.0`** — fresh lineage superseding the deprecated `0.7.0` zero-dep library. Ships the `motebit-verify` CLI binary with every hardware-attestation platform bundled (Apple App Attest, Google Play Integrity, TPM 2.0, WebAuthn) and motebit-canonical defaults pre-wired (bundle IDs, RP ID, integrity floor). Network-free, self-attesting. License: BSL-1.1 — the opinionated motebit composition is what's restricted; the underlying leaves sit on the Apache-2.0 permissive floor. Runs `npm install -g @motebit/verify` to get the tool.

- **`@motebit/verifier@1.0.0`** — library-only. The `motebit-verify` CLI that used to live here has moved to `@motebit/verify` (above). This package now ships only the Apache-2.0 helpers (`verifyFile`, `verifyArtifact`, `formatHuman`, `VerifyFileOptions` with the optional `hardwareAttestation` injection point). Third parties writing Apache-2.0-only TypeScript verifiers compose this with `@motebit/crypto` — and optionally any subset of the four Apache-2.0 `@motebit/crypto-*` platform leaves — without pulling BSL code.

- **`@motebit/crypto@1.0.0`** — role unchanged; version bump marks 1.0 maturity of the primitive substrate. Apache-2.0 (upgraded from MIT in the same release; the floor flip gives every contributor's work an explicit patent grant and litigation-termination clause), zero monorepo deps.

- **`@motebit/protocol@1.0.0`** — wire types + algebra. Apache-2.0 permissive floor. 1.0 signals the protocol surface is stable enough to implement against.

- **`@motebit/sdk@1.0.0`** — stable developer-contract surface. 1.0 locks the provider-resolver / preset / config vocabulary for integrators.

- **`create-motebit@1.0.0`** — scaffolder bumps to match.

- **`motebit@1.0.0`** — operator console CLI bumps to match.

The three-package lineage for verification tooling follows the pattern that survives decades — git / libgit2, cargo / tokio, npm / @npm/arborist:

```
@motebit/verify                BSL         the CLI motebit-verify + motebit-canonical defaults over the bundled leaves
@motebit/verifier              Apache-2.0  library: verifyFile, verifyArtifact, formatHuman
@motebit/crypto                Apache-2.0  primitives: verify, sign, suite dispatch
@motebit/crypto-appattest      Apache-2.0  Apple App Attest chain verifier (pinned Apple root)
@motebit/crypto-play-integrity Apache-2.0  Google Play Integrity JWT verifier (pinned Google JWKS)
@motebit/crypto-tpm            Apache-2.0  TPM 2.0 EK chain verifier (pinned vendor roots)
@motebit/crypto-webauthn       Apache-2.0  WebAuthn packed-attestation verifier (pinned FIDO roots)
```

The four platform leaves and the three core permissive-floor packages are Apache-2.0 — each answers "how is this artifact verified?" against a published public trust anchor, the permissive side of the protocol-model boundary test. Motebit-canonical composition (default bundle IDs, RP ID, CLI shape) stays BSL one layer up in `@motebit/verify`. See the separate `permissive-floor-apache-2-0` changeset for the rationale behind the floor licensing.

## Migration

The 1.0 release is a coordinated major bump across the fixed release group. The APIs exported by `@motebit/protocol`, `@motebit/sdk`, `@motebit/crypto`, `create-motebit`, and `motebit` have NOT broken — this major marks endgame-pattern maturity, not a code-shape change. The actual behavioral shifts are confined to the verification-tooling lineage:

**1. `@motebit/verifier` bin removed (breaking).**

```ts
// Before — @motebit/verifier@0.8.x shipped a `motebit-verify` binary.
// After  — @motebit/verifier@1.0.0 is library-only.
// Install `@motebit/verify@^1.0.0` for the CLI:
//   npm install -g @motebit/verify
//   motebit-verify cred.json
// The programmatic library surface is unchanged:
import { verifyFile, formatHuman } from "@motebit/verifier"; // ← still works
```

**2. `@motebit/verify@0.7.0` (deprecated library) → `@motebit/verify@1.0.0` (resurrected CLI).**

| You were using (0.7.0)                               | Migrate to                                                                          |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `verify()` function in TypeScript                    | `import { verify } from "@motebit/crypto"` — same shape, more features              |
| `verifyFile` / `formatHuman` / programmatic wrappers | `import { verifyFile } from "@motebit/verifier"`                                    |
| Running `motebit-verify` on the command line         | `npm install -g @motebit/verify` at `^1.0.0` — same command, full platform coverage |

Users pinned to `"@motebit/verify": "^0.7.0"` stay on the deprecated 0.x line automatically — semver prevents auto-bumps to 1.0.0. The 0.x tarballs remain immutable on npm; archaeology is preserved.

## Rationale

The entire published protocol surface hits 1.0 together as the endgame-pattern milestone. The three-package lineage for verification tooling (verify / verifier / crypto) follows the shape long-lived tool families use — git / libgit2, cargo / tokio, npm / @npm/arborist. The coordinated major signals that this is the architecture intended to hold long-term.

**Operator follow-up after this release lands:**

```bash
npm deprecate @motebit/verify@0.7.0 \
  "Superseded by @motebit/verify@1.x — the canonical CLI. For the library, see @motebit/crypto."
```

Replaces the stale deprecation message on the 0.x line with a two-pointer migration guide.
