---
"@motebit/protocol": minor
---

Add canonical money primitives to the permissive-floor protocol surface: `MICRO`, `CENTS`, `toMicro`, `fromMicro`, `toCents`, `fromCents`. Pure algebra over numbers — interop law for integer-unit accounting. Every motebit implementation in any language uses the same formula at the API boundary.

Two reference precisions:

```ts
import { toMicro, toCents } from "@motebit/protocol";

toMicro(0.5); // 500_000  — USDC 6-decimal ledger precision
toCents(0.5); // 50       — Stripe / fiat-rail precision
```

`@motebit/virtual-accounts/money.ts` continues to export `MICRO`, `toMicro`, `fromMicro` — they re-export from the new canonical home, so existing imports work unchanged. Settlement rails (Stripe, x402) consume these directly instead of re-rolling `Math.round(amount * 100|1_000_000)` inline.

A new drift gate (`scripts/check-money-boundary.ts`) forbids inline copies of the converter formula in money-touching packages. Same closure pattern as cryptosuite agility — one canonical family, additive: a third precision (RWA tokens, JPY rails) is a new function in the same file, not a third inline copy.
