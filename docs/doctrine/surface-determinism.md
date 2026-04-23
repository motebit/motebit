# Surface determinism

A user who taps an affordance has authorized a specific capability invocation. The implementation must honor that authorization deterministically — not route it through a model and hope the model agrees.

## The anti-pattern

A button labeled "Review this PR." Under it, a click handler that reads:

```ts
onClick(() =>
  handleSend(
    `Delegate this code review to a remote agent (required_capabilities: ["review_pr"]). PR: ${url}`,
  ),
);
```

The handler hands an English prompt to the AI loop. The loop runs a model. The model, on a bad day, answers with bullet-point questions instead of calling `delegate_to_agent`. The affordance lied — it said "Review this PR," but the path it took was advisory, not binding.

This is the same category error as services inlining protocol plumbing (guarded by `check-service-primitives`): a convention that looked pragmatic once is a load-bearing surface by the time three siblings have copied it. Once the model is in the routing path between user intent and execution, there is no way for the receipt to say whether the user authorized the specific delegation or only the conversation that preceded it.

## The principle

> When intent is unambiguous (a chip, a button, a slash command, a scene-object click, a voice opt-in), the path from authorization to execution must be deterministic — no LLM in the loop.

The model is for interpretation when intent is ambiguous (the chat box). When intent is unambiguous, it's a category error to have the model decide.

## The fix

Three layers, each doing one thing:

1. **Protocol vocabulary (`@motebit/protocol`, Apache-2.0).** `IntentOrigin` — a closed string-literal union: `"user-tap" | "ai-loop" | "scheduled" | "agent-to-agent"`. Attached to every `ExecutionReceipt` and to every relay task submission as `invocation_origin`. Signature-bound: the value present at sign-time is the value any verifier sees. Legacy receipts omit the field and MUST NOT be retroactively reclassified.

2. **Runtime primitive (`@motebit/runtime`, BSL).** `MotebitRuntime.invokeCapability(capability, prompt, options): AsyncGenerator<StreamChunk>`. Submits with `required_capabilities: [capability]` and `invocation_origin: "user-tap"`. Shares the submit-and-poll core with `delegate_to_agent` (extracted into `relay-delegation.ts` so the two paths never diverge). Yields `delegation_start → text → delegation_complete` (with `full_receipt`). On failure, yields a single `invoke_error` chunk carrying a closed `DelegationErrorCode` — never falls through to the AI loop, never hides the failure behind a retry.

3. **Static gate (`scripts/check-affordance-routing.ts`).** Scans `apps/*/src/ui/**` and `apps/*/src/commands/**` for handlers that construct a capability-naming prompt and pass it to `handleSend` / `sendMessageStreaming`. Fails CI on any match.

## Honest degradation, not graceful

A deterministic path cannot use the AI loop as its fallback layer. Tempting ("if `review_pr` fails, let the model try") and wrong — the fallback reintroduces the very ambiguity the deterministic path existed to remove. The contract is stricter:

- **Pre-flight failures** (network, auth, 429, insufficient balance, trust threshold, no routing, 400) → system message with actionable next step. No assistant bubble opens, no receipt artifact emerges.
- **In-flight failures** (timeout, agent-failed, network glitch mid-poll) → system message. The task may continue server-side; user knows the current invocation did not complete.
- **Result-time failures** (receipt.status=`failed`, malformed receipt, signature verify fails) → emerge the receipt bubble in `is-failed` or `is-unverified` state. The receipt is real evidence of what happened; hiding it would be theatre.

No silent retry. No fake bubble. No fall-through to the AI loop.

## Why the discriminator is signature-bound

A receipt with `invocation_origin: "user-tap"` is stronger evidence than `"ai-loop"` in any dispute about consent. The user did not just authorize the conversation; they authorized this specific capability invocation. Because the value is covered by the Ed25519 signature, no relay or intermediary can retroactively downgrade a user-tap authorization into an ai-loop narrative. That property is what makes it worth shipping as a protocol-level field rather than a runtime-side annotation.

## Cross-cuts

- [`self-attesting-system.md`](self-attesting-system.md) — the chip that says "Review this PR" can be cryptographically proven to have invoked `review_pr`. The receipt provides both the claim and the mechanism to verify it; `invocation_origin` is what makes the verification specifically about user-tap authorization.
- [`operator-transparency.md`](operator-transparency.md) — the transparency declaration can honestly state that user-tap and ai-loop delegations route through the same pipeline but carry audit-distinguishable origins. A relay that treated them differently without declaring so would break the declaration; the signature-bound discriminator makes that drift detectable.
- [`protocol-model.md`](protocol-model.md) — `IntentOrigin` lives in `@motebit/protocol` (Apache-2.0, vocabulary). The `invokeCapability` method and the `check-affordance-routing` gate live in BSL (judgment). The dual-license split is the right one: any third party implementing the protocol must honor the discriminator on receipts, but the deterministic invocation path and its drift defense are judgments specific to this codebase's UX doctrine.
