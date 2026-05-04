---
"motebit": patch
---

Internal: widen `makeAuditSink` in `motebit skills install/list/...` subcommands to accept the broader `SkillAuditEvent` union (now including `skill_consent_granted` from the consent-gate arc). The body still writes the JSON-serialized event verbatim to `~/.motebit/skills/audit.log`, so any consumer that consumed the prior `SkillTrustGrantEvent`-only stream sees the new variant as just another event line — no log-format break, no behavior change. Companion to the protocol-side widening shipped in `cfa3d42d`.
