---
"motebit": patch
---

`motebit migrate-keyring` no longer tells you the desktop app moved your keys into the OS keychain — no shipped desktop uses the OS keychain. When `~/.motebit/dev-keyring.json` is gone but a `dev-keyring.json.migrated-*` copy is present, it now says what that copy is: a previous `migrate-keyring` run's retired plaintext keyring, kept owner-only. It then points you at `motebit restore`, or at moving the copy back and running the command again. When the only thing present is a `keychain-index.json`, it says that a pre-release desktop build left it, and does not claim that a previous run retired anything.
