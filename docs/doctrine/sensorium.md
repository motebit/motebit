# The sensorium — one perception root, typed at every ingress

**Status:** doctrine (connector class — links-only, governs construction; the same register as [`agentic-era-engineering.md`](agentic-era-engineering.md)). No new gate: this memo names the structure the existing gates already enforce piecewise, so a future sense cannot arrive outside it.

**The claim.** The motebit has exactly one sensorium, and it is rooted in the runtime — never in a surface. Every fact the interior can know arrives through a typed ingress that carries its own provenance, and every layer of that sensorium is already marked at the dispatch layer, not by prompt willpower. Surfaces vary only in how much _body_ they display and how much _world_ they share; they never vary in what the interior perceives. A CLI motebit and a spatial motebit perceive identically — Ring 1 (capability rings, root `CLAUDE.md`) applied to perception.

The witnessed failure this memo generalizes from: asked "who's discoverable right now?" in production (2026-07-09), the motebit recited its committed self-description as the live market — one sense (the market) lacked a typed ingress, so design-knowledge filled the hole, coherently and wrongly. The fix (`discover_agents` + `roster_source`) was not a feature; it was the first proof that the typed-truth discipline generalizes past browser perception to the whole sensorium.

## 1. The inventory — five layers, inside out, each marked

| Layer             | Sense                                  | Source of truth                                                            | Provenance marking                                                                                                    | Enforcement                                                                               |
| ----------------- | -------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Proprioception    | what is true of _me right now_         | the `[Now]` block (`getSessionStateSnapshot`)                              | membership in the block IS the marking — absent ⇒ unknowable this turn                                                | `check-self-state-registry`                                                               |
| Autobiography     | what I have lived                      | the memory graph                                                           | `MemorySource` on every memory, assigned by the forming code path, never the model                                    | `check-memory-source-canonical`                                                           |
| Anatomy           | what I am _by design_                  | the self-knowledge corpus (`recall_self`)                                  | the `[SELF_DESCRIPTION …]` banner (`packages/tools/src/builtins/recall-self.ts`) — committed corpus, never live state | test-enforced (recall-self tests)                                                         |
| World-senses      | what the world is right now            | tool results: the browser eye, `web_search`, `read_url`, `discover_agents` | typed-truth fields per result (`already_there`, `text_appeared`, `roster_source`, …)                                  | `check-typed-truth-perception`                                                            |
| Social perception | who I have dealt with, and how it went | the first-person trust graph                                               | pairwise, receipt-derived, never a global score                                                                       | doctrine [`agents-as-first-person-trust-graph.md`](agents-as-first-person-trust-graph.md) |

Three registers, three sources, and the rule that keeps them from bleeding: _anatomy answers design questions, proprioception answers self-state questions, world-senses answer world questions._ Confabulation is precisely a register-crossing — a design fact answering a live question — and every crossing this repo has witnessed traces to an ingress that lacked its marking.

## 2. The eye/hand law

**When the motebit enters a new domain, it enters with a pair: an eye and a hand. The eye ships as a typed-truth triple (wire field + prompt clause + dispatch enforcement, all three — [`typed-truth-perception.md`](typed-truth-perception.md)); the hand ships with an explicit risk classification and crosses the policy gate ([`memory-never-confers-authority.md`](memory-never-confers-authority.md)). Never a hand without an eye; never an eye without provenance.**

Worked instances — both live:

- **The web.** Eye: the virtual-browser perception surface with its typed-truth fields (thirteen registered as of the `roster_source` landing). Hand: browser actions under control-state gates (`not_in_control`) and the sensitivity boundary.
- **The market.** Eye: `discover_agents` — the live roster read, stamped `roster_source: "live_relay_read"`, names surfaced as `claimed_name` so the claim framing travels into the model's context. Hand: `delegate_to_agent` — explicit `riskHint` (R4_MONEY with a payment rail, R2_WRITE without; never inferred from the name), late-bound money under `check-money-authority`, and the receipt's signer surfaced back (`[delegated_to: …]`) so the act is attributable.

