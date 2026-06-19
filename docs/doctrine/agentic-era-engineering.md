# Agentic-era engineering

A checksum over how this repository is built — not a new architecture project. It names the worldview the codebase already enforces, so the practice stops being tacit and starts being something a build can be checked against. Every claim below links to the code, gate, or named seam that makes it real; nothing here is aspirational, and no term is introduced unless it changes a decision.

## The thesis

Construction is cheap now; **coherence is the scarce resource.** When agents — not only humans — read, extend, and build on a system, the binding constraint shifts from "can we build it" to "does it stay consistent, and can an outsider consume its guarantees correctly without the author translating." So the engineering spend goes to the machine that maintains coherence — the enforced layer DAG ([`check-deps`](../../scripts/check-deps.ts)), the drift-gate suite, the doctrine corpus — not to feature count.

A coherence moat only compounds if others can build on it, and that requires **legibility** — not the prose kind, the executable kind. The moat explains itself through types, gates, structured verdicts, and repair instructions, so a stranger (human or agent) consumes it correctly without tribal knowledge. The codebase is the moat; executable legibility is how the moat compounds.

## The shared invariant: verifiability, not consensus

The one thing every participant must agree on is minimized to the **verification substrate** — canonicalization (JCS), the signature-suite registry, the wire schemas — and kept additive (a new suite is a registry append per [`agility-as-role`](agility-as-role.md), not a re-vote). Everything participants actually disagree about — trust, judgment, governance — is pushed into the sovereign interior. Two parties who agree on nothing about values can still verify each other's artifacts from first principles. Agreement is demoted to the cheapest possible layer; it is not abolished — we still anchor to a chain for transparency, additive and never gatekeeping (the proof-composability principle). This is minimal-shared consensus, not "zero consensus."

## Three operating principles, already enforced

1. **Make illegal states unrepresentable; instrument what you can't; never assume.** The three-rung ladder — type/gate → live instrument → the danger rung, _assumed_ — is the enforcement spine ([`gate-repair-instructions`](gate-repair-instructions.md) § Boundaries; [`runtime-invariants-over-prompt-rules`](runtime-invariants-over-prompt-rules.md)). What can't be made unrepresentable gets a live check on the artifact (treasury reconciliation, declared-vs-proven posture, the signed `ApprovalDecision` in the R4 path via `verifyGrantForTurn`), never assumed from a green elsewhere.

2. **Gates teach.** A failing gate emits a repair instruction — canonical source plus the fix — so a global rule reveals itself on contact instead of having to be known in advance ([`gate-repair-instructions`](gate-repair-instructions.md), enforced by [`check-gates-effective`](../../scripts/check-gates-effective.ts)). This is what makes more gates survivable for local work.

3. **Coherence is not truth.** The machine maintains type and behavioral coherence, not semantic coherence. "Is this honest / is this the right thing to build" is irreducible judgment no gate closes — which is why a signed sovereign decision stays in the money path rather than being faked as a check ([`verify-family-fail-closed`](verify-family-fail-closed.md)). The semantic residue is owned by a human.

## Two calibrations, so the thesis travels without mis-adoption

- **State the cost-center.** "Spend on the machine, not the features" is unconditional only because motebit is a protocol: correctness _is_ the product and the cost of wrong is effectively unbounded ([`protocol-primacy`](protocol-primacy.md)). A product-layer consumer must re-proportion coherence-spend against feature-validation by _their_ blast radius, not inherit motebit's. The thesis is calibrated, not universal.

- **The locality dial.** "Verifiable locality with enforced global invariants" is a curve, not a free pairing: every global gate makes a local edit less local — it must now know the global rule to be safe. The dial's slope is a function of **gate legibility** — a gate that teaches its rule on contact converts "know every global rule to edit locally" into "learn the one you just hit." Repair instructions don't pay down the locality cost; they flatten its slope. More gates is only sustainable because the gates teach.

## Scope

This governs _repository construction_ and how the moat is consumed — it is not the wire protocol (that lives in `spec/`). It is a checksum: if a future build contradicts a line here, either the build is wrong or this doc is stale and must be corrected in the same pass. Held to the same rule as the rest of the doctrine — practice and doctrine never diverge.

## Cross-cuts

- [`gate-repair-instructions.md`](gate-repair-instructions.md) — gates teach; the three-rung ladder; the floor-vs-ceiling boundary.
- [`runtime-invariants-over-prompt-rules.md`](runtime-invariants-over-prompt-rules.md) — make illegal states unrepresentable at the runtime.
- [`verify-family-fail-closed.md`](verify-family-fail-closed.md) — coherence ≠ truth; the structured-verdict reshape; the executable-legibility arc.
- [`protocol-primacy.md`](protocol-primacy.md) — why motebit's cost-center calibration is "correctness is the product."
- [`agility-as-role.md`](agility-as-role.md) — divergence enters as a registry append, never a wire break.
- [`agency-proof-integration.md`](agency-proof-integration.md) — the first external consumer the legibility surface is measured against.
