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
2. **The Trusted-caller bypass was unconditional.** A Trusted caller cleared approval even inside the R4 approval band. Combined with provenance-free memory ("user trusts Alice with payments" — said by whom?), the dispatch chain _recalled belief → trusted caller → auto-executed money_ had no signed artifact anywhere in it. Closed: step 8b runs **after** every approval-lowering adjustment and re-raises approval for R4 unless `verifiedGrant` is present. Trusted still clears R0–R3 up to the owner's band — the bypass is subordinated, not removed. Since #880 E it is also capped: a Trusted caller clears exactly what the owner's own preset auto-allows and never skips an approval the owner's own turn would face (Trusted is earned from this motebit's outbound hires, so it must not widen inbound authority past the owner's).

`denyAbove` is untouched: a grant never overrides a hard deny. The deterministic `invokeCapability` path is also untouched — a user's explicit tap _is_ the authorization ([`surface-determinism.md`](surface-determinism.md)); this invariant governs the model-initiated tool loop.

## The producer/validator split

`validate()` stays synchronous; crypto happens upstream at dispatch:

- **Producer** — `verifyGrantForTurn(token, grant, revocations)` in `@motebit/runtime`: runs `verifyStandingDelegation` + `verifyTokenAgainstGrant` with `isRevoked` built from `findGrantRevocation` (all `@motebit/crypto`, re-exported via `@motebit/verifier`). Returns the `verifiedGrant` value on full success, `null` on any failure — fail-closed; a partial verification never confers authority. It is the **only** sanctioned writer of `verifiedGrant` (gate-scanned).
- **Transport** — `sendMessageStreaming` options → loop options → `TurnContext`, the same channel `delegationScope` rides.
- **Validator** — policy-gate step 8b consumes the typed fact and nothing else.

## Relationship to provenance

[`memory-provenance.md`](memory-provenance.md) makes a memory's epistemic standing legible (`[from:user]` vs `[from:tool]`); this doctrine makes that standing **non-load-bearing for money**. The two compose: provenance fixes what the model believes, the invariant fixes what belief can do. A `user_stated` memory of "I trust Alice with payments" is still memory — it may prompt the model to _propose_ a delegation; the execution either presents a live grant or waits for a tap.

## Scope honesty and triggers

Today no caller presents `DelegationToken`s to the runtime and no grant store exists. The seam and the invariant ship now; net effect: **R4 never auto-executes** — which is the invariant, expressed as the degenerate case. The UX cost is one approval tap per money-moving call (the `approval_request` chunk already renders risk level). That tap exists only on the owner's own turns. In a turn that runs another principal's words (a customer's `motebit_task`, a caller's `motebit_query`), no human is there to answer, so a call that would pause for approval is refused outright instead (#880, the policy gate's no-approval-channel view). A foreign task's approval never outlives the task, and the "denied" is on its signed receipt. An MCP caller was already treated this way. Deferred, behind the standing-delegation proposal's named triggers: the grant store, inbound-token presentation on delegated tasks, and the relay revocation feed. When those land, `verifyGrantForTurn` is already the verification chain they call.

## Failure modes, named

- **Approval fatigue** pushes users toward granting standing delegations — which is the designed pressure: authority migrates into signed, scoped, revocable artifacts instead of ambient trust.
- **A compromised producer** is the residual risk; the gate-scan (no assignment of `verifiedGrant` outside the producer + the option-threading sites) bounds it to the one audited module.
- **A path that never asks the gate** bypasses the invariant entirely — the 2026 composition audit found `motebit serve --direct` (both the MCP `motebit_task` tool and the relay WebSocket dispatch) executing tools straight from the registry, so an R4 tool reached through a task moved money while the same tool called over MCP was refused. The deterministic path now executes through `MotebitRuntime.executeToolGated` (policy gate + `verifyGrantForTurn` + rail metering; `requiresApproval` refuses, since no human is on that path), and `check-money-authority` holds every tool-registry `execute` reference — located by the TypeScript checker, so aliasing, destructuring, bracket access, `.call/.apply/.bind`, callbacks, casts and private handler-map access all count — to a closed, sanctioned set.
- **A grant authorizes its delegate, and nobody else.** `verifyGrantForTurn` binds every presentation to its PRESENTER: the grant verifies only when its `delegate_id` (and, when known, `delegate_public_key`) is the identity the presenting path authenticated — this motebit on an owner turn, the transport-verified caller on a foreign one. A task submitter on `serve --direct` is a foreign principal: the prompt, and so the tool's arguments, are theirs, and the owner's own grant never lets them choose where the owner's money goes. A caller the transport verified no identity for (relay dispatch, a shared bearer) is authorized by no grant. Revocation is read at each presentation, never cached from startup.
- **A grant spends only its delegator's money, and the delegator must be this runtime.** Presenter binding asks _who_ holds the grant; it cannot ask _whose money_ it delegates. A stranger can sign a grant with delegator = delegate = itself, and every signature checks out. `verifyGrantForTurn` therefore pins the delegator to the verifying runtime's own identity (`motebit_id` AND key, never an id-only match): a grant authorizes spending only when this runtime signed it. Enforced in `grant-verifier.ts` (`grantDelegatorIs`), on every presentation path — the loop, `executeToolGated`, `executeGrantedDelegation`.
- **A reference scan can always be routed around.** Structural typing lets an `interface Runner { execute(…) }` in another file drive the registry with no registry type in sight, so the static scan (`check-money-authority` assertion 5) is an early warning, not the enforcement. The enforcement is a runtime capability: the runtime's registry refuses an R4_MONEY tool unless the call carries a single-use capability bound to that tool name and its exact args, minted by the runtime's ECMAScript-private minter only on a gate-decided path — `executeToolGated` after verify + gate + the blast-radius meter; the AI loop for a call the gate allowed under a grant `verifyGrantForTurn` produced (a runtime-checked set — the `VerifiedGrant` brand is type-only) and the meter passed; the approval resume for the exact call the gate paused. Every other route (alias, wrapper, `bind`/`call`/`apply`, callback, merged registry) fails at runtime and the handler never runs (`money-capability.ts`; assertion 6 locks the structure).
- **Free-rail delegation at R2** can still send data outbound — covered by the existing outbound sensitivity gate, not this invariant.
