---
"motebit": patch
---

Drop the redundant default `name` field in the `makeSummary` test helper for the new SkillsController test suite. The helper signature already requires `overrides.name`, so the inline default `name: "placeholder"` was unreachable and tripped TS2783 ("'name' is specified more than once, so this usage will be overwritten") under tsc — runtime semantics unchanged, tsc-strict was the only rejector.
