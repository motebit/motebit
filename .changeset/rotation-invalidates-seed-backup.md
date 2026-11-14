---
"motebit": patch
---

A committed key rotation now invalidates the previous seed backup. A recovery seed is one key, and `motebit rotate` mints a new random key, but the backup acknowledgment (`seed_backed_up_at`) was a bare timestamp: after a rotation `motebit seed` still said "recorded" and the startup nudge stayed silent while the paper seed recovered only the retired key.

The acknowledgment is now bound to the key it covers (`seed_backed_up_key`, local config only, never wire): `motebit seed reveal` binds the key the revealed seed derives, `motebit restore` binds the key the entered seed derives, and `seedBackupStatus` reads "not backed up" whenever that key is not `device_public_key`, so every commit path (fresh, resumed, an interrupted commit finished later) invalidates it, and an abandoned or refused rotation leaves it alone. Nothing is deleted: the old acknowledgment stays as the record of the retired key, and `motebit seed` says the recorded seed is for a retired key and should be kept. `motebit rotate` says once that the seed changed. A legacy (unbound) acknowledgment counts only while the current key is provably the sovereign genesis key, so an already-rotated user reads "not backed up" after upgrading. The binding rule lives in `@motebit/surface-kit` (sibling: `rotation-invalidates-seed-backup-ignored.md`).
