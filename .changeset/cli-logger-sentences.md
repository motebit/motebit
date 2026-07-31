---
"motebit": patch
---

Known runtime events now render as designed sentences in the REPL instead of `key=value` dumps (#480): route degrade (`direct payment route unavailable — this task goes through the relay; no onchain payment leaves the wallet`), the volatile grant-spend-store warning, and relay key-pin rotation/mismatch. The compact context form remains the fallback for unknown events — and for a known event whose context doesn't match the shape its sentence was written for.
