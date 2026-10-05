---
"motebit": patch
---

The legacy plaintext `cli_private_key` config field keeps loading through 2.x; its removal moves from 2.0.0 to 3.0.0. Only the interactive launch, `attest` and `export` rewrite it to the encrypted `cli_encrypted_key`; the daemon and other headless commands read it as-is, so a machine set up before 1.0 that has only run headless can still hold its only copy of the identity key (also its wallet) in that field. Removing the read at 2.0.0 would have locked those users out. The startup warning now names 3.0.0. To migrate now, run `motebit` interactively once and set a passphrase.
