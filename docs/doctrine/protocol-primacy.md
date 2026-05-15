# Protocol primacy

**Motebit is a protocol with a company on top, not a company with a protocol on the side.**

This is the constitutional invariant. Every drift gate, every architectural split, every other doctrine memo in this directory is downstream of this single commitment. The protocol exists and functions identically whether the user pays motebit-cloud, brings their own keys, or runs entirely on-device. The business is a service-bundling convenience layer that captures margin on top of a substrate that works without it.

If a business decision would invert this ordering — even subtly, even just in marketing language — the decision is rejected. The ordering is the moat.

## What the ordering means concretely

The following are **protocol-level properties** available to every motebit identity regardless of subscription status:

- Cryptographic identity (Ed25519, suite-dispatched for cryptosuite agility)
- Trust graph accumulation
- Signed receipts (the agent signs them with its own key; the relay archives but cannot fabricate them)
- Federation participation
- Multi-device sync via the relay-as-convenience-layer (relay is not a trust root per [`services/relay/CLAUDE.md`](../../services/relay/CLAUDE.md) rule 6 — every relay-asserted truth is independently verifiable onchain without relay contact)
- Credential anchoring (Solana memos via `@motebit/wallet-solana`)
- Audit trail portability (export, verify, replay independently — `motebit-verify` is Apache-2.0 + canonical, ships in a published npm package)
- Sovereign fallback when motebit-cloud credits exhaust (the body works without the company)
- BYOK access (any of the registered `ByokVendor` instances per [`agility-as-role.md`](agility-as-role.md))
- On-device inference (WebLLM, Apple FM, MLX, local-server)
- Sensitivity-gate enforcement (medical / financial / secret never reach external AI regardless of vendor or tier)

The following are **convenience-tier properties** that motebit-cloud subscription unlocks:

- Bundled AI inference credits (relay-hosted proxy with 20% margin baked into per-token billing)
- Bundled voice provider credits (Premium tier — Inworld / ElevenLabs / Deepgram auto-routed)
- Compliance attestations (Sovereign tier — SOC 2 Type II, HIPAA BAA, GDPR DPA)
- Extended audit log retention _within sensitivity ceilings_ (Sovereign tier — operational retention extended to 7 years for `none` / `personal`-tier data; ceilings for `medical` / `financial` / `secret` remain protocol-level and apply uniformly across all tiers per [`retention-policy.md`](retention-policy.md). The convenience tier extends retention within the ceilings, never above them — the ceilings are interop law, not per-deployment defaults)
- Hardware-attestation-as-admission-policy (Sovereign tier — converts the additive scoring from [`hardware-attestation.md`](hardware-attestation.md) into a procurement gate)
- SLA grade + dedicated support

**The two lists are disjoint by construction.** No protocol-level property has a paid-tier dependency. No convenience-tier property is required for the protocol to function.

## Why this is the moat, not just a preference

No incumbent can adopt the protocol-first posture without dismantling their own business.

- **Anthropic Skills** is Anthropic's platform AND is the user's identity in their system. To open-source the identity layer would be to give away their lock-in.
- **OpenAI Agents Platform** — same shape.
- **Google's agent strategy** — same shape.
- **Microsoft / Copilot** — same shape.
- **A2A** — communication protocol with no identity primitive; assumes the platform owns identity.
- **MCP** — capability protocol with no identity primitive; same assumption.

Every closed-source AI platform's business model **requires** owning the user's identity. Motebit's architectural commitment is that identity, trust, and governance are protocol-layer problems, not platform-layer ones. That makes the protocol-first posture structurally impossible for incumbents to copy — they'd have to give up their lock-in to compete on motebit's terms.

The competitive moat is not "better tech." Incumbents have more capital and more tech. The moat is **a posture incumbents can't adopt without dismantling their own business.** The protocol-first commitment is the moat.

