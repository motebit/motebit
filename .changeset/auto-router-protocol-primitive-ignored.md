---
"@motebit/policy": patch
"@motebit/proxy": patch
---

Auto-router dispatcher (`dispatchRouting`, `applyBalanceFilter`, `REFERENCE_ROUTING_POLICY`) lands in `@motebit/policy` as the BSL-judgment-layer consumer of `@motebit/protocol`'s new routing types.

`services/proxy/src/app/v1/messages/route.ts` refactored from inlined `TASK_MODEL_MAP` + `getAffordableModelForTask` to the protocol-layer primitive: `applyBalanceFilter(catalog, balance)` then `dispatchRouting(taskShape, filteredCatalog, {jurisdiction:"US"}, REFERENCE_ROUTING_POLICY)`. `classifyTask` (LLM-based intent classifier) stays proxy-internal as the input source. `services/proxy/src/validation.ts` imports `InferenceHost`/`ModelLab`/`Jurisdiction` from `@motebit/protocol` (lifted there) and re-exports for proxy-internal back-compat.

PR 1 ships motebit-cloud-proxy as the first registered consumer in drift gate `check-routing-decision-coverage` (#95); PR 2 adds BYOK; PR 3 adds on-device. The three-instance endgame mirrors chrome-as-state-render's web/mobile/spatial rollout.

Doctrine: `docs/doctrine/auto-routing-as-protocol-primitive.md`.
