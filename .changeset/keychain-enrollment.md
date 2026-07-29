---
"motebit": minor
---

`motebit keychain enroll` — opt-in passphrase enrollment in the macOS login Keychain (the third leg of the recovery arc: "remember a passphrase" stops being a single point of identity loss, with zero operator involvement).

Once enrolled, commands unlock silently: the resolution chain is `MOTEBIT_PASSPHRASE` → session cache → enrolled keychain (validated against the encrypted key; a stale enrollment falls through to the prompt with a re-enroll hint, never a lockout) → interactive prompt. `motebit keychain` shows status; `motebit keychain remove` undoes it.

Honest by design: the item is protected by your macOS account, not biometrics (v1 uses `/usr/bin/security` — no native modules, no gyp builds); any process running as your user can read it, which is why enrollment is opt-in and never a default; it does not replace the recovery seed (keychain and disk die with the machine — the seed nudge stays until a backup is acknowledged); and `motebit seed reveal` always asks interactively, enrolled or not. Other platforms report unsupported honestly.
