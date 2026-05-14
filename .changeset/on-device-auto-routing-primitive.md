---
"@motebit/protocol": minor
"@motebit/policy": minor
---

Land the on-device auto-routing primitive — third-consumer half of the auto-router PR-3 arc (doctrine: `docs/doctrine/auto-routing-as-protocol-primitive.md` § "Three-instance endgame"). PR 1 (2026-05-13) shipped motebit-cloud-proxy; PR 2 (2026-05-14) shipped BYOK across web/desktop/mobile; PR 3 (this commit) closes the three-instance-deep validation by landing the third concrete consumer with fundamentally different cost semantics: zero marginal $/token (on-device runs on user hardware), no balance filter, no jurisdiction filter (the user's device IS the jurisdiction), dynamic catalog (what's installed locally varies per user).

The architectural payoff: validates the doctrine claim that `dispatchRouting(TaskShape × ProviderCapability × Constraints) → RoutingDecision` is consumer-neutral across all three sovereignty postures, not just two. With PR 1 + PR 2, the role-as-instance pattern (7th instance of `agility-as-role.md`) had two consumers — same risk shape as a 2-instance closed registry. PR 3 makes it three. Same dispatcher, same `RoutingDecision` discriminated union, same `REFERENCE_ROUTING_POLICY`, same closed `TaskShape` registry — across three consumers with three fundamentally different cost models (subscription / pay-per-call / zero-marginal).

**`@motebit/protocol`** — closed-registry expansions for the on-device case:

- `InferenceHost` += `"local-server"`. The on-device case: requests route to the user's own inference server (Ollama, LM Studio, llama.cpp, Jan, vLLM, text-generation-webui — all expose `/v1/chat/completions` via the OpenAI-compat shim). Mirrors the `OnDeviceBackend` value of the same name in `@motebit/sdk`. The proxy NEVER routes to `local-server` — defensive arms in `services/proxy/src/app/v1/messages/route.ts::getProviderApiKey` (returns null) and `buildProviderRequest` (throws) name the structural violation rather than silently degrading.
- `ModelLab` += `"mistral" | "microsoft" | "alibaba"`. The labs the canonical `LOCAL_SERVER_SUGGESTED_MODELS` set draws from: Mistral AI trains Mistral, Microsoft trains Phi-3, Alibaba trains Qwen2. The proxy never sees these labs (it doesn't host their models); the registry expansion is purely consumer-side (the on-device dispatcher's catalog), which is why the registry's stated semantic "who trained the weights" generalizes cleanly without protocol-layer churn.

**`@motebit/policy`** — new on-device router primitive (`on-device-router.ts`):

- `ON_DEVICE_MODEL_CATALOG: Record<OnDeviceBackend, readonly ProviderCapability[]>` — per-backend `ProviderCapability` catalog. Single populated backend today is `local-server` with 8 entries (Llama 3.2 / 3.1 / 3, Mistral, Codellama, Gemma2, Phi-3, Qwen2 — mirrors `LOCAL_SERVER_SUGGESTED_MODELS` in `@motebit/sdk/models.ts`). Single-model backends (`webllm`, `apple-fm`, `mlx`) ship empty catalogs by design — they're surfaces where the user picks one model at config time. All `local-server` entries have `inputCostPerMillion: 0` + `outputCostPerMillion: 0` (the truthful representation of marginal cost on user hardware) and `host: "local-server"` (the new InferenceHost registry entry). `as const satisfies Record<OnDeviceBackend, ...>` enforces backend coverage structurally.
- `buildOnDeviceCatalog(backend)` — pure dispatch on the union.
- `dispatchOnDeviceRouting(text, backend, constraints?)` — composed entry point. Reuses `extractTaskShape` from `byok-router.ts` (the heuristic detector is the right shape for any consumer that can't afford per-message LLM classification). Returns `RoutingDecision`; surfaces handle all three discriminator values.

Single-model backends return `{ kind: "deny" }` from the dispatcher because their catalog is empty — the honest signal ("nothing to auto-route across"). The same `RoutingDecision.kind === "deny"` channel covers both "constraints empty the catalog" (BYOK) and "catalog was empty to begin with" (on-device single-model). One shape; two semantic origins.

Coverage: 11 new tests under `__tests__/on-device-router.test.ts`, pure-function. Tests pin (a) backend coverage of `OnDeviceBackend`, (b) the zero-marginal-cost invariant, (c) every catalog entry routes through `host: "local-server"` (defense against a future bug smuggling a remote-host entry into the on-device catalog), (d) lab-coverage invariant matching `LOCAL_SERVER_SUGGESTED_MODELS`, (e) the composed dispatcher's behavior across the multi-model `local-server` path AND the single-model paths (which deny by design).

What this commit deliberately defers to commit B (sibling, this week):

- Desktop on-device consumer wire-up — `_onDeviceAutoRouteBackend` field on `DesktopApp`, `OnDeviceProviderConfig.autoRoute` flag in sdk, per-turn dispatch in desktop's `sendMessageStreaming`, drift-gate `on-device-runtime-desktop` consumer registration, doctrine PR 3 close. Land alongside the verifiable end-to-end consumer site.
- Web / mobile on-device mirror. Same shape as desktop; cross-surface mirror per one-pass-delivery follows when there's verifiable signal. Web's WebLLM path has download-cost per model swap making per-turn routing inappropriate; mobile's local-server is less common today than desktop's.
