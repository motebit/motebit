---
"@motebit/protocol": patch
---

Pin the failed-vs-denied status semantics on `ExecutionReceipt` and `ToolInvocationReceipt`. The discriminator is who refused: `denied` is the governance boundary's verdict (a policy gate blocked the task's actions and no permitted work completed), `failed` is the execution interior's verdict (crashes, timeouts, and the worker's own principled refusals all included). Doc-comment clarification only — no wire-format or runtime change; existing receipts stand as minted. Canonical prose lives in `spec/execution-ledger-v1.md` §11.1 "Status semantics".
