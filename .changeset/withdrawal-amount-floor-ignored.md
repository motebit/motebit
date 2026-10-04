---
"@motebit/virtual-accounts": patch
"@motebit/relay": patch
---

Refuse money amounts that convert to less than one micro-unit. Production held two `pending` withdrawals of 0 micro-units: `POST /api/v1/agents/:id/withdraw` validated the DOLLAR value (`amount > 0`) and then converted with `toMicro`, so a positive sub-micro amount (1e-7 USD rounds to 0) recorded a $0 withdrawal, and the `@motebit/virtual-accounts` chokepoint `requestWithdrawal` validated nothing.

`@motebit/protocol` adds the one rule as pure algebra next to `toMicro`: `isPositiveMicro(micro)` (a positive safe integer), `parsePositiveMicro(dollars)` (a finite number whose `toMicro` conversion is at least 1 micro, else `null`) and `MIN_POSITIVE_MICRO` (1). `requestWithdrawal`, `InMemoryAccountStore.debitAndRecordWithdrawal` and the relay's `SqliteAccountStore.debitAndRecordWithdrawal` throw a `RangeError` on any other amount; the relay's `enqueuePendingWithdrawal` applies the same rule (NaN and fractional amounts previously passed its `<= 0` check). Every relay route that converts a client-supplied dollar amount validates the converted value: `/withdraw` (400 naming the 0.000001 USD minimum), `/checkout` (non-finite refused; the $0.50 floor stays), the Stripe checkout credit, and `POST /listing` pricing (`unit_cost` must be 0 or at least 1 micro).
