---
"@motebit/crypto": minor
"@motebit/protocol": minor
---

`verifyWithdrawalReceipt` — the portable verifier for completed-withdrawal receipts, closing a self-attesting-system gap on the money-out path. A completed withdrawal is a truth the relay asserts (relay CLAUDE.md Rule 6: every such truth must be independently verifiable without relay contact), but until now the relay signed a `WithdrawalReceiptPayload` with no portable verifier — a third party could not confirm it.

Changes: `WithdrawalReceiptPayload` moves to `@motebit/protocol` (permissive-floor wire law); `signWithdrawalReceipt` moves into the `@motebit/crypto` kernel and gains its mirror `verifyWithdrawalReceipt` (both re-exported from `@motebit/virtual-accounts` for back-compat, and from `@motebit/verifier` so external consumers verify through the pinned aggregate). The market-v1 §2.9 wire record gains `relay_id` — a signed-payload field that was absent, so the response is now self-verifiable from the record alone. Registered in `check-signed-artifact-verifiers` (gap → within/verifier).
