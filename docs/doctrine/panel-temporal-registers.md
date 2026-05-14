# Panel temporal registers

Records aren't homogeneous. The six side-rail panels split along a temporal axis into two registers that demand different UX shapes. This doctrine names the split, anchors it in motebit's five protocol primitives, and tells future panels which register they belong to before any pixels move.

Composes with [`records-vs-acts`](records-vs-acts.md) as parent: that doctrine assigns each UI element to body (act) or panel (record); this one adds the temporal mode axis to the records side. Where they conflict, records-vs-acts governs — this doctrine only refines what happens _inside_ the records side.

## The temporal axis

Three surface kinds, three temporal modes:

- **Body / slab / creature** — **present**. The motebit's live state, ephemeral acts, what it is doing _right now_. Per records-vs-acts.
- **Identity register** (Sovereign, Memories, Conversations) — **retrospective: past → present**. Who motebit has become. Accumulated history made visible as the present-extant state of the sovereign self.
- **Runtime register** (Skills, Goals, Agents) — **prospective: present → future**. What motebit can do and will do. Present-capability and committed-intention made visible as the available-future shape of the sovereign self.

The slight asymmetry — both registers span time, anchored at the present — is intentional. Skills/Agents are present-capability (not purely future); Sovereign/Memories are present-extant (not purely past). The directionality of the gaze is what differs: identity _looks back_; runtime _looks forward_.

## The six panels

| Panel             | Register | Primitive  | Temporal anchor                                   |
| ----------------- | -------- | ---------- | ------------------------------------------------- |
| **Sovereign**     | identity | identity   | What you are (accumulated → extant)               |
| **Memories**      | identity | memory     | What motebit remembers (accumulated → extant)     |
| **Conversations** | identity | memory     | What you've said (accumulated → extant)           |
| **Capabilities**  | runtime  | capability | What motebit can do (extant → invocable)          |
| **Goals**         | runtime  | execution  | What motebit will do (declared → committed)       |
| **Agents**        | runtime  | delegation | Who motebit collaborates with (known → invocable) |

The capability-primitive panel is named **Capabilities** (not Skills) because it
hosts two sibling sub-tabs — **Skills** (agentskills.io procedural knowledge) and
**Connections** (MCP tool servers, future capability sources) — both of which
satisfy the substrate-vs-accumulation test below. The agentskills.io brand
survives at the sub-tab level; the panel rises to name the primitive.

The split is not aesthetic. It maps cleanly onto motebit's foundational primitive set (see "Why six, why three+three" below). When two independently-derived doctrines produce the same 3+3 split, the categories are being _discovered_, not designed.

## Why six, why three+three

Two doctrines already encode this shape from different angles. Codifying the panel inventory closes the gap that was the only thing missing while the architecture was already there.

**Identity register** surfaces the three things named in root [`CLAUDE.md`](../../CLAUDE.md) "no one else is building together" as records:

1. _Persistent sovereign identity_ → Sovereign
2. _Accumulated trust_ → Memories + Conversations
3. _Governance at the boundary_ → **not a panel** (the membrane itself; see "What is not a panel")

**Runtime register** surfaces the agent-runtime primitives named in [`the-stack-one-layer-up.md`](the-stack-one-layer-up.md):

1. _Capability bundle_ → Capabilities (Skills + Connections sub-tabs)
2. _Autonomous execution_ → Goals
3. _Delegation graph_ → Agents

Five protocol primitives total (identity / memory / capability / execution / delegation), six panels (memory has two facets: stored knowledge in Memories, interaction history in Conversations). The sixth primitive — governance — sits at the membrane, not on a record surface.

## Apple design-language per register

The UX shapes are not interchangeable. Each register has a different design dialect, and a panel proposal can be falsifiably critiqued against the register it belongs to.

**Identity register** — biographical, read-mostly, audited mutations as ceremonies. Mood: _accumulated weight_. Apple analogs:

