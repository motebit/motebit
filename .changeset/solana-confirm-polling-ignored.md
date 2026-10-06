---
"@motebit/wallet-solana": patch
"@motebit/relay": patch
"@motebit/proxy": patch
---

Solana confirmation never depends on a websocket subscription, and an anchor memo whose outcome is unknown is never re-sent blindly.

- `@motebit/wallet-solana`: new `confirm-signature.ts` — `confirmSignatureByPolling` / `checkSignatureOnce` confirm by HTTP `getSignatureStatuses` (history included) and `getBlockHeight` (read first), returning `confirmed` / `failed` / `expired` / `pending`, bounded, injectable sleep/clock. Every confirmation in the package goes through it: the memo submitter, the adapter's `sendUsdc` / `sendUsdcBatch` path, and both Jupiter swaps. A static test fails on any `confirmTransaction(` / `sendAndConfirmTransaction(` / `onSignature(` in `src/`.
- `@motebit/wallet-solana`: `SolanaMemoSubmitter` signs, reports `{ signature, lastValidBlockHeight }` through an optional `beforeBroadcast` hook (a throw stops the send), sends once and polls that signature. Non-confirmed outcomes throw `AnchorTransactionFailedError`, `AnchorBroadcastExpiredError` or `AnchorConfirmationPendingError`. New `checkBroadcast(ref)` asks about a recorded signature without sending. Optional `connection` and `confirm` config.
- `@motebit/relay`: every anchoring stream (federation settlement, agent settlement, credential, identity-log, transparency, revocation) writes through `submitRecordedAnchor` (`anchor-broadcasts.ts`): the memo's signature is recorded in `relay_anchor_broadcasts` (migration v57) before it is sent; a later attempt for the same anchor reconciles that signature first — landed ⇒ confirmed with it, pending ⇒ nothing sent, expired / failed ⇒ exactly one new memo.
- `@motebit/proxy`: allowlist descriptions name the polled confirmation instead of web3.js `confirmTransaction`.
