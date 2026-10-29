---
"motebit": patch
---

Node adapters for the repo-task run (governed repo change, milestone B build step 2), not yet wired to a command: a git tree reader that reads only the tip's tree (`git ls-tree` / `git cat-file` with isolated git config and literal pathspecs), a worktree writer that refuses symlink components and anything whose real path leaves the worktree, and a durable JSON-lines receipt file. The governed-run receipts carry the call's real status (see the runtime changeset).
