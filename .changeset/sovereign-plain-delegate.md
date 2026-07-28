---
"motebit": patch
---

`motebit delegate --sovereign` now works without `--plan`: the plain delegate path pays the worker directly from the sovereign Solana wallet via a single-step paid P2P delegation (discovery or `--target`, cold-start via `--pay-new-agents`, honest `Paid:` settlement line). Previously the flag was silently ignored — the command fell through to relay-custody, hit the empty virtual account, and misdirected a funded sovereign user to `motebit fund`. Every missing prerequisite now refuses loudly with its remedy, and nothing falls back to relay-custody. `--budget` is enforced as a hard pre-broadcast ceiling over the entire resolved payment (worker + all fee legs) — an over-budget resolution fails `budget_exceeded` with no money moved. (`@motebit/protocol` becomes a declared CLI dependency — previously reached only transitively.)
