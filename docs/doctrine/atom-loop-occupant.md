# The atom, the loop, and the occupant

What is the smallest invariant that cannot be removed without collapsing accountable agency? Not the trust graph — remove it and the system gets amnesiac, not unaccountable. Not the policy gate — remove it and the agent is ungoverned, not unattributable. Not receipts-as-a-schema — any signed statement of an act would do. Not even the `motebit_id`-commits-to-genesis-key lever — remove it and accountability doesn't collapse, it _recentralizes_ into a registry's claim (the custodial model, degraded but standing; see [identity-binding-verification](identity-binding-verification.md)). The irreducible atom is a single predicate with two inseparable clauses:

> `verify(canonicalize(claim), pk)` — **and** — _`sk` never crosses the membrane._

Remove key exclusivity and non-repudiation dies instantly: every artifact becomes deniable ("anyone could have signed that"), and no downstream structure can repair it — trust accumulation, dispute-grade history, and settlement verification all inherit deniability from the leaked atom. Remove canonicalization and you get the subtler collapse: signatures that bind to _bytes_ but not to _meaning_. Without one canonical form, a verifier can be shown a different parse of the same signed blob than the signer intended — attribution survives but what was attributed becomes ambiguous, and ambiguity is deniability with better manners. Canonicalization is the least glamorous line in the stack and it is doing constitutional work.

Every other invariant in the corpus is this predicate _applied to a subject matter_. Receipts are it applied to execution — subject = signer, and the fact that `EvalAttestation` had to be carved out as a separate artifact class precisely because subject ≠ signer is the repo testifying that the distinction is load-bearing ([evals-as-attestations](evals-as-attestations.md)). Delegation is it applied to authority transfer ([delegation](delegation.md)). Key rotation is it applied reflexively — the identity's own next state signed by its prior state, which is all [identity-as-lineage](identity-as-lineage.md) is: the atom pointed at the system's own transitions. [memory-never-confers-authority](memory-never-confers-authority.md) is its negative space — the rule that nothing _unsigned_ authorizes.

## The collapse test

Run the reduction both ways. Keep only the atom and strip everything else: identity is rebuildable as signed lineage, authority as signed grants, history as signed commitments, succession as signed transitions. Keep everything else and remove the atom: what remains is _testimony_ — an operator's database of claims about what agents did, accountable only in the sense that an institution vouches for it. It may still function, still keep logs, still enforce governance; it no longer produces proof. The proof-vs-testimony line is therefore constitutional, not operational — it is the exact boundary [self-attesting-system](self-attesting-system.md) and [operator-transparency](operator-transparency.md) (declared vs. proven posture) are built on, and it is the difference between this architecture and every hosted platform in the competitive landscape: they have logs; none has non-repudiation.

## The HSM objection

The atom is sufficient for accountability. It is not sufficient for agency: a hardware security module satisfies both clauses — canonical, exclusive commitments — and no one mistakes an HSM for an actor. So the atom is the atom of accountable _commitments_, not yet of accountable _agency_. The gap is real, and no single addition bridges it:

- **State alone** — a Certificate Transparency log signs over its own history; its tree head commits to its past commitments. Stateful, non-equivocating, self-referencing. Not an agent.
- **Stakes alone** — a bonded notary is a slashable signer. Consequence-bearing. Not an agent.
- **Refusal alone** — an HSM with PIN policy and rate limits already refuses. Selective. Not an agent, because the policy it enforces is _imposed on it_, not held by it.

## The loop

The smallest _architectural_ addition is not another primitive — it is a closed loop through the boundary, with two one-way valves whose failure modes are distinct and must not be conflated:

- **Outbound: nothing crosses except as a chosen canonical commitment.** The interior's selections reach the world only through the atom, gated by policy the signer itself holds as signed, revisable state — refusal belongs to the signer, unlike the HSM's imposed PIN. Remove this valve and the signer degrades into a **conduit**: attribution passes through it to whoever feeds it inputs, which is exactly what an HSM is — a tool whose signatures commit its operator.
- **Inbound: consequence returns as signed interior state.** What the commitments caused flows back through the boundary as memory, trust earned-and-losable, lineage — and those mutations are themselves signed (the atom applied reflexively). Remove this valve and the signer is a **stateless oracle**: attribution has nowhere to land, nothing at the signer can be credited, diminished, or bound by its own past.

With both valves, attribution **terminates** at the signer instead of passing through it — and that termination is what "actor" means operationally. [delegation](delegation.md) already bookkeeps the distinction: a delegated agent is _terminus_ for its execution and _conduit_ for its principal's authority, and the delegation chain is the signed record of which is which, hop by hop.

## The occupant

