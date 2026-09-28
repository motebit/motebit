---
"@motebit/runtime": minor
"@motebit/wallet-solana": minor
"@motebit/web": patch
"@motebit/desktop": patch
"@motebit/mobile": patch
---

A payment that may have left the wallet is never followed by a fresh broadcast for the same intent, and a hire's payment is always its own transaction (#885).

- `@motebit/wallet-solana`:
  - Sign-then-send seam: `sendUsdc` / `sendUsdcBatch` / `buildP2pPaymentProof` / `SolanaWalletRail.buildP2pPayment` take optional `BroadcastHooks`. `beforeBroadcast({ signature, lastValidBlockHeight })` runs after signing and before sending (again on a blockhash-expiry re-sign); if it throws, nothing is sent.
  - New read-only `SolanaRpcAdapter.getSignatureOutcome` (`Web3JsRpcAdapter`): `landed` / `failed` / `expired` / `pending` / `rpc_error`. `expired` only when one `getEpochInfo` read shows block height past `lastValidBlockHeight` + a 10-block margin AND the full-history status response's `context.slot` is at least that read's slot — a lagging node's "not found" is `pending`.
  - Sticky pending: once any read in a confirmation has seen the transaction in a block (`SignatureOutcome` / `P2pPaymentConfirmation` `pending` with `seen: true`), a later `expired`/`absent` for it is never accepted — in the adapter's post-expiry poll and in the runtime's own-signature confirmation — so a lagging or minority-fork node cannot turn a landed payment into a re-sign or a void. Landing/expiry decisions never run at `"processed"` (clamped to `"confirmed"`).
  - After an expiry the adapter polls `getSignatureOutcome` (every ~1.5s, up to 30s) until the answer is decisive — web3.js raises the expiry at lastValid+1, inside the absence margin, so a single ask would turn every expiry into a failed send.
  - The blockhash-expiry retry no longer re-signs blind: `TransactionExpiredBlockheightExceededError` means web3.js stopped hearing, not that the tx failed to land. The adapter asks `getSignatureOutcome` about the transaction it sent: `landed` ⇒ that is the payment (no re-sign); `failed` ⇒ `confirmed: false`, never retried; only `expired` re-signs; `pending` / `rpc_error` ⇒ the error is thrown for the caller's own-signature confirmation. This closes a pre-existing double-pay (both attempts landing).
  - `SolanaRpcAdapter.honorsBroadcastHooks` (true on `Web3JsRpcAdapter`). `SolanaWalletRail.confirmP2pPayment({ request, transaction })` exists ONLY over an adapter that declares it: a verdict about THAT signature; a landed tx becomes a proof only if it is from this wallet and pays exactly the requested legs. No leg-matching attribution (`findOutgoingTransfer` is untouched and unused here).
- `@motebit/runtime`:
  - `resolveAndSubmitP2pDelegation` records `p2p-payment:<signature>` in the paid-intent ledger inside `beforeBroadcast` (a failed write stops the send). After a builder throw it asks `confirmP2pPayment` about each of ITS OWN signatures: one landed ⇒ proceed with it; all dead ⇒ `payment_broadcast_failed` (entries voided); nothing signed ⇒ `payment_broadcast_failed` "nothing was sent"; otherwise `payment_status_unknown`, recorded. `PaidIntentLedger.voidUnsent` added; the exclusion list is gone.
  - `submitP2pDelegation` retries a failed submit with the same proof; the terminal code is `payment_not_admitted` (definitive refusal) or the new `payment_admission_unconfirmed` (a network failure, 5xx or 409 may have been admitted unseen). Both carry `settledPayment` + `submitError`.
  - Any OTHER transaction a hire signed (a re-sign) is voided only if the chain calls it dead; otherwise it is recorded as owed and reported on the result (`settlement.extraPayments` / `error.extraPayments` + `notice`), shown by the loop tool result, invokeCapability and the CLI.
  - Owed records fail closed: `PaidIntentLedger.recordOwed` holds an in-memory lock for the process lifetime when the durable write throws, and the result says so (`ledgerWriteFailed`).
  - A 409 `TASK_P2P_PROOF_REPLAYED` ends as `payment_admission_unconfirmed` (the proof already funded a task), never "refused".
  - `retrieveDelegationResult` answers `p2p-payment:` / `p2p-unconfirmed:` ids locally (`not_admitted`) — the relay has no read by payment.
  - The confirmer is wired on the loop, invokeCapability, granted and CLI paths; `BuildP2pPayment`, `P2pBroadcastHooks`, `SignedP2pTransaction`, `ConfirmP2pPayment`, `p2pPaymentConfirmerOf` exported.
- `@motebit/runtime`: new `payment_notice` stream chunk. `invokeCapability` yields it (success and failure); a `delegate_to_agent` call stashes it and the stream emits it right after the call (chat and post-approval paths). `paymentNoticeCopy` is the one owner-facing sentence every surface renders.
- `@motebit/web`, `@motebit/desktop`, `@motebit/mobile`: render `payment_notice` as a system message on every chat stream (turn, post-approval resume, and the web chip invocation). Desktop and mobile single-turn goal runs lead the outcome summary and completion event with it (never the signed artifact).
- `@motebit/web`: recurring goal fires carry a `payment_notice` on the run record (`payment_notice`, never the artifact); the goal card shows the latest one, and `runNow` renders it live.
- `@motebit/runtime`: doors without a chunk stream log the notice loudly (`delegation.payment_notice`): the non-streaming `sendMessage`, a served task (`handleAgentTask`), and plan execution (planner chunks have no notice variant).
- `@motebit/runtime`: `ignoreChunk` — the `default:` of a chunk switch that refuses `payment_notice` at compile time; the granted door's failure result now carries `unconfirmedPayment`, `extraPayments`, `ledgerWriteFailed` and `notice`.
- `@motebit/web`: copy for `payment_status_unknown`, `payment_not_admitted` and `payment_admission_unconfirmed` — each says not to hire again.
