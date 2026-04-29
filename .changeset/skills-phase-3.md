---
"@motebit/protocol": minor
"@motebit/sdk": minor
"motebit": patch
---

Skills v1 phase 3: per-skill audit entries in the execution ledger (spec/skills-v1.md §7.4).

Every skill the runtime's `SkillSelector` pulls into context now produces one `EventType.SkillLoaded` event-log entry, immediately after the selector returns and before the AI loop receives the system prompt. The audit trail lets a user prove later: _"the obsidian skill ran on date X with this exact signature value at session sensitivity Y."_

**`@motebit/protocol`** — adds the wire-format type and event:

```text
SkillLoadPayload  { skill_id, skill_name, skill_version, skill_signature,
                    provenance, score, run_id?, session_sensitivity }
EventType.SkillLoaded
```

**`@motebit/sdk`** — extends `SkillInjection` with two audit-only fields the runtime threads into the ledger entry:

```text
SkillInjection.score      BM25 relevance — surfaces selection rationale
SkillInjection.signature  Envelope signature.value — content-addressed pointer
                          to the exact bytes loaded; empty for trusted_unsigned
```

The AI loop's prompt builder ignores both fields (rendering stays unchanged). They ride only into the `SkillLoaded` event payload.

**`motebit`** (CLI) — runtime-factory's hook now passes `score` + `signature` through from the BSL `SkillSelector` result.

Best-effort emission: a failed `eventStore.append` is logged via `runtime._logger.warn("skill_load_event_append_failed", ...)` and the AI loop proceeds. Audit absence (skill loaded without matching event) is preferable to a turn blocked on a transient storage error.

Skill_signature audit utility: a stale ledger entry whose signature does not resolve in the current registry is itself a useful signal — the skill was re-signed (legitimate update) or removed (less common). Both provable from the audit trail without retaining the original bytes.

Wire-schema artifact: `spec/schemas/skill-load-payload-v1.json` ships under Apache-2.0 alongside the existing skills schemas.

4 new runtime tests cover: emit-with-payload, empty-selector, selector-throw (loop continues), no-hook-wired. 683/683 runtime, all 54 drift gates green.