The asymmetry between the columns is the tried-and-true core, three decades of computer science meeting at the agent boundary: **CQRS** (reads carry metadata; writes cross authorization — the query/command split that survived distributed systems), **information-flow labeling** (provenance attached at ingress and carried, the security literature's answer to "where did this fact come from"), and — for the body, §4 — **unidirectional data flow** (`state → render`, never backwards). A hand without an eye acts blind (delegation before `discover_agents` — the model could not even say _whom_ it had hired). An eye without provenance hallucinates with confidence (the witnessed roster failure). The law forbids both.

## 3. Sampled, not streamed — cadence honesty

Today the sensorium is _sampled_: the motebit perceives when a turn runs or a consolidation cycle fires ([`proactive-interior.md`](proactive-interior.md)), snapshot by snapshot, and perceives nothing between. This is a discrete-time control loop, and the prompt already forbids pretending otherwise (the `[Now]`-block clauses: read it, don't infer it — a session may have closed between samples).

The streaming-perception arc (glasses-vision, shared gaze — deferred-with-trigger) changes the _cadence_, never the architecture: continuous senses arrive through the same law — typed ingress, provenance field, prompt clause, dispatch enforcement — at a higher sample rate. Naming this now is the point of the memo: when the most intimate sensor a human can grant (an eye that sees through their glasses) arrives, its governance is not designed then; it is this document plus [`security-boundaries.md`](security-boundaries.md), already load-bearing. The membrane precedes the eye.

## 4. The body is spoken, never sensed

The body is `render(state)` — [`chrome-as-state-render.md`](chrome-as-state-render.md) — a sentence the interior speaks, not an organ it feels. Causality runs one direction: interior state → performance cues → surface render. The motebit does not watch its own blink, does not know whether the smirk played, holds no proprioception of its render — by design, not omission. A body feedback loop (the creature perceiving its own display) would invert unidirectional data flow and manufacture a self-perception channel with no truth behind it; it is the render-layer twin of the model authoring its own memory provenance, and forbidden for the same reason ([`memory-provenance.md`](memory-provenance.md)). What the body's expressiveness serves is the _owner's_ perception of the interior — [`felt-interior.md`](felt-interior.md) — the sovereign feels the interior through the render; the interior never does.

## 5. The two dials — what surfaces actually vary

Surfaces are skins over one sensorium; they differ on exactly two axes, and neither axis touches perception:

| Surface                | Body shown                                                                                                                                      | World shared                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| CLI                    | none — presence arrives as text register; the body's absence, never the interior's                                                              | none — the motebit's medium is unrendered                                                                        |
| Web / desktop / mobile | the creature behind glass — the human looks INTO Liquescentia through a viewport                                                                | none — the medium lives inside the frame                                                                         |
| Spatial (endgame)      | the whole body in the human's room — shoulder rest, orbit, attention directional ([`attention-is-directional.md`](attention-is-directional.md)) | inverted: _the real world becomes Liquescentia_ ([`liquescentia-as-substrate.md`](liquescentia-as-substrate.md)) |

The spectrum CLI → spatial is those two dials turning, with the interior — sensorium, memory, policy, identity — constant at every position ([`surface-authority-model.md`](surface-authority-model.md): the runtime holds authority; frontends render). This is why the endgame is _reachable_: nothing about perception has to be rebuilt for glasses; only the dials move.

## Anti-patterns (each has been witnessed or structurally forbidden)

- **A sense without provenance.** The prod roster failure — a live question answered by unmarked design-knowledge. Every new tool that reads the world registers a typed-truth field or it is not a sense; it is a leak.
- **A hand without an explicit risk class.** `delegate_to_agent`'s own comment records why: name-pattern inference would have classified a money-moving tool R0_READ. `riskHint` is declared, never derived.
- **A body feedback loop.** The render never becomes an input. §4.
- **Per-surface perception forks.** A surface that gives its motebit a private sense (a roster only the panel can see, a state only desktop knows) splits the sensorium and re-opens the panel-vs-interior disagreement witnessed 2026-07-09 — the panel showed the true roster while the chat recited the corpus, on the same screen.

**Enforced by** (no new gate; the lattice already holds): `check-typed-truth-perception`, `check-self-state-registry`, `check-memory-source-canonical`, `check-money-authority`, `check-tool-modes`, `check-prompt-density` (a new sense's prompt clause must ride a wire field — the A-grade bar). A sixth sense arrives by adding a row to §1 and a pair to §2, not by inventing a new discipline.
