---
"@motebit/runtime": minor
"@motebit/wallet-solana": minor
"@motebit/web": patch
---

A payment that may have left the wallet is never followed by a fresh broadcast for the same intent, and a hire's payment is always its own transaction (#885).

- `@motebit/wallet-solana`:
  - Sign-then-send seam: `sendUsdc` / `sendUsdcBatch` / `buildP2pPaymentProof` / `SolanaWalletRail.buildP2pPayment` take optional `BroadcastHooks`. `beforeBroadcast({ signature, lastValidBlockHeight })` runs after signing and before sending (again on a blockhash-expiry re-sign); if it throws, nothing is sent.
  - New read-only `SolanaRpcAdapter.getSignatureOutcome` (`Web3JsRpcAdapter`: block height read BEFORE the status, full-history status search): `landed` / `failed` / `expired` / `pending` / `rpc_error`.
  - New read-only `SolanaWalletRail.confirmP2pPayment({ request, transaction })`: a verdict about THAT signature only; a landed tx becomes a proof only if it is from this wallet and pays exactly the requested legs. No leg-matching attribution (`findOutgoingTransfer` is untouched and unused here).
- `@motebit/runtime`:
  - `resolveAndSubmitP2pDelegation` records `p2p-payment:<signature>` in the paid-intent ledger inside `beforeBroadcast` (a failed write stops the send). After a builder throw it asks `confirmP2pPayment` about each of ITS OWN signatures: one landed ⇒ proceed with it; all dead ⇒ `payment_broadcast_failed` (entries voided); nothing signed ⇒ `payment_broadcast_failed` "nothing was sent"; otherwise `payment_status_unknown`, recorded. `PaidIntentLedger.voidUnsent` added; the exclusion list is gone.
  - `submitP2pDelegation` retries a failed submit with the same proof; the terminal code is `payment_not_admitted` (definitive refusal) or the new `payment_admission_unconfirmed` (a network failure, 5xx or 409 may have been admitted unseen). Both carry `settledPayment` + `submitError`.
  - `retrieveDelegationResult` answers `p2p-payment:` / `p2p-unconfirmed:` ids locally (`not_admitted`) — the relay has no read by payment.
  - The confirmer is wired on the loop, invokeCapability, granted and CLI paths; `BuildP2pPayment`, `P2pBroadcastHooks`, `SignedP2pTransaction`, `ConfirmP2pPayment`, `p2pPaymentConfirmerOf` exported.
- `@motebit/web`: copy for `payment_status_unknown`, `payment_not_admitted` and `payment_admission_unconfirmed` — each says not to hire again.
