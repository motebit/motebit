---
"@motebit/protocol": minor
---

`ToolDefinition.moneyBinding?: "args" | "late"` — the R4 metering axis (standing-delegation §3.3 AND-composition). Absent/`"args"` keeps today's semantics: the loop meters the tool call's own `amount_micro`+`counterparty` before execution. `"late"` declares that the spend materializes inside execution (e.g. a delegation quote resolved after worker discovery): the loop still requires a verified grant + wired meter to admit a grant-cleared call, and the metering itself moves to the rail seam — the runtime binds the payment builder only through `wrapP2pPaymentWithMeter`, which meters the delegator's TOTAL outflow (worker net + every fee leg) at the last point before broadcast and refuses on deny (gate `check-ceiling-from-grant` assertion 4). First declarer: `delegate_to_agent` — the standing grant can now authorize a real paid delegation, metered.
