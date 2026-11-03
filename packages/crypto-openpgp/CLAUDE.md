# @motebit/crypto-openpgp

Commit-signature verifier for governed repo changes. Apache-2.0 (permissive floor), Layer 0, Node built-ins only. Sibling of the `crypto-*` platform leaves: it answers "how is this artifact verified?" against a published public trust anchor — here the git hosting operator's commit-signing keys (GitHub's `web-flow.gpg`) — and holds no motebit judgment. `@motebit/verify` (its `@motebit/verify/git` subpath, the landed mode) is its only consumer; motebit-canonical composition (where the pinned-keys file lives, which committer counts as the landing) stays there.

## Why this package exists

The offline verifier of a landed governed repo change (`spec/repo-change-v1.md` §9) accepts the squash commit's committer time only when the commit's OpenPGP signature verifies under a pinned set of the operator's keys. Verifying that signature is signature-verification logic, and `packages/verify/CLAUDE.md` Rule 1 keeps all such logic out of the aggregator, so it lives here. openpgp.js is LGPL-3.0 and cannot sit on the Apache-2.0 floor, so the one shape operators actually emit (v4 RSA/SHA-256) is read byte by byte (RFC 4880 §4–6, §12.2), with hashing and RSA verification from `node:crypto`.

## Rules

1. **One shape, nothing more.** One v4 signature packet: RSA, SHA-256, binary-document type, a hashed creation time, a consistent issuer. Any other algorithm, packet version, or trailing data is a refusal. A new shape (an operator moving to EdDSA) is an additive arm plus fixtures, never a loosening of the existing one.
2. **The keys are injected at the call site, never fetched.** No network, no keyserver, no WKD. The pinned-keys file is the trust decision. Fingerprints are computed from key bytes, never read from a label.
3. **Refusals are values.** `verifyCommitSignature` returns `{ ok: false, reason }` for anything the commit holds and never throws on it. `parsePinnedSigningKeys` throws, because a bad pin file is a configuration error.
4. **Node built-ins only.** No runtime dependencies; no motebit imports. Tests use ephemeral keys generated per run, never a real operator key.

## Consumers

- `packages/verify/src/git/landed.ts`: `motebit-verify repo-change --landed`, and through `@motebit/verify/git` the self-check of `motebit repo-task run`.
