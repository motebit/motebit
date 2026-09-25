---
"create-motebit": patch
---

Key-file durability, build 3 (`docs/proposals/key-file-durability-v1.md`, lane A).

- **`create-motebit rotate` refuses an identity with a relay configured** (`sync_url`, a pinned `relay_public_key`, or `MOTEBIT_SYNC_URL`) and points at `motebit rotate`: this command never talks to a relay, so it would move the key locally while the relay kept the old one. It also refuses while a `motebit rotate` is in flight (`pending-rotation.json`) or an earlier `create-motebit rotate` left its new key stranded in `config.json.rotation-next-*`.
- **The retired key is kept.** After a successful rotation the old key stays at `config.json.pre-rotation-<time>` (`0600`) and the command says so. The founder's ruling: a retired key is erased only after a relay accepted the succession, which this command cannot know.
- **No lost update.** Writes compare the identity against what was read and take the same `config.json.lock` the `motebit` CLI takes: a save that does not change the identity keeps a newer key another process committed; a replacement decided on a state that no longer exists is refused.
- **Replacing an identity keeps its rotation in flight.** A guided replace or `--agent --force` moves the replaced identity's `pending-rotation.json` aside as `pending-rotation.json.clobbered-<time>` instead of leaving it for the next `motebit rotate` to delete.
- **`motebit.md`** files (project, agent, `~/.motebit` snapshot) are written atomically, and one that names another identity is kept as `motebit.md.clobbered-<time>`. An agent's key is written before the files that name it.
- A damaged config readable by others is narrowed to `0600` by the read that refuses it; a config symlink whose target is missing is refused, never replaced; preserved copies are byte copies; config directories are created `0700`.

A kept copy is refused, rather than attempted, when the file to keep cannot be resolved at all (a dangling or looping link, or nothing there): nothing is changed.
