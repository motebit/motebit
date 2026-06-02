---
"@motebit/protocol": minor
---

Add `computeP2pFeeMicro(netCostMicro, feeRate)` — the canonical P2P settlement fee-leg primitive (`gross - net` where `gross = round(net / (1 - feeRate))`, in micro-units). This is interop law on the money path: the relay's `requiresP2pProof` submission validator and the delegator client that builds the payment proof must compute the fee identically, or the proof is rejected (`TASK_P2P_FEE_AMOUNT_MISMATCH`). Hosting it in `@motebit/protocol` (which both the relay and the runtime depend on, but `@motebit/market` is not a runtime dep) gives one source of truth instead of two inline copies that can drift. The relay's `services/relay/src/tasks.ts` validator now consumes it.
