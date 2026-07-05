---
"@motebit/policy": minor
"@motebit/persistence": minor
---

Money-execution Inc 3b siblings: `@motebit/policy` gains `extractMoneyAction` (fail-closed money-fact extraction from R4 tool args — explicit `amount_micro`+`counterparty` shape only, no heuristics; unmeterable ⇒ no autonomous money); `@motebit/persistence` gains `SqliteGrantSpendStore` (migration 41, `grant_spend_state`) — the durable blast-radius accumulator whose persistence is load-bearing for the LIFETIME ceiling (an in-memory accumulator re-arms the delegator's total bound on every restart), atomic via read→`evaluateBlastRadius`→write inside one `driver.transaction`.
