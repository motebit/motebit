/**
 * On-device auto-router — the third consumer of `dispatchRouting`.
 *
 * Doctrine: `docs/doctrine/auto-routing-as-protocol-primitive.md`
 * § "Three-instance endgame" — auto-routing is
 * `f(TaskShape × ProviderCapability × Constraints) → RoutingDecision`.
 * PR 1 shipped motebit-cloud-proxy (2026-05-13); PR 2 shipped BYOK
 * (2026-05-14); PR 3 (this module) closes the three-instance-deep
 * validation: a third concrete consumer with fundamentally different
 * cost semantics (zero marginal $/token; constraint is local hardware
 * capacity, not money), different "host" semantics (the user's own
 * machine, not a remote endpoint), and a dynamic catalog (what's
 * installed locally varies per user).
 *
 * **What this module is.** The protocol-side composition of three
 * primitives every on-device consumer needs:
 *
 *   1. `ON_DEVICE_MODEL_CATALOG[backend]` — per-backend
 *      `ProviderCapability[]`. Today populated for the `local-server`
 *      backend (Ollama / LM Studio / llama.cpp / Jan / vLLM —
 *      they all expose `/v1/chat/completions` via the OpenAI-compat
 *      shim and ingest the user's pulled model set). The catalog
 *      mirrors `LOCAL_SERVER_SUGGESTED_MODELS` from `@motebit/sdk`
 *      — the safe-defaults the settings UIs surface across surfaces.
 *      `inputCostPerMillion` and `outputCostPerMillion` are 0 — the
 *      truthful representation of marginal cost on the user's own
 *      hardware. `host: "local-server"` (the new `InferenceHost`
 *      registry entry PR 3 lands); `lab` reflects model origin
 *      (Meta for Llama / Codellama, Mistral for Mistral, Google for
 *      Gemma2, Microsoft for Phi-3, Alibaba for Qwen2). The other
 *      `OnDeviceBackend` entries (`apple-fm`, `mlx`, `webllm`) are
 *      single-model surfaces today where per-turn auto-routing
 *      doesn't apply — they're absent from the catalog by design
 *      and added when multi-model support lands per-backend.
 *
 *   2. `buildOnDeviceCatalog(backend)` — pure dispatch on
 *      `OnDeviceBackend`. Single-model backends return an empty
 *      catalog; the dispatcher's `deny` path is the honest signal
 *      to the consumer ("nothing to auto-route across").
 *
 *   3. `dispatchOnDeviceRouting(text, backend, constraints?)` —
 *      composed entry point. Reuses `extractTaskShape` from
 *      `byok-router.ts` (BYOK and on-device both pay zero
 *      marginal-cost-per-classifier-call here — the heuristic is
 *      the right shape for both). Returns the typed
 *      `RoutingDecision`; consumers handle all three discriminator
 *      values.
 *
 * **What this module is NOT.** Not the runtime integration. Surface
 * runtimes (`apps/desktop`, `apps/web`, `apps/mobile`) consuming
 * on-device dispatch call this from their `sendMessageStreaming`
 * path when `OnDeviceProviderConfig.autoRoute === true`. Each
 * surface's consumer site is registered in the drift gate
 * `check-routing-decision-coverage` (#95).
 *
 * **What this module does NOT enforce.** No balance filter — on-
 * device runs on the user's hardware; there's no money flow. No
 * jurisdiction filter by default — on-device IS the user's
 * jurisdiction (their physical device). The catalog entries carry
 * `jurisdiction: "US"` as a sentinel since the `Jurisdiction`
 * registry is closed and the dispatcher's jurisdiction filter is
 * opt-in (omit `constraints.jurisdiction` and every catalog entry
 * survives the filter, which is the correct behavior for on-device
 * consumers).
 *
 * Three-instance-deep validation complete: same `dispatchRouting`,
 * same `RoutingDecision`, same `REFERENCE_ROUTING_POLICY`, same
 * closed `TaskShape` registry — across three consumers with three
 * fundamentally different cost models (subscription / pay-per-call /
 * zero-marginal). The doctrine's "auto-routing is consumer-neutral"
 * claim is now structurally proven across the full
 * cloud/BYOK/on-device spectrum.
 */

import type { OnDeviceBackend } from "@motebit/sdk";
import type { ProviderCapability, RoutingConstraint, RoutingDecision } from "@motebit/protocol";

import { dispatchRouting, REFERENCE_ROUTING_POLICY } from "./auto-router.js";
import { extractTaskShape } from "./byok-router.js";

// === On-device model catalog ===============================================

