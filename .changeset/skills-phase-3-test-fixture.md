---
"motebit": patch
---

Update phase 2 ai-core prompt-test fixtures to include the new `score` and `signature` fields on `SkillInjection` (added in phase 3). No behavior change — the prompt builder still ignores both fields, the renderings asserted by the tests are unchanged.
