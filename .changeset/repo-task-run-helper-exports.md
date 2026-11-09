---
"motebit": patch
---

`motebit repo-task run` adds a publish condition to its "To publish" output: the pull request's title and body must not contain the word "committer". GitHub's merge queue re-wraps the squash commit's message and, when it signs the commit, inserts a copy of its signature block after every line that begins with that word. The landed commit then fails its own signature, so the change can never verify offline. The `repo-task run` module also exports its `--author` parser, its rule that the output directory must not be inside the repository, and its default commit identity. The negative acceptance fixture (`scripts/governed-change-fixture.ts`, a repository script that is never published) uses these exports instead of copying the rules.