/**
 * Per-backend `ProviderCapability` catalog for on-device auto-routing.
 * The single populated backend today is `local-server` — the canonical
 * local OpenAI-compat inference server umbrella (Ollama, LM Studio,
 * llama.cpp, Jan, vLLM, text-generation-webui). Models sourced from
 * `LOCAL_SERVER_SUGGESTED_MODELS` in `@motebit/sdk/models.ts` (the
 * canonical safe-defaults across every settings UI).
 *
 * Single-model on-device backends (`apple-fm`, `mlx`, `webllm`) are
 * absent — they're surfaces where the user picks one model at config
 * time (the WebLLM download cost makes per-turn switching prohibitive;
 * Apple FM / MLX expose a single model per device). When per-backend
 * multi-model support lands (e.g., MLX with multiple loaded models),
 * the catalog grows additively here.
 *
 * Catalog ordering is the consumer's preference signal — earlier
 * entries are preferred when the dispatcher falls back. Local-server's
 * ordering matches `LOCAL_SERVER_SUGGESTED_MODELS` (the safe defaults
 * users typically pull first via `ollama pull llama3.2`).
 *
 * The `as const satisfies` clause enforces backend coverage
 * structurally — a new `OnDeviceBackend` registry entry without a
 * catalog mapping is a TypeScript error at this module's compile site.
 */
export const ON_DEVICE_MODEL_CATALOG = {
  // Local-server umbrella: every model below is invoked the same way
  // (HTTP POST to `{base}/v1/chat/completions`); the user's pulled
  // model set is the live catalog. The 8 entries here mirror
  // `LOCAL_SERVER_SUGGESTED_MODELS` — the safe-defaults the settings
  // UIs surface across surfaces. Adding more models is a settings-
  // surface UX decision; the catalog grows additively.
  "local-server": [
    {
      // Llama 3.2 is the canonical Ollama default (`ollama pull` lands
      // here on first install). Tier: chat-default, ~3B-class.
      modelName: "llama3.2",
      host: "local-server",
      lab: "meta",
      jurisdiction: "US",
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
    },
    {
      modelName: "llama3.1",
      host: "local-server",
      lab: "meta",
      jurisdiction: "US",
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
    },
    {
      modelName: "llama3",
      host: "local-server",
      lab: "meta",
      jurisdiction: "US",
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
    },
    {
      modelName: "mistral",
      host: "local-server",
      lab: "mistral",
      jurisdiction: "US",
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
    },
    {
      modelName: "codellama",
      host: "local-server",
      lab: "meta",
      jurisdiction: "US",
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
    },
    {
      modelName: "gemma2",
      host: "local-server",
      lab: "google",
      jurisdiction: "US",
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
    },
    {
      modelName: "phi3",
      host: "local-server",
      lab: "microsoft",
      jurisdiction: "US",
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
    },
    {
      modelName: "qwen2",
      host: "local-server",
      lab: "alibaba",
      jurisdiction: "US",
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
    },
  ],
  // Single-model on-device backends — auto-routing doesn't apply
  // today (WebLLM has download cost per model swap; Apple FM / MLX
  // expose a single model per device). Empty catalog → dispatcher
  // returns `deny`; consumers handle that as "use configured model"
  // (calm-software fallback matching BYOK's per-turn deny path).
  webllm: [],
  "apple-fm": [],
  mlx: [],
} as const satisfies Record<OnDeviceBackend, readonly ProviderCapability[]>;

/**
 * Return the on-device catalog for a backend. Pure dispatch on the
 * union; a new `OnDeviceBackend` addition fails to compile until
 * the catalog grows an entry (single-model backends ship the empty
 * array, which is the honest signal that auto-routing has nothing
 * to choose between).
 */
export function buildOnDeviceCatalog(backend: OnDeviceBackend): readonly ProviderCapability[] {
  return ON_DEVICE_MODEL_CATALOG[backend];
}

// === Composed dispatcher ===================================================

/**
 * Compose `extractTaskShape` (reused from BYOK — the heuristic
 * detector is the right shape for any consumer that can't afford a
 * per-message LLM classifier call) + `buildOnDeviceCatalog` +
 * `dispatchRouting` into a single entry point for on-device consumers.
 *
 * Per turn, on-device surface runtimes call this with the inbound
 * message text + the user's configured backend + optional constraints.
 * Returns the typed `RoutingDecision` — surfaces handle all three
 * discriminator values (`route` | `fallback` | `deny`) per the drift-
 * gate-enforced contract in `check-routing-decision-coverage` (#95).
 *
 * No balance filter — on-device pays zero marginal cost per token.
 * No jurisdiction filter by default — on-device IS the user's
 * jurisdiction; surfaces that want jurisdiction-aware on-device
 * routing pass an explicit `RoutingConstraint`.
 *
 * Single-model backends (`webllm`, `apple-fm`, `mlx`) return
 * `{ kind: "deny" }` from this dispatcher because their catalog is
 * empty by design. Surfaces handle that the same way they handle
 * the BYOK consumer's deny path — fall through to the user's
 * configured model. This is the unified "nothing to auto-route"
 * shape, expressed as the existing `RoutingDecision.kind === "deny"`
 * channel rather than a new shape.
 */
export function dispatchOnDeviceRouting(
  text: string,
  backend: OnDeviceBackend,
  constraints: RoutingConstraint = {},
): RoutingDecision {
  const taskShape = extractTaskShape(text);
  const catalog = buildOnDeviceCatalog(backend);
  return dispatchRouting(taskShape, catalog, constraints, REFERENCE_ROUTING_POLICY);
}