- **Health** — accumulated state visualized over time; the present graph is the past summed forward.
- **Wallet** — identity-bearing artifacts (cards, passes, IDs) presented as durable possessions.
- **Photos** — chronological accumulation; the surface organizes what has been, not what will be.

Implications: chronological scaffolding, slow cadence, mutations as deliberate acts (e.g. a `DeletionCertificate` is a signed ceremony, not a confirm-dialog), calm visual density.

**Runtime register** — commitment-bearing, status-active, mutation-first. Mood: _living capability_. Apple analogs:

- **Shortcuts** — composable capability assembled from typed primitives; the surface is a workshop.
- **Reminders** — commitment-bearing items with conditional triggers (time, location, contact); each item lives as a card with state.
- **Focus modes** — active-state controls that change what the system does; the surface is a register of what's currently on.

Implications: cards-as-commitments, live status pulses (working/waiting/done), mutation-first affordances (CREATE, INVITE, INSTALL as primary verbs), receipts disclosed per item, budget envelopes per commitment.

A runtime-register panel rendered in identity-register language reads as MVP. The current Goals panel — text input + frequency dropdown + create button — is the worked example: cron + LLM is identity-shaped (a form, a list) when the doctrine demands runtime-shaped (a commitment card, a living status, a ceremony of declaration).

## Bounded commitment is multi-dimensional

"Budget envelopes per commitment" is one of the runtime-register's design-language pillars above. The shape of that envelope deserves its own clause because the wrong framing slips into API + UX vocabulary and is much harder to undo there than in prose.

A goal is a commitment to do work. The cap on that commitment has to cover **every dimension along which the goal can consume resource**, not just the loudest one. Inference tokens, voice synthesis seconds, paid tool-call invocations, wall-clock time, risk surface — each is an axis the user would want bounded if it became significant. Asking "what unit?" foregrounds the loudest current axis (tokens, ~80%+ of cost today) and bakes its assumptions into the schema and the call sites; asking "what does it mean to bound a commitment?" surfaces that the answer is multi-dimensional and the schema has to be too.

**v1 ships a single axis: `tokens`.** It's the only doctrinally-clean unit available today — universal across motebit-cloud / BYOK / on-device, where USD would bake cloud-mode assumptions into the goal record and break protocol-primacy for the BYOK + on-device modes the auto-router doctrine names. It also captures the dominant cost slice. v1 is correct as far as it goes; what would be wrong is positioning it as **the** unit rather than **an** axis.

**Endgame is N axes, additively.** The runtime helper accepts a record of axes — `checkGoalBudget({ tokens?: { cap, spent }, voice_seconds?: { cap, spent }, ... })` — and returns the first exhausted one. Adding an axis later is a closed-union extension on `GoalBudgetAxis` plus a new `budget_<axis>` column on the goal record plus a corresponding `spent_<axis>` rollup; no signature break, no call-site rewrite. Surface UI displays the envelope per-axis at the unit-native scale ("Inference: 12k/50k tokens") with cost translation as additive disclosure when computable ("· ≈$0.30 on Sonnet"), never as the headline — the universal unit is the axis-native one, the cost is the mode-specific augment.

**Distinct from `BudgetAllocation` in the sovereign panel.** `packages/panels/src/sovereign/controller.ts` ships an existing `BudgetAllocation` primitive — that's a per-task delegation cap, USD-shaped, single-axis because the peer agent absorbs the multi-axis execution on their end. Goal budget = self-execution cap, multi-axis. Task budget = peer-delegation cap, single-axis USD. The two share the word "budget" but model orthogonal commitments; don't collapse them in a future refactor. (When motebit acts as a peer for someone else, the inverse holds — they pay you a single-axis USD task budget and you absorb your own multi-axis goal budgets.)

