---
"@motebit/surface-kit": patch
"@motebit/web": patch
"@motebit/desktop": patch
"@motebit/mobile": patch
---

`@motebit/surface-kit` gains `seedBackupPosture`: a seed-backup acknowledgment covers the public key it names, read against the identity's current key, so a committed rotation reads "not backed up" on every path (legacy unbound acknowledgments count only while the current key is the sovereign genesis key). It also gains `ROTATION_SEED_BACKUP_NOTICE`, which web (a system message in place of the success toast), desktop (a system message) and mobile (inside the "Key Rotated" alert) now show once when a rotation commits, and never on a failed or refused one. The published consumer is `motebit` (sibling: `rotation-invalidates-seed-backup.md`).
