---
"motebit": patch
---

**`motebit delegate --plan` no longer runs a still-running step twice** (#816). In relay mode each plan step is submitted to the relay and polled for its receipt. When the poll deadline passed, the step was resubmitted with a new `Idempotency-Key`, even if the relay still reported the task running or could not be reached. The relay admitted that as a second task, so the step ran, and was paid for, twice.

After the deadline the adapter now asks the relay once more. If there is still no receipt, the retry resubmits under the same `Idempotency-Key`, so the relay replays the task it already admitted instead of admitting a new one. Only a task that conclusively failed is retried as a new task, with a new key and the failed worker excluded, as before.
