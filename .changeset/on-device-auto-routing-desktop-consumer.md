---
"@motebit/sdk": minor
---

Add `autoRoute?: boolean` to `OnDeviceProviderConfig` — opts the user into per-turn auto-routing across the on-device backend's available models. When `true` AND the backend is multi-model (`local-server` today; `apple-fm` / `mlx` / `webllm` are single-model surfaces), surface runtimes consume the third-consumer half of the auto-routing primitive (`@motebit/policy::dispatchOnDeviceRouting`) to pick the best model for each turn's `TaskShape` from the backend's catalog. When `false` or omitted, the surface uses the single configured `model`.

Closes the auto-routing PR 3 doctrine arc (`docs/doctrine/auto-routing-as-protocol-primitive.md` § "PR 3 — on-device consumer"). The architectural payoff: with PR 1 (motebit-cloud-proxy) + PR 2 (BYOK across web/desktop/mobile) shipped, the role-as-instance pattern (7th instance of `agility-as-role.md`) had two consumers — same risk shape as a 2-instance closed registry. PR 3 makes it three. The doctrine claim "auto-routing is consumer-neutral" is now structurally proven across the full sovereignty spectrum (subscription / pay-per-call / zero-marginal).

Desktop consumer site lives at `apps/desktop/src/index.ts::DesktopApp.sendMessageStreaming` — the same intercept point PR 2 added for BYOK, now extended with a parallel on-device branch. The two state fields (`_byokAutoRouteVendor` + `_onDeviceAutoRouteBackend`) are mutually exclusive; `initAI` populates exactly one based on the unified config's mode + autoRoute flag.

Drift gate `check-routing-decision-coverage` (#95) gains `on-device-runtime-desktop` consumer entry. Same desktop file as `byok-runtime-desktop`, different dispatcher entry (`dispatchOnDeviceRouting`). The gate now enforces **5 consumers × 3 decision kinds**.

Per `feedback_sovereignty_orthogonal`: orthogonal to tier — on-device auto-routing is never subscription-gated. The user owns the hardware; the surface's job is to compose the canonical dispatcher over it.

Deferred follow-ups (named in the doctrine, all triggered by real-consumer signal):

- Web + mobile on-device consumer mirror. Web's WebLLM has download-cost per model swap making per-turn routing inappropriate (catalog is single-model on web today; dispatcher denies cleanly). Mobile's local-server is less common than desktop's Ollama. Mirror lands when there's surface-side signal.
- Per-policy on-device routing — surface-specific `REFERENCE_LOCAL_SERVER_ROUTING_POLICY` mapping `TaskShape` → local model names (e.g., `code: "codellama"`, `chat: "llama3.2"`). Today every on-device dispatch lands in `fallback` because the canonical `REFERENCE_ROUTING_POLICY` names cloud models. The role-vs-policy distinction makes this a clean future swap.
- Multi-model `apple-fm` / `mlx` / `webllm` catalogs. Today these backends are single-model; the dispatcher denies them by design (the honest signal). When per-backend multi-model support lands, the catalog grows additively.
