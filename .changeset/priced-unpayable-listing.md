---
"@motebit/relay": patch
---

A priced listing now demands payment whether or not it declares `pay_to_address`.

`getAgentPricing` returns null without a `pay_to_address` — correct for the
x402 middleware it feeds, since that is an onchain path and the address is
where the money goes. But the relay-custody funding check reused it as a
general "does this agent charge" predicate, and that lane credits the worker's
virtual account and never reads `pay_to_address`. A listing priced above zero
with no payout address therefore read as FREE: priced enough to mint a
`price_snapshot`, not priced enough to demand payment. An unfunded delegation
fell through to the free-agent branch and booked an allocation `status='locked'`
with `amount_locked` set and no debit — a row every downstream payout site
trusts. The funding check now derives from the same `getListingUnitCost` read
that produces `price_snapshot`, so the two cannot disagree.
