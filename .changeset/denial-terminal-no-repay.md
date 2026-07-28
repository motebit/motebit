---
"motebit": patch
---

Money-safety and human-veto integrity for paid delegation. A human "no" on an approval is now terminal: the model is told the refusal is a decision (not a retryable failure), and a re-proposal of the same tool + arguments is never shown to the human again. A paid delegation whose result could not be retrieved now reports `PAYMENT_ALREADY_SETTLED` with the amount, tx hash, and task id — so an autonomous caller cannot mistake a delivery failure for a failed hire and broadcast a second payment for work already bought.
