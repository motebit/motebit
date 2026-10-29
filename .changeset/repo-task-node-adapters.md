---
"motebit": patch
---

Node adapters for the repo-task run (governed repo change, milestone B build step 2), not yet wired to a command: a git tree reader that reads only the tip's tree (`git ls-tree` / `git cat-file` with isolated git config and literal pathspecs); a git change stager that never writes the worktree — new content goes to git's object store as blobs (`hash-object -w`), and the change commit is built on a private index with every path on stdin (`read-tree`, `update-index -z --index-info`, `write-tree`, `commit-tree -p <tip>`), touching no worktree file, repository index or ref; and a durable JSON-lines receipt file. The governed-run receipts carry the call's real status (see the runtime changeset).
