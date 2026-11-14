---
"motebit": patch
"create-motebit": patch
---

A seed-backup acknowledgment is never carried onto a new identity, and a legacy acknowledgment is never a false alarm with false text.

- **Carried acknowledgments.** When a write replaces the identity in `~/.motebit/config.json` (a `motebit` first-launch mint, `motebit restore` of another identity, or `create-motebit`'s "Overwrite?" path), the CLI's `saveFullConfig` and create-motebit's `writeConfigFile` move the replaced identity's acknowledgment aside into `seed_backup_prior: [{ at, key, motebit_id }]`. It is kept, never deleted, and never treated as current. A restore that records a fresh acknowledgment keeps the fresh one current and keeps the replaced one aside. A stale snapshot saved after the identity changed takes the disk's acknowledgment along with the disk's identity.
- **Legacy acknowledgments** (recorded before the key binding) now also count when a verified `motebit.md` on this machine is bound to the current key, records no succession, and was signed (its signed `created_at`) no later than the acknowledgment. A file regenerated afterwards, for example by create-motebit after a rotation, proves nothing. A never-rotated identity with a random id therefore stays "backed up". `motebit keychain enroll` uses the same wording as the other readers.
- **Date evidence also binds the sovereign-id rule.** If every verified `motebit.md` for the current key was signed after a legacy acknowledgment, the acknowledgment is not honoured, even for a v8 id. This covers the state main's create-motebit replace left behind: an old identity's acknowledgment next to a newly minted identity. A `created_at` counts only as a full timestamp with a time and a zone. An acknowledgment dated more than five minutes in the future is not honoured.
- **When coverage is unknown,** `motebit seed`, `motebit doctor` and the startup line ask the owner to re-confirm the recovery seed. They say "retired key" only when the acknowledgment names a known key that differs from the current one.

Sibling: `seed-backup-not-carried-ignored.md`.