The constraint is reinforced at the capital-structure layer. Growth-stage and public-market investors evaluate AI-company traction on net-revenue-retention, customer-lifetime-value, and switching-cost — all metrics that require the company to own user identity. Even an incumbent's product team that wanted to open the identity layer would face investor rejection of a revenue model that doesn't match the proven enterprise-SaaS playbook. The moat is product-architecturally inaccessible AND capital-structurally inaccessible to every closed-source incumbent. Two reinforcing constraints, one structural position.

If motebit-cloud ever starts gating identity, trust, or receipts behind subscription tiers — even subtly, even just in pitch language — the moat collapses. Motebit becomes structurally identical to ChatGPT Plus With Crypto Primitives. Federation peers have no reason to trust the protocol because the company de facto owns it. The whole strategic position rests on the two-layer separability.

## The protocol-first audit

Before proposing any motebit-cloud feature, tier-description, marketing claim, or strategic decision, ask:

> **"Does this work identically for a user who never subscribes?"**

Three possible answers:

1. **Yes — feature works identically without subscription.** Then it's a protocol-level property. Describe it as available to all motebits. Never gate it. Never frame it as a subscription benefit.

2. **No — feature requires subscription to function (e.g., bundled inference credits).** Then it's a convenience-tier property. Tier-gate it freely, charge accordingly, describe it as motebit-cloud's value-add.

3. **It's complicated.** Recurse: which sub-properties are protocol-level and which are convenience? Decompose until every sub-property is unambiguously in one of the two categories. **Never describe a mixed feature as if it were entirely tier-gated — that's the drift class this audit exists to catch.**

**Worked example.** Suppose someone proposes the feature _"federation-broadcast announcement on motebit-cloud subscribers."_ Run the audit by decomposition:

- **federation-broadcast** as a capability — works identically for any motebit, paid or unpaid → protocol-level. Describe as "every motebit can broadcast federation announcements."
- **announcement-routing** as a managed scheduling service (priority queue, delivery confirmation, retry logic, dedicated relay capacity) — requires motebit-cloud's managed infrastructure → convenience-tier. Describe as motebit-cloud Premium's "managed announcement routing."

The combined feature gets described in **two registers**: "every motebit can broadcast federation announcements; motebit-cloud Premium adds managed routing convenience on top." Never described as "Premium tier unlocks federation broadcast" — the broadcast capability isn't gated; only the routing-management bundle is.

**Where the audit applies (touchpoints).** The audit fires on every surface where motebit-cloud's relationship to the protocol is articulated, code OR prose:

- Tier configuration in `services/relay/src/subscriptions.ts` — `DEPOSIT_MODELS`, credit-pool sizing, tier-specific routing, retention windows
- Tier UI copy in surface settings panels (`apps/web/src/ui/settings.ts`, `apps/desktop/src/ui/settings.ts`, `apps/mobile/src/components/settings/IntelligenceTab.tsx`)
- Pricing-page copy on `motebit.com` (what each tier "includes")
- Marketing-site language about what motebit "is"
- YC application + investor pitch materials + sales decks
- PR descriptions for motebit-cloud features (the PR template should prompt the audit)
- Public statements (X / blog posts / podcast interviews / talks) about motebit-cloud's value prop
- Doctrine memos themselves, **recursively** — this memo had to pass the audit on its own retention-window claim, which is how the within-ceilings clarifier above was caught during review

Most of the drift class in real conversation happens on **prose surfaces, not code surfaces**. Code change without doctrinal articulation is structurally safe (the runtime enforces protocol-first by construction); doctrinal articulation without code change still requires the audit because pitch language and tier descriptions can break the moat even when no code moves.

The cost of getting this wrong is large. The cost of doing the audit is one sentence of thought per decision.

## What motebit-cloud is, and is not

**Motebit-cloud IS:**

- A subscription that bundles managed inference + (Premium) managed voice + (Sovereign) compliance attestations
- A convenience layer that captures ~10% margin on inference-as-served plus breakage on expired credits
- A customer-acquisition funnel for the relay-fee scale revenue
- One specific bundling product on top of a vendor-agnostic protocol
- Optional — sovereignty trumps tier-gating per _feedback_sovereignty_orthogonal_.

**Motebit-cloud IS NOT:**

