---
"@motebit/crypto-openpgp": major
---

New package: the git commit-signature verifier `motebit-verify repo-change --landed` uses to accept a landed change's committer time — one v4 RSA/SHA-256 `gpgsig` shape, checked against operator signing keys the caller pins (`parsePinnedSigningKeys`, `verifyCommitSignature`, and the types `PinnedSigningKey` and `CommitSignatureCheck`). Node built-ins only; no network.

## Migration

Nothing to migrate: the package is new. Install `@motebit/crypto-openpgp` to check a commit signature under pinned keys without `@motebit/verify`; `@motebit/verify/git` re-exports the same functions.
