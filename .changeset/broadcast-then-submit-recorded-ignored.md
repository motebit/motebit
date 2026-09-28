---
"@motebit/runtime": minor
"@motebit/wallet-solana": minor
---

A payment that may have left the wallet is never followed by a fresh broadcast for the same intent (#885).

- `@motebit/runtime`:
  - `resolveAndSubmitP2pDelegation` records the payment in the paid-intent ledger at broadcast, under `p2p-unadmitted:<tx>` (in flight), before submitting. On admission the task entry takes over (`PaidIntentLedger.admitted`); if admission never happens the entry becomes unretrieved and locks the pair across sessions.
  - `submitP2pDelegation` retries a failed submission with the SAME proof (`submitRetry`, default 1s/3s/9s; transient = network, 5xx, 408, 429, 401, 409 other than `TASK_P2P_PROOF_REPLAYED`). A submission that is never admitted returns the new code `payment_not_admitted`, with `settledPayment` (taskId = the ledger id) and `submitError` (the relay's last answer).
  - A `buildP2pPayment` throw is resolved through the injected `confirmP2pPayment` (new param, wired from the runtime's wallet on the loop, invokeCapability and granted paths): landed → proceed with that proof (checked against the requested legs); absent → `payment_broadcast_failed`; pending → waited up to 180s; anything else, or no confirmer → the new code `payment_status_unknown`, recorded as `p2p-unconfirmed:…`, never retried.
  - `retrieveDelegationResult` answers ledger ids with no relay task locally (`not_admitted`); `/result` and `retrieve_task_result` render it. The `intent_already_paid` message names such entries honestly.
  - `selectAndRunDelegation` never falls back to relay-mode for a result carrying a money fact.
  - New exports: `p2pPaymentConfirmerOf`, `isPaymentWithoutTaskId`, types `ConfirmP2pPayment`, `P2pPaymentConfirmation`, `SubmitRetryPolicy`.
- `@motebit/wallet-solana`:
  - New read-only `SolanaWalletRail.confirmP2pPayment` — the multi-leg sibling of `confirmSend`; `landed` carries the proof.
  - `OutgoingTransferQuery.alsoLegs`: a multi-leg lookup matches only a transaction whose transfers are exactly those legs.
  - `buildP2pPaymentProof` now shares its leg list and proof assembly with the lookup (no behavior change).
