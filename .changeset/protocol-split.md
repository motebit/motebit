---
"@motebit/protocol": minor
"@motebit/sdk": minor
"@motebit/verify": minor
"create-motebit": minor
"motebit": minor
---

Move trust algebra from MIT sdk to BSL semiring — enforce IP boundary.

**Breaking:** The following exports have been removed from `@motebit/sdk`:

- `trustLevelToScore`, `trustAdd`, `trustMultiply`, `composeTrustChain`, `joinParallelRoutes`
- `evaluateTrustTransition`, `composeDelegationTrust`
- `TRUST_LEVEL_SCORES`, `DEFAULT_TRUST_THRESHOLDS`, `TRUST_ZERO`, `TRUST_ONE`

These are trust algebra algorithms that belong in the BSL-licensed runtime, not the MIT-licensed type vocabulary. Type definitions (`TrustTransitionThresholds`, `DelegationReceiptLike`, `AgentTrustLevel`, `AgentTrustRecord`) remain in the SDK unchanged.

Also adds CI enforcement (checks 9-10 in check-deps) preventing algorithm code from leaking into MIT packages in the future.
