---
"motebit": minor
---

`motebit wallet swap <sol-amount>` — owner-invoked SOL → USDC normalization (wallet homeostasis, funding side; born from the first live funding: the founder sent SOL expecting the wallet to normalize). A deterministic affordance: the owner's passphrase is the authorization; the Jupiter adapter enforces a fail-closed gas floor (0.005 SOL — the wallet never metabolizes its last fuel) with the refusal naming the max swappable amount. `motebit wallet` now teaches its own funding posture (USDC on the SOLANA network; SOL is auto-managed gas). Autonomous posture normalization stays deferred-with-trigger — it would ride the standing-grant meter like any autonomous money.
