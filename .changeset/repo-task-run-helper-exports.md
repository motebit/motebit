---
"motebit": patch
---

No change in behaviour. The `repo-task run` module now exports its `--author` parser, its rule that the output directory must not be inside the repository, and its default commit identity. The negative acceptance fixture (`scripts/governed-change-fixture.ts`, a repository script that is never published) uses these exports instead of copying the rules.
