---
"@motebit/sdk": minor
---

A paid-result record names the relay that owes its result.

`PaidIntentRecord` gains an optional `relay_url?: string` — the relay the paying call was bound to. Additive: a record written before it has none and is read from whichever relay is bound, as before. Stores that persist records should keep the field when it is present.