**Implementation enforcement** ([`packages/runtime/src/goals.ts`](../../packages/runtime/src/goals.ts) `checkGoalBudget`): pure record-input function returning `{ allowed, exhausted_axis, axes }`. Schedulers across surfaces (cli, desktop, mobile, web runner) call it before each fire and pause the goal with status `budget_exhausted` on `!result.allowed`. Re-checked every tick — raising any axis cap auto-resumes the goal next fire. The `exhausted_axis` field drives axis-specific surface copy (today only "Token budget exhausted"; tomorrow naturally extends to "Voice-minutes exhausted" without a new field on the result type). The `feedback_framing_slips_propagate_to_api_and_ux` memory anchor names the discipline that produced this section: catching the framing slip ("tokens is the unit" → "tokens is v1 axis") at write-time so the API + UX never encode the loose claim.

## What is not a panel

Two categories sit outside the six and must not be folded in.

**Governance** — the privacy / policy layer is the _membrane_, not a record. It's the surface tension the doctrine sits on. Trying to make governance a panel is a records-vs-acts category error: governance is neither act (it doesn't perform) nor record (it doesn't accumulate as a viewable artifact); it's the _boundary across which_ acts and records pass. Governance manifests as sensitivity ceilings in the privacy layer, the policy gate at the slab boundary, retention policy in stores. Never as a side-rail panel.

**Settings** — what you ARE _configuration-wise_. Different category from records entirely: settings is config, not interior state. Per the memory-anchored `Settings vs Sovereign` distinction (sovereign = what you HAVE / OWE / DOING; settings = what you ARE configuration-wise), settings is a seventh surface but a third category. Folding it into the panel-doctrine creates a category mismatch. The panels-pattern doctrine already separates settings ([`panels-pattern.md`](panels-pattern.md) §4 — "Not a controller").

The typed registry enforces this structurally: `PanelPrimitive` does not include `"governance"`. Any attempt to declare a panel with `primitive: "governance"` is a type error.

## Substrate vs accumulation: the falsifiable test

Settings and capability-primitive panels both surface "things motebit can use." The cut between them is **substrate vs accumulation**, and the test is one question:

> **Does this thing accumulate, or does it substitute?**

- **Substitutes** (pick one at a time, swap in / swap out) → **Settings**. Substrate config — substitutable engine selection. Examples: chosen inference host (Claude / OpenAI / Gemini / Groq), default voice provider, default model tier, sensitivity rules. You pick _which_ engine drives motebit, not _how many_.
- **Accumulates** (add many, sources stack) → **capability-primitive panel**. Additive sources that extend what motebit can do. Examples: installed skills (agentskills.io procedural knowledge), connected MCP servers (tool servers), future capability extension points. You add _more_ sources; motebit's reach grows monotonically.

Substrate is the _engine_. Accumulation is the _kit motebit has acquired_. Both are "external reach" but they are different categories with different surface treatments.

**The MCP placement implication, executed.** Pre-migration, MCP servers lived in Settings → Intelligence (`apps/web/src/ui/settings.ts`). That was a category error caught by this test: MCP servers accumulate (you add many, each provides a set of tools that stack on the agent's available actions), so they belong on the capability-primitive panel alongside Skills, not in Settings alongside inference-host choice. The web migration shipped 2026-05-13: panel renamed Skills → **Capabilities** with two sub-tabs — **Skills** (agentskills.io procedural knowledge, `createSkillsController` untouched) and **Connections** (MCP tool servers, future capability sources). Route flipped `/skills` → `/capabilities`. Typed `SIDE_RAIL_PANELS` registry id flipped `"skills"` → `"capabilities"` in the same commit so doctrine + code stay in lockstep. Storage path (`motebit:mcp_servers` localStorage) stayed put — UI migrated, persistence didn't; decoupled concerns, separate commit if storage ever needs to move. Skills controller was NOT absorbed: MCP is sibling, not merged — different shapes, different storage, different lifecycles, different package (`@motebit/mcp-client`). Desktop + mobile mirror in same arc per the one-pass-delivery doctrine. The agentskills.io ecosystem brand survives at the sub-tab level; the panel rises to name the primitive.

**The voice-migration corollary.** Voice provider is currently substrate-shaped (single default TTS engine, one chosen voice). If motebit ever supports multi-voice — different voices per context, per agent, per surface, user-cloneable voice library — voice migrates to a capability-primitive panel. Same architectural property as MCP: capability that's substitutive in some configurations and accumulative in others. The test answers when to move: the day "add another voice" becomes a thing the user does, voice has crossed from substrate to accumulation.

Same trigger applies to any future surface that could go either way (inference-host routing, sensitivity profiles, model tier per task). The substrate-vs-accumulation question, asked at design time, prevents the next category error before it ships.

## Three failure modes

1. **Designing a runtime panel in identity-register language.** Symptom: the panel looks like a form + list. Diagnostic: ask "what is the _commitment_ this panel holds?" If the answer is "an entry in a list," it's identity-shaped. If the answer is "a live binding the agent is currently honoring," it's runtime-shaped. Goals MVP fails this test today.

2. **Trying to make governance a panel.** Symptom: a "Privacy" or "Policy" panel proposal that surfaces sensitivity ceilings as a record list. Diagnostic: per records-vs-acts, governance is the membrane. It manifests _through_ the privacy layer at every boundary, not _on_ a records surface.

3. **Folding Settings into the doctrine.** Symptom: someone counts seven panels including Settings and tries to fit it into "identity register because it's about you." Diagnostic: Settings is config (what you ARE configuration-wise), not state (what you HAVE). Different category.

## How to apply

Before adding any new side-rail panel surface, answer three questions:

1. **Does it surface one of the five protocol primitives** (identity / memory / capability / execution / delegation)? If no, it's not a side-rail panel — it's a feature, a sub-view, or a category error.
2. **Which register** — identity (retrospective) or runtime (prospective)?
3. **Does the design language match the register?** Identity follows Health/Wallet/Photos shape; runtime follows Shortcuts/Reminders/Focus shape.

If all three answers are clean, declare the panel in [`packages/panels/src/registry.ts`](../../packages/panels/src/registry.ts) — the typed `SIDE_RAIL_PANELS` constant is the single source of truth for what counts as a side-rail panel. The type system enforces register + primitive validity.

If the panel doesn't surface a primitive, or it tries to surface governance, or its register is ambiguous, the doctrine is telling you the surface doesn't belong in the six. That's the doctrine working as intended.

## The Conversations note

Conversations needs explicit placement because it is the panel most likely to be miscategorized. Conversations records _past dialogue_ — the memory-primitive's interaction facet. That places it firmly in the identity register: retrospective, biographical, "what you've said." New conversations are _not_ records of dialogue — they are the act of dialogue, which happens on the body (the chat surface in the present tense). The Conversations panel holds the records; the body holds the act. This is records-vs-acts working correctly across the temporal axis.

## Cross-references

- [`records-vs-acts.md`](records-vs-acts.md) — **parent doctrine**. Acts → body, records → panels. This memo refines the records side.
- [`panels-pattern.md`](panels-pattern.md) — the mechanical pattern for how panel state lives across surfaces (3-surface controller, etc.). Orthogonal axis: this doctrine is _what_ a panel is for; panels-pattern is _how_ its state is shared.
- [`delegation.md`](delegation.md) — the connector that makes the five primitives compose into a system. Each runtime-register panel surfaces a face of the delegation graph.
- [`the-stack-one-layer-up.md`](the-stack-one-layer-up.md) — the five-primitive convergence point with hosted agent platforms. Identity / memory / capability / execution / governance plus delegation as connector.
- [`goals-vs-tasks.md`](goals-vs-tasks.md) — goal = user-declared outcome; task = emergent plan step. The Goals panel surfaces goals; tasks emerge in the body during execution.
- [`packages/panels/src/registry.ts`](../../packages/panels/src/registry.ts) — typed `SIDE_RAIL_PANELS` constant + `PanelRegister` / `PanelPrimitive` types. The single source of truth for which surfaces are side-rail panels and what they surface.
- Root [`CLAUDE.md`](../../CLAUDE.md) "The three things no one else is building together" — the identity-register half of the symmetry.
