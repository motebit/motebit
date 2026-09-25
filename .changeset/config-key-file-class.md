---
"motebit": patch
---

`~/.motebit/config.json` is now read and written under three rules, at every reader and writer — it holds `cli_encrypted_key` (for a CLI identity, the only copy of the private key) and, for anyone who has not migrated, the deprecated `cli_private_key` in plaintext.

- **Absence is not damage.** A missing config is a first run. A config that exists but cannot be read, does not parse, or parses to something other than an object (`null`, `[]`, a number) is now refused with a message naming the file — it was previously read as "no config", which told the user they had no identity and let the next save overwrite whatever was recoverable.
- **Damage is never overwritten.** A save over a damaged config first keeps its bytes as `config.json.clobbered-<time>` — the name `motebit doctor`, `migrate-keyring` and the missing-key remedy already point at, and which nothing previously wrote — or refuses. `motebit restore` (where `doctor` sends a user with a damaged config) now completes over one, on both of its config reads, and says where the old bytes went; an aborted restore leaves the file untouched.
- **Atomic and owner-only.** A save stages a new file created `0600`, fsyncs it, renames it over the config and fsyncs the directory, so a crash, full disk or kill leaves the old file or the new one, never a partial one; the scratch copy is removed on failure. A config written world-readable by an earlier version is narrowed to `0600` the next time it is loaded.

`motebit doctor` reports a damaged config as a failing check (exit 1) — before, it reported "not created yet", and the CLI's top-level error handler prints the refusal as a message rather than a stack trace. `pending-rotation.json` (a rotation's encrypted new key) and the `motebit.md` snapshots written by `rotate` and `export` use the same atomic replacement.
