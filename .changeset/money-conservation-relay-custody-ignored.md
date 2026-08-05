---
"@motebit/virtual-accounts": minor
---

`computeWithdrawableAvailable` — one definition of what may leave as cash.

An account's withdrawable amount is `balance − disputeHold − grantHold`, and
every exit path must subtract both holds. `requestWithdrawal` always did; the
aggregated sweep and the batch enqueue it feeds computed `balance − disputeHold`
and ignored the promotional-grant hold entirely, so on a deploy with a sweep rail
configured and free credit enabled an unspent grant was auto-swept to the agent's
own wallet as real cash — the exact outcome the grant hold exists to prevent,
reachable on the one exit path nobody has to ask for.

All four sites now consume this canonical computation instead of re-deriving it,
including `getAccountBalanceDetailed` — the user-facing "available" figure, and
so the likeliest place for a displayed number to drift from what a withdrawal
would actually permit. Withdrawal-only by construction: `debitSpendable` still
consults the dispute hold alone, so grant credit stays spendable on inference.
