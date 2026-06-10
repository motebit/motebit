---
"@motebit/protocol": minor
---

The standing-authority invariant — memory never confers authority (`docs/doctrine/memory-never-confers-authority.md`).

`TurnContext.verifiedGrant?: { grant_id, verified_at }` — a cryptographically verified standing-delegation grant covering the turn. Populated exclusively by the runtime's dispatch-layer grant verifier (`verifyGrantForTurn`: `verifyStandingDelegation` + `verifyTokenAgainstGrant` + a revocation check over signed artifacts), never from model output, recalled memory, trust level, or configuration. Its sole consumer is the policy gate's new step 8b: an R4_MONEY tool call auto-executes only when `verifiedGrant` is present; otherwise it requires live human approval regardless of any approval-lowering path — the Trusted-caller bypass, the service-motebit adjustment, and governance presets are subordinated for R4 (they still clear R0–R3). `denyAbove` is never overridden by a grant; the deterministic `invokeCapability` tap path is untouched.

Companion fix: `delegate_to_agent` now registers with an explicit `riskHint` (`R4_MONEY` + irreversible when a payment rail is configured, `R2_WRITE` otherwise) — previously it carried no hint and the risk-model patterns classified the money-capable delegation tool `R0_READ`, letting it auto-execute as read-class.

Gate-enforced by `check-money-authority` (drift-defenses #123): block present + ordered after the trust switch, explicit riskHint, single audited producer of `verifiedGrant`.
