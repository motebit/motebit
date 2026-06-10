# Memory never confers authority

**Status:** shipped (invariant + producer seam, 2026-06-10). Grant store / inbound-token plumbing / relay revocation feed deferred behind the named triggers in `docs/proposals/standing-delegation-v1.md` §6b.
**Code:** `packages/policy/src/policy-gate.ts` (step 8b), `packages/runtime/src/grant-verifier.ts` (`verifyGrantForTurn`), `packages/runtime/src/interactive-delegation.ts` (explicit `riskHint`).
**Gate:** `check-money-authority`.
**Siblings:** [`memory-provenance.md`](memory-provenance.md), [`delegation.md`](delegation.md), [`runtime-invariants-over-prompt-rules.md`](runtime-invariants-over-prompt-rules.md), [`surface-determinism.md`](surface-determinism.md).

## The invariant

**Memory may inform; only signed artifacts authorize.** An R4_MONEY tool call may auto-execute — no live human approval — only when the turn carries a cryptographically verified standing-delegation grant (`TurnContext.verifiedGrant`). Nothing the model emits, recalls, or claims can populate that field; no trust level, governance preset, or configuration can substitute for it. There is no switch that disables the branch — that absence is what makes it an invariant rather than a policy default ([`runtime-invariants-over-prompt-rules.md`](runtime-invariants-over-prompt-rules.md)).

## The hole this closes

Two compounding gaps, both verified from the bytes during the memory-architecture audit:

1. **`delegate_to_agent` classified R0_READ.** It registered with no `riskHint`, and its name/description match no risk pattern — so a tool that settles real money over the P2P rail fell to the read-class default and auto-executed. Closed: explicit `riskHint` (`R4_MONEY` + irreversible when a payment rail is configured at registration; `R2_WRITE` otherwise — costless delegation shouldn't prompt).
2. **The Trusted-caller bypass was unconditional.** A Trusted caller cleared approval even inside the R4 approval band. Combined with provenance-free memory ("user trusts Alice with payments" — said by whom?), the dispatch chain _recalled belief → trusted caller → auto-executed money_ had no signed artifact anywhere in it. Closed: step 8b runs **after** every approval-lowering adjustment and re-raises approval for R4 unless `verifiedGrant` is present. Trusted still clears R0–R3 — the bypass is subordinated, not removed.

`denyAbove` is untouched: a grant never overrides a hard deny. The deterministic `invokeCapability` path is also untouched — a user's explicit tap _is_ the authorization ([`surface-determinism.md`](surface-determinism.md)); this invariant governs the model-initiated tool loop.

## The producer/validator split

`validate()` stays synchronous; crypto happens upstream at dispatch:

- **Producer** — `verifyGrantForTurn(token, grant, revocations)` in `@motebit/runtime`: runs `verifyStandingDelegation` + `verifyTokenAgainstGrant` with `isRevoked` built from `findGrantRevocation` (all `@motebit/crypto`, re-exported via `@motebit/verifier`). Returns the `verifiedGrant` value on full success, `null` on any failure — fail-closed; a partial verification never confers authority. It is the **only** sanctioned writer of `verifiedGrant` (gate-scanned).
- **Transport** — `sendMessageStreaming` options → loop options → `TurnContext`, the same channel `delegationScope` rides.
- **Validator** — policy-gate step 8b consumes the typed fact and nothing else.

## Relationship to provenance

[`memory-provenance.md`](memory-provenance.md) makes a memory's epistemic standing legible (`[from:user]` vs `[from:tool]`); this doctrine makes that standing **non-load-bearing for money**. The two compose: provenance fixes what the model believes, the invariant fixes what belief can do. A `user_stated` memory of "I trust Alice with payments" is still memory — it may prompt the model to _propose_ a delegation; the execution either presents a live grant or waits for a tap.

## Scope honesty and triggers

Today no caller presents `DelegationToken`s to the runtime and no grant store exists. The seam and the invariant ship now; net effect: **R4 never auto-executes** — which is the invariant, expressed as the degenerate case. The UX cost is one approval tap per money-moving call (the `approval_request` chunk already renders risk level). Deferred, behind the standing-delegation proposal's named triggers: the grant store, inbound-token presentation on delegated tasks, and the relay revocation feed. When those land, `verifyGrantForTurn` is already the verification chain they call.

## Failure modes, named

- **Approval fatigue** pushes users toward granting standing delegations — which is the designed pressure: authority migrates into signed, scoped, revocable artifacts instead of ambient trust.
- **A compromised producer** is the residual risk; the gate-scan (no assignment of `verifiedGrant` outside the producer + the option-threading sites) bounds it to the one audited module.
- **Free-rail delegation at R2** can still send data outbound — covered by the existing outbound sensitivity gate, not this invariant.
