# Auto-routing as protocol primitive

The auto-router's render is **`f(TaskShape × ProviderCapability × Constraints) → RoutingDecision`**, not a hardcoded `Record<task, model>` map living in one consumer's source. Every surface that picks a model for a task — motebit-cloud, BYOK, on-device — consumes the same dispatcher with its own provider catalog and own routing policy. This is the same matrix-as-primitive shape that [`chrome-as-state-render.md`](chrome-as-state-render.md) applied to slab chrome, now applied to model selection.

The mistake this doctrine corrects: routing logic that lives at the proxy is a SaaS-style feature gate. Routing logic that lives at the protocol layer with the proxy as one consumer is a sovereign primitive — BYOK users get the same auto-routing over their own provider keys, on-device users get the same auto-routing over local models. The protocol works without motebit-cloud; motebit-cloud earns its stake by adding aggregator-scale routing intelligence on top of the same dispatcher.

## The polarity error today (pre-PR-1)

`services/proxy/src/app/v1/messages/route.ts` inlined the routing decision: `TASK_MODEL_MAP` lookup → `getAffordableModelForTask` walk → resolved model. The proxy was the source of truth for the routing function, and BYOK / on-device had no path to the same logic. Auto-routing was a motebit-cloud feature, not a motebit primitive.

The pivot starts when the dispatcher's signature becomes `f(taskShape, catalog, constraints, policy) → RoutingDecision` and the proxy becomes a _consumer_ of it. Even when only one consumer ships, the dispatcher is shaped against the matrix.

## The principle

> Auto-routing is `f(TaskShape × ProviderCapability × Constraints) → RoutingDecision`. The dispatcher is a pure function in `@motebit/policy`; consumer-specific concerns (balance-aware filtering, intent classification, provider-key gating) wrap the protocol-layer call. New consumers add to the closed CONSUMERS registry; new task shapes are protocol-level appends.

Three coordinated commitments:

1. **The dispatcher signature is the matrix.** A dispatcher that took only `taskShape` would carry the SaaS-conflation error this doctrine corrects (motebit-cloud is the source of truth for routing). A dispatcher that took only `catalog` would lose the task-shape axis. The triple is the architectural primitive.
2. **Each `TaskShape` is a closed registry entry, not a function-call-site decision.** Adding a shape (`"voice-conversation"`, `"image-generation"`) is a protocol-level append + a new arm in `REFERENCE_ROUTING_POLICY` + drift-gate-induced coverage in every CONSUMER.
3. **The routing-policy is a consumer-side function, NOT a closed registry.** A `Record<TaskShape, string>` today; potentially a learned function of the same signature in the future. Policies are swapped via dependency injection; the registry-shaped thing is `TaskShape` (the role), not the policy (the parameter).

## The matrix

`TaskShape × ProviderCapability × Constraints = 7 × N × M` — most cells are sparse; the dispatcher's job is to pick the right model from the catalog given the task shape and constraints.

