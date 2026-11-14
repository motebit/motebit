---
"@motebit/surface-kit": patch
"@motebit/web": patch
"@motebit/desktop": patch
"@motebit/mobile": patch
---

`@motebit/surface-kit` gains `seedBackupPosture`. A seed-backup acknowledgment covers the public key (and identity) it names, read against the identity's current key and id, so a committed rotation reads "not backed up" on every path. A legacy acknowledgment with no key is never honoured; it requires one re-confirmation.

It also gains `ROTATION_SEED_BACKUP_NOTICE`. Web shows it as a system message in place of the success toast, desktop as a system message, and mobile inside the "Key Rotated" alert. Each shows it once when a rotation commits, and never on a failed or refused one.

The published consumer is `motebit` (sibling: `rotation-invalidates-seed-backup.md`).
