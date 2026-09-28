---
"motebit": patch
---

**`motebit delegate --plan` no longer runs a step twice when the relay's answer goes missing** (#816). In relay mode each plan step is submitted to the relay under an `Idempotency-Key` and polled for its receipt. Three situations used to resubmit the step under a new key, and the relay admitted it as a second task, so the step ran, and was paid for, twice:

- the poll deadline passed while the relay still reported the task running, or could not be reached;
- the submission request reached the relay but its response was lost (the request threw, or the `201` body never arrived whole);
- a retry met `409` because the relay was still processing the earlier request under the same key. This one was reported as a hard failure, even though the task had been admitted and could still complete.

None of these means the task was not admitted. After a deadline the adapter now asks the relay once more. When it still has no answer, or a submission gets no response, it resubmits under the same key, so the relay replays the task it already admitted instead of admitting a new one. A `409` is retried with backoff (1s, 2s, 4s, … up to 30s), also under the same key, for as long as the step's own time budget allows.

When the relay never confirms how the task ended (a `409` that outlasts the step's budget, or retries that run out while the relay cannot be reached), the step now ends as **undetermined** instead of failed: "Submission unconfirmed — the task may still complete; check /result". An undetermined step is not retried and does not count against the worker, because running it again could run the task twice.

A task the relay no longer has (`404` on the step's own task id: it expired from the queue without a receipt, so no result is coming) is final for that task. The step is retried as a new task, with a new key and that task's worker excluded. Only a task that conclusively failed, or expired this way, gets a new key. Any other rejection from the relay is handled as before. When the step gives up, the error now reports how many attempts were actually made.
