---
"motebit": minor
---

REPL: bare capability names now invoke the capability, not the AI loop.

Typing `wallet` (or the shell habit `motebit wallet`) inside the REPL used to route to chat and come back as an essay — actively obscuring a money-critical answer when the user wanted their funded address. New slash commands `/id`, `/wallet`, and `/ledger <goal-id>` invoke the capabilities deterministically (`/wallet` reuses the key the REPL already unlocked — no re-prompt), and exact bare names from a curated read-only set (`wallet`, `id`, `balance`, `ledger <goal-id>`, `help`) resolve to their slash with a dim `→ /wallet` teaching line. The resolver is deliberately narrow: questions and sentences stay chat, and money or mutating commands never route from bare text.
