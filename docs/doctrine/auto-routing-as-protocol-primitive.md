# Auto-routing as protocol primitive

> **Layer:** law (the dispatcher filters the catalog by constraints) — enforced by `packages/policy/src/__tests__/auto-router.test.ts`

**Status:** [doctrine-status.md § auto-routing-as-protocol-primitive](../ops/doctrine-status.md#auto-routing-as-protocol-primitivemd)

The auto-router's render is **`f(TaskShape × ProviderCapability × Constraints) → RoutingDecision`**, not a hardcoded `Record<task, model>` map living in one consumer's source. Every surface that picks a model for a task — motebit-cloud, BYOK, on-device — consumes the same dispatcher with its own provider catalog and own routing policy. This is the same matrix-as-primitive shape that [`chrome-as-state-render.md`](chrome-as-state-render.md) applied to slab chrome, now applied to model selection.

The mistake this doctrine corrects: routing logic that lives at the proxy is a SaaS-style feature gate. Routing logic that lives at the protocol layer with the proxy as one consumer is a sovereign primitive — BYOK users get the same auto-routing over their own provider keys, on-device users get the same auto-routing over local models. The protocol works without motebit-cloud; motebit-cloud earns its stake by adding aggregator-scale routing intelligence on top of the same dispatcher.

## The polarity error (pre-PR-1)

`services/proxy/src/app/v1/messages/route.ts` inlined the routing decision: `TASK_MODEL_MAP` lookup → `getAffordableModelForTask` walk → resolved model. The proxy was the source of truth for the routing function, and BYOK / on-device had no path to the same logic. Auto-routing was a motebit-cloud feature, not a motebit primitive.

The pivot starts when the dispatcher's signature becomes `f(taskShape, catalog, constraints, policy) → RoutingDecision` and the proxy becomes a _consumer_ of it. Even when only one consumer ships, the dispatcher is shaped against the matrix.

## The principle

> Auto-routing is `f(TaskShape × ProviderCapability × Constraints) → RoutingDecision`. The dispatcher is a pure function in `@motebit/policy`; consumer-specific concerns (balance-aware filtering, intent classification, provider-key gating) wrap the protocol-layer call. New consumers add to the closed CONSUMERS registry; new task shapes are protocol-level appends.

Three coordinated commitments:

1. **The dispatcher signature is the matrix.** A dispatcher that took only `taskShape` would carry the SaaS-conflation error this doctrine corrects (motebit-cloud is the source of truth for routing). A dispatcher that took only `catalog` would lose the task-shape axis. The triple is the architectural primitive.
2. **Each `TaskShape` is a closed registry entry, not a function-call-site decision.** Adding a shape (`"voice-conversation"`, `"image-generation"`) is a protocol-level append + a new arm in `REFERENCE_ROUTING_POLICY` + drift-gate-induced coverage in every CONSUMER.
3. **The routing-policy is a consumer-side function, NOT a closed registry.** A `Record<TaskShape, string>`, or a learned function of the same signature. Policies are swapped via dependency injection; the registry-shaped thing is `TaskShape` (the role), not the policy (the parameter).

## The matrix

`TaskShape × ProviderCapability × Constraints = |TaskShape| × N × M` — most cells are sparse; the dispatcher's job is to pick the right model from the catalog given the task shape and constraints.

**`TaskShape` registry** (the closed protocol-level inventory — adding a shape requires a registry append + policy arm + every consumer's drift-gate coverage):

| shape       | semantic                                                                 |
| ----------- | ------------------------------------------------------------------------ |
| `quick`     | Fast / low-latency tasks (tool-heavy, short responses, sub-second feel). |
| `chat`      | Conversational back-and-forth — the default.                             |
| `reasoning` | Deep reasoning — chain-of-thought, multi-step inference.                 |
| `code`      | Code-related — completion, review, debugging.                            |
| `research`  | Research / long-context — synthesis across many sources.                 |
| `creative`  | Creative writing — open-ended generation, voice, prose.                  |
| `math`      | Math / scientific — symbolic reasoning, calculation, proofs.             |

Each shape's model in `REFERENCE_ROUTING_POLICY` is a reference default, replaceable per consumer.

**`ProviderCapability` axes** (lifted from `services/proxy/src/validation.ts`'s `MODEL_CONFIG`; each production model carries `{host, lab, jurisdiction, input/outputCostPerMillion}`):

- `InferenceHost` — closed registry, defined in `@motebit/protocol` (`packages/protocol/src/routing.ts`; `validation.ts` re-exports it).
- `ModelLab` — closed registry, defined in `@motebit/protocol` (`packages/protocol/src/routing.ts`; `validation.ts` re-exports it).
- `Jurisdiction` — predicate, not role; lifted to `@motebit/protocol`.

**`RoutingConstraint` (consumer-neutral)**: `jurisdiction?`, `maxInputCostPerMillion?`, `maxOutputCostPerMillion?`, `requiresToolUse?`, `sensitivityCeiling?`. No motebit-cloud-specific fields.

**`RoutingDecision`** (discriminated union): `{ kind: "route" | "fallback" | "deny", reason }`.

## PR 1 scope (motebit-cloud)

**In scope:**

1. Protocol-layer types in `packages/protocol/src/routing.ts` (Apache-2.0): `TaskShape` closed registry + named constants + `ALL_TASK_SHAPES` frozen iteration + `isTaskShape` type guard + `ProviderCapability` + `RoutingConstraint` + `RoutingDecision`. Also lifts `InferenceHost`, `ModelLab`, `Jurisdiction` from the proxy's `validation.ts`.
2. Pure dispatcher in `packages/policy/src/auto-router.ts` (BSL-1.1): `dispatchRouting`, `applyBalanceFilter` (consumer-side wrapper), `REFERENCE_ROUTING_POLICY` (the canonical static default, replaceable per consumer).
3. Tests in `packages/policy/src/__tests__/auto-router.test.ts`: matrix coverage (each of 7 shapes), fallback path, deny path, jurisdiction filter, cost ceilings, balance-wrapper composition.
4. First consumer: refactor `services/proxy/src/app/v1/messages/route.ts` to consume `dispatchRouting` instead of inlining the routing logic. `classifyTask` (LLM-based intent classifier) stays proxy-internal as the input source.
5. Drift gate #95 (`scripts/check-routing-decision-coverage.ts`): CONSUMERS-registry coverage. PR 1 registers motebit-cloud-proxy as the one consumer.
6. Adversarial probe in `scripts/check-gates-effective.ts` proves the gate fires when a consumer drops `dispatchRouting`.
7. This doctrine memo.

**Out of scope (named here, deferred to PR 2-N):**

- BYOK consumer — § "PR 2 — BYOK consumer" below.
- On-device consumer — § "PR 3 — on-device consumer" below.
- Chrome narration of routing decisions — § "PR 4 — chrome narration of routing decisions" below.
- Routing-decision receipts: receipt-schema extension to make "the system picked model X because Y" auditable in the ledger.
- Learned routing function replacing `REFERENCE_ROUTING_POLICY` at motebit-cloud (ModelLab as the eventual host).
- TaskShape taxonomy refinement (capability-shaped vs categorical — the shapes are categorical; capability-shaped would be `"tool-heavy" | "long-context" | "vision" | ...`).

## PR 2 — BYOK consumer

**The architectural payoff of PR 1.** With only one consumer, the role-as-instance pattern had the same risk shape as the old single-cryptosuite world — looks right, doctrine-shaped, but unproven structurally. PR 2 validates that `dispatchRouting(TaskShape × ProviderCapability × Constraints) → RoutingDecision` is consumer-neutral as the doctrine claims by landing a second concrete consumer with a DIFFERENT catalog source, DIFFERENT cost profile (no balance filter), and DIFFERENT shape-detection strategy (heuristic vs LLM classifier).

**Shape, in two parts:**

1. **Primitive** — `@motebit/policy/byok-router.ts`:
   - `BYOK_MODEL_CATALOG: Record<ByokVendor, readonly ProviderCapability[]>` — per-vendor `ProviderCapability` catalog with pricing, jurisdiction, lab, host. Sourced from the same `MODEL_CONFIG` table the proxy uses (`services/proxy/src/validation.ts`) for the four vendors the proxy hosts; DeepSeek added as the BYOK-only fifth vendor (jurisdiction `CN`, excluded from proxy by `MOTEBIT_CLOUD_ALLOWED_JURISDICTIONS`, accepted via the BYOK sovereignty path). `as const satisfies Record<ByokVendor, ...>` enforces registry-mirror at the type system.
   - `extractTaskShape(text): TaskShape` — heuristic shape detector. BYOK consumers can't afford the LLM-classifier roundtrip the proxy uses (a Haiku call per turn billed at vendor rates would double the user's cost). Signal order: code (fenced block / function shape / HTML tag pair / refactor cue) → math (LaTeX / equation operators) → research (long-form cue + length > 800) → reasoning (chain-of-thought cues OR 400-800-char deliberation length) → creative (write a poem / imagine / pretend) → quick (< 80 chars) → chat (default). Consumers wanting classifier-level accuracy compose their own detector.
   - `dispatchByokRouting(text, vendor, constraints?)` — composed entry point: extract shape → build catalog → dispatch → typed `RoutingDecision`. Surfaces handle all three discriminator values.

2. **Surface wire-up** — the web consumer:
   - `apps/web/src/web-app.ts` holds `_byokAutoRouteVendor: ByokVendor | null` + `_currentProvider: StreamingProvider | null`; `connectProvider` populates both from `UnifiedProviderConfig`.
   - `WebApp.sendMessageStreaming` intercepts per-turn: when BYOK + `autoRoute` is active, dispatch `dispatchByokRouting(text, vendor)` → mutate the StreamingProvider's `setModel(...)` per the typed decision → forward to runtime unchanged. Every `RoutingDecision.kind` (`route` | `fallback` | `deny`) handled in the switch (the contract enforced by `check-routing-decision-coverage` #95).
   - `ByokProviderConfig` carries `autoRoute?: boolean` (additive, backward-compat; the surface defaults to false → the user's single configured model wins as before).
   - Drift gate `check-routing-decision-coverage`: every BYOK surface consumer is a registered CONSUMER, held to all 3 decision kinds.

**What PR 2 validates about the doctrine:**

| Concern                    | Proxy (PR 1)                                   | BYOK (PR 2)                                           | Same primitive?                                                     |
| -------------------------- | ---------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------- |
| Catalog source             | `getProviderCatalog()` (proxy `MODEL_CONFIG`)  | `BYOK_MODEL_CATALOG[vendor]` (per-vendor sub-catalog) | YES                                                                 |
| Cost filter                | `applyBalanceFilter(catalog, balance)` wrapper | (none — BYOK pays vendors directly)                   | YES (wrapper is optional)                                           |
| Jurisdiction               | `{ jurisdiction: "US" }` constraint            | (none — user's vendor choice = jurisdiction)          | YES                                                                 |
| Shape detection            | LLM (`classifyTask` Haiku call)                | Heuristic (`extractTaskShape`)                        | YES (input is `TaskShape`; how you produce it is consumer's choice) |
| Routing policy             | `REFERENCE_ROUTING_POLICY`                     | `REFERENCE_ROUTING_POLICY`                            | YES                                                                 |
| `RoutingDecision` handling | All three kinds                                | All three kinds                                       | YES (gate enforces)                                                 |

Three different concerns; one dispatcher. The doctrine claim — auto-routing is consumer-neutral — is structurally proven, not just asserted.

**Deferred from PR 2 (not deferred indefinitely):**

- Settings-side UI toggle exposing `autoRoute` — see § "Two known shapes the auto-routing arc deliberately ships unfinished", item (1).
- Classifier-mode shape detection. The heuristic shape detector is the cheap default; surfaces that want LLM-classifier-level accuracy compose their own detector and pass directly to `dispatchRouting`. Future arc: a small token-shape ML classifier (~1ms, mediocre but fast) replaces the heuristic — pure-function signature swap.

## PR 3 — on-device consumer

**The three-instance-deep validation.** PR 1 is the proxy as the first consumer; PR 2 is BYOK as the second; PR 3 (this section) is the on-device consumer as the third. The role-as-instance pattern (an instance of `agility-as-role.md`) is doctrine-shaped with one consumer, validated by a second concrete consumer, and structurally proven across all three sovereignty postures (subscription / pay-per-call / zero-marginal) by the third.

**On-device's structural differences from PR 1 + PR 2:**

- **Cost** — zero marginal $/token. `inputCostPerMillion: 0` + `outputCostPerMillion: 0` on every catalog entry. The dispatcher uses `<=` for the cost filter so a `maxInputCostPerMillion: 0` constraint doesn't filter them out (locked by test).
- **Host** — `"local-server"`, a new `InferenceHost` registry entry. The user's own inference server (Ollama / LM Studio / llama.cpp / Jan / vLLM — all expose `/v1/chat/completions` via the OpenAI-compat shim), NOT a remote provider. The proxy NEVER routes to this host; defensive arms in `services/proxy/src/app/v1/messages/route.ts::getProviderApiKey` + `buildProviderRequest` name the structural violation.
- **Catalog shape** — per `OnDeviceBackend` rather than per `ByokVendor`. Multi-model backends (such as `local-server`) ship a populated catalog; single-model backends (`apple-fm` / `mlx` / `webllm`) ship empty catalogs by design. The dispatcher denies single-model backends — the honest signal ("nothing to auto-route across"); consumers fall through to the configured model. The same `RoutingDecision.kind === "deny"` channel covers both "constraints empty the catalog" (BYOK) and "catalog was empty to begin with" (on-device single-model). One shape; two semantic origins.

**Shape, in two parts:**

1. **Protocol + policy primitive:**
   - `@motebit/protocol`: `InferenceHost` includes `"local-server"`; `ModelLab` includes the labs the canonical `LOCAL_SERVER_SUGGESTED_MODELS` set draws from. Defensive arms in proxy's exhaustive switches.
   - `@motebit/policy/on-device-router.ts`: `ON_DEVICE_MODEL_CATALOG: Record<OnDeviceBackend, readonly ProviderCapability[]>` (local-server entries mirroring `LOCAL_SERVER_SUGGESTED_MODELS`; empty catalogs for single-model backends); `buildOnDeviceCatalog`; `dispatchOnDeviceRouting`. Reuses `extractTaskShape` from `byok-router.ts` (the heuristic detector is the right shape for any consumer that can't afford per-message LLM classification).
   - Pure-function tests pin catalog coverage / zero-marginal-cost / host invariant / lab coverage / dispatcher behavior across multi-model + single-model paths.

2. **Surface wire-up** — the desktop consumer:
   - `OnDeviceProviderConfig.autoRoute?: boolean` in `@motebit/sdk`. Additive, backward-compat. Per `feedback_sovereignty_orthogonal`: orthogonal to tier — on-device auto-routing is never subscription-gated.
   - `desktopConfigToUnified` threads `autoRoute` through the on-device arm (alongside the BYOK arms).
   - `DesktopApp` holds `_onDeviceAutoRouteBackend: OnDeviceBackend | null` parallel to `_byokAutoRouteVendor`. The two state fields are mutually exclusive (one mode per unified config); `initAI` populates exactly one based on the config's mode + autoRoute flag. `_currentProvider` is shared.
   - `sendMessageStreaming` extends the BYOK intercept with a parallel on-device branch. Both branches handle all three `RoutingDecision.kind` values; one dispatches `dispatchByokRouting`, the other `dispatchOnDeviceRouting`.
   - Drift gate `check-routing-decision-coverage` (#95) registers each on-device surface consumer with `entry: "dispatchOnDeviceRouting"`, held to all 3 decision kinds.

**What PR 3 validates structurally (extending the PR 2 table):**

| Concern                    | Proxy (PR 1)                                  | BYOK (PR 2)                           | On-device (PR 3)                        | Same primitive?                                                   |
| -------------------------- | --------------------------------------------- | ------------------------------------- | --------------------------------------- | ----------------------------------------------------------------- |
| Catalog source             | `getProviderCatalog()` (proxy `MODEL_CONFIG`) | `BYOK_MODEL_CATALOG[vendor]`          | `ON_DEVICE_MODEL_CATALOG[backend]`      | YES                                                               |
| Cost filter                | `applyBalanceFilter` wrapper                  | (none — direct vendor billing)        | (none — zero marginal cost)             | YES (wrapper optional)                                            |
| Jurisdiction               | `{ jurisdiction: "US" }` constraint           | (none — vendor choice = jurisdiction) | (none — user's device = jurisdiction)   | YES                                                               |
| Shape detection            | LLM (`classifyTask` Haiku call)               | Heuristic (`extractTaskShape`)        | Heuristic (same `extractTaskShape`)     | YES (shape is the input; how you produce it is consumer's choice) |
| Routing policy             | `REFERENCE_ROUTING_POLICY`                    | `REFERENCE_ROUTING_POLICY`            | `REFERENCE_LOCAL_SERVER_ROUTING_POLICY` | YES (the policy is an injected parameter)                         |
| `RoutingDecision` handling | All three kinds                               | All three kinds                       | All three kinds                         | YES (gate enforces)                                               |
| Cost model                 | Balance-based ($/token tier)                  | Pay-per-call ($/token direct)         | Zero marginal cost (user hardware)      | YES                                                               |

Three fundamentally different cost models flowing through the same dispatcher. The doctrine claim is structurally proven across the full sovereignty spectrum. Adding the on-device consumer needed no change to the dispatcher's signature, the `RoutingDecision` discriminated union, the `REFERENCE_ROUTING_POLICY`, or the closed `TaskShape` registry; the only protocol surface that grew was closed-registry expansion for `InferenceHost` + `ModelLab` — additive, backward-compat, exhaustive-switch-enforced.

**The policy is a consumer-side override.** `dispatchOnDeviceRouting` consumes `REFERENCE_LOCAL_SERVER_ROUTING_POLICY` (local-server models per TaskShape) instead of the cloud-shaped `REFERENCE_ROUTING_POLICY`, so an on-device turn lands in `kind: "route"` rather than a misleading `kind: "fallback"` (`↺` implies "we swapped from your preference" when the user never picked a cloud model). This is the role-vs-policy distinction exercised by a real consumer-specific override.

**Deferred from PR 3, not deferred indefinitely:**

- Web + mobile on-device consumer mirror. Web's WebLLM has download-cost per model swap making per-turn routing inappropriate (a single-model catalog is denied cleanly by the dispatcher). Mobile's local-server is less common than desktop's Ollama. Mirror lands when there's surface-side signal.
- Multi-model `apple-fm` / `mlx` / `webllm` catalogs. These backends are single-model; when per-backend multi-model support lands (e.g., MLX with multiple loaded models, WebLLM with cached model swap), the catalog grows additively.

## PR 4 — chrome narration of routing decisions

**Closing the doctrine-stated observability gap.** Every `RoutingDecision` the dispatcher returns carries a `reason` field whose purpose is observability — per § "Routing decision": "every variant carries `reason` for observability — the dispatcher's choice should always be human-legible, even when the choice is 'I couldn't pick anything.'" Until PR 4, that doctrine was code-stated but render-absent: the field existed, no consumer read it. PR 4 closes the gap by surfacing routing decisions in the slab chrome.

**The architectural shape — second narration source for chrome-as-state-render.**

PR 1 of [`chrome-as-state-render.md`](chrome-as-state-render.md) named task-step narration as the chrome's content for the `motebit × virtual_browser` register. PR 4 extends the chrome to absorb a second narration source — routing decisions — without forcing chrome-shape changes. This validates the matrix-as-primitive abstraction: the chrome doesn't fork by narration-type; it grows ADDITIVELY by accepting more typed opts. The two narration sources have distinct semantic registers:

| Source                  | Register                                                            | Producer                                                                                | Position in strip                                      |
| ----------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **Task-step narration** | "What motebit is doing in the world" — first-person voice           | The AI loop (`extractNarrationTag` in `@motebit/ai-core`)                               | Middle slot (replaces URL display when present)        |
| **Routing narration**   | "Which model the dispatcher chose under the hood" — system metadata | The surface's auto-router intercept (`dispatchByokRouting` / `dispatchOnDeviceRouting`) | After URL chip in the middle strip; lower-opacity chip |

The two are intentionally NOT collapsed into a single narration string ("Routing to Opus · Reading the page"). They surface separately because they answer different questions. A user looking at the chrome sees both registers as distinct calm-software cues.

**Shape:**

- `@motebit/policy/auto-router.ts` exports `formatRoutingChip(decision: RoutingDecision): string | null` — pure helper that maps the typed decision to a short chip-string. `route` → just the model name; `fallback` → `${backup} ↺` (the `↺` glyph signals a swap from the policy preference); `deny` → null (calm-software default: no chip when no routing happened). The chrome stays UX-agnostic of the discriminated union — surfaces pass a pre-formatted string, not the `RoutingDecision` object.
- `apps/web/src/ui/slab-chrome.ts` `SlabChromeOpts` carries `routingNarration?: string | null`. `renderMotebitVirtualBrowserRegister` builds a routing chip inside the existing narration strip after the URL chip when present. The chip is non-interactive in PR 4 (informational); future arcs may wire hover-reveal of the full `decision.reason`.
- `apps/web/src/web-app.ts` holds `_routingNarration: string | null` parallel to `_taskStepNarration`. Populated in `sendMessageStreaming`'s BYOK intercept via `formatRoutingChip(decision)` AFTER the existing `setModel` mutation, then `applyChromeToCurrentState` is called explicitly so the chip flickers in alongside the model swap. Cleared at the START of every `sendMessageStreaming` (the chip never outlives its own turn) AND in `connectProvider` (a BYOK→cloud config swap drops the chip cleanly).

**Three tests pin the chip semantic** in `auto-router.test.ts`: `route` returns just the model name; `fallback` returns model + glyph; `deny` returns null.

**The user-visible payoff.** A BYOK user with `autoRoute: true` opens the slab (cobrowser / computer-use), types a code question, sees the chrome strip render "via gpt-5.4 ↺" (the dispatcher's fallback — Anthropic catalog asked for the code task → fell back to claude-opus-4-7). The dispatcher's reason is doctrine-stated; the chip is the doctrine made visible. Same for on-device — desktop user with Ollama + `autoRoute: true` sees "via llama3.2" (a `route` under the local-server policy).

**Deferred from PR 4, not deferred indefinitely:**

- Desktop + mobile slab-chrome routing chip mirror (web has the most-developed virtual_browser chrome surface). Desktop/mobile chrome surfaces would mirror the `routingNarration` opt + chip rendering when their chrome surfaces grow to match web's matrix-shape.
- Desktop + mobile cloud-mode routing chip (the proxy's `X-Motebit-Routing-Reason` header, read through `AnthropicProvider`'s `onRoutingReason` callback, so BYOK / on-device / cloud render the same chip via the same chrome slot) follows when those surfaces grow comparable chrome (sibling of the slab-chrome routing-chip-mirror item above).
- Hover-reveal of full `decision.reason`. PR 4's chip is informational; an interactive variant (hover or tap) revealing the full reason text ("wanted gpt-5.4, used claude-opus-4-7 because policy preferred gpt-5.4 for code, but it's not in the filtered catalog") is the natural follow-up.
- Chat-log-level routing chip. PR 4 surfaces the chip in the slab chrome (visible when slab is open + in virtual_browser register). For chat-only flows (slab closed), the routing decision per-message would render next to each AI response in the chat log. Separate surface arc.

## Two known shapes the auto-routing arc deliberately ships unfinished

A principal-engineer audit on 2026-05-14 (post-PR-4) named two architectural shapes the arc deliberately leaves unfinished. Naming them here keeps the deferrals honest — they're load-bearing follow-ups, not invisible debt.

**(1) `autoRoute` is a hidden flag.** The settings toggle for `ByokProviderConfig.autoRoute` / `OnDeviceProviderConfig.autoRoute` is deferred; until it ships, users opt in via persisted-config editing (localStorage on web; AsyncStorage on mobile; Tauri config JSON on desktop). The architectural primitive is real and tested across all surfaces; the user-touchpoint is invisible until a settings UI lands. **Deferral reason:** the architectural validation (3-instance-deep consumer-neutrality proof) was the load-bearing claim for the doctrine; settings UI is an additive UX commit per surface that doesn't change the protocol shape. **Trigger to ship the toggle:** the first user signal that asks for auto-routing across BYOK models, OR a motebit-cloud-cancel-and-go-BYOK flow needing the toggle as an explicit affordance.

**(2) The intercept logic is duplicated 3× across surfaces** (`apps/web/src/web-app.ts`, `apps/desktop/src/index.ts`, `apps/mobile/src/mobile-app.ts`). Each surface holds its own `_byokAutoRouteVendor` + `_currentProvider` field pair (+ `_onDeviceAutoRouteBackend` on desktop) and its own dispatch switch in `sendMessageStreaming`. Per `architecture_synchronization_invariants` this is the exact shape that drifts — a bug fix on web won't propagate to desktop/mobile automatically. **Deferral reason:** consolidating into a shared `@motebit/runtime` consumer-helper would require either threading provider-state mutation into the runtime (which contradicts the runtime's consumer-neutral posture) OR a new shared "auto-router-bridge" module that surfaces inject. Neither shape is obviously right yet; shipping the duplication and waiting for the first divergence-fix is the honest move. **Trigger to consolidate:** the second time a bug fix on one surface has to be ported to the other two — at that point the cost of duplication exceeds the design-uncertainty cost of consolidation.

The integration test in `apps/web/src/__tests__/web-app.test.ts` (§ "BYOK auto-routing — integration") pins the wire shape end-to-end for the web consumer; sibling integration tests for desktop + mobile follow when those surfaces grow comparable test infrastructure. The drift-gate-plus-integration-test pair is the structural defense the duplication needs.

## TaskShape agility — an instance of agility-as-role

`TaskShape` is an instance of [`agility-as-role.md`](agility-as-role.md)'s pattern. The role names a closed registry of swappable entries; the routing-policy itself is **a consumer-side function**, NOT a role.

**The distinction matters because the codebase has the same conflation history:**

- Pre-2026-05 the proxy had a single `Provider` flat type conflating who-hosts-it with who-trained-it. The 2026-05-13 intelligence-source-agility refactor split it into `InferenceHost` (role) + `ModelLab` (role) + `Jurisdiction` (predicate).
- Earlier in the auto-router design session, the initial draft framed routing-policy itself as a role ("routing-policy-as-role"). That repeated the same vocabulary error: a routing-policy is a function/parameter (`Record<TaskShape, string>` or eventually a learned function of the same signature), not a closed-registry entry. Distinguishing role (registry-shape) from policy (function-shape) is the correction.

The instance is **`TaskShape`** — the registry of task categories the dispatcher branches on. The routing-policy itself is dependency-injected at call site. Adding `"voice-conversation"` is a registry append (registry-shape work); shipping a learned routing function is a parameter swap (function-shape work). Different shapes, different ceremony.

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
- **BYOK (PR 2):** heuristic-classified intent (`extractTaskShape`) → TaskShape → dispatchRouting(`BYOK_MODEL_CATALOG[vendor]`, no balance filter) → mutate StreamingProvider model → invoke user's provider with user's key. Composed via `dispatchByokRouting` in `@motebit/policy/byok-router.ts`; web consumer site in `apps/web/src/web-app.ts`.
- **On-device (PR 3):** heuristic-classified intent (`extractTaskShape`, reused from BYOK) → TaskShape → dispatchRouting(`ON_DEVICE_MODEL_CATALOG[backend]`, no balance filter, no jurisdiction filter — user's device IS the jurisdiction) → mutate StreamingProvider model → invoke user's local inference server. Composed via `dispatchOnDeviceRouting` in `@motebit/policy/on-device-router.ts`; desktop consumer site in `apps/desktop/src/index.ts`. Single-model backends (`apple-fm` / `mlx` / `webllm`) ship empty catalogs by design → dispatcher denies → consumer falls through to configured model.

If any consumer requires routing semantics that can't be expressed via `TaskShape + ProviderCapability + RoutingConstraint + Policy`, that's a doctrine refinement signal — not a one-off feature. The matrix-as-primitive claim survives only if all three consumers share the dispatcher.

This is the test that prevents the auto-router from being a motebit-cloud-shaped feature. The matrix as architectural primitive is end-game-correct only if it composes across all three sovereignty postures.

## Cross-doctrine compose

This primitive composes with five doctrines that today live as separate concerns:

- **[`chrome-as-state-render`](chrome-as-state-render.md)** — same matrix-as-primitive structural shape. Chrome's `f(controlState × embodimentMode)` and routing's `f(TaskShape × ProviderCapability × Constraints)` are the same architectural pattern at different layers; the three-instance-deep endgame validation (web/mobile/spatial for chrome; motebit-cloud/BYOK/on-device for routing) is the same doctrinal proof.
- **[`agility-as-role`](agility-as-role.md)** — `TaskShape` is an instance. The doctrine's role/predicate distinction is reinforced: roles are closed registries; policies are consumer-side functions.
- **[`runtime-invariants-over-prompt-rules`](runtime-invariants-over-prompt-rules.md)** — `RoutingDecision` is a typed cell; exhaustive switch enforces handling. Illegal routing states are unrepresentable at compile time (TypeScript) + at the consumer-registration level (drift gate).
- **[`protocol-model`](protocol-model.md)** — `REFERENCE_ROUTING_POLICY` follows the `REFERENCE_*` naming convention (interop reference default vs interop law; implementers MAY override).
- **[`protocol-primacy`](protocol-primacy.md)** — the audit "does this work identically for a user who never subscribes?" returns YES: BYOK + on-device consumers in PR 2/3 demonstrate this.

The pivot doesn't introduce a new doctrine; it surfaces the structural cut where these five compose. The auto-router's protocol primitive is where they meet.

## What this doctrine deliberately does NOT specify

These decisions stay emergent. Specifying them now ossifies what should remain in motion through PR 2-N.

- **The shape of a learned routing function.** `REFERENCE_ROUTING_POLICY` is a static `Record<TaskShape, string>`. The eventual replacement (ModelLab as host) has the same signature `(TaskShape, ProviderCapability[], RoutingConstraint) → RoutingDecision` but with learned weights. The training shape, the data source, the deployment cadence — all emerge.
- **Per-consumer policy overrides.** PR 2's BYOK consumer might ship `REFERENCE_BYOK_ROUTING_POLICY`; PR 3's on-device might ship `REFERENCE_ON_DEVICE_ROUTING_POLICY`. Or they might all share `REFERENCE_ROUTING_POLICY`. The choice belongs to the PR that adds the consumer, not this doctrine.
- **TaskShape refinement.** Adding `"voice-conversation"`, `"image-generation"`, `"agentic"`, etc. is a future protocol-level append; refinement waits for actual consumer pull.
- **Routing receipts.** Making each decision auditable in the signed receipt ledger is a receipt-schema extension, not part of this primitive's contract.

The contract this doctrine freezes is the architectural primitive (`f(TaskShape × ProviderCapability × Constraints) → RoutingDecision`), the closed registries (`TaskShape`, `InferenceHost`, `ModelLab`, `Jurisdiction`), the consumer-neutrality of `RoutingConstraint`, the role-vs-policy distinction (`TaskShape` is the role; routing-policy is a consumer-side function), and PR 1's scope. Everything else stays in motion.
