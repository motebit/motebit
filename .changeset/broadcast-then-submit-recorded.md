---
"motebit": minor
---

A paid P2P delegation whose task submission fails after the payment went out is now recorded and never paid for twice (#885).

`motebit delegate --sovereign` (and every relay-mediated P2P hire in the REPL) pays the worker and the relay fee in one onchain transaction, then submits the task with that payment proof. Before this change two windows lost track of money that had already left the wallet:

- **The submission failed after the payment** (relay 503, network error). Nothing was recorded, so the next run paid again.
- **The payment step threw after the transaction landed** (a lost confirmation). It was reported as "payment failed to broadcast — no funds moved", so the next run paid again.

Now:

- The payment is written to `~/.motebit/motebit.db` the moment its proof is in hand, **before** the task is submitted. If the process dies mid-submit, the next session refuses to pay the same worker for the same capability again.
- A failed submission is retried with the **same** payment (up to three retries over about 13 seconds). The relay dedupes on the transaction hash, so a retry can never become a second task or a second payment.
- If the relay still does not admit the task, the command exits with `payment_not_admitted`, names the transaction, and says not to run it again. The payment stays on record as `p2p-unadmitted:<tx>`. `/result` lists it and answers it locally (there is no relay task to fetch), and `/result dismiss` clears it once reconciled.
- If the payment step throws, the wallet's read-only history lookup decides. If the payment landed, the hire proceeds with that transaction. If it provably did not land, the error is `payment_broadcast_failed`, as before. If it cannot be decided, the error is `payment_status_unknown`: nothing is submitted, nothing is broadcast again, and the entry (`p2p-unconfirmed:…`) refuses a re-hire until you check the wallet and dismiss it.
