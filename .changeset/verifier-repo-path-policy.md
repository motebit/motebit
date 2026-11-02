---
"@motebit/verifier": minor
---

Add the repository path policy interpreter (`motebit/repo-path-policy@1.0`, spec/repo-change-v1.md §7.2): the path predicate as data, read from `.motebit/repo-path-policy.json`.

New exports:

- `parseRepoPathPolicy(text)`: strict parse. It throws on invalid JSON, a missing or unknown key, any other `spec`, a non-string or duplicate pattern, or a pattern outside the closed grammar (literal segments of `[A-Za-z0-9._-]`, `*` within a segment, and `**` as a whole segment).
- `isRepoPathPermitted(policy, path)`: the predicate a caller passes as `VerifyRepoChangeInput.isPathPermitted`. A path is permitted when an include matches it, no exclude matches it, and it has no line terminator.
- `isRepoPathIncluded(policy, path)`: includes name files, so they match exact case and never descend into a directory.
- `repoPathExclusion(policy, path)`: returns `"exact"`, `"case_folded"` or `null`. Excludes descend into directories and fold ASCII case.
- `REPO_PATH_POLICY_SPEC`, `REPO_PATH_POLICY_FILE`, and the `RepoPathPolicy` and `RepoPathExclusion` types.

The module imports nothing, so the autonomy-tier classifier loads the same interpreter from source without a build. Nothing else in the package changes.
