---
"@motebit/relay": patch
"@motebit/runtime": patch
---

One P2P `payment_proof` admits at most one task (#918; `spec/delegation-v1.md` §3.3, 1.4). The only reuse guard read `relay_settlements.p2p_tx_hash`, which exists only once a task settled, so the same unsettled proof under a new `Idempotency-Key` admitted and dispatched a second task on one payment.

Client-visible changes:

- **The same proof under any other key is refused.** `POST /agent/:motebitId/task` answers `409 TASK_P2P_PROOF_ALREADY_ADMITTED` when the proof's tx hash is bound to an admitted task. The body carries that task's `task_id` only when the caller is entitled to see it: the identity whose verified token submitted it, or the operator. Another principal's refusal carries no task id. A proof whose task already settled keeps `409 TASK_P2P_PROOF_REPLAYED`.
- **The same proof under the same key is unchanged.** It is the #888 replay of the first answer.
- **A refusal before admission spends nothing.** The binding is written inside the admission transaction, so a validation, eligibility, discovery or leg refusal, or a rollback inside the transaction, leaves the proof unbound, and a corrected retry under any key is admitted once.
- **The federated 502s no longer invite a new key.** After a federated forward is rejected or times out, the proof is spent on the admitted task named in the 502 body. The retry is the same-key replay, or polling that task's result (a timed-out forward may still have been accepted). A new task needs a new payment.
- **The executor relay binds too.** `POST /federation/v1/task/forward` answers `409 {status: "rejected", reason: "p2p_proof_already_admitted"}` when a peer forwards a proof already bound to a different `task_id`. The same `task_id` re-forwarded is unchanged (`duplicate`).
- **Schema change.** Migration v47 adds `relay_p2p_proof_claims` (tx hash, task id, submitter, time), backfilled from queued tasks and settled proofs. Rows are never deleted.

Client follow-up (not in this change): `packages/runtime` `isRetryableSubmitStatus` treats every 409 other than `TASK_P2P_PROOF_REPLAYED` as retryable, so it retries `TASK_P2P_PROOF_ALREADY_ADMITTED` a bounded number of times before ending in `payment_admission_unconfirmed`. That end state is correct. The #885 client keys on the tx hash, so it gets the same-key replay and never this code.

The runtime's P2P submit loop treats `409 TASK_P2P_PROOF_ALREADY_ADMITTED` as final (never retried; ends `payment_admission_unconfirmed` with the payment's lock kept), like `TASK_P2P_PROOF_REPLAYED`. The relay's transparency declaration (and PRIVACY.md) lists the new `relay_p2p_proof_claims` table.
