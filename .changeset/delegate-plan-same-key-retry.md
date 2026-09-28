---
"motebit": patch
---

**`motebit delegate --plan` no longer runs a step twice when the relay's answer goes missing** (#816). In relay mode each plan step is submitted to the relay under an `Idempotency-Key` and polled for its receipt. Three situations used to resubmit the step under a new key, and the relay admitted it as a second task, so the step ran, and was paid for, twice:

- the poll deadline passed while the relay still reported the task running, or could not be reached;
- the submission request reached the relay but its response was lost (the request threw);
- a retry met `409` because the relay was still processing the earlier request under the same key. This one was reported as a hard failure, even though the task had been admitted and could still complete.

None of these means the task was not admitted. After a deadline the adapter now asks the relay once more. When it still has no answer, or a submission gets no response, it resubmits under the same key, so the relay replays the task it already admitted instead of admitting a new one. A `409` is retried after a short backoff (1s, 2s, 4s, 8s), also under the same key. Only a task that conclusively failed is retried as a new task, with a new key and the failed worker excluded, as before. Any other rejection from the relay is handled as before.
