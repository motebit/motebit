---
"@motebit/verify": minor
---

`motebit-verify repo-change --landed`: judge a governed repo change offline, on the squash commit that landed it (spec/repo-change-v1.md §9, "Offline on a landed change"). `--landed <squash commit> --trusted-tip <commit> --repository <owner/name> --github-keys <file> --repo <clone>`, mutually exclusive with the CI-on-PR flags.

- Git's object lookups are not trusted: every commit, tree and blob is read raw through one `cat-file --batch` (commit-graph off, grafts and replace refs ignored) and re-hashed against its id; trees are parsed in-process and refused unless canonical (no duplicate names, git's order, git's five modes); first-parent chains are walked from the commits' own bytes, never by `rev-list`; a shallow clone is refused.
- Shape checks: one parent; the squash entries are exactly one `A 100644` at `.motebit/bundles/<grant_id>.json` plus the record's `entries`; `parent_commit` is a first-parent ancestor of the parent; the squash commit is on the trusted tip's first-parent chain. Pins, revocations, the path policy and tracked paths are read at the parent; spent is the parent's first-parent history.
- The evaluation time is the squash commit's committer time (`operator_recorded`), accepted only when the committer is `GitHub <noreply@github.com>` and its `gpgsig` — exactly one v4 binary RSA/SHA-256 OpenPGP signature, CRC-checked, made within five minutes after the committer time and by a key that existed then — verifies under a key in the pinned-keys file (armored v4 RSA public key blocks, fingerprints computed). Otherwise `authority` is `unknown`. The signature check is the new `@motebit/crypto-openpgp` leaf's.

New on `@motebit/verify/git`: `verifyRepoChangeLanded`, `computeLandedRepoChangeInputs`, `acceptLandingTime`, `LANDING_SIGNATURE_WINDOW_S`, `openRawObjects`, `parseTree`, `parseCommit`, `gitObjectId`, `ObjectStoreError`, `parsePinnedSigningKeys`, `verifyCommitSignature`, `splitSignedCommit`, `crc24` (re-exported from `@motebit/crypto-openpgp`), and `IsolatedGit.objectStream()`. `readRepoState` and `computeEntries` take an optional blob reader (default unchanged).
