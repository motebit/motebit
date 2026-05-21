# @motebit/sdk Changelog

## 1.3.0

### Minor Changes

- 4a7e281: Add `autoRoute?: boolean` to `ByokProviderConfig` — opts the user into auto-routing across the vendor's available models per turn. When `true`, surface runtimes (web today; desktop/mobile mirror following) consume the second-consumer half of the auto-routing primitive (`@motebit/policy::dispatchByokRouting`) to pick the best model for each turn's `TaskShape` from the vendor's catalog. When `false` or omitted, the surface uses the single configured `model` (backward-compat default).

  Closes the auto-routing PR 2 doctrine arc (`docs/doctrine/auto-routing-as-protocol-primitive.md` § "PR 2 — BYOK consumer"). The architectural payoff: with PR 1's motebit-cloud-proxy as the only consumer of `dispatchRouting`, the role-as-instance pattern was doctrine-shaped but unproven structurally. PR 2 validates that the dispatcher is consumer-neutral by landing a second concrete consumer with a different catalog source (`BYOK_MODEL_CATALOG[vendor]`), no balance filter (BYOK pays vendors directly), no jurisdiction filter, and heuristic shape detection instead of LLM classification — all via the same `dispatchRouting` entry point unchanged.

  Web consumer site lives at `apps/web/src/web-app.ts::WebApp.sendMessageStreaming` (the natural intercept point where the BYOK config and StreamingProvider reference both live). Registered as the 2nd CONSUMER in the drift gate `check-routing-decision-coverage` (#95). Per the gate's structural enforcement, the consumer references every `RoutingDecision.kind` value (`route` | `fallback` | `deny`).

  Per `feedback_sovereignty_orthogonal`: this flag is orthogonal to tier — BYOK auto-routing is never subscription-gated. The user already has the vendor's key; the surface's job is to compose the canonical dispatcher over it.

  Deferred follow-ups (named in the doctrine, not deferred indefinitely):
  - Desktop + mobile mirror of the web consumer wire-up. Same shape (`_byokAutoRouteVendor` + `_currentProvider` + `setModel` per turn); cross-surface mirror follows per the one-pass-delivery doctrine. Each surface adds its own `byok-runtime-{desktop,mobile}` entry to the drift gate's CONSUMERS registry.
  - Settings-side UI toggle exposing `autoRoute`. The flag is in the config type and respected by the runtime; the BYOK settings panel doesn't yet surface a toggle. Users today opt-in by editing localStorage or via a future settings UI commit.
  - Classifier-mode shape detection. The heuristic shape detector (`@motebit/policy::extractTaskShape`) is the cheap default; surfaces wanting LLM-classifier-level accuracy compose their own detector and pass directly to `dispatchRouting`.

- eed64ea: Add `autoRoute?: boolean` to `OnDeviceProviderConfig` — opts the user into per-turn auto-routing across the on-device backend's available models. When `true` AND the backend is multi-model (`local-server` today; `apple-fm` / `mlx` / `webllm` are single-model surfaces), surface runtimes consume the third-consumer half of the auto-routing primitive (`@motebit/policy::dispatchOnDeviceRouting`) to pick the best model for each turn's `TaskShape` from the backend's catalog. When `false` or omitted, the surface uses the single configured `model`.

  Closes the auto-routing PR 3 doctrine arc (`docs/doctrine/auto-routing-as-protocol-primitive.md` § "PR 3 — on-device consumer"). The architectural payoff: with PR 1 (motebit-cloud-proxy) + PR 2 (BYOK across web/desktop/mobile) shipped, the role-as-instance pattern (7th instance of `agility-as-role.md`) had two consumers — same risk shape as a 2-instance closed registry. PR 3 makes it three. The doctrine claim "auto-routing is consumer-neutral" is now structurally proven across the full sovereignty spectrum (subscription / pay-per-call / zero-marginal).

  Desktop consumer site lives at `apps/desktop/src/index.ts::DesktopApp.sendMessageStreaming` — the same intercept point PR 2 added for BYOK, now extended with a parallel on-device branch. The two state fields (`_byokAutoRouteVendor` + `_onDeviceAutoRouteBackend`) are mutually exclusive; `initAI` populates exactly one based on the unified config's mode + autoRoute flag.

  Drift gate `check-routing-decision-coverage` (#95) gains `on-device-runtime-desktop` consumer entry. Same desktop file as `byok-runtime-desktop`, different dispatcher entry (`dispatchOnDeviceRouting`). The gate now enforces **5 consumers × 3 decision kinds**.

  Per `feedback_sovereignty_orthogonal`: orthogonal to tier — on-device auto-routing is never subscription-gated. The user owns the hardware; the surface's job is to compose the canonical dispatcher over it.

  Deferred follow-ups (named in the doctrine, all triggered by real-consumer signal):
  - Web + mobile on-device consumer mirror. Web's WebLLM has download-cost per model swap making per-turn routing inappropriate (catalog is single-model on web today; dispatcher denies cleanly). Mobile's local-server is less common than desktop's Ollama. Mirror lands when there's surface-side signal.
  - Per-policy on-device routing — surface-specific `REFERENCE_LOCAL_SERVER_ROUTING_POLICY` mapping `TaskShape` → local model names (e.g., `code: "codellama"`, `chat: "llama3.2"`). Today every on-device dispatch lands in `fallback` because the canonical `REFERENCE_ROUTING_POLICY` names cloud models. The role-vs-policy distinction makes this a clean future swap.
  - Multi-model `apple-fm` / `mlx` / `webllm` catalogs. Today these backends are single-model; the dispatcher denies them by design (the honest signal). When per-backend multi-model support lands, the catalog grows additively.

### Patch Changes

- Updated dependencies [b0d068b]
- Updated dependencies [92c2800]
- Updated dependencies [6a46f33]
- Updated dependencies [53e11b5]
- Updated dependencies [2428248]
- Updated dependencies [f1d3308]
- Updated dependencies [a5abc51]
- Updated dependencies [904d744]
- Updated dependencies [4ea0127]
- Updated dependencies [46189c6]
- Updated dependencies [00585fc]
- Updated dependencies [7dd54da]
- Updated dependencies [be9275a]
- Updated dependencies [343e81f]
- Updated dependencies [8262902]
  - @motebit/protocol@2.0.0

## 1.2.0

### Minor Changes

- f1ba621: audit-chain-runtime-wire — `ChainedAuditSink` is now a composable
  wrapper that auto-wires when surfaces supply both a `toolAuditSink`
  and an `auditChainStore` adapter. Closes the gap from audit-chain-1
  - audit-chain-2 where the primitives existed but had zero consumers
    in production.

  **`@motebit/protocol` (minor):** new `AuditChainEntry` and
  `AuditChainStoreAdapter` interfaces. Wire-format permissive-floor
  types so `StorageAdapters.auditChainStore` can reference them
  without sdk crossing into BSL `@motebit/policy`. Concrete primitives
  (`appendAuditEntry`, `verifyAuditChain`, the `crypto.subtle`
  hashing) stay in `@motebit/policy/audit-chain.ts` — only the type
  moves; same algorithm. `@motebit/policy` re-exports
  `AuditEntry` / `AuditChainStore` as type aliases for backward
  compatibility with existing in-package callers.

  **`@motebit/sdk` (minor):** `StorageAdapters.auditChainStore?:
AuditChainStoreAdapter` — surfaces opt in by passing
  `new SqliteAuditChainStore(driver)` (cli, web, future surfaces with
  SQLite) or omitting (in-tree tests, minimal sandboxes).

  **Runtime auto-wire:** when both `toolAuditSink` and
  `auditChainStore` are present, the runtime constructs
  `new ChainedAuditSink({ inner: toolAuditSink, chainStore, motebitId })`
  and passes the wrap to `PolicyGate`. Inner sink keeps doing what it
  does (persistence, sync queries); chain layer runs in parallel for
  tamper-evidence.

  **ChainedAuditSink refactor — composable wrapper, not extends-
  in-memory:** the prior shape extended `InMemoryAuditSink`,
  duplicating the persistence layer. New shape implements
  `AuditLogSink` directly and delegates `append` / `query` /
  `getAll` / `queryStatsSince` / `queryByRunId` / `enumerateForFlush`
  to the supplied `inner` sink. Cleaner architecturally, surface-
  agnostic — the same primitive composes over `SqliteToolAuditSink`,
  `TauriToolAuditSink`, `ExpoToolAuditSink`, or any future
  implementation.

  **MotebitDatabase exposes `auditChainStore: SqliteAuditChainStore`**
  alongside the existing `toolAuditSink`. CLI threads both into its
  `StorageAdapters`; the runtime auto-wraps. Web + mobile surfaces
  follow the same pattern when they migrate.

- 52ba36c: **Foundation-model agility — DeepSeek lands as the fourth `ByokVendor`.** The closed-set additive registry `ByokVendor = "anthropic" | "openai" | "google"` gains `"deepseek"`. Fourth instance of `agility-as-role` (alongside cryptosuite agility, permissive-floor, settlement-rail custody split); the role is "foundation-model vendor accessible via OpenAI-compatible (or Anthropic's) wire protocol." Same closure pattern as `SuiteId` — additive at the registry, exhaustive-switch enforced at the dispatch, baseline-locked at the api-extractor surface.

  **Why this fourth instance.** Motebit's founding doctrine claim from `CLAUDE.md` — _"A motebit is a droplet of intelligence under surface tension. You own the identity. The intelligence is pluggable."_ — was structurally contradicted by a 3-vendor BYOK registry of exclusively-expensive Big Tech providers (Anthropic, OpenAI, Google). Adding DeepSeek restores the doctrinal claim: the registry stays closed at the wire-vocab boundary (per `protocol/CLAUDE.md` rule 5) but the additive shape demonstrates "pluggable" is real. DeepSeek V3 (`deepseek-chat`) is roughly Claude-Sonnet-class on tool-use benchmarks at ~10× cheaper pricing ($0.27/M input · $1.10/M output vs Claude Sonnet's $3/$15), served via DeepSeek's OpenAI-compatible API at `https://api.deepseek.com`. The affordability path lands NOW for capital-constrained users.

  **What's in the SDK surface:**
  - `ByokVendor` union extended to `"anthropic" | "openai" | "google" | "deepseek"`
  - `DEEPSEEK_MODELS = ["deepseek-chat"] as const` in `models.ts` (single-entry today; expandable when `deepseek-reasoner` / R1 tool-use support is verified)
  - `DEFAULT_DEEPSEEK_MODEL = "deepseek-chat"` for the default-tier convention
  - `DEEPSEEK_CANONICAL_URL = "https://api.deepseek.com"` in `provider-resolver.ts`
  - `defaultModelForVendor("deepseek")` returns `DEFAULT_DEEPSEEK_MODEL`
  - `canonicalVendorBaseUrl("deepseek")` returns `DEEPSEEK_CANONICAL_URL`
  - Resolver's `byok` arm: DeepSeek dispatches as `wireProtocol: "openai"` (same arm as Google — DeepSeek's hosted API exposes the OpenAI chat-completions schema)

  **Important conceptual note for integrators.** DeepSeek is _open-source weights_ served via DeepSeek's hosted API. It belongs in BYOK (cloud inference, API key) not on-device (sovereign local inference). The on-device path stays for smaller open models that fit on consumer hardware (Llama 3.2, Qwen 7B-32B, Phi-4); the BYOK-DeepSeek path is for affordable cloud access to a Sonnet-class open-source model. Two distinct affordability/sovereignty paths, both real, both shipping.

  **Tests.** New "byok deepseek" describe block in `provider-resolver.test.ts` covering: dispatch to `wireProtocol: "openai"` at the canonical URL; default model fallback; CORS-proxy substitution via `env.cloudBaseUrl`. `defaultModelForVendor` + `canonicalVendorBaseUrl` exhaustive-vendor tests extended. Type-invariants config array gets `{ mode: "byok", vendor: "deepseek", apiKey: "k" }`.

  **API surface.** `sdk.api.md` baseline regenerated. Additive — `@public` exports (`ByokVendor`, `DEEPSEEK_CANONICAL_URL`, `DEEPSEEK_MODELS`, `DEFAULT_DEEPSEEK_MODEL`) ship with the union extension. No removals; closed-set additive entry.

  **Doctrine.** `docs/doctrine/agility-as-role.md` updated — fourth named instance ("Foundation-model agility") with full role/instance/migration/defense notes. The doctrine memo now closes the asymmetry it carried before this slice (the "intelligence is pluggable" doctrine claim ↔ "vendors are a closed additive registry" protocol shape now structurally aligned).

  Closed-registry discipline holds. The next vendor add (OpenRouter as meta-vendor, Groq, Together, Fireworks, or any sibling) is a registry append + three dispatch arms + a default model entry + parallel surface UIs. Mechanical template-match against this slice.

