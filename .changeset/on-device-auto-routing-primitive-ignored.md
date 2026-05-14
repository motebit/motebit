---
"@motebit/policy": minor
---

On-device auto-routing primitive (PR 3a sibling of `on-device-auto-routing-primitive.md`, split per the changeset-discipline rule that ignored + published packages can't share a changeset).

Adds `@motebit/policy/on-device-router.ts` — the third-consumer half of the auto-router primitive per `docs/doctrine/auto-routing-as-protocol-primitive.md` § "PR 3 — on-device consumer":

- `ON_DEVICE_MODEL_CATALOG: Record<OnDeviceBackend, readonly ProviderCapability[]>` — per-backend catalog. Single populated backend today is `local-server` with 8 entries mirroring `LOCAL_SERVER_SUGGESTED_MODELS` (Llama 3.2 / 3.1 / 3, Mistral, Codellama, Gemma2, Phi-3, Qwen2). Single-model backends (`webllm`, `apple-fm`, `mlx`) ship empty catalogs by design. All `local-server` entries have `inputCostPerMillion: 0` + `outputCostPerMillion: 0` (zero marginal cost on user hardware) and `host: "local-server"` (the new `InferenceHost` registry entry the sibling protocol changeset adds).
- `buildOnDeviceCatalog(backend)` — pure dispatch on the union.
- `dispatchOnDeviceRouting(text, backend, constraints?)` — composed entry point. Reuses `extractTaskShape` from `byok-router.ts`. Returns the typed `RoutingDecision`.

11 new pure-function tests pin (a) backend coverage of `OnDeviceBackend`, (b) the zero-marginal-cost invariant, (c) every catalog entry routes through `host: "local-server"`, (d) lab-coverage invariant matching `LOCAL_SERVER_SUGGESTED_MODELS`, (e) the composed dispatcher's behavior.

The architectural payoff: validates the doctrine claim that `dispatchRouting(TaskShape × ProviderCapability × Constraints) → RoutingDecision` is consumer-neutral across all three sovereignty postures (subscription / pay-per-call / zero-marginal), not just two. PR 3 closes the three-instance-deep validation of the role-as-instance pattern (7th instance of `agility-as-role.md`).
