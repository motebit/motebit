---
"motebit": patch
"create-motebit": patch
---

A seed-backup acknowledgment is never carried onto a new identity, and the backup status never reports an old seed as covering a different key or identity.

- **Carried acknowledgments.** Some writes replace the identity in `~/.motebit/config.json`:
  - a `motebit` first-launch mint;
  - `motebit restore` of another identity;
  - `create-motebit`'s "Overwrite?" path;
  - the desktop's identity switch.

  These writes move the replaced identity's acknowledgment aside into `seed_backup_prior: [{ at, key, motebit_id }]`. It is kept, never deleted, and never treated as current. A restore that records a fresh acknowledgment keeps the fresh one current and keeps the replaced one aside. A stale snapshot saved after the identity changed takes the disk's acknowledgment along with the disk's identity.

- **Legacy acknowledgments now require one re-confirmation.** An acknowledgment with no bound key is never honoured, whatever the identity file or the clock says. The owner is asked once to re-confirm the recovery seed (`motebit seed reveal`).
- **The identity is bound too.** A new acknowledgment also records `seed_backed_up_motebit_id`.
  - For another identity it reads "not backed up for this identity", never "retired".
  - "Retired key" is said only for a known earlier key of the same identity.
- **Reveal race.** `motebit seed reveal` re-reads the config before recording. If the identity or key changed while the seed was on screen, nothing is recorded, and it says so.
- **Keychain wording.** `motebit keychain enroll` uses the same wording as the other readers.

Sibling: `seed-backup-not-carried-ignored.md`.
