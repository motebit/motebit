---
"@motebit/protocol": patch
---

Doc-only: `ACCOUNT_DEPOSIT_AUDIENCE`'s comment now records that the self-declared `POST /agents/:id/deposit` route was removed (a treasury-drain vector — it credited spendable balance from a client-supplied amount) and that the audience remains reserved for a future _funded_ deposit-initiation endpoint. No API-surface change; balance is credited only by verified server-side funding (onchain deposit-detector, Stripe webhook).
