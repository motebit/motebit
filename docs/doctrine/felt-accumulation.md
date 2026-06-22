# Felt accumulation — the interior at work

[`felt-interior.md`](felt-interior.md) gave the owner two registers of the accruing
interior: it **changed** (the consolidation act, the `tending` cue) and it **holds**
(the resting `Felt*` records — memory, trust, consolidation), both now shipped across
surfaces. But the thing thesis #2 actually promises — _the agent gets more capable the
longer it runs_ — is felt in neither. A glance at a memory record tells the owner the
interior is **large**; it never lets them feel it **work**. The missing register is the
interior **drawn upon**: the moment accrued state changes an outcome — a question not
re-asked, a verification skipped, a plan shaped by last night's consolidation. That
moment, not the mass, is where "more capable over time" is felt.

This is the register the agents one layer up cannot reach
([`the-stack-one-layer-up.md`](the-stack-one-layer-up.md); Microsoft AGT, Hermes): their
identities are **ephemeral by construction** — created and destroyed in minutes — so they
have no past to draw upon and no leverage moment to show. A motebit's interior is
persistent, signed, and sovereign; this doctrine makes its **use** felt, not just its
size. Felt, riding entirely on the proven substrate — revealing accrual, never re-proving
it.

## 1. The leverage moment is an act — and the shape is already doctrine

By the [`records-vs-acts.md`](records-vs-acts.md) category test, the interior being drawn
upon is unambiguously an **act**: ephemeral, _from_ the motebit, presented then
reabsorbed — not a record it holds. records-vs-acts already proved this exact shape and
preserved the renderer for it: _"a credential briefly orbits during the delegation that
uses it, then fades"_ — `CredentialSatelliteRenderer`, kept alive for precisely the
in-use trigger after the permanent-satellite revert. The leverage moment is the
**generalization** of that orbit from credentials to all accrued state: a recalled memory,
a trust edge, a consolidated fact surfaces _as it is drawn upon_, then fades.