The loop hosts agency; it does not generate it. The thing that _selects_ — that has ends, that makes the signer's commitments choices rather than throughput — is the interior, and the architecture deliberately refuses to make it an invariant: intelligence is pluggable, brought-your-own, never sold and never canonical ([intelligence-pluggability-contract](intelligence-pluggability-contract.md)). The HSM is a boundary with an empty interior; the self-signing body differs from the self-signing machine by being _inhabited_. This is not unfinished architecture — a system that claimed its invariants generate agency would be selling intelligence. The boundary is constitutional; the inhabitant is replaceable.

Compressed: **the atom makes commitments undeniable; the loop makes them someone's; the interior makes them chosen. Only the first two are invariants — and that is a design decision, not an omission.**

## Enforcement posture

Per-claim status, five states: _implemented_ (library/construction), _schema-enforced_, _gate-enforced_ (a named drift gate goes red), _deferred fail-open_ (gap with a named trigger), _declared only_. The last two are legitimate constitutional states — obligations, not commentary. This table is itself a drift surface: [composition-preserves-enforcement](composition-preserves-enforcement.md) governs its staleness, and `check-doctrine-citations` binds its names.

| Claim                                    | Witness                                                                                                                                              | Posture                                                                                                                                                                         |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Meaning has one canonical form           | JCS + suite-dispatch in `@motebit/crypto` (the only Ed25519 caller); Python conformance suites re-derive it in CI                                    | Implemented; conformance-checked                                                                                                                                                |
| Only the interior produces the signature | OS-keyring key custody behind the membrane; hardware attestation is additive scoring, never a gate ([hardware-attestation](hardware-attestation.md)) | Implemented; isolation strength varies by surface and is documented per-surface                                                                                                 |
| Nothing unsigned authorizes money        | `TurnContext.verifiedGrant` produced only by `verifyGrantForTurn`                                                                                    | Gate-enforced (`check-money-authority`); runtime fail-closed                                                                                                                    |
| Receipts: subject = signer               | Receipt family suite pins in wire-schemas; `EvalAttestation` carve-out for subject ≠ signer                                                          | Schema-enforced                                                                                                                                                                 |
| Consequence returns as signed state      | `ConsolidationReceipt`; accrual basis minted only by real accrual code paths                                                                         | Gate-enforced (`check-accrual-basis-canonical`, `check-memory-source-canonical`)                                                                                                |
| Continuity is reflexive signing          | Rotation succession chain; seed-derived sovereign ids ([identity-restore](identity-restore.md))                                                      | Implemented; anchoring rungs additive by design ([identity-binding-verification](identity-binding-verification.md))                                                             |
| Raw strings cannot inhabit id types      | `Brand<T,B>` branded ids                                                                                                                             | **Declared only** — the optional-brand hole: the brand key is optional, so a raw string assigns without a cast; tightening touches every consumer and is its own ticket         |
| Verify family fails closed everywhere    | [verify-family-fail-closed](verify-family-fail-closed.md)                                                                                            | **Deferred fail-open** on two external seams (standing-delegation revocation, receipt-chain embedded-key fallback), named triggers recorded there; internal R4 path fail-closed |

## The audit

Before a new architectural mechanism ships, three questions with veto power:

1. **Does it preserve the atom?** Any state change or claim-of-act not grounded in a signed canonical artifact is testimony entering a proof system. A self-asserted boolean, a client-supplied balance, an unverified "the environment says so" — each fails here before implementation review begins.
2. **Does it preserve the loop?** Outbound: does anything cross the boundary that the signer did not choose under policy it holds? Inbound: does any consequence fail to return as signed interior state — or any state mutate without a signed cause?
3. **Does it preserve the boundary between architecture and occupant?** Two failure directions, both fatal: making the occupant constitutional (a canonical model, an invariant that only holds for one intelligence), and delegating constitutional enforcement _to_ the occupant — an invariant that depends on the model behaving is a prompt rule, and [runtime-invariants-over-prompt-rules](runtime-invariants-over-prompt-rules.md) already forbids it.

These are conservation tests: veto power, not design sufficiency. Retrodicted against decisions made for independent reasons, they predict the outcomes — the self-declared deposit route deleted (question 2), sandbox attestation's never-a-self-asserted-boolean (question 1), the `EvalAttestation` carve-out (questions 1–2), intelligence-pluggability itself (question 3). They would not have invented the commitment bond, the fee structure, or the five spatial primitives — sufficiency comes from the physics and the thesis, not from here.

## Boundary

This is a lens with a table, not a theorem — it inherits the humility of [identity-as-lineage](identity-as-lineage.md): no claim about cognition, consciousness, or what agency _is_, only about what makes it accountable and where that is enforced. It legislates nothing new: the executable-legibility discipline it follows is [agentic-era-engineering](agentic-era-engineering.md)'s, and the declared-vs-proven split in the table is [operator-transparency](operator-transparency.md)'s, applied per-claim — this page enacts those laws rather than restating them. A regression on the atom is never a bug; it is a collapse, and it should be triaged as one.
