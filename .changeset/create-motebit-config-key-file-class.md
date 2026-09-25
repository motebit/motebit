---
"create-motebit": patch
---

`create-motebit` writes the same `config.json` the `motebit` CLI keeps its identity key in, so it now obeys the same three rules — for the operator's `~/.motebit/config.json` and for a scaffolded agent's own `<agent>/.motebit/config.json`.

- **Absence is not damage.** A config that exists but cannot be read is refused rather than read as empty. That mattered twice over: the guard that refuses to replace an existing identity decides from `motebit_id` alone, so an unreadable config looked like a fresh machine and was overwritten.
- **Damage is never overwritten.** With `--force`, the scaffold proceeds and the damaged bytes are kept as `config.json.clobbered-<time>` first; without it, it refuses and changes nothing.
- **Atomic and owner-only.** Configs (including the scaffolded agent's, which holds its only key copy and was written world-readable) are staged `0600`, fsynced and renamed into place; a pre-existing world-readable config is narrowed to `0600` when read.

`create-motebit rotate` now saves the new key to config before it rewrites `motebit.md`, and replaces `motebit.md` atomically — the previous order had a crash window in which the identity file named a key whose private half was saved nowhere.
