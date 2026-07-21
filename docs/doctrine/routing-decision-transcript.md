# Routing-decision transcript — a hire you can prove, not just replay

**The routing arc made the hire deterministic and reproducible; the transcript makes it provable. A signed, self-contained record of why this worker won — the routing moment entering the receipt family as dispute-grade history.**

## The gap this closes

[`exploration-as-market-vitality.md`](exploration-as-market-vitality.md) already names the honest limit of what shipped: the structured `routing.worker_selected` log is a **reproducibility aid, not an independently-auditable proof**. Recomputing the draw needs the frozen admissible candidate set, the first-person trust snapshot (the α/β come from mutable, private `agent_trust` records — not in any receipt), the weights, the prior mapping, the evidence-cap rule, and an algorithm-version tag. A caller who omits a candidate, or mutates its trust ledger after the fact, cannot be caught from the seed alone. The transcript is the artifact that carries those inputs, signed by the delegator at decision time.

Why this is worth an arc at all is [`clearing-house-not-thin-waist.md`](clearing-house-not-thin-waist.md): the moat is dispute-grade history a fork cannot reproduce — never the protocol, never the coordination software. The routing machinery decides which agent gets paid work; the transcript is what turns "the newcomer won on merit" from the operator's word into a checkable sentence. The exploration doctrine spent design effort making every draw a pure function of signed, recorded context precisely so this artifact could exist; until the transcript ships, that reproducibility is a property with no consumer.

## Shape: receipt, not attestation

The delegator signs a record of **its own act of choosing** — subject = signer. That places the transcript in the receipt family of [`receipts-unified.md`](receipts-unified.md) (JCS + Ed25519 suite-dispatch + `@motebit/verifier`, the five family invariants), not the attestation family of [`evals-as-attestations.md`](evals-as-attestations.md), whose defining property is subject ≠ signer. An `EvalAttestation` is one party's judgment of another; a routing transcript is the same trust boundary as an `ExecutionReceipt` — a first-person signed act, verifiable offline by anyone holding it.

## What it carries

- The capability hired for, and the **frozen admissible candidate set** — per candidate: `motebit_id`, `unit_cost`, verified-bond status, the posterior read (α, β), and the drawn θ̃.
- The **seed provenance**: the tick token's Ed25519 signature (already a recorded, signed artifact), binding the transcript to the specific delegation turn.
- The **decision parameters**: weights, the level→prior mapping, the evidence-cap rule, exploration strength, and an algorithm-version tag.
- The **outcome**: winner, the explored flag (did the draw override the exploit-favorite), or the pin (`targetWorkerId`) when the hire was a deterministic override — a pinned hire mints a trivial transcript recording the pin as the reason, no draw.

The verification law is **recomputation**: `selectWorker` and `sampleBeta` are pure functions of exactly these inputs, so a verifier re-runs the ranking from the transcript and checks the winner matches the signature's claim. Determinism is same-version (golden vectors pin same-version identity; the cross-engine last-ULP caveat carries over from the exploration doctrine unchanged) — the version tag is load-bearing, not decorative.

## Invariants

- **Reveals, never authorizes.** The transcript is evidence about a decision already made under the hard gates; no verifier output feeds any gate, and `check-money-authority` is untouched. Same rule as [`felt-accumulation.md`](felt-accumulation.md): leverage reveals, never authorizes.
- **Produced-basis only.** The transcript is minted by the real selection code path at the `WorkerSelector` seam — never model-authored, never reconstructed after the fact. Same honesty floor as [`memory-provenance.md`](memory-provenance.md): an artifact that testifies about interior state must be minted by the code that produced the state.
- **First-person disclosure is dispute-scoped.** The per-candidate (α, β) are the delegator's private interior — its opinion of its counterparties. The transcript is minted always and retained locally ([`retention-policy.md`](retention-policy.md)); it **egresses on dispute or by owner choice, never by broadcast**. And the REFUSED clause of the exploration doctrine stays refused here: a transcript proves that MY decision was faithful to MY ledger. It is not evidence about the worker for anyone else's ledger, and no aggregation of transcripts into a cross-delegator reputation feed is built — that would be the global score whose refusal is the sybil resistance ([`agents-as-first-person-trust-graph.md`](agents-as-first-person-trust-graph.md)).
- **Ordering, never a gate — unchanged.** The transcript observes ranking; admissibility, pins, and money authority are recorded, not altered.
- **The bond enters the record.** The transcript must state each candidate's verified-bond status, because bond-lifted exploration priority is part of "why this worker won." That forces the deferred bond-live-wiring (discovery surfacing a verified-bond signal) to ship as this arc's prerequisite increment rather than a sibling — the transcript cannot honestly record a field the closure cannot see.

## Consumer #1 — trigger honesty

The exploration doctrine deferred this artifact with the trigger "the first consumer that has to _prove_ a routing choice rather than reproduce it." That consumer is the **archetype conformance probe** ([`agent-archetypes.md`](agent-archetypes.md)): the market-activation proof — a newcomer earning a job on merit — currently rests on the runtime's own log. Asserting a verified transcript in the scheduled probe makes it accept-on-proof, the same shape as the paid-P2P `sub_settlements` assertion that closed the "green whether or not the tree settles" gap. The trigger is fired by our own living-conformance contract, not by an external ask — named plainly so this doc doesn't read as a trigger retro-fitted to a decision.

## Increments

- **Inc 0 (this doc)** — shape settled: receipt-family, dispute-scoped disclosure, bond as prerequisite.
- **Inc 1 — bond-in-discovery (prerequisite).** The relay's discover surface carries a verified-bond signal per candidate; the runtime closure joins it into `RankableWorker.bonded`. Closes the standing bond-live-wiring deferral; the sybil-swarm bound goes live on real hops.
- **Inc 2 — type + law.** `RoutingDecisionTranscript` in `@motebit/protocol` (+ wire-schemas), sign/verify in `@motebit/crypto`, a verifier arm in `@motebit/verifier`. Closed shapes, suite-dispatched, per [`registry-pattern-canonical.md`](registry-pattern-canonical.md) where a vocabulary closes.
- **Inc 3 — producer.** Minted at the runtime's `WorkerSelector` seam on every ranked (and pinned) paid hire; the transcript digest is bound into the sub-hop's `ExecutionReceipt` so the paid act commits to the choice that caused it; local retention per retention policy.
- **Inc 4 — proof contract.** The conformance probe verifies the transcript of its own delegation's routing; a drift gate holds producer coverage (a ranked paid hire without a transcript is a red build, not a log line).

## Deferred, with triggers

- **VRF-grade draw** — unchanged from the exploration doctrine: only if the draw ever becomes a third-party fairness guarantee.
- **Model-routing transcripts** — [`auto-routing-as-protocol-primitive.md`](auto-routing-as-protocol-primitive.md) is the other routing graph; a signed record of model selection waits for a consumer that must prove one.
- **Selective disclosure of the candidate set** (revealing the decision while blinding non-winning candidates' identities or posteriors) — waits for a real dispute where full-set disclosure is the sticking point.
- **REFUSED (not deferred):** any aggregation of transcripts into cross-delegator or global reputation, by the relay or anyone else. Named here so no future increment "optimizes" it in.