- 6347e9a: **Groq lands as the fifth `ByokVendor` — American-hosted open-source counterpart to DeepSeek.** The closed-set additive registry `ByokVendor = "anthropic" | "openai" | "google" | "deepseek"` gains `"groq"`. Same closure pattern + dispatch shape as the prior DeepSeek slice (registry append + three exhaustive-switch arms + a `*_MODELS` constant + parallel surface UIs). Fifth instance of `agility-as-role`; the pattern is now demonstrably mechanical for future open-source-via-API additions.

  **Why Groq specifically as the next vendor.** Two slices ago we added DeepSeek (open-source, Chinese-hosted, cheapest) to close the founding "intelligence is pluggable" doctrine contradiction. Groq is the natural sibling: open-source weights (Meta Llama 3.3 70B + OpenAI's GPT-OSS releases), American-hosted, fastest available inference (~280 tok/sec via Groq's LPU hardware). Cross-geography parity — users uncomfortable with Chinese hosting now have a comparable open-source option without falling back to the three closed-source Big Tech providers. Two distinct optimization targets surfaced via the same selector: DeepSeek for cheapest ($0.27/M input), Groq for fastest American ($0.59/M input). Both ~5–10× cheaper than American closed-source alternatives.

  **What's in the SDK surface:**
  - `ByokVendor` union extended to `"anthropic" | "openai" | "google" | "deepseek" | "groq"`
  - `GROQ_MODELS = ["llama-3.3-70b-versatile", "openai/gpt-oss-120b"] as const` in `models.ts` (Llama 3.3 70B is the default tool-use workhorse; GPT-OSS 120B is OpenAI's open-weights release hosted competitively only via Groq, MoE architecture comparable to GPT-4 class on tool benchmarks)
  - `DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile"`
  - `GROQ_CANONICAL_URL = "https://api.groq.com/openai/v1"` in `provider-resolver.ts` (note the `/openai/v1` namespace — Groq explicitly versions the OpenAI-shape API)
  - `defaultModelForVendor("groq")` returns `DEFAULT_GROQ_MODEL`
  - `canonicalVendorBaseUrl("groq")` returns `GROQ_CANONICAL_URL`
  - Resolver's `byok` arm: Groq dispatches as `wireProtocol: "openai"` (same arm as Google / DeepSeek — Groq's hosted API is OpenAI-compatible with minor caveats around logprobs / logit_bias / certain audio formats which don't affect motebit's tool-use loop)

  **Notable industry context (preserved for doctrine fidelity).** In December 2025 NVIDIA entered a $20B _non-exclusive licensing agreement_ with Groq, paying $20B to license Groq's LPU inference chip architecture and hire founder Jonathan Ross + most of the engineering leadership. Groq remains operationally independent under new CEO Simon Edwards; the API service continues unchanged. The structure is reportedly a "reverse acqui-hire" designed to avoid antitrust filing requirements (licensing deals are exempt from Hart-Scott-Rodino premerger notification). For motebit's vendor-agnostic stance this is _exactly_ the kind of consolidation the `agility-as-role` pattern absorbs cleanly — the role (foundation-model vendor accessible via OpenAI-compatible wire protocol) survives the instance's corporate relationships. Today the Groq API works as a first-class BYOK option; tomorrow, if NVIDIA fully absorbs Groq into their inference stack, the registry pattern can swap or supplement it without touching consumer code. This is the structural value of the agility-as-role discipline.

  **Tests.** New "byok groq" describe block in `provider-resolver.test.ts` covering: dispatch to `wireProtocol: "openai"` at the canonical URL; default model fallback; CORS-proxy substitution via `env.cloudBaseUrl`. `defaultModelForVendor` + `canonicalVendorBaseUrl` exhaustive-vendor tests extended (now 5 vendors). Type-invariants config array gets `{ mode: "byok", vendor: "groq", apiKey: "k" }`. 49/49 SDK tests green.

  **API surface.** `sdk.api.md` baseline regenerated. Additive — `@public` exports (`ByokVendor` union extension, `GROQ_CANONICAL_URL`, `GROQ_MODELS`, `DEFAULT_GROQ_MODEL`) ship with the union extension. No removals.

  **Doctrine.** `docs/doctrine/agility-as-role.md` updated — "four entries" → "five entries," with the cross-geography distinguishing-axis framing (DeepSeek = cheapest Chinese, Groq = fastest American) and the NVIDIA-licensing-agreement context preserved as a doctrinal example of how the role survives instance-level corporate shifts.

  Mechanical template-match against the prior DeepSeek slice. Future open-source-via-API additions (OpenRouter as meta-vendor, Together, Fireworks, Mistral La Plateforme) follow the same shape.

- 3b77bf0: ConversationMessage carries an optional `sensitivity` tier; runtime filters trimmed history at AI-context construction time.

  Closes the read side of the fifth (and final) egress-write boundary in the
  sensitivity-floor arc. Each variant of the `ConversationMessage` discriminated
  union (`user` / `assistant` / `tool`) now carries an optional
  `sensitivity?: SensitivityLevel` field, and the runtime's
  `ConversationManager.trimmed()` filters messages tagged above the current
  effective session tier before the conversation is handed to the AI loop.

  Untagged messages (legacy data persisted before the v1 floor, fixtures
  without a runtime) flow through unchanged for backward compat.

  Closes the cross-device leak shape: a Secret-effective turn on device A
  persists user/assistant messages at Secret (write-side floor, shipped in
  the prior commit); cross-device sync surfaces them to device B whose
  session is at None tier; the pre-call AI gate sees None × None and passes;
  trimmed history would carry the persisted-at-Secret messages into BYOK
  without this filter. The read-side filter closes the bypass — tagged
  messages above the current effective tier are excluded from trimmed
  history regardless of what the gate permits, because trimmed history is
  itself an egress shape.

  ```text
  ConversationManager.trimmed():
    1. compute effective = getEffectiveSensitivity?() ?? None
    2. filter messages: keep msg if msg.sensitivity == null OR
         rankSensitivity(msg.sensitivity) <= rankSensitivity(effective)
    3. trim filtered history into the token budget
  ```

  The filter is dynamic — driven by the runtime's `getEffectiveSessionSensitivity`
  getter at each call — not a static `CONTEXT_SAFE_SENSITIVITY` constant. A
  session whose tier elevates mid-conversation regains access to its own
  elevated messages; a session at None excludes Secret messages even if
  they are load-bearing for the current turn. Same posture the pre-call AI
  gate enforces upstream.

  Doctrine: `motebit-computer.md` §"Mode contract" — fifth boundary of the
  egress-shape arc, now both write and read closed.

