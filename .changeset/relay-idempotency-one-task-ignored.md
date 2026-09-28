---
"@motebit/relay": patch
---

`POST /agent/:motebitId/task`: within the key's 24-hour retention window, one `Idempotency-Key` admits at most one task (#888; `spec/delegation-v1.md` §3.3, 1.3). After the window the key is free again.

Client-visible changes:

- **An error body carries `task_id` when a task was admitted.** A submission that admitted a task and then failed now names that task in its error body. Examples are a federation forward rejected or timed out (502), the ranking loop's 402, or an internal 500. The field is additive.
- **A same-key retry replays that error rather than retrying.** After such a failure, a replay under the same key returns the same status and body. It never admits a second task and never forwards again. To try again, use a new key.
- **A refusal made before admission still frees the key, as on main.** This covers validation, settlement gates, insufficient funds (402), and every federated-P2P check. Those checks are an undiscoverable pinned worker (404), an unbound settlement address, a missing priced listing, an unresolvable executor treasury, a mismatched proof leg (400), and an open circuit (503). A corrected same-key retry is admitted once and forwarded once.
- **A 409 names the task when the key already admitted one.** A 409 for a key whose admitted task has not recorded its response now carries `task_id`. This covers a submission still in flight, or one that ended in a crash before recording its response.
- **Ordering.** The budget allocation and the federated-P2P discovery and validation now run before the task is enqueued. The hold, the idempotency claim and the queued task commit in one transaction.
- **Schema change.** `relay_idempotency_keys` gains a `task_id` column, added in place.
