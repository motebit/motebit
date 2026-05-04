---
"motebit": minor
---

Add `motebit skills audit [skill-name] [--event-type=…] [--limit=N] [--json]` — first read-side consumer of the durable skill audit trail. Reads `~/.motebit/skills/audit.log` (the line-delimited JSON stream emitted by `registry.trust` / `registry.untrust` / `registry.remove` and the panels-side `RegistryBackedSkillsPanelAdapter`'s `skill_consent_granted` events), filters + formats + prints. Most-recent-first ordering matches the panels-side `getAll()` convention on web (IDB) and mobile (SQLite).

Closes the doctrine gap shipped by the consent-audit arc — the protocol type and durable persistence existed, but no surface answered "did I approve installing this medical skill?" without grepping the log file directly. `motebit skills audit` answers it. Operator-grade UI; per-skill timeline / federation-dispute flows are deferred until those consumers arrive.

Adds `--event-type` flag (string) for filtering by `SkillAuditEvent` discriminator (`skill_trust_grant` / `skill_trust_revoke` / `skill_remove` / `skill_consent_granted`). Additive to the existing `--limit` and `--json` flags.