- A gateway to motebit's identity
- A gateway to the trust graph
- A gateway to signed receipts
- A gateway to federation participation
- A gateway to the agent economy (the 5% relay fee applies to all motebits, paid or unpaid; the agent-economy substrate is protocol-level, not subscription-level)
- A SaaS in the standard sense (where the company owns the user's data, identity, and switching cost)
- A required component of motebit (the body works without it)

When someone proposes a motebit-cloud feature, the question is never "what does this lock users into?" The question is always "what convenience does this bundle on top of a protocol that already gives users everything?"

## Cross-cuts

- [`services/relay/CLAUDE.md`](../../services/relay/CLAUDE.md) rule 6 — "Relay is a convenience layer, not a trust root." The same principle at the relay layer.
- [`protocol-model.md`](protocol-model.md) — the three-layer permissive / BSL / accumulated-state model. The two-layer protocol-vs-business split is downstream of the three-layer license split.
- _feedback_sovereignty_orthogonal_ (memory anchor) — "Tier and provider mode are orthogonal: never gate BYOK behind subscription."
- _feedback_intelligence_commodity_ (memory anchor) — "Don't sell intelligence as the product. Charge for relay, include AI as convenience."
- _feedback_endgame_not_mvp_ (memory anchor) — "Build endgame patterns, not MVPs." The protocol-first ordering is endgame by construction.
- _strategy_open_source_moat_ (memory anchor) — "Open-source protocol (adoption), never open-source accumulated state." The open protocol is the substrate; private accumulated state is the company's data moat. The ordering matches this doctrine's protocol-first / company-on-top framing.
- [`agility-as-role.md`](agility-as-role.md) — vendor optionality at the protocol layer means motebit-cloud has no exclusives. Every BYOK vendor is also available outside motebit-cloud.
- [`retention-policy.md`](retention-policy.md) — sensitivity ceilings are interop law (protocol-level); operational retention windows are reference defaults (per-deployment, including motebit-cloud's specific tier choices).

## The audit at the panel level — local-first as a per-surface test

The protocol-first audit applies recursively at the **panel** level, not just the feature/tier level. Every panel surface in the droplet/material family is a separate audit target:

> **"Does this panel render meaningful content for a user with no relay configured?"**

Three structural categories:

1. **Pure local** — panel has no relay dependency at all (chat history, memories, locally-installed skills, MCP server config, on-device activity log, scheduled goals). Audit passes by construction.
2. **Local-first, relay-augmented** — panel has a local source of truth AND optionally augments with relay-fetched cross-device/federation data. The local source always renders; the relay adds on top. This is the doctrinally-correct shape for panels surfacing accumulated state that spans devices (Sovereign Credentials / Ledger / Budget / Identity).
3. **Network-required by nature** — panel content IS the network discovery surface (Agents Discover, Capabilities Browse). Relay-required is correct here because the relay IS the substrate of the content. Audit passes by virtue of "this feature exists only because federation exists."

**Doctrinally-incorrect:** relay-gated on local data that _could_ be rendered without one. This is the drift class the Sovereign panel had pre-2026-05-15.

### Renderer vs controller — where the drift hides

The Sovereign worked example surfaced a structural lesson: **a panel's controller can be local-first-correct while its renderer is relay-gating-wrong.** The `@motebit/panels/sovereign` controller already merged local + relay sources correctly (`fetchCredentials()` reads `adapter.getLocalCredentials()` then merges relay data; `fetchSovereignBalance()` reads via direct Solana RPC). But each renderer in `apps/web/src/ui/sovereign-panels.ts` short-circuited with `if (!hasRelay) → empty` before reading what the controller had already fetched. The architectural intent was preserved at the data layer and discarded at the presentation layer.

**The audit needs to check both:**

- **Adapter layer**: does the adapter expose a local accessor for each typed data shape the panel surfaces? (e.g., `getLocalCredentials`, `getLocalIdentity`, `getLocalLedger`)
- **Renderer layer**: does the renderer read from state directly, never branching on relay-availability for _whether_ to render local data? (Branching on relay-availability for _what error register to show_ — e.g., "fetch never attempted" vs "fetch failed" — is acceptable; branching to hide local content is not.)

A panel passes the audit only when both layers are correct.

### Worked example — Sovereign panel local-first arc, 2026-05-15

The Sovereign panel had four tabs each with `if (!hasRelay) → empty` renderer gates, even though three of the four had local data sources already wired through the controller. Fix arc (commits `dd305854` → `b22d5bf3` → `70076837`):

1. **Renderer cleanup** (`dd305854`) — removed relay-gates from `renderCredentials` + `renderBudget`; reframed `renderSuccession`'s `!hasRelay` check to distinguish "never attempted" (calm empty) from "fetch failed" (Retry affordance); `renderLedger`'s caption no longer mentions relay.
2. **`getLocalIdentity` adapter accessor** (`ffcd6c89`) — optional method on `SovereignFetchAdapter`. Web implementation queries the local event store for the bootstrap `EventType.IdentityCreated` event. State exposed via `state.localIdentity`. Renderer shows "Current identity" hero card from local data, regardless of relay state.
3. **`getLocalLedger` adapter accessor** (`b22d5bf3`) — same optional pattern. Web reads from `GoalsRunner` state filtered to executed goals. Controller merges local + relay with goal_id dedup; local wins (signed locally is canonical, relay is mirror). Future contract-preserving arc swaps source to per-fire signed `ExecutionReceipt` aggregation via `replayGoal()` — same `GoalRow` wire shape.
4. **Cross-surface mirror** (`70076837`) — desktop + mobile implementations of both accessors. Optional `?` on the contract allowed staged delivery without breaking surfaces that don't yet implement.

After the arc: all four Sovereign tabs pass the audit on all three surfaces. A user with zero relay configuration sees their own identity, on-chain balance, locally-signed credentials, and executed goals from second zero.

### Lessons encoded

- **The audit fires per panel** — pass/fail is binary per panel, not per app. Even one panel that fails the audit invalidates the "you own your identity" claim for users hitting that panel without a relay.
- **Optional adapter methods enable staged cross-surface delivery** — adding `getX?(): Promise<...>` to the contract lets one surface ship the local-first answer before others. Controller treats absence as null. No regression on surfaces that defer.
- **Wire-shape preservation enables contract-preserving deepening** — the Ledger arc shipped `GoalsRunner`-derived rows mapped to the existing `GoalRow` shape. A future arc can swap the source to signed `ExecutionReceipt` aggregation without changing what the consumer reads. Pick the eventually-correct wire shape _first_ so source-of-truth deepening is non-breaking.
- **Renderer audits matter** — a doctrine that only checks the data layer misses the drift class where renderers hide local data behind relay-gates. Check both.

## Drift signals — when this doctrine has been violated

Catch these patterns as adversarial test cases when reviewing motebit-cloud pitch language or feature proposals:

- "$X/mo gets the user inference + identity + trust graph" — **violation**: identity and trust graph are protocol-level, not subscription-level. Corrected: "$X/mo gets managed inference; identity and trust graph are sovereign at every tier."
- "Subscription unlocks federation peering" — **violation**: federation participation is protocol-level. The relay handles peering; the relay is convenience-layer.
- "Premium tier includes signed receipts" — **violation**: every motebit signs its own receipts with its own key. Premium tier might include extended _retention_ of receipt archives; the receipts themselves are protocol-level.
- "Standard tier excludes hardware attestation" — **violation**: hardware attestation is additive scoring at the protocol layer per [`hardware-attestation.md`](hardware-attestation.md). Sovereign tier can require it as an admission policy (a procurement-shaped business rule); it cannot be removed from the protocol.
- "BYOK users pay 5% relay fee, motebit-cloud subscribers pay 3%" — **violation**: settlement-rail fee is protocol-shaped and applies uniformly. Convenience-tier discounts on protocol-level economics break the ordering.
- "The agent economy runs on motebit-cloud" — **violation**: the agent economy runs on the protocol. Motebit-cloud is one bundling option on top.

Each of these has been a real drift moment in real conversation. Catch the next one before it lands in shipped artifacts.
