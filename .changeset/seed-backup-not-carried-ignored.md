---
"@motebit/surface-kit": patch
"@motebit/desktop": patch
---

`seedBackupPosture` is bound-only. An acknowledgment with no recorded key is never honoured: legacy acknowledgments require one re-confirmation, because nothing on disk can prove which key they covered without trusting a wall clock. The acknowledgment may also name its `motebitId`.

The not-backed-up posture carries a `reason`:

- `never`: never acknowledged.
- `retired_key`: a known earlier key of the same identity. This is the only case a surface may describe as "retired".
- `other_identity`: the acknowledgment was recorded for another identity.
- `unconfirmed`: a legacy acknowledgment, or no current key, so the surface asks the owner to re-confirm.

`setAsideReplacedSeedBackup` and `SEED_BACKUP_FIELDS` are the one implementation of the "never carried onto a new identity" rule. The CLI's `saveFullConfig` and the desktop's identity switch (restore, key-transfer pairing) both use them, and create-motebit keeps a twin.

The published consumers are `motebit` and `create-motebit` (sibling: `seed-backup-not-carried.md`).
