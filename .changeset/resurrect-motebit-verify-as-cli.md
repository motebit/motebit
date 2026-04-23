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

- **`@motebit/verify@1.0.0`** — fresh lineage superseding the deprecated `0.7.0` zero-dep library. Ships the `motebit-verify` CLI binary with every hardware-attestation platform bundled (Apple App Attest, Google Play Integrity, TPM 2.0, WebAuthn). Network-free, self-attesting. License: BSL-1.1. Runs `npm install -g @motebit/verify` to get the tool.

- **`@motebit/verifier@1.0.0`** — library-only. The `motebit-verify` CLI that used to live here has moved to `@motebit/verify` (above). This package now ships only the MIT helpers (`verifyFile`, `verifyArtifact`, `formatHuman`, `VerifyFileOptions` with the optional `hardwareAttestation` injection point). Third parties writing MIT-only TypeScript verifiers compose this + `@motebit/crypto` without pulling BSL code.

- **`@motebit/crypto@1.0.0`** — unchanged in role, version bump to mark 1.0 maturity of the primitive substrate. MIT, zero monorepo deps.

- **`@motebit/protocol@1.0.0`** — wire types + algebra. MIT floor. 1.0 signals the protocol surface is stable enough to implement against.

- **`@motebit/sdk@1.0.0`** — stable developer-contract surface. 1.0 locks the provider-resolver / preset / config vocabulary for integrators.

- **`create-motebit@1.0.0`** — scaffolder bumps to match.

- **`motebit@1.0.0`** — operator console CLI bumps to match.

The three-package lineage for verification tooling follows the pattern that survives decades — git / libgit2, cargo / tokio, npm / @npm/arborist:

```
@motebit/verify     BSL  the CLI motebit-verify + bundled adapters
@motebit/verifier   MIT  library: verifyFile, verifyArtifact, formatHuman
@motebit/crypto     MIT  primitives: verify, sign, suite dispatch
```

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
