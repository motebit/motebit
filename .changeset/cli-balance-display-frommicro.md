---
"motebit": patch
---

Route the CLI's micro→USDC display conversion through the canonical `fromMicro` (re-exported by `@motebit/sdk`) instead of an inline `/ 1_000_000` in `wallet` and `migrate`. Value-identical (`fromMicro` is `micro / MICRO`), display-only — the ledger is unchanged — but it makes the converter the single audit point for unit conversion. Imported via `@motebit/sdk` (apps consume the product vocabulary, not `@motebit/protocol` directly — `check-app-primitives`).
