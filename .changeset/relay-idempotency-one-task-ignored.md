---
"@motebit/relay": patch
---

`POST /agent/:motebitId/task`: one `Idempotency-Key` admits at most one task (#888; `spec/delegation-v1.md` §3.3, 1.3).

Client-visible changes:

- **An error body carries `task_id` when a task was admitted.** A submission that admitted a task and then failed now names that task in its error body. Examples are a federation forward answering 502, a circuit-open 503, the ranking loop's 402, or an internal 500. The field is additive.
- **A same-key retry replays the error rather than retrying.** After such a failure, a replay under the same key returns the same status and body. It never admits a second task and never forwards again. To try again, use a new key.
- **A refusal made before admission still frees the key.** This covers validation, settlement gates and insufficient funds (402). A same-key retry, for example after funding, proceeds.
- **The budget allocation now runs before the task is enqueued.** The hold, the idempotency claim and the queued task commit in one transaction.
- **Schema change.** `relay_idempotency_keys` gains a `task_id` column, added in place.
