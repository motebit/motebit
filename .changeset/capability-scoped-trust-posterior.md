---
"@motebit/protocol": minor
---

Capability-scoped competence in first-person worker routing — `AgentTrustRecord` gains an optional, local-only `capability_stats` map (`{capability: {successful_tasks, failed_tasks}}`).

Competence is a skill, not a relationship: being reliable at `web_search` says nothing about `read_url`. The routing reliability posterior now scopes its success/fail counts to the capability being hired (`competenceCounts` in `@motebit/semiring`, `selectWorker(self, candidates, { capability })`), while the pairwise `trust_level` — the sybil edge and the cold-start prior — stays capability-agnostic. Additive and backward-compatible: the field is optional, never on the wire (the `.strict()` `TrustCredentialSubject` still carries only the aggregate counts), and callers that pass no capability get the aggregate counts, byte-identical to before. See `docs/doctrine/first-person-worker-routing.md` § "Competence is a skill".
