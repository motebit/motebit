---
"create-motebit": patch
---

`create-motebit` writes the same `config.json` the `motebit` CLI keeps its identity key in, so it now obeys the same three rules — for the operator's `~/.motebit/config.json` and for a scaffolded agent's own `<agent>/.motebit/config.json`.

- **Absence is not damage.** A config that exists but cannot be read is refused rather than read as empty. That mattered twice over: the guard that refuses to replace an existing identity decides from `motebit_id` alone, so an unreadable config looked like a fresh machine and was overwritten.
- **Damage is never overwritten.** With `--force`, the scaffold proceeds and the damaged bytes are kept as `config.json.clobbered-<time>` first; without it, it refuses and changes nothing.
- **Atomic and owner-only.** Configs (including the scaffolded agent's, which holds its only key copy and was written world-readable) are staged `0600`, fsynced and renamed into place; a pre-existing world-readable config is narrowed to `0600` when read.

`create-motebit rotate` no longer has a failure point that loses a key. Before any file that names or holds a key is replaced, the current config (the old key) is kept as `config.json.pre-rotation-<time>` and the next config (the new key) is written as `config.json.rotation-next-<time>`, both `0600`. Only then are `motebit.md.backup`, `motebit.md` and the config replaced, each atomically; on success both copies are removed (the old key is retired on purpose). If a step fails, the command says which key `motebit.md` names, where each key is held, and the one `mv` that finishes the job. The rotated file is verified before anything is written. (Previously an interrupted rotate could leave `motebit.md` naming a key whose private half existed nowhere.)

The agent-identity guard now applies to interactive runs too: `create-motebit <dir> --agent` refuses when `<dir>/.motebit/config.json` already exists, unless `--force`. With `--force` — here and when a guided scaffold replaces an existing identity — the replaced config is kept as `config.json.clobbered-<time>` before anything is written.

Deliberate edges: a symlinked config is replaced at the file it points to (the link survives), and every preserved copy is of the real file's bytes (a hard link to the resolved file, or a copy created `0600` from the start), never a second name for the symlink; a config readable by group or others is narrowed to `0600` when read, even if that was deliberate; an empty config is damage, not a first run.
