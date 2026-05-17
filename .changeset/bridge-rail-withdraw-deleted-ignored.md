---
"@motebit/settlement-rails": major
---

`BridgeSettlementRail.withdraw()` removed; Bridge is now treasury-only. Sibling of the `withdrawable-guest-rail-marker` changeset in `@motebit/protocol`. Arc 1 Commit 2 of the off-ramp arc.

**Breaking change.** `BridgeSettlementRail` no longer implements `WithdrawableGuestRail` (it declares `supportsWithdraw: false as const`), and the `withdraw()` method has been deleted from the class body. Any external code that called `bridgeRail.withdraw(...)` is now a compile error — the method does not exist on the type.

**What stays.** The class still exists and still implements `GuestRail`. It still participates in the `SettlementRailRegistry` (still gets `name: "bridge"`, still answers `isAvailable()` for health checks, still wires the `onProofAttached` callback). The `BridgeClient` interface keeps `createTransfer` + `getTransfer` for future treasury-conversion methods (e.g., `convertOwnAccount(amount)` that will map to `Bridge.createTransfer({on_behalf_of: MotebitCustomerId, from: motebit_treasury, to: motebit_mercury_account})` — same-party in/out, no third-party transmission). The treasury arc lands those; today this rail's surface from the GuestRail interface is `isAvailable` + `attachProof` only.

**Why this is a major bump.** The `withdraw` method removal is breaking for any caller. The user-facing withdrawal capability that was wired (but operationally never activated in production — `BRIDGE_CUSTOMER_ID` never set in Fly secrets) is now structurally impossible. The deletion makes the Bridge compliance email's narrow framing — _"Motebit's use of Bridge is limited to corporate treasury management"_ — structurally true rather than procedurally true. No env-var flip can re-introduce user-facing Bridge withdrawal because the method does not exist on the rail.

## Migration

Before:

```ts
const bridgeRail = railRegistry.get("bridge");
if (bridgeRail) {
  await bridgeRail.withdraw(motebitId, amount, "USDC", destination, idempotencyKey);
}
```

After:

```ts
// Bridge user-facing withdrawal is structurally absent. Route user-facing
// withdrawals through `OperatorSolanaTransfer` (Path 0, sovereign Solana)
// or `WithdrawableGuestRail` instances (x402 EVM, Stripe). Bridge stays
// registered for treasury operations — future treasury-conversion methods
// will be added separately and will NOT use the GuestRail.withdraw shape.

import { isWithdrawableRail } from "@motebit/protocol";
const rail = railRegistry.get("x402");
if (rail && isWithdrawableRail(rail)) {
  await rail.withdraw(motebitId, amount, "USDC", destination, idempotencyKey);
}
```

In-flight migration: pre-deletion verification confirmed `BRIDGE_CUSTOMER_ID` was never set in production Fly secrets, so the Bridge rail never registered and `BridgeSettlementRail.withdraw` was never called in production. Zero in-flight Bridge user withdrawals existed at deletion time; no orphaned `bridge:*`-referenced rows in `relay_withdrawals` require migration.

Constructor config changes: `maxPollAttempts` and `pollIntervalMs` removed from `BridgeRailConfig` — those were only consumed by the deleted `withdraw()` method's `pollForCompletion` private helper. Callers passing them got ignored fields; remove them from the config object.

**Rationale.** Surface deletion is the strongest structural enforcement available for the off-ramp doctrine: the absence of the method on the type IS the negative-proof. A drift gate catches at CI; a type fence at the dispatch site can be routed around by the next refactor; surface deletion catches every call site that could ever reference the method, including ones that don't exist yet. The pattern matches the deleted `DirectAssetRail` (2026-04-08) which was removed for the same doctrinal reason — relay signing on behalf of agents — but extends the discipline to the orchestrator-vs-direct distinction.
