---
"@motebit/protocol": major
---

Introduce `WithdrawableGuestRail extends GuestRail` marker interface; remove `withdraw()` and `withdrawBatch?()` from the `GuestRail` base. Arc 1 Commit 2 of the off-ramp arc (sibling of `path-0-solana-sovereign-withdrawal` changeset). Same shape as the existing `DepositableGuestRail` / `BatchableGuestRail` discriminant-narrowing pattern, applied to the withdrawal axis.

**Why this is a major bump.** `withdraw()` is no longer on the base `GuestRail` interface — any external code that called `someRail.withdraw(...)` after typing the variable as bare `GuestRail` will fail to compile. The migration is mechanical (narrow through `isWithdrawableRail()` before calling) but it IS a breaking change in the public surface.

**Why this matters doctrinally.** The off-ramp arc's load-bearing invariant is _"Motebit is not a transmitter of user funds."_ Path 0 (Arc 1 Commit 1) made the sovereign return-of-custody path the structurally-preferred route. This commit makes the previously-bank-shaped fallback (Bridge user withdrawal) structurally impossible: `BridgeSettlementRail` cannot satisfy `WithdrawableGuestRail` because it carries `supportsWithdraw: false` and the `withdraw` method has been removed at the package level. The fence isn't a drift gate or a type narrowing at a single call site — it's the absence of the method on the type itself. Anywhere in the workspace, anywhere in any future contributor's code, `bridgeRail.withdraw(...)` is a compile error because the method does not exist.

## Migration

Before:

```ts
import type { GuestRail } from "@motebit/protocol";

function autoSettleWithdrawal(rail: GuestRail, ...args) {
  return rail.withdraw(motebitId, amount, currency, destination, idempotencyKey);
}
```

After:

```ts
import type { GuestRail, WithdrawableGuestRail } from "@motebit/protocol";
import { isWithdrawableRail } from "@motebit/protocol";

function autoSettleWithdrawal(rail: GuestRail, ...args) {
  if (!isWithdrawableRail(rail)) {
    // Rail is registered for something other than user-facing withdrawal
    // (treasury orchestration, deposit intake). Skip or route elsewhere.
    return null;
  }
  // After narrowing, `rail` is `WithdrawableGuestRail` and `withdraw` is callable.
  return rail.withdraw(motebitId, amount, currency, destination, idempotencyKey);
}

// Alternatively, type the parameter as WithdrawableGuestRail directly
// when the caller has already done the narrowing:
function fireWithdrawal(rail: WithdrawableGuestRail, ...args) {
  return rail.withdraw(motebitId, amount, currency, destination, idempotencyKey);
}
```

Rails that previously implemented `GuestRail` with a `withdraw()` method must now declare `implements WithdrawableGuestRail` instead, and add `readonly supportsWithdraw = true as const` alongside the existing `supportsDeposit` / `supportsBatch` discriminants. Rails that are registered for non-user-facing purposes (treasury orchestration, deposit-only, anchor submission) should declare `readonly supportsWithdraw = false as const` and either delete their `withdraw()` method or leave it undeclared — the structural absence IS the invariant.

The `BatchableGuestRail` interface now extends `WithdrawableGuestRail` (batch is a specialization of single withdraw). Batchable rails must implement both `supportsWithdraw: true` and `supportsBatch: true`.

**Rationale.** Marker-interface narrowing is the strongest structural enforcement available — stronger than drift gates (which catch at CI), stronger than type fences at a single dispatch site (which the next refactor can route around), stronger than `@deprecated` JSDoc (which compiles fine). The method's absence from the type IS the negative-proof. The pattern is already used in this package for deposit (`DepositableGuestRail`) and batch (`BatchableGuestRail`); the withdrawal axis now follows the same shape.

**Reference consumers** (not in changeset scope): `@motebit/settlement-rails` (major bump in its own changeset — `BridgeSettlementRail.withdraw` removed) and `services/relay/src/budget.ts` (Path 2 dispatch + Bridge webhook handler deleted; Path 1 narrows through `isWithdrawableRail`).
