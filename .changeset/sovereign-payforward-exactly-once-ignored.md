---
"@motebit/planner": patch
"@motebit/runtime": patch
"@motebit/wallet-solana": minor
---

Sovereign pay-forward: a delivery-uncertain outcome never becomes a new payment (#887).

`SovereignDelegationAdapter` paid on Solana, then executed over MCP, and retried after payment. It could pay twice in three ways: a lost `send` response, an MCP timeout, or a missing or malformed receipt.

- `@motebit/planner`:
  - **Send errors.** A thrown `send` is resolved through the wallet's read-only `confirmSend`. If the transfer landed, the step proceeds with that signature. If it is confirmed absent, the next worker may be tried. If it cannot be decided, the step stops with "payment status unknown" and nothing is paid again.
  - **After payment.** A timeout, a transport error, or an answer that is not a verified receipt signed by the paid worker stops the step with "paid, result not retrieved (tx …, worker …)". Nothing is re-hired.
  - **Signed failures.** Only a verified failed receipt, signed by the paid worker itself, may retry with another worker.
  - **Ledger.** Every payment is recorded on an injected paid-intent ledger before the task is presented. A worker already holding a paid, unretrieved result is refused before any money moves. Ledger writes never abort a paid flow.
- `@motebit/runtime`: `createSovereignDelegationAdapter` wires the runtime's durable `PaidIntentLedger` (#884) and logger into the adapter.
- `@motebit/wallet-solana`:
  - New read-only `SolanaWalletRail.confirmSend`, which returns `landed`, `absent`, `pending` or `unknown`.
  - New optional `SolanaRpcAdapter.findOutgoingTransfer`, implemented on `Web3JsRpcAdapter` as one fail-closed page of signature history.
  - New export `SOLANA_TX_LANDING_HORIZON_MS`.
  - `InsufficientUsdcBalanceError` and `InvalidSolanaAddressError` are documented as pre-signing only.
