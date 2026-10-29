---
"@motebit/verifier": minor
---

Export the governed repo change's shared rules, so every judge runs one implementation: `isCanonicalRepoPath` (the spec §4 path rule), `isCanonicalBase64Url`, `parseRepoChangeTools` (a strict `repo_read_blob` / `repo_write_path` list), `isRepoTaskScopeShape`, `repoChangeAuthorityWindow`, and the rule checks `checkRepoChangeTickStructure`, `checkRepoChangeWindow`, `checkRepoChangeGrantShape` (subject, scope binding schema, strict tool lists, no `spend_ceiling`, lifetime at most 24 hours, cadence no less than the lifetime) and `checkRepoChangeParties`, each reporting failures with their repo-change repair codes through a `RepoChangeRuleSink`. `verifyRepoChange` now calls them; its verdicts are unchanged. The repo-task run in `@motebit/runtime` calls the same functions before it starts and on every tool call.
