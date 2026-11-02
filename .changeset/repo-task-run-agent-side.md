---
"motebit": minor
---

Add `motebit repo-task run`, the agent side of a governed repo change (milestone B, build step 4; spec/repo-change-v1.md).

```bash
motebit repo-task run --agent <agent config dir> --delegation <dir> [--repo <worktree>] [--provider <p>] [--model <m>] [--output <dir>]
```

- The agent is its own motebit identity in its own config directory (`--agent`). Only its identity and key fields are read from `<dir>/config.json`. The default `~/.motebit` (or `MOTEBIT_CONFIG_DIR`) is refused, and the command never reads `~/.motebit/config.json`. The key is unlocked with `MOTEBIT_AGENT_PASSPHRASE` or a prompt, and erased on every exit path.
- The preflight runs before any passphrase prompt or model call, and fails closed. The tip is resolved from the `.git` files without running git on the real git directory, and HEAD must be on the scope's `base_ref`. The pins, revocations and path policy are read from the tip's tree. A malformed revocation refuses the run, and so do a spent grant and a dirty worktree (a tracked path's type, mode or content differs from the tip). The agent must be an agent pin and not the principal. The run's authority law is judged at the local clock.
- The provider is built from `--provider`/`--model` and that provider's API-key environment variable only, with the default personality. The motebit cloud provider is refused.
- After the run come the change commit and the bundle commit (`.motebit/bundles/<grant_id>.json`, the canonical JSON of the bundle), each built on a private index. The agent signs an `ExecutionReceipt` whose `result` is the canonical change record. No ref is created or moved, nothing is pushed, and the worktree is never written.
- A self-check (`verifyRepoChange`, CI-on-PR mode, inputs computed from the two trees) prints the verdict, and the command exits non-zero unless the change is fully verified and `completed`. On success it prints `parent_commit`, `head_commit`, `bundle_commit` and the publisher's push command.

It judges path identity by the filesystem (device and inode), never by spelling, so a case alias or a hard link of the default config directory, or of the repository, is refused like the path itself. The output directory may not lie in the repository's git directories, nor below any directory whose `.git` resolves to this repository (every worktree, found without trusting git's worktree list); a `.git` that cannot be resolved is refused too.
