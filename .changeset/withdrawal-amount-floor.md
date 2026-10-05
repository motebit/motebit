---
"@motebit/protocol": minor
---

Add `isPositiveMicro(micro)`, `parsePositiveMicro(dollars)` and `MIN_POSITIVE_MICRO` next to `toMicro`: the one rule for a money amount that must move value. `isPositiveMicro` is true only for a positive safe integer of micro-units; `parsePositiveMicro` returns the `toMicro` conversion of a finite dollar number when that conversion is at least 1 micro (0.000001 USD), else `null`. Validate the converted value, never the dollar value alone: `1e-7` USD is `> 0` yet converts to 0 micro, which is how $0 withdrawals reached a relay ledger. Pure and additive.
