---
"@motebit/verify": minor
---

Add `motebit-verify repo-change`, the CI-on-PR judge of a governed repo change (milestone B, build step 4c-i; spec/repo-change-v1.md §7, §9), and the `@motebit/verify/git` subpath export it is built on.

```bash
motebit-verify repo-change --repo <clone> --base <trusted tip commit> --head <pr head commit> \
  --repository <owner/name> --base-ref <ref name> --pr-author <login> [--now <ms>] [--json]
```

- Every input `verifyRepoChange` (`@motebit/verifier`) needs is computed from the clone: the bundle the pull request adds under `.motebit/bundles/` (its exact bytes), the entries from the full trees (never `git diff`), the paths tracked at `--base`, and the pins, revocations and path policy read at `--base`, never from the pull request. Spent is whether the bundle path ever existed on `--base`'s first-parent history.
- The shape checks fold into `integrity`: `parent_commit` is `--base`; the pull request is exactly the change commit and the bundle commit, linear; `head_commit..pr_head` is exactly one `A 100644` at the grant's bundle path; the base ref is `main`; the author is `motebit-agent`; nothing under `.motebit/bundles/` is modified or deleted. Every axis is still computed and printed when one fails.
- Git never runs on the clone's own git directory, and nothing is fetched: every call runs against a private, empty bare repository whose config the tool writes, reading the real object store. A bare clone works as well as a worktree.
- The evaluation time is the local clock unless `--now` is given, recorded as `local_clock`. Exit 0 only when fully verified with outcome `completed`; 1 on any other verdict; 2 on a usage or I/O error, or when the change cannot be judged (no parsable path policy at `--base`, a shallow clone).

`@motebit/verify/git` exports the reader: `verifyRepoChangePullRequest`, `computeRepoChangeInputs`, `computeEntries`, the isolated session (`openIsolatedGit`, `resolveGitDirectories`, `resolveObjectDirectory`), `resolveRepoTip`, `listTree`, `readBlob`, `commitParents`, `gitBlobId`, `readRepoState`, `isGrantSpent` and `pinFromIdentityFile`. It moved here from the `motebit` CLI (relicensed BUSL-1.1 → Apache-2.0), and the CLI now imports it, so there is one implementation.
