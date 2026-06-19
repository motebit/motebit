# Gate repair instructions

A drift gate that fails must tell the reader **how to fix it**, not just **that** something broke. The agentic-era invariant: an agent (or human) who hits a red gate should be able to close the loop from the failure text alone — without opening the gate's source to reverse-engineer what it wanted.

This is the difference between a gate that prints `3 violation(s) found` (the reader becomes the parser) and one that names the canonical source of truth and the exact edit. The first is a tripwire; the second is self-serviceable.

## The contract

When a gate fails, its output (stdout + stderr) MUST carry a **repair instruction**: two halves.

1. **A canonical-source pointer** — _where the truth lives_. A repo path (`packages/protocol/src/index.ts`, `apps/web/index.html`, `services/relay/.env.example`) or a `@motebit/<pkg>` symbol. Not "a config drifted" — _which file_.
2. **An actionable directive** — _what to do_. A runnable command (`pnpm --filter @motebit/wire-schemas build-schemas`), a `Fix:` label, or an imperative anchored to a target (`import X from @motebit/y`, `route through Z`, `add the field`, `align the doc claim`).

This is a **floor**, not a prose-quality bar — a floor is what a regex can enforce. A gate clears the ceiling above it by naming the _specific_ edit, not just the rule it broke. Stating the rule (`every signed artifact MUST carry a suite`) is not a repair instruction; naming where to add the field is.

## Enforcement is on the outcome, not the mechanism

A gate may print however it likes — the contract is on the emitted text, so no gate is forced to adopt a particular helper. The contract is enforced behaviorally, where the repo already drives every gate into failure to prove it bites: [`check-gates-effective`](../../scripts/check-gates-effective.ts) runs each gate against its probe, captures the real failure output, and asserts `hasRepairInstruction` passes. A gate that bites but emits no repair instruction fails the effectiveness run. New gates comply or CI goes red — the obligation is structural, not a convention a reviewer has to remember.

The matcher (`hasRepairInstruction`) and the convenience emitter (`failWithRepair`) live in [`scripts/lib/gate-report.ts`](../../scripts/lib/gate-report.ts). `failWithRepair({ invariant, canonical, fix })` is the easiest way to clear the contract — its required `canonical` + `fix` fields make the repair instruction structurally unavoidable — but a gate's own hand-rolled output is equally valid as long as the text satisfies the contract.

If a gate's failure genuinely cannot name a canonical source or a concrete edit (rare), it goes on `REPAIR_CONTRACT_ALLOWLIST` in `check-gates-effective` with a reason — a deliberate admission that a failure isn't self-serviceable, which should almost always be fixed in the gate instead.

## Boundaries — what a green check does NOT prove

This contract is a **partial gate**, and the discipline is to never mistake it for a total one. It checks a _lexical/structural_ property (is a source pointer + a directive present in the text?) as a proxy for a _semantic_ one (is the fix actually correct and helpful?). A passing `hasRepairInstruction` means a repair instruction is **present**, not that it is **right**. Over-trusting that green check is the era's signature bug; an over-claimed gate manufactures exactly that.

So the enforcement ladder has three rungs, strongest first, and every invariant should be placed on the highest rung it can reach — never assumed onto a lower one:

1. **Unrepresentable** — the type system or a gate makes the wrong state impossible (the [`runtime-invariants-over-prompt-rules`](runtime-invariants-over-prompt-rules.md) ideal). The repair _contract's structural half_ lives here.
2. **Instrumented** — what can't be made unrepresentable gets a live invariant check on the artifact, surfaced and trusted as a measurement, never assumed from a green elsewhere. Motebit already does this for the ungateable: treasury reconciliation (recorded-fee-sum vs onchain balance), operator-transparency's declared-vs-proven posture, the signed human `ApprovalDecision` in the R4 money path. The _honesty_ of a repair instruction belongs here, not on rung 1.
3. **Assumed** — nothing checks it. The danger rung. An invariant sitting here while a nearby green check implies coverage is the failure this whole doctrine exists to surface.

And the residue is real: the machine maintains **type and behavioral** coherence, not **semantic** coherence. "Is this label honest / is this the right thing to build" is an irreducible judgment layer no gate closes — which is why motebit keeps a _signed sovereign decision_ in the money path rather than pretending to gate it. Coherence is not truth. A perfectly-typed system can still say something false; the gates keep it consistent and legible, and a human still owns the claim.

## Why this is a sibling of the existing principles

- [`runtime-invariants-over-prompt-rules`](runtime-invariants-over-prompt-rules.md) — make illegal states unrepresentable. Here the "illegal state" is a gate that catches drift but can't tell you how to repair it; the contract makes that state fail CI.
- Synchronization-invariants meta-principle (root `CLAUDE.md`) — name the canonical truth, name the sync owner and trigger, add a defense. The canonical truth is the repair contract in `gate-report.ts`; the trigger is `check-gates-effective`; the defense is the per-gate assertion.
- [`registry-pattern-canonical`](registry-pattern-canonical.md) — the meta-gate that locks the gates. This locks a different property of every gate: not that it bites, but that its bite is _legible_.

## Scope note

The contract reaches every gate `check-gates-effective` probes. `check-receipt-conformance` is excluded from that harness (it needs the packages built + a Python reference, so it runs in its own CI job); its failure output is held to the same standard by hand, not by the probe.
