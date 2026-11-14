---
"motebit": patch
"create-motebit": patch
---

A seed-backup acknowledgment is never carried onto a new identity, and a legacy acknowledgment is never a false alarm with false text.

- **Carried acknowledgments.** When a write replaces the identity in `~/.motebit/config.json` (a `motebit` first-launch mint, `motebit restore` of another identity, or `create-motebit`'s "Overwrite?" path), the CLI's `saveFullConfig` and create-motebit's `writeConfigFile` move the replaced identity's acknowledgment aside into `seed_backup_prior: [{ at, key, motebit_id }]`. It is kept, never deleted, and never treated as current. A restore that records a fresh acknowledgment keeps the fresh one current and keeps the replaced one aside. A stale snapshot saved after the identity changed takes the disk's acknowledgment along with the disk's identity.
- **Legacy acknowledgments** (recorded before the key binding) now also count when a verified `motebit.md` on this machine is bound to the current key and records no succession. A never-rotated identity with a random id therefore stays "backed up".
- **When coverage is unknown,** `motebit seed`, `motebit doctor` and the startup line ask the owner to re-confirm the recovery seed. They say "retired key" only when the acknowledgment names a known key that differs from the current one.

Sibling: `seed-backup-not-carried-ignored.md`.
