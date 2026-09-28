---
"@motebit/planner": patch
"@motebit/runtime": minor
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

**Pay-forward is disabled (#887).** A relay-admitted worker (the default for every priced `molecule-runner` listing) refuses a pay-forward task after the money has moved, and no listing, discovery record or MCP schema exposes a worker's admission mode.

- `@motebit/runtime` gains `SOVEREIGN_PAY_FORWARD_ENABLED` (`false`), `SOVEREIGN_PAY_FORWARD_DISABLED_MESSAGE` and `SovereignPayForwardDisabledError`.
- `createSovereignDelegationAdapter` throws before any discovery or payment.
- There is no config or env override.
- The adapter and its exactly-once logic stay tested behind the gate, so re-enabling is that one constant.
