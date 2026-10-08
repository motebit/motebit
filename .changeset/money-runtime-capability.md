---
"@motebit/runtime": patch
"motebit": patch
---

An R4_MONEY tool's handler is now unreachable without a runtime capability. The runtime's tool registry refuses a money tool unless the call carries a single-use capability that only a gate-decided runtime path mints, bound to that tool name and its exact arguments; calling the registry's `execute` directly, through an alias, a wrapper, a structural interface, `bind`/`call`/`apply`, a callback or a merged registry fails at runtime and the handler never runs. A standing grant now verifies only when its delegator is this runtime's own identity (motebit id and key): a grant a stranger signed — including one naming the stranger as its own delegate — authorizes nothing here. Unchanged and still refused by design: an R4_MONEY task arriving by relay WebSocket dispatch, which carries no verified caller identity, never clears R4.
