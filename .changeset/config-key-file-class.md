---
"motebit": patch
---

`~/.motebit/config.json` is now read and written under three rules, at every reader and writer — it holds `cli_encrypted_key` (for a CLI identity, the only copy of the private key) and, for anyone who has not migrated, the deprecated `cli_private_key` in plaintext.

- **Absence is not damage.** A missing config is a first run. A config that exists but cannot be read, does not parse, or parses to something other than an object (`null`, `[]`, a number) is now refused with a message naming the file — it was previously read as "no config", which told the user they had no identity and let the next save overwrite whatever was recoverable.
- **Damage is never overwritten.** A save over a damaged config first keeps its bytes as `config.json.clobbered-<time>` — the name `motebit doctor`, `migrate-keyring` and the missing-key remedy already point at, and which nothing previously wrote — or refuses. `motebit restore` (where `doctor` sends a user with a damaged config) now completes over one, on both of its config reads, and says where the old bytes went; an aborted restore leaves the file untouched.
- **Atomic and owner-only.** A save stages a new file created `0600`, fsyncs it, renames it over the config and fsyncs the directory, so a crash, full disk or kill leaves the old file or the new one, never a partial one; the scratch copy is removed on failure. A config written world-readable by an earlier version is narrowed to `0600` the next time it is loaded.

`motebit doctor` reports a damaged config as a failing check (exit 1) — before, it reported "not created yet", and the CLI's top-level error handler prints the refusal as a message rather than a stack trace. `pending-rotation.json` (a rotation's encrypted new key) and the `motebit.md` snapshots written by `rotate` and `export` use the same atomic replacement.

The rotation write-ahead (`pending-rotation.json`) follows the same split: a file that exists but cannot be read, parsed, or is missing a field is now `"unreadable"`, never "nothing held" — it may be the only copy of a new key the relay already accepted. `motebit rotate` stops on it and leaves it in place; `motebit restore` refuses a passphrase reset while one is present, and on a fresh install or a replace keeps its bytes as `pending-rotation.json.clobbered-<time>` instead of deleting it.

Deliberate edges, stated so nobody mistakes them for regressions:

- **Symlinked config.** A `config.json` that is a symlink is replaced at the file it points to, so the link survives (a rename over the link would have turned it into a regular file).
- **Group-readable configs are narrowed.** Loading narrows any config readable by group or others to `0600`, including one made group-readable on purpose. The key file's confidentiality outranks that rare setup; keep a separate, deliberately shared copy if you need one.
- **An empty or whitespace-only config is damage**, not a first run: it is refused (and preserved before any overwrite) like any other unparseable file. Only a missing file is a first run.
