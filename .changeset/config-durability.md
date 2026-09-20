---
"motebit": patch
---

`~/.motebit/config.json` is now replaced atomically and written owner-only, and a config that cannot be read is no longer reported as an absent one.

That file holds `cli_encrypted_key` — for a CLI identity, the only copy of the private key — and, for anyone who has not migrated, the deprecated `cli_private_key` in plaintext. It was written by truncating and rewriting in place, so a crash, a full disk or a kill mid-write could leave it empty or partial; it was created world-readable; and `loadFullConfig` answered `{}` for every failure, so a damaged file read as "you have no identity" and the next save overwrote whatever was recoverable.

Saves now stage beside the target, fsync, and rename, so a reader sees the old file or the new one and never a partial one. Loads distinguish absent (a first run) from unreadable (refused, with the file left untouched and a message naming it). `motebit doctor` reports a damaged config and stops rather than running checks that would rewrite it.
