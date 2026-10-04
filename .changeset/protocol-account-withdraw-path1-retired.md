---
"@motebit/protocol": patch
---

Doc comments only: `AccountWithdrawRequest.destination` and the account-withdraw module header no longer describe Path 1 (x402 to an EVM wallet) as a live payout. Path 1 is retired (#948): the reference relay refuses an EVM `0x` destination with 400 `WITHDRAWAL_DESTINATION_UNSUPPORTED` before any debit. No type or runtime change. Sibling of the ignored-package changeset `withdrawal-payouts-chain-decided-ignored.md`.
