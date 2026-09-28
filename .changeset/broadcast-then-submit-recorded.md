---
"motebit": minor
---

A paid P2P delegation is recorded before its payment is sent, and a failure after the payment never leads to paying twice (#885).

`motebit delegate --sovereign` (and every relay-mediated P2P hire in the REPL) pays the worker and the relay fee in one onchain transaction, then submits the task with that payment proof. Before this change two windows lost track of money that had already left the wallet:

- **The submission failed after the payment** (relay 503, network error). Nothing was recorded, so the next run paid again.
- **The payment step threw after the transaction landed** (a lost confirmation). It was reported as "no funds moved", so the next run paid again.

Now:

- The wallet signs the payment, the payment is written to `~/.motebit/motebit.db` under that transaction's signature, and only then is it sent. If it cannot be recorded, it is not sent. If the process dies mid-hire, the next session refuses to pay the same worker for the same capability again.
- A failed submission is retried with the **same** payment (up to three retries over about 13 seconds). The relay dedupes on the transaction, so a retry never becomes a second payment.
- If the relay still has not taken the task, the command exits with `payment_not_admitted` (the relay refused it) or `payment_admission_unconfirmed` (it may have taken it without the answer arriving), names the transaction, and says not to run it again. The payment stays on record as `p2p-payment:<tx>`; `/result` lists it and `/result dismiss` clears it once reconciled.
- If a hire's wallet also sent another payment that no task accounts for, or a payment could not be written to the local record, the REPL, `/invoke`, an attached frontend and goal runs print one warning line naming it — never only text the model may or may not relay.
- If the payment step throws, motebit asks the chain about **that exact transaction** — never about "some transaction that pays this worker", which a second hire running at the same time could match. Landed: the hire proceeds with it. Provably dead: `payment_broadcast_failed`, and nothing moved. Undecidable: `payment_status_unknown`, recorded, never sent again. A failure before anything was signed says so.
