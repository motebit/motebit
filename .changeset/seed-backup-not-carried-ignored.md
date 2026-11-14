---
"@motebit/surface-kit": patch
---

`seedBackupPosture` gains an `identityFiles` input. A legacy (unbound) acknowledgment counts when one of those files is bound to the current key (checked with `boundIdentityFile`: the signature and succession chain verify, the file names this `motebit_id`, and its current key is the current key) and records zero successions. Until now only a v8 sovereign id could prove that.

The not-backed-up posture now carries a `reason`:

- `never`: never acknowledged.
- `retired_key`: the acknowledgment names a known key that differs from the current one. This is the only case a surface may describe as "retired".
- `unconfirmed`: which key the acknowledgment covers is unknown, so the surface asks the owner to re-confirm.

The published consumer is `motebit` (sibling: `seed-backup-not-carried.md`).
