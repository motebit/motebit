---
"motebit": patch
---

The approval prompt now names the stakes. A money action renders a distinct `⚠ MONEY · IRREVERSIBLE` band, states that it pays from your sovereign wallet, and shows either the `--budget` ceiling or an honest "amount set by the worker's listing at hire time" — never a fabricated figure, since a delegation's price is late-bound. The action itself reads in human language ("Hire an agent on the motebit network to: …") instead of raw tool JSON, and the context renders as output with a single-line prompt, which also fixes the block duplicating on screen as you typed your answer. Delegation progress now animates on the post-approval execution path, which previously rendered nothing at all while a paid task ran.