- b7f79b2: Drag-drop perception substrate — protocol-layer types for the gesture the slab doctrine has named since landing.

  ```ts
  export type DropPayloadKind = "url" | "text" | "image" | "file" | "artifact";

  export type DropTarget = "slab" | "creature" | "ambient";

  export type DropPayload =
    | {
        kind: "url";
        url: string;
        sourceFrame?: string;
        target?: DropTarget;
        attestation: UserActionAttestation;
      }
    | {
        kind: "text";
        text: string;
        mimeType?: string;
        target?: DropTarget;
        attestation: UserActionAttestation;
      }
    | {
        kind: "image";
        bytes: Uint8Array;
        mimeType: string;
        target?: DropTarget;
        attestation: UserActionAttestation;
      }
    | {
        kind: "file";
        bytes: Uint8Array;
        filename: string;
        mimeType: string;
        target?: DropTarget;
        attestation: UserActionAttestation;
      }
    | {
        kind: "artifact";
        receiptHash: string;
        payloadJson: string;
        target?: DropTarget;
        attestation: UserActionAttestation;
      };

  export interface UserActionAttestation {
    readonly kind: "user-drag";
    readonly timestamp: number;
    readonly surface: "web" | "desktop" | "mobile" | "spatial" | "cli";
    readonly contentHashSha256?: string;
  }

  export function resolveDropTarget(payload: DropPayload): DropTarget;
  ```

  Two-level pattern, same shape as `SuiteId` / `GuestRail` / `ToolMode` (the agility-as-role pattern in `docs/doctrine/agility-as-role.md`). Categorical drop kinds are closed at the protocol layer — adding a kind is a protocol bump (additive, registry append). Per-kind handlers are runtime-extensible via `MotebitRuntime.registerDropHandler(kind, handler)`; v1 default handlers stage slab items for `url`, `text`, `image` in **`shared_gaze` mode** — the user is the driver, motebit is the observer, source is `user-source`, consent fires per-source. (`mind` would be a category error: `mind` is interior cognition, not user-fed external material.) The doctrine's three drop targets (`slab` / `creature` / `ambient`) carry as an optional hint defaulting to `slab`; spatial Phase 1B unlocks the other two without a wire-format change.

  `UserActionAttestation` is **attestation of intentional delivery, not content authenticity.** The user's gesture proves they meant to deliver the payload — it does NOT prove the payload is authentic, unforged, or what it claims to be. A user can drag a forged PDF; the gesture still attests only that delivery was intentional. Authenticity comes from separate provenance — a source URL the runtime fetched, a cryptographic signature on the bytes, an `ExecutionReceipt`, or a content hash a trusted source previously published. Audit prose must keep the two distinct.

  The three `DropTarget` values are **not equivalent drop zones with different visual effects.** They carry meaningfully different persistence and governance: `slab` is turn/session-scoped perception, `creature` is identity-adjacent state mutation requiring explicit confirmation / signed user intent, `ambient` is workspace-scoped reference with source-consent + expiration. v1 surfaces only ever set `slab`; `creature` and `ambient` unlock together with the per-target governance UX in spatial Phase 1B (never separately).

  **Ambient invariant: consultable context, not automatic prompt context.** The motebit can reach for an ambient drop when a turn calls for it (retrieval-shaped), but the drop itself does NOT auto-fill the prompt at the next AI call. Future implementations will be tempted to dump ambient bytes into every turn's context pack; this invariant exists to prevent that failure mode.

  **Dimensionality is not the gate; governance is.** A 2D web surface CAN distinguish the three targets via raycast pick at drop time (creature mesh hit, slab plane hit, no hit ≡ ambient). The actual gate is the per-target governance UX (creature confirmation modal + chosen mutation semantic; ambient consultable-context store + retrieval API). Until those exist, `MotebitRuntime.feedPerception` fails closed on non-slab targets with `DropTargetGovernanceRequiredError` (re-exported from `@motebit/runtime`) — same fail-closed pattern as `SovereignTierRequiredError`. The error names the missing consumer so a future implementer can wire it up by replacing the rejection with the governance-aware handler.

  Drop-out provenance — when a motebit-produced artifact leaves the slab toward another destination — uses `ExecutionReceipt` (already in the protocol). This release covers the in-direction substrate.

  Drift gate `check-drop-handlers` (#77) enforces both arms: every `DropPayloadKind` has a registered handler or an explicit allowlist entry, AND every per-surface drop handler routes through `runtime.feedPerception` (never constructs a prompt and calls `sendMessage` — the prompt-backdoor failure mode named in `motebit-computer.md` §"Failure modes specific to supervised agency").

  Doctrine: `motebit-computer.md` §"Perception input — drop kinds and handlers" + `liquescentia-as-substrate.md` §"Cohesive permeability" (the membrane physics every drop crosses under conditions).

- 28306ef: Vision-1 — pixel governance composes three gates instead of always
  stripping. The previous `projectForAi` rule ("AI never sees pixel
  bytes") was a safe floor mistakenly comment-elevated to doctrine; the
  endgame is provider-mode + sensitivity + consent-aware passthrough.

  Pixels are governed evidence, not automatic external context.

  New exports from `@motebit/sdk`:
  - `PixelConsentState` — `"denied" | "session"`. Per-session consent
    for pixel passthrough to external AI providers. Default `"denied"`
    is fail-closed; the user grants for a session via the `/vision
grant` slash command on web (and the future VisionConsentBand).
    Sovereign (`on-device`) providers bypass this gate entirely — bytes
    never cross a network boundary.
  - `DEFAULT_PIXEL_CONSENT` — `"denied"`. The fail-closed default for
    fresh sessions.
  - `PixelOmittedReason` — `"consent_required" | "sensitivity_blocked" |
"no_capability"`. Carried on the `bytes_omitted` directive when
    pixels are stripped, so the AI's perception doctrine routes to
    the right typed remediation surface (`/vision grant`,
    `/sensitivity none`, switch-providers) rather than parsing human
    text. Future variants are additive — consumers route on the cases
    they care about and ignore the rest.

  Composition (in `@motebit/ai-core`'s `projectForAi`):

  ```text
  sovereign provider                   → bytes pass (private)
  external + sensitivity > none        → strip, reason: sensitivity_blocked
  external + sensitivity = none + !consent → strip, reason: consent_required
  external + sensitivity = none + consent  → bytes pass (governed)
  ```

  Sensitivity composition matches `assertSensitivityPermitsAiCall` for
  outbound text — the same primitive now governs pixels at the same
  boundary. The receipts trail (`ToolInvocationReceipt` per
  `@motebit/mcp-client`) records every visual transfer; no new
  receipt infrastructure.

  Doctrine: `motebit-computer.md` §"Mode contract" composes pixels
  through the same three-axis decision (provider, sensitivity,
  consent) the rest of the runtime uses for outbound governance.
  `surface-determinism.md` (#90) forbids the AI from asking "may I
  see?" via prompt — consent is granted via the typed
  `/vision grant` affordance.

  Open string-literal unions — additive new states (e.g.
  `{ kind: "domain"; domains: string[] }` for per-domain remembered
  consent) land without breaking existing consumers.

- 2490143: Add optional `staleBytesOmissionReason` field to `SessionStateSnapshot` — typed-truth signal for "a prior tool result's `bytes_omitted_reason` is no longer the current gate's verdict."

  Additive (optional field). The runtime computes the staleness by tracking the most recent omission reason emitted by `projectForAi` and comparing against the current gate state at snapshot time. When the gate that fired has since flipped (consent denied → session, sensitivity elevated → none, etc.), the snapshot carries the prior reason so the prompt's PERCEPTION_DOCTRINE clause can teach the AI to re-take rather than re-recommend the affordance for the stale reason.

  Closes the failure mode where the AI tells the user "type /vision grant" after the user has already granted it — witnessed 2026-05-11 on the Google CAPTCHA flow. Same typed-truth-perception shape as `frame_stale` and `not_in_control`.

- 8b1d660: Add optional `task_step_narration?: string` field to `AIResponse` — the wire foundation for the slab chrome's `motebit × virtual_browser` register per [`docs/doctrine/chrome-as-state-render.md`](../docs/doctrine/chrome-as-state-render.md). The field carries a single first-person present-tense sentence ("Reading the page" / "Filling in the form" / "Hit a paywall — need your input") at the supervisor-cares-about granularity. Optional and additive: existing consumers ignore it; absence means the chrome recedes to the empty register.

  The field is typed-truth-validated at runtime (`validateTaskStepNarration` in `@motebit/ai-core`'s `narration-validation.ts`) before the chrome reads it — the third graduation of [`runtime-invariants-over-prompt-rules.md`](../docs/doctrine/runtime-invariants-over-prompt-rules.md), the typed-truth-perception triple applied to in-flight motebit-voiced text. A narration that contradicts wire-level typed truth (claims "Reading apple.com" while the page is on google.com) gets falsified and replaced with a runtime-templated fallback before the chrome renders it. The chrome's narration register's trust contract is: every line shown is wire-true regardless of what the model proposed.

  PR 1 first slice — the wire foundation. Subsequent slices add the chrome's state-driven render against `controlState × embodimentMode`, the `motebit × virtual_browser` register that consumes this field, the `user × virtual_browser` register (cobrowse-as-mode), and the `/wheel` + chip-tap handoff affordance per the doctrine memo's PR 1 scope.

  Backward-compatible (additive optional field). No consumer code changes required to keep working; consumers wanting the new register read the field when present and skip when absent.

- c243dd2: Sensitivity-gate audit event — turns the shipped fail-closed gate from invisible-but-correct into observable-and-provable.

  ```ts
  enum EventType {
    // ...
    SensitivityGateFired = "sensitivity_gate_fired",
  }

  type SensitivityGateEntry =
    | "sendMessage"
    | "sendMessageStreaming"
    | "generateActivation"
    | "generateCompletion"
    | "outbound_tool";

  type SensitivityElevationSource = "session" | "slab_item";

  interface SensitivityGateFiredPayload {
    readonly entry: SensitivityGateEntry;
    readonly session_sensitivity: SensitivityLevel;
    readonly effective_sensitivity: SensitivityLevel;
    readonly provider_mode: "on-device" | "motebit-cloud" | "byok" | "unset";
    readonly elevated_by?: {
      readonly via: SensitivityElevationSource;
      readonly slab_item_id?: string;
    };
    readonly tool_name?: string;
  }
  ```

  Every `assertSensitivityPermitsAiCall` block now emits a structured `SensitivityGateFired` event to the EventStore BEFORE throwing `SovereignTierRequiredError`. The four shipped egress closures (session-elevated state, drops, tool outputs, memory writes) all leave inspectable evidence. Audit consumers query via `events.query({ event_types: [EventType.SensitivityGateFired] })` for the trail of every blocked egress crossing.

  **Strictly metadata.** Payload contains entry name, session/effective tier, provider mode, elevation attribution (with content-free slab item ID for forensic correlation), and tool name when applicable. NEVER raw drop content, tool result bytes, slab item payloads, or prompt strings. Logging the payload that triggered the block would itself be a leak surface — same kind of leak the gate exists to prevent. Field naming choice (`elevated_by.via` rather than `source`) avoids false-positives in `check-mode-contract-readers` (#76) where the destructure-detection regex can't distinguish object-literal write from contract-field read.

  Companion change: `MotebitRuntime.assertSensitivityPermitsAiCall` promoted from `private` to public. The gate predicate is motebit's named primitive for sensitivity-tier-vs-provider routing — the mechanism every commit in the four-egress-shape arc is built around. Surfaces, tests, and audit tooling now have a typed entry point. Internal sites (sendMessage, sendMessageStreaming, generateActivation, generateCompletion, the outbound-tool wrap) call the same method — the public promotion adds no new code path, it just names what was already the architectural seam.

  Doctrine: `motebit-computer.md` §"Mode contract — six declarations per mode." Closes the audit-trail pivot named after the four-egress-shape arc.

- eec271d: Prompt-1 — runtime session-state surfaced to the AI's prompt as a
  `[Now]` block. Closes the runtime-state-confabulation hallucination
  class witnessed across the co-browse arc: the AI claims continuity
  ("the browser is already open on Hacker News") from conversation
  memory after a refresh / runtime restart / dispose — when the
  actual session is closed.

  New exports from `@motebit/sdk`:
  - `BrowserSessionInfo` — surface-supplied cloud-browser state.
    `status: "closed" | "open"`, plus optional `url` and
    `control: ControlState`. Surfaces register a provider via
    `runtime.setBrowserSessionProvider(...)`; absent provider →
    `{ status: "closed" }` default.
  - `SessionStateSnapshot` — the full runtime-side composition: the
    surface's `BrowserSessionInfo` plus the runtime's
    `sensitivity` and `pixelConsent` fields. Built by
    `runtime.getSessionStateSnapshot()` once per AI turn and threaded
    into `ContextPack.sessionState`.
  - `ContextPack.sessionState?: SessionStateSnapshot` — the new
    context-pack field. Loop threads it on every iteration (state
    can shift mid-turn — `/vision grant` flips consent; control
    transitions happen via the band).

  Wire path:

  ```text
  surface (web)              runtime                    ai-core
     │                          │                         │
     ├─ setBrowserSession        │                         │
     │  Provider(() => …)        │                         │
     │                          │                         │
                                getSessionStateSnapshot()
                                composes BrowserSessionInfo
                                + sensitivity + pixelConsent
                                │                         │
                                │   sendMessageStreaming  │
                                │   sessionState: …       │
                                │  ────────────────────►  │
                                │                         │
                                │                  contextPack
                                │                  .sessionState
                                │                         │
                                │                  formatSessionState
                                │                  → "[Now] Browser:
                                │                  open at … · Control:
                                │                  motebit driving · …"
  ```

  Format restraint — only emit lines that have something to say.
  Default state (closed browser, none sensitivity, denied consent)
  collapses to `[Now] Browser: closed`. Elevated tiers and granted
  consent get their own `·`-separated lines.

  The PERCEPTION*DOCTRINE block in `packages/ai-core/src/prompt.ts`
  extends with a rule: *"Runtime state is in the [Now] block — read
  it, don't infer it. Do NOT claim 'the browser is already open' or
  'we're on Hacker News' from conversation memory after a session
  resumption — page refreshes, runtime restarts, and explicit
  dispose calls all close sessions while leaving conversation
  history intact. The [Now] block is the truth this turn."\_

  Block named `[Now]` (not `[Session]`) to avoid collision with the
  existing `[Session]` block, which describes conversation
  continuity (when the user last spoke).

  Open string-literal — additive new fields (e.g. desktop_drive
  embodiment status, future per-domain consent) land without
  breaking existing consumers.

- ef49992: typed-intent-implicit-grant — `UserActionAttestation` widens from a
  fixed `kind: "user-drag"` interface to a discriminated union over
  `"user-drag" | "user-typed-intent"`. The new arm carries a typed
  chat-input submit through perception alongside the existing drag
  gesture; producers stay structurally compatible, consumers gain a
  second case to discriminate on.

  **Why this matters.** The runtime threads
  `options.userActionAttestation` through `sendMessageStreaming` so
  tools that need consent can distinguish a user-driven turn from
  proactive idle work. The first consumer is `request_control` on
  the web cloud-browser surface: when the AI's reach for `computer`
  fails with `not_in_control` inside a turn the user typed and sent,
  the `request_control` flow auto-grants instead of opening the
  slab band's Grant/Deny doorbell. Re-confirming what the user can
  already see they did would violate the calm-software doctrine
  (`CLAUDE.md` § UI). Proactive paths (`generateActivation`,
  idle-tick consolidation) never run through `sendMessageStreaming`,
  so they never get a typed-intent attestation — the prompt band
  fires as before, fail-closed by default.

  **`@motebit/protocol` (minor):**

  ```text
  - export interface UserActionAttestation { kind: "user-drag"; ... }
  + export type UserActionAttestation =
  +   | { kind: "user-drag"; timestamp; surface; contentHashSha256? }
  +   | { kind: "user-typed-intent"; timestamp; surface };
  ```

  Additive new arm; the existing `user-drag` shape is preserved
  field-for-field. Exhaustive consumers that switch on `kind` gain
  one new case to handle.

  **`@motebit/sdk` (minor):** re-exports the widened type through
  `* from "@motebit/protocol"`. Surfaces that construct the
  attestation pass `kind: "user-typed-intent"` from chat-input
  handlers (today: web; sibling stamp on desktop / mobile when
  they grow a virtual_browser surface). The minor cascade is
  the structural one — the SDK's own surface didn't gain new
  exports.

  **Audit shape.** Auto-grant emits both control transitions
  (`request_control` initiated by motebit, `grant` initiated by
  user) synchronously in the same JS task; the band's reactive
  subscribers see `handoff_pending → motebit` back-to-back before
  the browser repaints, so no visible band flicker. The audit log
  reads identically to a band-tap grant; the differentiator
  (typed-intent vs band-tap) lives in the surface's chat history
  alongside the message timestamp.

### Patch Changes

- 2b897ed: **Reorder the `ByokVendor` union — DeepSeek last to surface its geographic outlier-ness.** Changed from `"anthropic" | "openai" | "google" | "deepseek" | "groq"` to `"anthropic" | "openai" | "google" | "groq" | "deepseek"`. The four American-hosted vendors group first; DeepSeek (the sole Chinese-hosted instance) reads last so the geographic asymmetry surfaces as intentional structural ordering rather than oversight.

  Pure reorder — no breaking change. The union's membership is unchanged; switch statements and consumers that already handle all five vendors keep working identically. Test assertion order and sdk.api.md baseline regenerated to match the new declared order. Pairs naturally with the UI calm-down commit that immediately preceded this slice: DeepSeek's "Hosted in China" disclosure is the only descriptive note in the entire BYOK row, and it's now at the end of the row where the geographic-outlier framing reads cleanly.

  Sibling reorders on every surface (web HTML buttons + sections, desktop HTML buttons, mobile IntelligenceTab radio buttons + conditional sections, CLI VALID_PROVIDERS array + default-model fallback chain) land in the same commit per CLAUDE.md's one-pass-delivery principle. Doctrine `docs/doctrine/agility-as-role.md` updated with a one-line framing note explaining the order.

- bd6ed97: Slice 2i — model registry drift fix. Caught during the live smoke
  of the slab arc: the Settings dropdown advertised
  `claude-opus-4-6 — most capable`, a model that doesn't exist
  (current Opus is 4.7).

  **Root cause** — single source of truth was already in
  `packages/sdk/src/models.ts` (`ANTHROPIC_MODELS`), but
  `apps/web/src/ui/settings.ts` had a duplicate literal list with the
  stale entry. Two files, two truths; sdk's was a version behind.

  **Fix:**
  - `ANTHROPIC_MODELS` and `PROXY_MODELS` updated to `claude-opus-4-7`
    (matches the canonical Claude 4.X family — Opus 4.7 / Sonnet 4.6
    / Haiku 4.5).
  - `apps/web/src/ui/settings.ts` no longer redeclares the Anthropic
    list — imports `ANTHROPIC_MODELS` from `@motebit/sdk` and maps to
    UI labels via a local `ANTHROPIC_MODEL_LABELS` lookup. Single
    source of truth for the IDs; surface owns the human-readable
    copy.
  - OpenAI / Google dropdowns intentionally diverge from sdk's
    `OPENAI_MODELS` / `GOOGLE_MODELS` — sdk's lists are the
    proxy-routed gpt-5.4 / gemini-2.5 cost tiers; the BYOK dropdown
    shows older models users may already pay for. Different intent,
    not a shadow. Only Anthropic is unified because only Anthropic
    has aligned intent.
  - `check-preset-imports` (drift gate #40) gains an entry for
    `ANTHROPIC_MODELS` — future surfaces that try to redeclare it
    fail CI before merge. Same lock as `APPROVAL_PRESET_CONFIGS` /
    `COLOR_PRESETS` / etc.

  Doctrine: `packages/sdk/CLAUDE.md` § "Model registry" + Rule 4
  ("Surfaces must not shadow canonical identifiers").

- 7b87916: Sensitivity ladder algebra graduates to the protocol layer.

  `rankSensitivity`, `maxSensitivity`, and `sensitivityPermits` are now
  exported from `@motebit/protocol` (and re-exported through `@motebit/sdk`
  via the existing `export *`). Pure deterministic math over the closed
  `SensitivityLevel` enum — qualifies as a permissive-floor primitive
  per `packages/protocol/CLAUDE.md` rule 1 ("deterministic math").

  ```text
  rankSensitivity(level): number               // None=0 .. Secret=4
  maxSensitivity(a, b):   SensitivityLevel     // join-semilattice composition
  sensitivityPermits(upper, candidate): bool   // candidate <= upper
  ```

  The ladder is interop law. Every motebit implementation must agree on
  which tier dominates which, or the cross-implementation gate isn't
  interoperable: device A persisting a turn at "secret" must mean the
  same thing to device B's session-tier filter. Hosting the math at the
  protocol layer makes the ordering a one-file change at the canonical
  source rather than four duplicated copies that drift independently.

  Graduation history: `rankSensitivity` had three local copies as of
  2026-05-07 (runtime/motebit-runtime.ts, runtime/conversation.ts,
  ai-core/loop.ts) plus a fourth-shaped table (`LEVEL_RANK` +
  `higherLevel` in policy-invariants/computer-sensitivity.ts). The
  ai-core copy's JSDoc explicitly named the trigger: "if a third reader
  appears, the helper graduates." Past trigger.

  Three runtime/ai-core copies are removed and the consumers now import
  from `@motebit/sdk`. policy-invariants's local `LEVEL_RANK` table is
  left in place because it operates on a separate string-literal
  `SensitivityLevel` type for computer-use sensitivity classification —
  cross-package type unification is a separate concern and not load-
  bearing for the gate-composition arc.

  Math properties verified by 13 new protocol-package tests:

  ```text
  rankSensitivity:    strictly monotonic; every adjacent pair differs by 1
  maxSensitivity:     None is identity; idempotent; commutative; associative
  sensitivityPermits: dual of maxSensitivity (max(upper, c) === upper iff
                      sensitivityPermits(upper, c)); reflexive
  ```

  `@motebit/sdk` is patch because it picks up the new exports through
  `export * from "@motebit/protocol"` without changing its own surface
  intentionally.

  Added to `PERMISSIVE_ALLOWED_FUNCTIONS` in `scripts/check-deps.ts`
  with a load-bearing review note tying the entries to the graduation
  trigger and the interop-law justification.

- Updated dependencies [f1ba621]
- Updated dependencies [a5bf96e]
- Updated dependencies [1f5b8aa]
- Updated dependencies [45aff03]
- Updated dependencies [891a11b]
- Updated dependencies [f083b7a]
- Updated dependencies [f4aa40d]
- Updated dependencies [f9fd8f2]
- Updated dependencies [a2daccd]
- Updated dependencies [f174164]
- Updated dependencies [5851a24]
- Updated dependencies [5286de2]
- Updated dependencies [ea6dc4d]
- Updated dependencies [88d8550]
- Updated dependencies [22b6a39]
- Updated dependencies [b7f79b2]
- Updated dependencies [b42cee1]
- Updated dependencies [9c39980]
- Updated dependencies [3f2e370]
- Updated dependencies [e383c63]
- Updated dependencies [eeebf19]
- Updated dependencies [9def0cd]
- Updated dependencies [91299fd]
- Updated dependencies [7ba2761]
- Updated dependencies [c243dd2]
- Updated dependencies [7b87916]
- Updated dependencies [b0f38a8]
- Updated dependencies [f78a82a]
- Updated dependencies [28added]
- Updated dependencies [0c6196c]
- Updated dependencies [ee5f70f]
- Updated dependencies [ef49992]
  - @motebit/protocol@1.3.0

## 1.1.0

### Minor Changes

- 74042b2: Retention policy phase 3 — memory registers under `mutable_pruning`, tombstone→erase, signed deletion certs at the call site.

  `@motebit/sdk`: `MemoryStorageAdapter` gains a required `eraseNode(nodeId)` method. Implementations physically remove the node row and every edge that references it; after `eraseNode(id)` resolves, `getNode(id)` returns `null` and `getEdges(id)` returns `[]`. The existing `tombstoneNode` method stays for soft-delete lifecycle paths (decay-pass / notability-pass) that intentionally do not issue a deletion cert. Required-not-optional addition because phase 3 ties the cert format's "bytes are unrecoverable" claim (decision 7) to the storage operation; admitting an adapter without `eraseNode` would silently weaken every cert it produces.

  `@motebit/crypto`: the `self_enforcement` reason in `verifyDeletionCertificate`'s reason × signer × mode table is admitted in every deployment mode (sovereign / mediated / enterprise). The earlier sovereign-only restriction was over-tight — the subject's own runtime drives policy whether an operator exists or not, and only operator-driven enforcement is `retention_enforcement`. The doctrine table at `docs/doctrine/retention-policy.md` §"Decision 5" matches.

  Both changes are caught by typecheck; downstream package implementations of `MemoryStorageAdapter` (browser-persistence, persistence/SQLite, desktop's tauri-storage, mobile's expo-sqlite, runtime's InMemoryMemoryStorage) all carry the new method.

- 57c0e45: Skills v1 phase 2: wire `SkillSelector` into the runtime context-injection path so installed skills actually inject per-turn (spec/skills-v1.md §7).

  **`@motebit/sdk`** — adds the developer-contract surface for the runtime ↔ skill-runtime adapter boundary:

  ```text
  SkillInjection         { name, version, body, provenance }
  SkillSelectorHook      { selectForTurn(turn) -> Promise<SkillInjection[]> }
  ContextPack            new optional `selectedSkills` field
  ```

  The `SkillSelectorHook` is the abstraction the runtime binds to. Surfaces (CLI / desktop / mobile) provide concrete implementations behind this interface; the runtime stays unaware of the BSL `@motebit/skills` package per the adapter-pattern doctrine.

  **`motebit`** (CLI) — wires `NodeFsSkillStorageAdapter + SkillRegistry + SkillSelector` behind the `SkillSelectorHook` interface. Each turn the runtime calls `selectForTurn(text)`; the hook reads `~/.motebit/skills/` fresh (so `install`/`trust`/`remove` propagate without restart), runs the BM25-ranked selector with `sessionSensitivity: "none"` and `hardwareAttestationScore: 0` defaults appropriate to the CLI today, maps the result to `SkillInjection[]`, and returns top-K. `process.platform` maps to `SkillPlatform` for the OS gate.

  Selected skill bodies inject into the system prompt as labeled blocks per spec §7.3:

  ```text
  [skill: git-commit-motebit-style@1.0.0 — verified]
  <body>
  ```

  Verified skills get `verified` tag; operator-attested unsigned skills get `operator-trusted (unsigned)` tag — the agent sees provenance posture and can factor it into reasoning.

  Fail-closed: a hook that throws is logged via `runtime._logger.warn("skill_selector_failed", ...)` and treated as an empty result. Selector failures never block the AI loop.

  Phase 2 remaining work: `scripts/` quarantine + per-script approval (deferred until a skill bearing scripts/ ships; will use the existing tool-approval gate per the saved project memory). Phase 3: signed `SkillLoadReceipt` in `execution-ledger-v1`.

- 2a48142: Skills v1 phase 3: per-skill audit entries in the execution ledger (spec/skills-v1.md §7.4).

  Every skill the runtime's `SkillSelector` pulls into context now produces one `EventType.SkillLoaded` event-log entry, immediately after the selector returns and before the AI loop receives the system prompt. The audit trail lets a user prove later: _"the obsidian skill ran on date X with this exact signature value at session sensitivity Y."_

  **`@motebit/protocol`** — adds the wire-format type and event:

  ```text
  SkillLoadPayload  { skill_id, skill_name, skill_version, skill_signature,
                      provenance, score, run_id?, session_sensitivity }
  EventType.SkillLoaded
  ```

  **`@motebit/sdk`** — extends `SkillInjection` with two audit-only fields the runtime threads into the ledger entry:

  ```text
  SkillInjection.score      BM25 relevance — surfaces selection rationale
  SkillInjection.signature  Envelope signature.value — content-addressed pointer
                            to the exact bytes loaded; empty for trusted_unsigned
  ```

  The AI loop's prompt builder ignores both fields (rendering stays unchanged). They ride only into the `SkillLoaded` event payload.

  **`motebit`** (CLI) — runtime-factory's hook now passes `score` + `signature` through from the BSL `SkillSelector` result.

  Best-effort emission: a failed `eventStore.append` is logged via `runtime._logger.warn("skill_load_event_append_failed", ...)` and the AI loop proceeds. Audit absence (skill loaded without matching event) is preferable to a turn blocked on a transient storage error.

  Skill_signature audit utility: a stale ledger entry whose signature does not resolve in the current registry is itself a useful signal — the skill was re-signed (legitimate update) or removed (less common). Both provable from the audit trail without retaining the original bytes.

  Wire-schema artifact: `spec/schemas/skill-load-payload-v1.json` ships under Apache-2.0 alongside the existing skills schemas.

  4 new runtime tests cover: emit-with-payload, empty-selector, selector-throw (loop continues), no-hook-wired. 683/683 runtime, all 54 drift gates green.

### Patch Changes

- Updated dependencies [c8c6312]
- Updated dependencies [e1d86f2]
- Updated dependencies [44d25cd]
- Updated dependencies [0233325]
- Updated dependencies [79dd661]
- Updated dependencies [fe0996e]
- Updated dependencies [374a960]
- Updated dependencies [a2ce037]
- Updated dependencies [4d05d70]
- Updated dependencies [98c1273]
- Updated dependencies [2a48142]
- Updated dependencies [cabf61d]
- Updated dependencies [9b4a296]
  - @motebit/protocol@1.2.0

## 1.0.1

### Patch Changes

- 9923185: Rename `DEFAULT_TRUST_THRESHOLDS` → `REFERENCE_TRUST_THRESHOLDS` (additive + deprecation, no behavior change).

  ## Why

  `DEFAULT_TRUST_THRESHOLDS` is exported from `@motebit/protocol` — the permissive-floor layer whose rule (see `packages/protocol/CLAUDE.md` rule 1) is "types, enums, constants, deterministic math." The values (`promoteToVerified_minTasks: 5`, `demote_belowRate: 0.5`, etc.) are constants, so they technically fit, but the **name** claimed more protocol authority than they carry:
  - The semiring algebra above (`trustAdd`, `trustMultiply`, `TRUST_LEVEL_SCORES`, `TRUST_ZERO`, `TRUST_ONE`) IS interop law — two motebit implementations MUST compute trust the same way to exchange scores across federation boundaries.
  - The transition thresholds (when to promote an agent, when to demote) are **motebit product tuning** — a federated implementation can choose stricter or looser values and still interoperate. The scores are compared; the policy that derives them is not.

  The `DEFAULT_` prefix read as "THE value every motebit implementation uses." `REFERENCE_` correctly signals "motebit's reference default; implementers MAY choose their own."

  ## What shipped
  - New export: `REFERENCE_TRUST_THRESHOLDS` from `@motebit/protocol` (identical values, clearer name)
  - Deprecation: `DEFAULT_TRUST_THRESHOLDS` marked `@deprecated since 1.0.1, removed in 2.0.0` with pointer to the new name and the reason above
  - Internal consumers (`@motebit/semiring`, `@motebit/market`, reference tests) migrated to the new name
  - Parity test in `packages/protocol/src/__tests__/trust-algebra.test.ts` asserts `DEFAULT_TRUST_THRESHOLDS === REFERENCE_TRUST_THRESHOLDS` until the 2.0.0 removal, preventing silent divergence during the deprecation window

  ## Impact

  Zero runtime change. Third-party consumers pinned to `@motebit/protocol@1.x` keep working — the old export is re-exported as an alias. Consumers should migrate to `REFERENCE_TRUST_THRESHOLDS` at their convenience before 2.0.0. The `check-deprecation-discipline` gate (drift-defenses #39) tracks the sunset.

- Updated dependencies [a428cf9]
- Updated dependencies [950555c]
- Updated dependencies [9923185]
  - @motebit/protocol@1.1.0

## 1.0.0

### Major Changes

- 009f56e: Add cryptosuite discriminator to every signed wire-format artifact.

  `@motebit/protocol` now exports `SuiteId`, `SuiteEntry`, `SuiteStatus`,
  `SuiteAlgorithm`, `SuiteCanonicalization`, `SuiteSignatureEncoding`,
  `SuitePublicKeyEncoding`, `SUITE_REGISTRY`, `ALL_SUITE_IDS`, `isSuiteId`,
  `getSuiteEntry`. Every signed artifact type gains a required `suite:
SuiteId` field alongside `signature`. Four Ed25519 suites enumerated
  (`motebit-jcs-ed25519-b64-v1`, `motebit-jcs-ed25519-hex-v1`,
  `motebit-jwt-ed25519-v1`, `motebit-concat-ed25519-hex-v1`) plus the
  existing W3C `eddsa-jcs-2022` for Verifiable Credentials.

  Verifiers reject missing or unknown `suite` values fail-closed. No
  legacy compatibility path. Signers emit `suite` on every new artifact.

  Identity file signature format changed:
  - Old: `<!-- motebit:sig:Ed25519:{hex} -->`
  - New: `<!-- motebit:sig:motebit-jcs-ed25519-hex-v1:{hex} -->`

  The `identity.algorithm` frontmatter field is deprecated (ignored with
  a warning when present; no longer emitted on export).

  Post-quantum migration becomes a new `SuiteId` entry + dispatch arm in
  `@motebit/crypto/suite-dispatch.ts`, not a wire-format change.

  ## Migration

  This release is breaking for every consumer that constructs, signs, or verifies a motebit signed artifact. The change is mechanical — add one field on construction, pass one argument on sign, re-sign identity files once — but there is no legacy acceptance path, so every caller must update in lockstep. Verifiers reject unsuited or unknown-suite artifacts fail-closed. Migration steps follow, grouped by the consumer surface.

  ### For consumers of `@motebit/protocol` types

  Every signed-artifact type now has a required `suite: SuiteId` field.
  Anywhere you construct one (tests, mocks, fixtures), add the correct
  suite value for that artifact class — see `SUITE_REGISTRY`'s
  `description` field for the per-artifact assignment, or consult
  `spec/<artifact>-v1.md §N.N` for the binding wire format.

  ```ts
  // Before
  const receipt: ExecutionReceipt = {
    task_id, motebit_id, ...,
    signature: sigHex,
  };

  // After
  import type { SuiteId } from "@motebit/protocol";
  const receipt: ExecutionReceipt = {
    task_id, motebit_id, ...,
    suite: "motebit-jcs-ed25519-b64-v1" satisfies SuiteId,
    signature: sigHex,
  };
  ```

  ### For consumers of `@motebit/crypto` sign/verify helpers

  Sign helpers that previously accepted just keys now require a `suite`
  parameter constrained to the suites valid for the artifact class:

  ```ts
  // Before
  const receipt = await signExecutionReceipt(body, privateKey);

  // After
  const receipt = await signExecutionReceipt(body, privateKey, {
    suite: "motebit-jcs-ed25519-b64-v1",
  });
  ```

  Verify helpers route through the internal `verifyBySuite` dispatcher;
  direct calls are unchanged at the boundary, but behavior now rejects
  artifacts without a `suite` field (legacy-no-suite path is deleted).

  ### For consumers of `motebit.md` identity files

  Identity files signed before this release will fail to parse. Re-sign
  by running `motebit export --regenerate` (or the CLI equivalent) after
  upgrading. The `identity.algorithm` YAML field is ignored on new
  parses and no longer emitted on export.

  ### For consumers of `DelegationToken` (`@motebit/crypto`)

  `DelegationToken` carries two breaking changes beyond the suite addition.
  Public keys are now **hex-encoded** (64 chars, lowercase) instead of
  base64url — consistent with every other Ed25519-key-carrying motebit
  artifact. And `signDelegation` takes `Omit<DelegationToken, "signature"
| "suite">` (the signer stamps the suite).

  ```ts
  // Before
  const token = await signDelegation(
    {
      delegator_id,
      delegator_public_key: toBase64Url(kp.publicKey),
      delegate_id,
      delegate_public_key: toBase64Url(otherKp.publicKey),
      scope,
      issued_at,
      expires_at,
    },
    kp.privateKey,
  );

  // After
  const token = await signDelegation(
    {
      delegator_id,
      delegator_public_key: bytesToHex(kp.publicKey),
      delegate_id,
      delegate_public_key: bytesToHex(otherKp.publicKey),
      scope,
      issued_at,
      expires_at,
    },
    kp.privateKey,
  );
  // token.suite is stamped as "motebit-jcs-ed25519-b64-v1"
  ```

  Verifiers reject tokens without `suite` (or with any value other than
  `"motebit-jcs-ed25519-b64-v1"`) fail-closed, and decode `delegator_public_key`
  from hex. Base64url-encoded tokens issued before this release do not
  verify — pre-launch, no migration tool is provided; re-issue tokens
  after upgrading.

  ### Running the new drift gates locally

  `pnpm run check` now runs ten drift gates (previously eight). Two new
  gates — `check-suite-declared` and `check-suite-dispatch` — enforce
  that every signed Wire-format spec section names a `suite` field and
  that every verifier in `@motebit/crypto` dispatches via the shared
  `verifyBySuite` function (no direct primitive calls).

- 2d8b91a: **Permissive floor flipped from MIT to Apache-2.0. Every contributor's work on the floor now carries an explicit, irrevocable patent grant and a patent-litigation-termination clause.**

  The `@motebit/protocol`, `@motebit/sdk`, `@motebit/crypto`, `@motebit/verifier`, `create-motebit`, the four `@motebit/crypto-*` hardware-attestation platform leaves (Apple App Attest, Google Play Integrity, TPM 2.0, WebAuthn), and the `motebit-verify` GitHub Action — the permissive-floor packages — have moved from MIT to Apache-2.0 in a coordinated release. The `spec/` tree carries Apache-2.0 too; every committed JSON Schema artifact under `spec/schemas/*.json` carries `"$comment": "SPDX-License-Identifier: Apache-2.0"` as its first field.

  ## Why
  1. **Patent clarity across the floor.** The floor now includes four verifiers operating against vendor attestation chains in heavy patent territory — Apple, Google, Microsoft, Infineon, Nuvoton, STMicroelectronics, Intel, Yubico, the FIDO Alliance. The VC/DID space the protocol builds on also carries patent filings. Apache-2.0 §3 grants every contributor's patent license irrevocably; §4.2 terminates the license of anyone who litigates patent claims against the Work. MIT is silent on patents.
  2. **Convergence.** The BSL runtime converts to Apache-2.0 at the Change Date (four years after each version's first public release). With the floor at MIT, the end state was MIT floor + Apache-2.0 runtime — two licenses forever. With the floor at Apache-2.0, the end state is one license: one posture, one patent grant, one procurement decision. Motebit's meta-principle is "never let spec and code diverge"; a built-in two-license end state is exactly the drift the rest of the codebase is designed to prevent.
  3. **Enterprise and standards-track posture.** Identity infrastructure that serious operators bet on ships Apache-2.0: Kubernetes, Kafka, Envoy, Istio, OpenTelemetry, SPIFFE, Keycloak. The IETF and W3C working groups that may eventually carry motebit specs also ship reference implementations under Apache-2.0. The license is part of the signal that motebit is protocol infrastructure, not an npm utility library.

  ## What changed at npm
  - `@motebit/protocol` `license` field: `"MIT"` → `"Apache-2.0"`.
  - `@motebit/sdk` `license` field: `"MIT"` → `"Apache-2.0"`.
  - `@motebit/crypto` `license` field: `"MIT"` → `"Apache-2.0"`.
  - `@motebit/verifier` `license` field: `"MIT"` → `"Apache-2.0"`.
  - `create-motebit` `license` field: `"MIT"` → `"Apache-2.0"`.
  - Each package's `LICENSE` file is replaced with the canonical Apache-2.0 text plus the existing trademark-reservation paragraph.
  - The `@motebit/crypto-appattest`, `@motebit/crypto-play-integrity`, `@motebit/crypto-tpm`, `@motebit/crypto-webauthn` leaves (currently private, bundled into `@motebit/verify`) also flip to Apache-2.0 at the source level.
  - A new `NOTICE` file at the repository root names the project, copyright holder, and trademark reservation per Apache §4.
  - The orphaned root `LICENSE-MIT` file is removed; the protocol badge and doctrine now point at `LICENSING.md` and the per-package `LICENSE` files.
  - `spec/` LICENSE is rewritten to Apache-2.0; the 52 committed JSON Schema artifacts under `spec/schemas/*.json` carry the `Apache-2.0` SPDX stamp.

  ## Migration

  For downstream consumers of the floor packages: **no code change required**. Apache-2.0 is strictly broader than MIT — everything permitted under MIT remains permitted under Apache-2.0. The `license` field in the npm manifest changes value, the installed `LICENSE` text changes shape, and the published `NOTICE` file appears, but nothing about importing or calling these packages changes.

  ```diff
    // Before — consumer's package.json
    "dependencies": {
  -   "@motebit/protocol": "^0.8.0"   // MIT
  +   "@motebit/protocol": "^1.0.0"   // Apache-2.0
    }
  ```

  ```ts
  // Before and after — no code change; same imports, same behavior
  import type { ExecutionReceipt } from "@motebit/protocol";
  import { verify, signExecutionReceipt } from "@motebit/crypto";
  ```

  For downstream contributors: the contributions you submit to the permissive floor now carry an explicit Apache §3 patent grant and are covered by the §4.2 litigation-termination clause. Inbound = outbound: what you grant to the project is what the project grants to users. The signed CLA (`CLA.md`) is updated in the same commit to reflect the new license instance. No re-signing is required for contributors who have already signed; the inbound-equals-outbound principle does the right thing automatically.

  For operators: the root `LICENSE` BSL text is unchanged. The embedded "Apache-2.0-Licensed Components" section lists the ten permissive-floor packages and `spec/`. A new `NOTICE` file at the repo root carries the Apache §4 attribution. The orphan `LICENSE-MIT` file at the repo root is removed.

  ## Backwards compatibility

  Apache-2.0 is broader than MIT — everything permitted under MIT remains permitted under Apache-2.0. Existing consumers of the floor packages do not need to change anything to continue use. The new additions are the patent grant (you, as a contributor, pass one) and the termination clause (you, as a contributor, lose your license if you sue over patents).

  ## Naming

  Identifier-level code (`PERMISSIVE_PACKAGES`, `PERMISSIVE_IMPORT_ALLOWED`, `PERMISSIVE_ALLOWED_FUNCTIONS`, the `check-spec-permissive-boundary` CI gate, the `permissive-client-only-e2e.test.ts` adversarial test) uses the architectural role name — "permissive floor" — not the specific license instance. Same pattern the codebase already uses for cryptosuite agility (one `SuiteId` registry; specific instances like `motebit-jcs-ed25519-b64-v1` are replaceable). Doctrine prose names `Apache-2.0` concretely where instance-level precision matters.

- e17bf47: Publish the four hardware-attestation platform verifier leaves as first-class
  Apache-2.0 packages, joining the fixed-group release at 1.0.0.

  Stop-ship finding from the 1.0 pre-publish audit: `@motebit/verify@1.0.0`
  declared runtime dependencies on four `@motebit/crypto-*` adapters marked
  `"private": true`, which would have caused `npm install @motebit/verify` to
  404 on the adapters. The root `LICENSE`, `README.md`, `LICENSING.md`, and the
  hardware-attestation doctrine all claim these adapters as public Apache-2.0
  permissive-floor packages — the `"private": true` markers were doctrine drift
  left behind from scaffolding.

  This changeset closes the drift by publishing the adapters and wiring them
  into the fixed group so they bump in lockstep with the rest of the protocol
  surface:
  - `@motebit/crypto-appattest` — Apple App Attest chain verifier (pinned
    Apple root)
  - `@motebit/crypto-play-integrity` — Google Play Integrity JWT verifier
    (pinned Google JWKS; structurally complete, fail-closed by default pending
    operator key wiring)
  - `@motebit/crypto-tpm` — TPM 2.0 Endorsement-Key chain verifier (pinned
    vendor roots)
  - `@motebit/crypto-webauthn` — WebAuthn packed-attestation verifier (pinned
    FIDO roots)

  Each carries the standard permissive-floor manifest (description, `exports`,
  `files`, `sideEffects: false`, `NOTICE`, keywords, homepage/repository/bugs,
  `publishConfig: public`, `lint:pack` with `publint` + `attw`, focused README
  showing how to wire the verifier into `@motebit/crypto`'s
  `HardwareAttestationVerifiers` dispatcher).

  Also in this changeset:
  - `engines.node` aligned to `>=20` across `@motebit/protocol`, `@motebit/sdk`,
    and `@motebit/crypto` — matches the rest of the fixed group and removes
    downstream consumer confusion (a `@motebit/verify` consumer on Node 18
    previously got inconsistent engines-check signals between libraries).
  - `NOTICE` added to `motebit` (the bundled CLI's tarball, required by Apache
    §4(d) because the bundle inlines Apache-licensed code from the permissive
    floor).

  No code changes — all four adapter implementations and public APIs are
  unchanged. The flip is manifest + metadata + README + fixed-group wiring.

  ## Migration

  **For `@motebit/verify` consumers:** no action required. `npm install -g @motebit/verify@1.0.0` now correctly pulls the four platform adapter packages from npm instead of failing on unpublished `workspace:*` refs. Before this changeset, `npm install @motebit/verify@1.0.0` would have 404'd on `@motebit/crypto-appattest@1.0.0` et al.

  **For direct library consumers (new capability):** the four platform adapters can now be imported independently when a third party wants only one platform's verifier without pulling the full CLI. Wiring into `@motebit/crypto`'s dispatcher:

  ```ts
  // Before (1.0.0-rc and earlier — adapters not installable from npm):
  // only possible via @motebit/verify's bundled verifyFile():
  import { verifyFile } from "@motebit/verifier";
  import { buildHardwareVerifiers } from "@motebit/verify";
  const result = await verifyFile("cred.json", {
    hardwareAttestation: buildHardwareVerifiers(),
  });

  // After (1.0.0 — fine-grained composition):
  import { verify } from "@motebit/crypto";
  import { deviceCheckVerifier } from "@motebit/crypto-appattest";
  import { webauthnVerifier } from "@motebit/crypto-webauthn";

  const result = await verify(credential, {
    hardwareAttestation: {
      deviceCheck: deviceCheckVerifier({ expectedBundleId: "com.example.app" }),
      webauthn: webauthnVerifier({ expectedRpId: "example.com" }),
      // tpm / playIntegrity omitted — verifier returns `adapter-not-configured` for those platforms
    },
  });
  ```

  **For Node 18 consumers of `@motebit/protocol`, `@motebit/sdk`, or `@motebit/crypto`:** the `engines.node` field now declares `>=20` across the entire fixed group (previously drifted: protocol/sdk/crypto said `>=18`, other packages said `>=20`). npm does not hard-enforce `engines` by default, so installs continue to succeed — but teams running strict-engine linters should upgrade to Node 20 LTS. Node 18 entered maintenance-only status April 2025.

  **For third-party protocol implementers:** no wire-format changes. The four platform attestation wire formats (`AppAttestCbor`, Play Integrity JWT, `TPMS_ATTEST`, WebAuthn packed attestation) are unchanged — this changeset only publishes the reference TypeScript verifiers for each.

- 58c6d99: **@motebit/verify resurrected as the canonical CLI, three-package lineage locked in.**

  The entire published protocol surface bumps to 1.0.0 in a coordinated release. What changes at npm:
  - **`@motebit/verify@1.0.0`** — fresh lineage superseding the deprecated `0.7.0` zero-dep library. Ships the `motebit-verify` CLI binary with every hardware-attestation platform bundled (Apple App Attest, Google Play Integrity, TPM 2.0, WebAuthn) and motebit-canonical defaults pre-wired (bundle IDs, RP ID, integrity floor). Network-free, self-attesting. License: Apache-2.0 — the aggregator encodes no motebit-proprietary judgment (defaults are overridable flags, not trust scoring or economics), so it sits on the permissive floor alongside the underlying leaves. Runs `npm install -g @motebit/verify` to get the tool, no license friction in CI pipelines or enterprise audit tooling.
  - **`@motebit/verifier@1.0.0`** — library-only. The `motebit-verify` CLI that used to live here has moved to `@motebit/verify` (above). This package now ships only the Apache-2.0 helpers (`verifyFile`, `verifyArtifact`, `formatHuman`, `VerifyFileOptions` with the optional `hardwareAttestation` injection point). Third parties writing Apache-2.0-only TypeScript verifiers compose this with `@motebit/crypto` — and optionally any subset of the four Apache-2.0 `@motebit/crypto-*` platform leaves — without pulling BSL code.
  - **`@motebit/crypto@1.0.0`** — role unchanged; version bump marks 1.0 maturity of the primitive substrate. Apache-2.0 (upgraded from MIT in the same release; the floor flip gives every contributor's work an explicit patent grant and litigation-termination clause), zero monorepo deps.
  - **`@motebit/protocol@1.0.0`** — wire types + algebra. Apache-2.0 permissive floor. 1.0 signals the protocol surface is stable enough to implement against.
  - **`@motebit/sdk@1.0.0`** — stable developer-contract surface. 1.0 locks the provider-resolver / preset / config vocabulary for integrators.
  - **`create-motebit@1.0.0`** — scaffolder bumps to match.
  - **`motebit@1.0.0`** — operator console CLI bumps to match.

  The three-package lineage for verification tooling follows the pattern that survives decades — git / libgit2, cargo / tokio, npm / @npm/arborist:

  ```
  @motebit/verify                Apache-2.0  the CLI motebit-verify + motebit-canonical defaults over the bundled leaves
  @motebit/verifier              Apache-2.0  library: verifyFile, verifyArtifact, formatHuman
  @motebit/crypto                Apache-2.0  primitives: verify, sign, suite dispatch
  @motebit/crypto-appattest      Apache-2.0  Apple App Attest chain verifier (pinned Apple root)
  @motebit/crypto-play-integrity Apache-2.0  Google Play Integrity JWT verifier (pinned Google JWKS)
  @motebit/crypto-tpm            Apache-2.0  TPM 2.0 EK chain verifier (pinned vendor roots)
  @motebit/crypto-webauthn       Apache-2.0  WebAuthn packed-attestation verifier (pinned FIDO roots)
  ```

  All seven packages in the verification lineage ship Apache-2.0 — the full verification surface lives on the permissive floor. Each answers "how is this artifact verified?" against a published public trust anchor, the permissive side of the protocol-model boundary test. The BSL line holds at `motebit` (the operator console) and everything below it, where the actual reference-implementation judgment lives (daemon, MCP server, delegation routing, market integration, federation wiring). See the separate `permissive-floor-apache-2-0` and `verify-cli-apache-2-0` changesets for the rationale behind the floor licensing.

  ## Migration

  The 1.0 release is a coordinated major bump across the fixed release group. The APIs exported by `@motebit/protocol`, `@motebit/sdk`, `@motebit/crypto`, `create-motebit`, and `motebit` have NOT broken — this major marks endgame-pattern maturity, not a code-shape change. The actual behavioral shifts are confined to the verification-tooling lineage:

  **1. `@motebit/verifier` bin removed (breaking).**

  ```ts
  // Before — @motebit/verifier@0.8.x shipped a `motebit-verify` binary.
  // After  — @motebit/verifier@1.0.0 is library-only.
  // Install `@motebit/verify@^1.0.0` for the CLI:
  //   npm install -g @motebit/verify
  //   motebit-verify cred.json
  // The programmatic library surface is unchanged:
  import { verifyFile, formatHuman } from "@motebit/verifier"; // ← still works
  ```

  **2. `@motebit/verify@0.7.0` (deprecated library) → `@motebit/verify@1.0.0` (resurrected CLI).**

  | You were using (0.7.0)                               | Migrate to                                                                          |
  | ---------------------------------------------------- | ----------------------------------------------------------------------------------- |
  | `verify()` function in TypeScript                    | `import { verify } from "@motebit/crypto"` — same shape, more features              |
  | `verifyFile` / `formatHuman` / programmatic wrappers | `import { verifyFile } from "@motebit/verifier"`                                    |
  | Running `motebit-verify` on the command line         | `npm install -g @motebit/verify` at `^1.0.0` — same command, full platform coverage |

  Users pinned to `"@motebit/verify": "^0.7.0"` stay on the deprecated 0.x line automatically — semver prevents auto-bumps to 1.0.0. The 0.x tarballs remain immutable on npm; archaeology is preserved.

  ## Rationale

  The entire published protocol surface hits 1.0 together as the endgame-pattern milestone. The three-package lineage for verification tooling (verify / verifier / crypto) follows the shape long-lived tool families use — git / libgit2, cargo / tokio, npm / @npm/arborist. The coordinated major signals that this is the architecture intended to hold long-term.

  **Operator follow-up — run immediately after `pnpm changeset publish` returns:**

  ```bash
  npm deprecate @motebit/verify@0.7.0 \
    "Superseded by @motebit/verify@1.x — the canonical CLI. For the library, see @motebit/crypto."
  ```

  The current deprecation message on `0.7.0` dates from the 2026-04-09 package rename and still claims "Same MIT license" — factually correct then, stale the moment 1.0.0 ships (the permissive floor is now Apache-2.0). The replacement message points at both migration paths — the CLI (`@motebit/verify@1.x`) and the library (`@motebit/crypto`) — and makes no license claim that can age. Running it immediately after publish keeps the stale-message window down to minutes, not days.

### Patch Changes

- 699ba41: Rewrite three fixed-group `@deprecated` annotations to the four-field
  contract from `docs/doctrine/deprecation-lifecycle.md`:
  `OLLAMA_SUGGESTED_MODELS` and `OllamaSuggestedModel` in `@motebit/sdk`,
  and `cli_private_key` on `motebit`'s `FullConfig` shape. Each marker
  now carries `since`, `removed in`, a replacement pointer, and a reason
  — downstream consumers see a consistent deprecation format across the
  entire fixed-group publish surface, and the planned
  `check-deprecation-discipline` drift gate has a clean starting line
  when it lands post-1.0.

  No behavior change — JSDoc-only edits.

- 1e07df5: Ship `@motebit/verifier` — offline third-party verifier for every signed Motebit artifact (identity files, execution receipts, W3C verifiable credentials, presentations). Exposes `verifyFile` / `verifyArtifact` / `formatHuman` as a library and the `motebit-verify` CLI with POSIX exit codes (0 valid · 1 invalid · 2 usage/IO). Zero network, zero deps beyond `@motebit/crypto`. Joins the fixed public-surface version group.
- Updated dependencies [ceb00b2]
- Updated dependencies [8cef783]
- Updated dependencies [e897ab0]
- Updated dependencies [c64a2fb]
- Updated dependencies [bd3f7a4]
- Updated dependencies [54158b1]
- Updated dependencies [009f56e]
- Updated dependencies [620394e]
- Updated dependencies [4eb2ebc]
- Updated dependencies [85579ac]
- Updated dependencies [2d8b91a]
- Updated dependencies [e17bf47]
- Updated dependencies [58c6d99]
- Updated dependencies [54e5ca9]
- Updated dependencies [3747b7a]
- Updated dependencies [db5af58]
- Updated dependencies [1e07df5]
  - @motebit/protocol@1.0.0

## 0.8.0

### Minor Changes

- b231e9c: MIT/BSL protocol boundary, credential anchoring, unified Solana anchoring
  - **@motebit/crypto** — new package (replaces @motebit/verify). First npm publish. Sign and verify all artifacts with zero runtime deps. New: `computeCredentialLeaf`, `verifyCredentialAnchor` (4-step self-verification).
  - **@motebit/protocol** — new types: `CredentialAnchorBatch`, `CredentialAnchorProof`, `ChainAnchorSubmitter`, `CredentialChainAnchor`. Semiring algebra moved to MIT.
  - **@motebit/sdk** — re-exports new protocol types.
  - **create-motebit** — no API changes.
  - **motebit** — sovereign delegation (`--sovereign` flag), credential anchoring admin panel, unified Solana anchoring for settlement + credential streams.

  New specs: settlement@1.0, auth-token@1.0, credential-anchor@1.0, delegation@1.0 (4 new, 9 total).

### Patch Changes

- Updated dependencies [b231e9c]
  - @motebit/protocol@0.8.0

## 0.7.0

### Minor Changes

- 9b6a317: Move trust algebra from MIT sdk to BSL semiring — enforce IP boundary.

  **Breaking:** The following exports have been removed from `@motebit/sdk`:
  - `trustLevelToScore`, `trustAdd`, `trustMultiply`, `composeTrustChain`, `joinParallelRoutes`
  - `evaluateTrustTransition`, `composeDelegationTrust`
  - `TRUST_LEVEL_SCORES`, `DEFAULT_TRUST_THRESHOLDS`, `TRUST_ZERO`, `TRUST_ONE`

  These are trust algebra algorithms that belong in the BSL-licensed runtime, not the MIT-licensed type vocabulary. Type definitions (`TrustTransitionThresholds`, `DelegationReceiptLike`, `AgentTrustLevel`, `AgentTrustRecord`) remain in the SDK unchanged.

  Also adds CI enforcement (checks 9-10 in check-deps) preventing algorithm code from leaking into MIT packages in the future.

### Patch Changes

- Typed relay errors, storage parity, deletion policy, dead code cleanup.
  - Wire `SettlementError` and `FederationError` into relay paths (previously generic `Error`)
  - Pluggable logger in sync-engine encrypted adapter (replaces `console.warn`)
  - Scope knip to external deps (`@motebit/*` excluded from dead-code analysis)
  - Remove dead `@noble/ciphers` (Web Crypto API replaced it)
  - Remove dead code: `termWidth`, web error banner cluster (JS + CSS + HTML)
  - Encode deletion policy as architectural invariant in CLAUDE.md
  - Full storage parity: all surfaces wire complete `StorageAdapters` interface
  - Mark `verifyIdentityFile()` as deprecated in verify README
  - Override `@xmldom/xmldom` to >=0.8.12 (GHSA-wh4c-j3r5-mjhp)

- Updated dependencies [9b6a317]
  - @motebit/protocol@0.7.0

## 0.6.11

### Patch Changes

- [`4f40061`](https://github.com/motebit/motebit/commit/4f40061bdd13598e3bf8d95835106e606cd8bb17) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`0cf07ea`](https://github.com/motebit/motebit/commit/0cf07ea7fec3543b041edd2e793abee75180f9e9) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`49d8037`](https://github.com/motebit/motebit/commit/49d8037a5ed45634c040a74206f57117fdb69842) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.6.10

### Patch Changes

- [`d64c5ce`](https://github.com/motebit/motebit/commit/d64c5ce0ae51a8a78578f49cfce854f9b5156470) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`ae0b006`](https://github.com/motebit/motebit/commit/ae0b006bf8a0ec699de722efb471d8a9003edd61) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`94f716d`](https://github.com/motebit/motebit/commit/94f716db4b7b25fed93bb989a2235a1d5efa1421) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`fc765f6`](https://github.com/motebit/motebit/commit/fc765f68f104abafe17754d0e82290e03cae1440) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`d1607ac`](https://github.com/motebit/motebit/commit/d1607ac9da58da7644bd769a95253bd474bcfe3f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`6907bba`](https://github.com/motebit/motebit/commit/6907bba938c4eaa340b7d3fae7eb0b36a8694c6f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`067bc39`](https://github.com/motebit/motebit/commit/067bc39401ae91a183fe184c5674a0a563bc59c0) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`3ce137d`](https://github.com/motebit/motebit/commit/3ce137da4efbac69262a1a61a79486989342672f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`d2f39be`](https://github.com/motebit/motebit/commit/d2f39be1a5e5b8b93418e043fb9b9e3aecc63c05) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`2273ac5`](https://github.com/motebit/motebit/commit/2273ac5581e62d696676eeeb36aee7ca70739df7) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`e3d5022`](https://github.com/motebit/motebit/commit/e3d5022d3a2f34cd90a7c9d0a12197a101f02052) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`dc8ccfc`](https://github.com/motebit/motebit/commit/dc8ccfcb51577498cbbaaa4cf927d7e1a10add26) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`587cbb8`](https://github.com/motebit/motebit/commit/587cbb80ea84581392f2b65b79588ac48fa8ff72) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`21aeecc`](https://github.com/motebit/motebit/commit/21aeecc30a70a8358ebb7ff416a9822baf1fbb17) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`ac2db0b`](https://github.com/motebit/motebit/commit/ac2db0b18fd83c3261e2a976e962b432b1d0d4a9) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`b63c6b8`](https://github.com/motebit/motebit/commit/b63c6b8efcf261e56f84754312d51c8c917cf647) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`fc765f6`](https://github.com/motebit/motebit/commit/fc765f68f104abafe17754d0e82290e03cae1440) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.6.9

### Patch Changes

- [`0563a0b`](https://github.com/motebit/motebit/commit/0563a0bb505583df75766fcbfc2c9a49295f309e) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.6.8

### Patch Changes

- [`6df1778`](https://github.com/motebit/motebit/commit/6df1778caec68bc47aeeaa00cae9ee98631896f9) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`c8928d6`](https://github.com/motebit/motebit/commit/c8928d6e700918fa3ea2bce8714a72eb5d4bfc80) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`c8928d6`](https://github.com/motebit/motebit/commit/c8928d6e700918fa3ea2bce8714a72eb5d4bfc80) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`c8928d6`](https://github.com/motebit/motebit/commit/c8928d6e700918fa3ea2bce8714a72eb5d4bfc80) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`4ae74fe`](https://github.com/motebit/motebit/commit/4ae74fefb4c2f249deafe044052d53c8679c2bf4) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`4ae74fe`](https://github.com/motebit/motebit/commit/4ae74fefb4c2f249deafe044052d53c8679c2bf4) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`c8928d6`](https://github.com/motebit/motebit/commit/c8928d6e700918fa3ea2bce8714a72eb5d4bfc80) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.6.7

### Patch Changes

- [`62cda1c`](https://github.com/motebit/motebit/commit/62cda1cca70562f2f54de6649eae070548a97389) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.6.6

### Patch Changes

- [`349939f`](https://github.com/motebit/motebit/commit/349939f7533ac2a73ef99cf4cc2413cd78849ce7) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`349939f`](https://github.com/motebit/motebit/commit/349939f7533ac2a73ef99cf4cc2413cd78849ce7) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.6.5

### Patch Changes

- [`e3173f0`](https://github.com/motebit/motebit/commit/e3173f0de119d4c0dd3fbe91de185f075ad0df99) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.6.4

### Patch Changes

- [`a58cc9a`](https://github.com/motebit/motebit/commit/a58cc9a6e79fc874151cb7044b4846acd855fbb2) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.6.3

### Patch Changes

- [`15a81c5`](https://github.com/motebit/motebit/commit/15a81c5d4598cacd551b3024db49efb67455de94) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`8899fcd`](https://github.com/motebit/motebit/commit/8899fcd55def04c9f2b6e34a182ed1aa8c59bf71) Thanks [@hakimlabs](https://github.com/hakimlabs)! - Wrong passphrase: calm reset guide instead of jargon error

## 0.6.2

### Patch Changes

- [`f246433`](https://github.com/motebit/motebit/commit/f2464332f3ec068aeb539202bd32f081b23c35b0) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`4a152f0`](https://github.com/motebit/motebit/commit/4a152f029f98145778a2e84b46b379fa811874cb) Thanks [@hakimlabs](https://github.com/hakimlabs)! - First-launch passphrase: explain identity before prompting

## 0.6.1

### Patch Changes

- [`1bdd3ae`](https://github.com/motebit/motebit/commit/1bdd3ae35d2d7464dce1677d07af39f5b0026ba1) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`2c5a6a9`](https://github.com/motebit/motebit/commit/2c5a6a98754a625db8c13bc0b5a686e5198de34d) Thanks [@hakimlabs](https://github.com/hakimlabs)! - First-run UX: calm setup guide instead of raw API key error

## 0.6.0

### Minor Changes

- [`ca36ef3`](https://github.com/motebit/motebit/commit/ca36ef3d686746263ac0216c7f6e72a63248cc12) Thanks [@hakimlabs](https://github.com/hakimlabs)! - v0.6.0: zero-dep verify, memory calibration, CLI republish
  - @motebit/sdk: Core types for the motebit protocol — state vectors, identity, memory, policy, tools, agent delegation, trust algebra, execution ledger, credentials. Zero deps, MIT
  - @motebit/crypto: Verify any motebit artifact — identity files, execution receipts, verifiable credentials, presentations. One function, zero runtime deps (noble bundled), MIT
  - create-motebit: Scaffold signed identity and runnable agent projects. Key rotation with signed succession. --agent mode for MCP-served agents. Zero runtime deps, MIT
  - motebit: Operator console — REPL, daemon, MCP server mode, delegation, identity export/verify/rotate, credential management, budget/settlement. BSL-1.1 (converts to Apache-2.0)
  - Memory system: calibrated tagging prompt, consolidation dedup (REINFORCE no longer creates nodes), self-referential filter, valid_until display filtering across all surfaces
  - Empty-response guard: re-prompt when tag stripping yields no visible text after tool calls
  - Governor fix: candidate modifications (confidence cap, sensitivity reclassification) now respected in turn loop

## 0.5.3

### Patch Changes

- [`268033b`](https://github.com/motebit/motebit/commit/268033b7c7163949ab2510a7d599f60b5279009b) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`8efad8d`](https://github.com/motebit/motebit/commit/8efad8d77a5c537df3866771e28a9123930cf3f8) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`61eca71`](https://github.com/motebit/motebit/commit/61eca719ab4c6478be62fb9d050bdb8a56c8fc88) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`cb26e1d`](https://github.com/motebit/motebit/commit/cb26e1d5848d69e920b59d903c8ccdd459434a6f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`758efc2`](https://github.com/motebit/motebit/commit/758efc2f29f975aedef04fa8b690e3f198d093e3) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`95c69f1`](https://github.com/motebit/motebit/commit/95c69f1ecd3a024bb9eaa321bd216a681a52d69c) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`c3e76c9`](https://github.com/motebit/motebit/commit/c3e76c9d375fc7f8dc541d514c4d5c8812ee63ff) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`518eaf1`](https://github.com/motebit/motebit/commit/518eaf1f30beab0bd0cad741dfb0d4fb186f5027) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`8eecda1`](https://github.com/motebit/motebit/commit/8eecda1fa7dc087ecaef5f9fdccd8810b77d5170) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`03b3616`](https://github.com/motebit/motebit/commit/03b3616cda615a2239bf8d18d755e0dab6a66a1a) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`ed84cc3`](https://github.com/motebit/motebit/commit/ed84cc332a24b592129160ab7d95e490f26a237f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`518eaf1`](https://github.com/motebit/motebit/commit/518eaf1f30beab0bd0cad741dfb0d4fb186f5027) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`ba2140f`](https://github.com/motebit/motebit/commit/ba2140f5f8b8ce760c5b526537b52165c08fcd64) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`e8643b0`](https://github.com/motebit/motebit/commit/e8643b00eda79cbb373819f40f29008346b190c8) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`6fa9d8f`](https://github.com/motebit/motebit/commit/6fa9d8f87a4d356ecb280c513ab30648fe02af50) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`10226f8`](https://github.com/motebit/motebit/commit/10226f809c17d45bd8a785a0a62021a44a287671) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`0624e99`](https://github.com/motebit/motebit/commit/0624e99490e313f33bd532eadecbab7edbd5f2cf) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`c4646b5`](https://github.com/motebit/motebit/commit/c4646b5dd382465bba72251e1a2c2e219ab6d7b4) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`0605dfa`](https://github.com/motebit/motebit/commit/0605dfae8e1644b84227d386863ecf5afdb18b87) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`c832ce2`](https://github.com/motebit/motebit/commit/c832ce2155959ef06658c90fd9d7dc97257833fa) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`813ff2e`](https://github.com/motebit/motebit/commit/813ff2e45a0d91193b104c0dac494bf814e68f6e) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`35d92d0`](https://github.com/motebit/motebit/commit/35d92d04cb6b7647ff679ac6acb8be283d21a546) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`b8f7871`](https://github.com/motebit/motebit/commit/b8f78711734776154fa723cbb4a651bcb2b7018d) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`916c335`](https://github.com/motebit/motebit/commit/916c3354f82caf55e2757e4519e38a872bc8e72a) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`401e814`](https://github.com/motebit/motebit/commit/401e8141152eafa67fc8877d8268b02ba41b8462) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`70986c8`](https://github.com/motebit/motebit/commit/70986c81896c337d99d3da8b22dff3eb3df0a52c) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`8632e1d`](https://github.com/motebit/motebit/commit/8632e1d74fdb261704026c4763e06cec54a17dba) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`5427d52`](https://github.com/motebit/motebit/commit/5427d523d7a8232b26e341d0a600ab97b190b6cf) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`78dfb4f`](https://github.com/motebit/motebit/commit/78dfb4f7cfed6c487cb8113cee33c97a3d5d608c) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`dda8a9c`](https://github.com/motebit/motebit/commit/dda8a9cb605a1ceb25d81869825f73077c48710c) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`dd2f93b`](https://github.com/motebit/motebit/commit/dd2f93bcacd99439e2c6d7fb149c7bfdf6dcb28b) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.5.2

### Patch Changes

- [`daa55b6`](https://github.com/motebit/motebit/commit/daa55b623082912eb2a7559911bccb9a9de7052f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`1d06551`](https://github.com/motebit/motebit/commit/1d06551bff646336aa369b3c126bbd40aa13b806) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`1d06551`](https://github.com/motebit/motebit/commit/1d06551bff646336aa369b3c126bbd40aa13b806) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`fd9c3bd`](https://github.com/motebit/motebit/commit/fd9c3bd496c67394558e608c89af2b43df005fdc) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`5d285a3`](https://github.com/motebit/motebit/commit/5d285a32108f97b7ce69ef70ea05b4a53d324c64) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`54f846d`](https://github.com/motebit/motebit/commit/54f846d066c416db4640835f8f70a4eedaca08e0) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`2b9512c`](https://github.com/motebit/motebit/commit/2b9512c8ba65bde88311ee99ea6af8febed83fe8) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`2ecd003`](https://github.com/motebit/motebit/commit/2ecd003cdb451b1c47ead39e945898534909e8b1) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`fd24d60`](https://github.com/motebit/motebit/commit/fd24d602cbbaf668b65ab7e1c2bcef5da66ed5de) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`7cc64a9`](https://github.com/motebit/motebit/commit/7cc64a90bccbb3ddb8ba742cb0c509c304187879) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`5653383`](https://github.com/motebit/motebit/commit/565338387f321717630f154771d81c3fc608880c) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`753e7f2`](https://github.com/motebit/motebit/commit/753e7f2908965205432330c7f17a93683644d719) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`10a4764`](https://github.com/motebit/motebit/commit/10a4764cd35b74bf828c31d07ece62830bc047b2) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.5.1

### Patch Changes

- [`9cd8d46`](https://github.com/motebit/motebit/commit/9cd8d4659f8e9b45bf8182f5147e37ccda304606) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`d7ca110`](https://github.com/motebit/motebit/commit/d7ca11015e1194c58f7a30d653b2e6a9df93149e) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`48d2165`](https://github.com/motebit/motebit/commit/48d21653416498f2ff83ea7ba570cc9254a4d29b) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`f275b4c`](https://github.com/motebit/motebit/commit/f275b4cccfa4c72e58baf595a8abc231882a13fc) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`8707f90`](https://github.com/motebit/motebit/commit/8707f9019d5bbcaa7ee7013afc3ce8061556245f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`a20eddd`](https://github.com/motebit/motebit/commit/a20eddd579b47dda7a0f75903dfd966083edb1ea) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`8eef02c`](https://github.com/motebit/motebit/commit/8eef02c777ae6e00ca58f0d0bf92011463d4d3e7) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`a742b1e`](https://github.com/motebit/motebit/commit/a742b1e762a97e520633083d669df2affa132ddf) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`04b9038`](https://github.com/motebit/motebit/commit/04b9038d23dcadec083ae970d4c05b2f3ce27c3f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`bfafe4d`](https://github.com/motebit/motebit/commit/bfafe4d72a5854db551888a4264058255078eab1) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`527c672`](https://github.com/motebit/motebit/commit/527c672e43b6f389259413f440fb3510fa9e1de0) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

All notable changes to `@motebit/sdk` are documented here. For full project history, see the [root changelog](../../CHANGELOG.md).

## [0.3.0] - 2026-03-13

### Added

- Branded ID types: `AllocationId`, `SettlementId`, `ListingId`, `ProposalId` (join existing `MotebitId`, `DeviceId`, `NodeId`, `GoalId`, `EventId`, `ConversationId`, `PlanId`)
- `PrecisionWeights` interface for active inference precision feedback
- `exploration_weight` field on `MarketConfig`
- `CollaborativePlanProposal`, `ProposalParticipant`, `ProposalStepCounter`, `ProposalResponse`, `CollaborativeReceipt` interfaces
- `ProposalStatus` and `ProposalResponseType` enums
- `assigned_motebit_id` on `PlanStep` and `SyncPlanStep`
- `proposal_id` and `collaborative` on `Plan` and `SyncPlan`
- 5 new `EventType` values: `ProposalCreated`, `ProposalAccepted`, `ProposalRejected`, `ProposalCountered`, `CollaborativeStepCompleted`
- `AgentServiceListing` and `AgentTrustRecord` interfaces for capability market
- `MemoryContent` type separated from `MemoryNode` for safe wire serialization
- `did` field on `VerifyResult` and `AgentCapabilities`
- `ReputationSnapshot` type for Beta-binomial smoothed reputation
- `CandidateProfile` and `TaskRequirements` types for market scoring
- Trust semiring algebra: `trustAdd`, `trustMultiply`, `composeTrustChain`, `joinParallelRoutes`, `composeDelegationTrust`
- Canonical `TRUST_LEVEL_SCORES` mapping (single source of truth)
- W3C Verifiable Credentials types: `VerifiableCredential`, `VerifiablePresentation`, `CredentialProof`
- `ExecutionTimelineEntry` and `GoalExecutionManifest` types for execution ledger
- Budget allocation types: `BudgetAllocation`, `Settlement`
- `precisionContext` field on `ContextPack`

## [0.1.0] - 2026-03-08

### Added

- Core protocol types: `MotebitState`, `BehaviorCues`, `MemoryNode`, `EventLogEntry`, `PolicyDecision`, `RenderSpec`
- Identity types: `MotebitId`, `DeviceId`, `NodeId`, `GoalId`, `EventId`, `ConversationId`, `PlanId`
- Agent delegation types: `ExecutionReceipt`, `DelegationToken`, `AgentTrustLevel`
- Tool, policy, and sync interfaces
- MIT licensed, zero dependencies