So felt-accumulation introduces no new act primitive on the body — it gives the existing
"accrued thing in use, briefly shown" shape a typed basis and extends it past credentials.
On flat surfaces the same act renders as a calm in-flow attribution woven into the work
already happening ("recalled from three weeks ago"; "we've settled cleanly 4× —
proceeding"), never a toast, never a standalone notice.

## 2. The derivative, without a derivative-display

felt-interior is emphatic: _present shape, not trend; never a delta, streak, or growth
chart_ — the inward global score is the sybil-bait turned on the owner. "More capable
**over time**" sounds like exactly the trend that bound forbids. The resolution is the
whole design:

**The derivative is lived, never rendered.** The owner is never shown "capability +12% this
week." They simply experience _more genuine leverage moments_ as state accrues — on day one
the interior has nothing to draw upon and the body stays honestly quiet; months in, the
agent draws upon it often, and that lived frequency **is** the feeling of growth. The trend
is emergent in experience, never a number on a surface. This keeps every felt-interior gate
intact: a leverage moment is honest-by-absence when there is nothing accrued to leverage,
and no surface ever charts the rate.

## 3. The honesty floor — attribution because _produced_, never _claimed_

felt-interior carries three honesty floors — consolidation shows detail _because signed_,
memory shows shape _because unsigned-local_, trust shows depth _because
proven-from-receipts_. The leverage register adds the **fourth**: a leverage attribution
exists **iff a real accrual code path produced it** — never because the model narrated one.

This is [`memory-provenance.md`](memory-provenance.md)'s authorship rule applied to acts:
_the basis is assigned by the code path that drew upon the state, never the model._ The
mechanism is identical and load-bearing:

- The accrual basis is **minted only inside the accrual source** — `@motebit/memory-graph`'s
  `recallRelevantCore` emits the `recalled_memory` basis as part of the retrieval it actually
  performed; the trust-graph edge lookup emits `trust_edge`; the model's text output carries
  **no** leverage marker, exactly as the `<memory>` tag carries no `source=`. A gate scans
  `ai-core` for any model-authored leverage marker — a model that could author "I remembered"
  could fabricate a relationship that was never used.
- An act renders a leverage attribution **only** if it carries an `AccrualBasis`
  (`@motebit/protocol`, a closed `AccrualKind` registry). The render path takes the
  attributed type, so a leverage attribution without a produced basis is a **compile error**,
  not a convention — the asymmetric-typing shape from `AttributedMemoryCandidate` (reads open,
  claims closed).
- **Fail-closed.** No basis → no attribution → the body shows the act plain. The interior is
  never narrated as having been used when it wasn't.

This floor is what lets the felt claim be _believed_: "more capable because I know you" is
trustworthy only because the system **cannot** assert it without having actually drawn upon
what it knows.

## 4. It annotates acts — it never manufactures them

The [`felt-interior.md`](felt-interior.md) §3 anti-eagerness bound is inherited and
**sharpened by construction**. A leverage attribution annotates an act the owner's request
already drove; it never adds an act, and it cannot, because the basis is emitted only by a
retrieval/lookup that the real work performed. There is no idle path that mints leverage to
keep a surface alive — manufacturing a leverage moment would require manufacturing the
underlying work, and the work is the user's, not the interior's vanity. A quiet interior on
a simple task is the honest outcome.

## 5. The accrual kinds — closed registry

`AccrualKind` is a closed, append-only registry ([`agility-as-role.md`](agility-as-role.md))
— name the kinds, never the mechanism; a new accrual source is one union entry, one marker,
and one gate reference:

| kind                     | the leverage made felt                        | real seam                                 |
| ------------------------ | --------------------------------------------- | ----------------------------------------- |
| `recalled_memory`        | a question not re-asked, a preference honored | `memory-graph` retrieval + `MemorySource` |
| `trust_edge`             | a peer not re-verified, friction reduced      | `AgentTrustRecord` first-person edge      |
| `consolidated_fact`      | a plan shaped by idle consolidation           | a `consolidation_derived` memory          |
| `prior_approval_pattern` | a step the owner no longer has to confirm     | approval history                          |
| `standing_delegation`    | an action auto-run under a signed grant       | the verified grant                        |

Each carries the leveraged source's reference for explicit reveal — the same
projection-on-demand as the `Felt*` records, never an eager dump.

## 6. Leverage reveals — it never authorizes

The load-bearing safety bound, because two kinds (`trust_edge`, `standing_delegation`) touch
the authority path. A leverage attribution is **epistemic display of why a friction was
reduced**, never the _grant_ of the reduction. "Proceeding without re-verifying because we've
settled 4×" describes a decision the policy and authority layers already permitted; the trust
edge being _felt_ must never become the mechanism that skips a required signed authorization.
Authority for money-moving and delegation remains the signed artifact
([`memory-never-confers-authority.md`](memory-never-confers-authority.md), `check-money-authority`);
the accrual basis may _point to_ the grant it ran under, never _be_ it. Surfacing the
relationship and reducing the friction are two facts; only the signed grant may cause the
second.

## Disclosure — summary-not-secret, sensitivity-ceilinged

Identical to [`felt-interior.md`](felt-interior.md) §3/§5. The attribution names the
_consequence_, bounded by the leveraged source's tier: "recalled a preference of yours"
(none/personal), the ceiling falling to redacted-consequence and then
existence-without-content as the tier rises ("acted on something private I remembered"). A
leverage attribution must never become a reason to surface, on a shoulder-surfable body, the
sensitive content it drew upon.

## What not to build

A "capability score" or "agent IQ" that climbs; a leverage _counter_ or rate chart (the §2
trend, the forbidden inward aggregate); a per-retrieval marker that fires on every read (the
noise [`felt-interior.md`](felt-interior.md) exists to prevent — only _consequential_
leverage, the act that changed an outcome, surfaces); a model-authored "I remember…"
narration with no produced basis (the §3 fabrication channel). Each buys the feeling of a
growing interior by betraying the substrate that makes the feeling earned.

## Gotchas and bounds

- **Leverage curdles into a scoreboard.** Counting leverage moments is the most natural next
  step and it is the §2 trend reborn. **Bound:** moments are surfaced as they genuinely
  happen and never aggregated, never rated, never charted.
- **Over-attribution drowns the signal.** Marking every retrieval is un-calm and dilutes the
  rare consequential one. **Bound:** the unit is the _consequential_ leverage (a question
  saved, a verification skipped, a plan shaped) — the [`felt-interior.md`](felt-interior.md)
  "durable mutation, not every operation" rule on the utilization axis.
- **The relationship becomes the authorization.** §6. A felt trust edge is not a grant.
  **Bound:** `check-money-authority` is upstream and untouched; the basis points to the signed
  grant, never replaces it.
- **Privacy on a shared screen.** A leverage attribution can surface recalled sensitive
  content. **Bound:** summary-not-secret, owner-only, the leveraged source's sensitivity
  ceiling.

## Status

**Doctrine (Inc 0) — this file.** The arc: Ring-1 `AccrualBasis` / `AccrualKind` in
`@motebit/protocol` (Inc 1); production at the real leverage seams in `memory-graph` /
trust-graph / `ai-core`, threaded produced-not-authored (Inc 2); per-surface render — flat
in-flow attribution, spatial as the generalized `CredentialSatelliteRenderer`-shape orbit
drawing on the memory haze / trust constellation (Inc 3); the deepening graft onto the
shipped `Felt*` records (Inc 4); `check-accrual-basis-canonical` locking
produced-not-authored and the no-aggregate refusal (Inc 5). Smallest honest first slice:
`recalled_memory` end-to-end on web only.

## Related

[`felt-interior.md`](felt-interior.md), [`records-vs-acts.md`](records-vs-acts.md),
[`memory-provenance.md`](memory-provenance.md),
[`memory-never-confers-authority.md`](memory-never-confers-authority.md),
[`typed-truth-perception.md`](typed-truth-perception.md),
[`agility-as-role.md`](agility-as-role.md),
[`runtime-invariants-over-prompt-rules.md`](runtime-invariants-over-prompt-rules.md),
[`proactive-interior.md`](proactive-interior.md),
[`the-stack-one-layer-up.md`](the-stack-one-layer-up.md),
[`agents-as-first-person-trust-graph.md`](agents-as-first-person-trust-graph.md).
