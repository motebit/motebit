---
"motebit": minor
---

`motebit delegate --plan --sovereign` now refuses (#887).

Settlement §9.1 pay-forward paid a worker onchain before presenting the task. A worker that admits work only through its relay refuses such a task after the money has moved, and no client can see a worker's admission mode before paying.

The command now exits 1 with "Sovereign pay-forward is disabled: …". It does this before the runtime-host election, the key unlock, discovery or any payment.

- **Instead:** use relay-mediated delegation (the default: `motebit delegate --plan` without `--sovereign`).
- **Unchanged:** single-step `motebit delegate --sovereign`, which is relay-mediated P2P with a payment proof.
