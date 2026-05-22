---
"motebit": patch
---

Route the CLI's micro→USDC display conversion through the canonical `fromMicro` (`@motebit/protocol`) instead of an inline `/ 1_000_000` in `wallet` and `migrate`. Value-identical (`fromMicro` is `micro / MICRO`), display-only — the ledger is unchanged — but it makes the protocol converter the single audit point for unit conversion. Adds `@motebit/protocol` as a direct dependency.