**`TaskShape` registry** (the closed protocol-level inventory — adding a shape requires a registry append + policy arm + every consumer's drift-gate coverage):

| shape       | reference policy model      | semantic                                                                 |
| ----------- | --------------------------- | ------------------------------------------------------------------------ |
| `quick`     | `claude-haiku-4-5-20251001` | Fast / low-latency tasks (tool-heavy, short responses, sub-second feel). |
| `chat`      | `claude-sonnet-4-6`         | Conversational back-and-forth — the default.                             |
| `reasoning` | `claude-opus-4-6`           | Deep reasoning — chain-of-thought, multi-step inference.                 |
| `code`      | `gpt-5.4`                   | Code-related — completion, review, debugging.                            |
| `research`  | `gemini-2.5-pro`            | Research / long-context — synthesis across many sources.                 |
| `creative`  | `claude-sonnet-4-6`         | Creative writing — open-ended generation, voice, prose.                  |
| `math`      | `claude-opus-4-6`           | Math / scientific — symbolic reasoning, calculation, proofs.             |

**`ProviderCapability` axes** (lifted from `services/proxy/src/validation.ts`'s `MODEL_CONFIG`; the 11 production models with `{host, lab, jurisdiction, input/outputCostPerMillion}`):

- `InferenceHost`: `"anthropic" | "openai" | "google" | "groq"` — closed registry, lifted to `@motebit/protocol`.
- `ModelLab`: `"anthropic" | "openai" | "google" | "meta"` — closed registry, lifted to `@motebit/protocol`.
- `Jurisdiction`: `"US" | "CN" | "EU"` — predicate, not role; lifted to `@motebit/protocol`.

**`RoutingConstraint` (consumer-neutral)**: `jurisdiction?`, `maxInputCostPerMillion?`, `maxOutputCostPerMillion?`, `requiresToolUse?`, `sensitivityCeiling?`. No motebit-cloud-specific fields.

**`RoutingDecision`** (discriminated union): `{ kind: "route" | "fallback" | "deny", reason }`.

## PR 1 scope (motebit-cloud, this commit)

**In scope:**

1. Protocol-layer types in `packages/protocol/src/routing.ts` (Apache-2.0): `TaskShape` closed registry + named constants + `ALL_TASK_SHAPES` frozen iteration + `isTaskShape` type guard + `ProviderCapability` + `RoutingConstraint` + `RoutingDecision`. Also lifts `InferenceHost`, `ModelLab`, `Jurisdiction` from the proxy's `validation.ts`.
2. Pure dispatcher in `packages/policy/src/auto-router.ts` (BSL-1.1): `dispatchRouting`, `applyBalanceFilter` (consumer-side wrapper), `REFERENCE_ROUTING_POLICY` (the canonical static default, replaceable per consumer).
3. Tests in `packages/policy/src/__tests__/auto-router.test.ts`: matrix coverage (each of 7 shapes), fallback path, deny path, jurisdiction filter, cost ceilings, balance-wrapper composition.
4. First consumer: refactor `services/proxy/src/app/v1/messages/route.ts` to consume `dispatchRouting` instead of inlining the routing logic. `classifyTask` (LLM-based intent classifier) stays proxy-internal as the input source.
5. Drift gate #95 (`scripts/check-routing-decision-coverage.ts`): CONSUMERS-registry coverage. PR 1 registers motebit-cloud-proxy as the one consumer.
6. Adversarial probe in `scripts/check-gates-effective.ts` proves the gate fires when a consumer drops `dispatchRouting`.
7. This doctrine memo.

**Out of scope (named here, deferred to PR 2-N):**

- ~~BYOK consumer (PR 2)~~ **SHIPPED 2026-05-14** in commits `4762229d` (primitive) + the PR 2b sibling (web wire-up + drift gate + this doctrine close). See § "PR 2 — BYOK consumer" below.
- On-device consumer (PR 3): runtime consumes the dispatcher with locally-available models (WebLLM/Ollama). Adds on-device to CONSUMERS registry.
- Chrome narration of routing decisions (PR 4): split into 4a (data plumbing — `RoutingDecision.reason` surfaces on the proxy response as `X-Motebit-Routing-Reason` header, shipped post-PR-1) and 4b (UX decision — chrome narration surface vs inspector panel vs trail slot; deferred pending UX design pass).
- Routing-decision receipts: receipt-schema extension to make "the system picked model X because Y" auditable in the ledger.
- Learned routing function replacing `REFERENCE_ROUTING_POLICY` at motebit-cloud (ModelLab as the eventual host).
- TaskShape taxonomy refinement (capability-shaped vs categorical — current 7 are categorical; capability-shaped would be `"tool-heavy" | "long-context" | "vision" | ...`).

## PR 2 — BYOK consumer (shipped 2026-05-14)

**The architectural payoff of PR 1.** With only one consumer, the role-as-instance pattern had the same risk shape as the old single-cryptosuite world — looks right, doctrine-shaped, but unproven structurally. PR 2 validates that `dispatchRouting(TaskShape × ProviderCapability × Constraints) → RoutingDecision` is consumer-neutral as the doctrine claims by landing a second concrete consumer with a DIFFERENT catalog source, DIFFERENT cost profile (no balance filter), and DIFFERENT shape-detection strategy (heuristic vs LLM classifier).

**Shipped in two commits:**

1. **`4762229d`** — primitive lands in `@motebit/policy/byok-router.ts`:
   - `BYOK_MODEL_CATALOG: Record<ByokVendor, readonly ProviderCapability[]>` — per-vendor `ProviderCapability` catalog with pricing, jurisdiction, lab, host. Sourced from the same `MODEL_CONFIG` table the proxy uses (`services/proxy/src/validation.ts`) for the four vendors the proxy hosts; DeepSeek added as the BYOK-only fifth vendor (jurisdiction `CN`, excluded from proxy by `MOTEBIT_CLOUD_ALLOWED_JURISDICTIONS`, accepted via the BYOK sovereignty path). `as const satisfies Record<ByokVendor, ...>` enforces registry-mirror at the type system.
   - `extractTaskShape(text): TaskShape` — heuristic shape detector. BYOK consumers can't afford the LLM-classifier roundtrip the proxy uses (a Haiku call per turn billed at vendor rates would double the user's cost). Signal order: code (fenced block / function shape / HTML tag pair / refactor cue) → math (LaTeX / equation operators) → research (long-form cue + length > 800) → reasoning (chain-of-thought cues OR 400-800-char deliberation length) → creative (write a poem / imagine / pretend) → quick (< 80 chars) → chat (default). Consumers wanting classifier-level accuracy compose their own detector.
   - `dispatchByokRouting(text, vendor, constraints?)` — composed entry point: extract shape → build catalog → dispatch → typed `RoutingDecision`. Surfaces handle all three discriminator values.

2. **PR 2b** (this commit) — web consumer wire-up:
   - `apps/web/src/web-app.ts` holds `_byokAutoRouteVendor: ByokVendor | null` + `_currentProvider: StreamingProvider | null`; `connectProvider` populates both from `UnifiedProviderConfig`.
   - `WebApp.sendMessageStreaming` intercepts per-turn: when BYOK + `autoRoute` is active, dispatch `dispatchByokRouting(text, vendor)` → mutate the StreamingProvider's `setModel(...)` per the typed decision → forward to runtime unchanged. Every `RoutingDecision.kind` (`route` | `fallback` | `deny`) handled in the switch (the contract enforced by `check-routing-decision-coverage` #95).
   - `ByokProviderConfig` gains `autoRoute?: boolean` (additive, backward-compat; the surface defaults to false → the user's single configured model wins as before).
   - Drift gate `check-routing-decision-coverage`: `byok-runtime-web` registered as the 2nd CONSUMER. The gate now enforces 2 consumers × 3 decision kinds.

**What PR 2 validates about the doctrine:**

| Concern                    | Proxy (PR 1)                                   | BYOK (PR 2)                                           | Same primitive?                                                     |
| -------------------------- | ---------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------- |
| Catalog source             | `getProviderCatalog()` (proxy `MODEL_CONFIG`)  | `BYOK_MODEL_CATALOG[vendor]` (per-vendor sub-catalog) | YES                                                                 |
| Cost filter                | `applyBalanceFilter(catalog, balance)` wrapper | (none — BYOK pays vendors directly)                   | YES (wrapper is optional)                                           |
| Jurisdiction               | `{ jurisdiction: "US" }` constraint            | (none — user's vendor choice = jurisdiction)          | YES                                                                 |
| Shape detection            | LLM (`classifyTask` Haiku call)                | Heuristic (`extractTaskShape`)                        | YES (input is `TaskShape`; how you produce it is consumer's choice) |
| Routing policy             | `REFERENCE_ROUTING_POLICY`                     | `REFERENCE_ROUTING_POLICY`                            | YES                                                                 |
| `RoutingDecision` handling | All three kinds                                | All three kinds                                       | YES (gate enforces)                                                 |

Three different concerns; one dispatcher. The doctrine claim — auto-routing is consumer-neutral — is now structurally proven, not just asserted.

**Deferred from PR 2 (not deferred indefinitely):**

- ~~Desktop + mobile mirror of the web consumer wire-up.~~ **SHIPPED 2026-05-14** alongside the PR 2 close. Both surfaces mirror the web shape: `_byokAutoRouteVendor` + `_currentProvider` field pair; `initAI` populates from `unified.mode === "byok" && unified.autoRoute === true`; `sendMessageStreaming` intercepts per turn and switches on `decision.kind`. `DesktopAIConfig.autoRoute?: boolean` + `MobileAIConfig.autoRoute?: boolean` added; both `*ConfigToUnified` converters thread the flag through the 5 BYOK arms. Drift gate gains `byok-runtime-desktop` + `byok-runtime-mobile` entries — the gate now enforces 4 consumers × 3 decision kinds (proxy + 3-surface BYOK). Mobile narrows `_currentProvider` to `AnthropicProvider | OpenAIProvider` via `instanceof` to exclude on-device `LocalInferenceProvider` cleanly (only cloud BYOK providers have `setModel` in the shape the dispatcher requires).
- Settings-side UI toggle exposing `autoRoute`. The flag is in the config type and respected by the runtime; the BYOK settings panel doesn't yet surface a toggle. Users today opt-in by editing localStorage or via a future settings UI commit.
- Classifier-mode shape detection. The heuristic shape detector is the cheap default; surfaces that want LLM-classifier-level accuracy compose their own detector and pass directly to `dispatchRouting`. Future arc: a small token-shape ML classifier (~1ms, mediocre but fast) replaces the heuristic — pure-function signature swap.

## TaskShape agility — the 7th instance of agility-as-role

`TaskShape` is the 7th instance of [`agility-as-role.md`](agility-as-role.md)'s pattern (after cryptosuite, license-floor, settlement-rail, inference-host, model-lab, jurisdiction-as-predicate). The role names a closed registry of swappable entries; the routing-policy itself is **a consumer-side function**, NOT a role.

**The distinction matters because the codebase has the same conflation history:**

- Pre-2026-05 the proxy had a single `Provider` flat type conflating who-hosts-it with who-trained-it. The 2026-05-13 intelligence-source-agility refactor split it into `InferenceHost` (role) + `ModelLab` (role) + `Jurisdiction` (predicate).
- Earlier in the auto-router design session, the initial draft framed routing-policy itself as a role ("routing-policy-as-role"). That repeated the same vocabulary error: a routing-policy is a function/parameter (`Record<TaskShape, string>` or eventually a learned function of the same signature), not a closed-registry entry. Distinguishing role (registry-shape) from policy (function-shape) is the correction.

The 7th instance is **`TaskShape`** — the registry of task categories the dispatcher branches on. The routing-policy itself is dependency-injected at call site. Adding `"voice-conversation"` is a registry append (registry-shape work); shipping a learned routing function is a parameter swap (function-shape work). Different shapes, different ceremony.

## Why `balanceMicroUsd` is consumer-side, not protocol-side

Balance is motebit-cloud-specific. BYOK consumers pay providers directly and don't have a balance; on-device consumers have no money flow at all. Putting `balanceMicroUsd` in the protocol-layer `RoutingConstraint` would either:

(a) Force BYOK + on-device consumers to fake-populate the field (semantic noise), OR
(b) Make it optional with semantics that don't apply outside motebit-cloud (drift trap — the field exists but means nothing for two of three consumers).

The cleaner shape: protocol-layer `RoutingConstraint` is consumer-neutral (jurisdiction, max cost, capability requirements, sensitivity ceiling). Balance-aware filtering is a **higher-order wrapper** in `@motebit/policy`: `applyBalanceFilter(catalog, balanceMicroUsd) → reduced catalog`. The proxy composes `applyBalanceFilter` BEFORE `dispatchRouting`. BYOK and on-device skip the wrapper entirely.

This is the same shape as how BYOK auth lives outside the protocol — protocol defines the abstraction; consumer-specific concerns wrap it. Protocol stays consumer-neutral.

## Why TaskShape coverage is TypeScript-enforced, not gate-enforced

`dispatchRouting`'s body uses an exhaustive switch over `TaskShape` with `const _exhaustive: never = taskShape` fallthrough. TypeScript enforces per-shape coverage at compile time — adding a new `TaskShape` to the protocol registry without growing the switch is a tsc error, not a gate failure. A drift gate scanning consumer files for `TaskShape` literals would be redundant ceremony.

What the gate (`check-routing-decision-coverage`, #95) DOES enforce structurally:

1. **Consumer registry** — closed list of files that consume `dispatchRouting`. New consumer = registry append + import + call + decision-kind coverage.
2. **Import alignment** — every consumer imports `dispatchRouting` from `@motebit/policy`. A rogue inline implementation is caught.
3. **Decision-kind coverage** — every consumer references all three `RoutingDecision.kind` values (`route`, `fallback`, `deny`). The structural enforcement of exhaustive decision handling at the consumer site, since TypeScript only sees the dispatcher's exhaustiveness.
4. **Sibling-alignment** — `TASK_SHAPES_REFERENCE` in the gate mirrors `ALL_TASK_SHAPES` from `@motebit/protocol`. A protocol-level append without gate update is itself a CI failure.

## Spatial-as-endgame validation

The registers are correct **only if they translate to all three consumers without semantic loss**.

- **motebit-cloud (proxy):** classifyTask → TaskShape → applyBalanceFilter(catalog, balance) → dispatchRouting → RoutingDecision → invoke API.
- **BYOK (PR 2, shipped 2026-05-14):** heuristic-classified intent (`extractTaskShape`) → TaskShape → dispatchRouting(`BYOK_MODEL_CATALOG[vendor]`, no balance filter) → mutate StreamingProvider model → invoke user's provider with user's key. Composed via `dispatchByokRouting` in `@motebit/policy/byok-router.ts`; web consumer site in `apps/web/src/web-app.ts`.
- **On-device (PR 3):** intent (user-explicit or local heuristic) → TaskShape → dispatchRouting(catalog from local WebLLM/Ollama capabilities, no balance filter) → invoke local model.

If any consumer requires routing semantics that can't be expressed via `TaskShape + ProviderCapability + RoutingConstraint + Policy`, that's a doctrine refinement signal — not a one-off feature. The matrix-as-primitive claim survives only if all three consumers share the dispatcher.

This is the test that prevents the auto-router from being a motebit-cloud-shaped feature. The matrix as architectural primitive is end-game-correct only if it composes across all three sovereignty postures.

## Cross-doctrine compose

This primitive composes with five doctrines that today live as separate concerns:

- **[`chrome-as-state-render`](chrome-as-state-render.md)** — same matrix-as-primitive structural shape. Chrome's `f(controlState × embodimentMode)` and routing's `f(TaskShape × ProviderCapability × Constraints)` are the same architectural pattern at different layers; the three-instance-deep endgame validation (web/mobile/spatial for chrome; motebit-cloud/BYOK/on-device for routing) is the same doctrinal proof.
- **[`agility-as-role`](agility-as-role.md)** — `TaskShape` is the 7th instance. The doctrine's role/predicate distinction is reinforced: roles are closed registries; policies are consumer-side functions.
- **[`runtime-invariants-over-prompt-rules`](runtime-invariants-over-prompt-rules.md)** — `RoutingDecision` is a typed cell; exhaustive switch enforces handling. Illegal routing states are unrepresentable at compile time (TypeScript) + at the consumer-registration level (drift gate).
- **[`protocol-model`](protocol-model.md)** — `REFERENCE_ROUTING_POLICY` follows the `REFERENCE_*` naming convention (interop reference default vs interop law; implementers MAY override).
- **[`protocol-primacy`](protocol-primacy.md)** — the audit "does this work identically for a user who never subscribes?" returns YES: BYOK + on-device consumers in PR 2/3 demonstrate this.

The pivot doesn't introduce a new doctrine; it surfaces the structural cut where these five compose. The auto-router's protocol primitive is where they meet.

## What this doctrine deliberately does NOT specify

These decisions stay emergent. Specifying them now ossifies what should remain in motion through PR 2-N.

- **The shape of a learned routing function.** `REFERENCE_ROUTING_POLICY` is a static `Record<TaskShape, string>` today. The eventual replacement (ModelLab as host) has the same signature `(TaskShape, ProviderCapability[], RoutingConstraint) → RoutingDecision` but with learned weights. The training shape, the data source, the deployment cadence — all emerge.
- **Per-consumer policy overrides.** PR 2's BYOK consumer might ship `REFERENCE_BYOK_ROUTING_POLICY`; PR 3's on-device might ship `REFERENCE_ON_DEVICE_ROUTING_POLICY`. Or they might all share `REFERENCE_ROUTING_POLICY`. The choice belongs to the PR that adds the consumer, not this doctrine.
- **TaskShape refinement.** Adding `"voice-conversation"`, `"image-generation"`, `"agentic"`, etc. is a future protocol-level append. The current 7 are the production set as of 2026-05-13; refinement waits for actual consumer pull.
- **Chrome narration of routing decisions.** PR 4+. Threading `RoutingDecision.reason` into `task_step_narration` so the slab chrome surfaces "Routing to Opus for reasoning · Reading the page" is a follow-up.
- **Routing receipts.** Making each decision auditable in the signed receipt ledger is a receipt-schema extension, not part of this primitive's contract.

The contract this doctrine freezes is the architectural primitive (`f(TaskShape × ProviderCapability × Constraints) → RoutingDecision`), the closed registries (`TaskShape`, `InferenceHost`, `ModelLab`, `Jurisdiction`), the consumer-neutrality of `RoutingConstraint`, the role-vs-policy distinction (`TaskShape` is the role; routing-policy is a consumer-side function), and PR 1's scope. Everything else stays in motion.
