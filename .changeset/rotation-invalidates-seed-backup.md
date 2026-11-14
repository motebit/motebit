---
"motebit": patch
---

A committed key rotation now invalidates the previous seed backup. A recovery seed is one key, and `motebit rotate` mints a new random key. The backup acknowledgment (`seed_backed_up_at`) was a bare timestamp, so after a rotation `motebit seed` still said "recorded" and the startup nudge stayed silent, while the paper seed recovered only the retired key.

- **Binding.** The acknowledgment is now bound to the key and identity it covers (`seed_backed_up_key`, `seed_backed_up_motebit_id`). These are local config only, never wire.
  - `motebit seed reveal` binds the key the revealed seed derives and the identity it was shown for.
  - `motebit restore` binds the key the entered seed derives.
- **Reading it.** `seedBackupStatus` reads "not backed up" whenever the bound key is not `device_public_key`. Every commit path invalidates it, including an interrupted commit finished later; an abandoned or refused rotation leaves it alone.
- **Nothing is deleted.** The old acknowledgment stays as the record of the retired key, and `motebit seed` says the recorded seed is for a retired key and should be kept.
- **One notice.** `motebit rotate` says once that the seed changed.
- **Legacy acknowledgments now require one re-confirmation.** An acknowledgment recorded before this release (a timestamp with no key) is never honoured: `motebit seed`, `motebit doctor`, `motebit keychain` and the startup line ask the owner to re-confirm the recovery seed once with `motebit seed reveal`. Nothing on disk can prove which key such an acknowledgment covered.

The binding rule lives in `@motebit/surface-kit` (sibling: `rotation-invalidates-seed-backup-ignored.md`).
