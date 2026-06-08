---
"motebit": patch
---

Remove the unused `listArchivedReceipts` helper — it listed an in-memory per-REPL session archive (not a durable store) and had zero callers; the by-id `getArchivedReceipt` (used within a single `invoke` run) stays. No behavior change.
