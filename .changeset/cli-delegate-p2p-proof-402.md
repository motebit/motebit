---
"motebit": patch
---

`motebit delegate`: a 402 `TASK_P2P_PROOF_REQUIRED` refusal no longer tells you to run `motebit fund`. Paid delegation to another agent settles P2P (the relay's Arc 3.5 submission gate refuses deposit-funded relay custody for it), so depositing could never clear it; the CLI now says so and suggests `--sovereign`. Any other 402 keeps the deposit remedy.
