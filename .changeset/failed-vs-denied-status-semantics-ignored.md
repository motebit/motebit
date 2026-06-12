---
"@motebit/wire-schemas": patch
---

Sharpen the `status` enum description on the ExecutionReceipt schema to carry the failed-vs-denied discriminator (boundary refused = `denied`, interior did not yield its outcome = `failed`, including the worker's own principled refusals). Description-only; the regenerated `spec/schemas/execution-receipt-v1.json` rides along. Canonical prose: `spec/execution-ledger-v1.md` §11.1 "Status semantics".
