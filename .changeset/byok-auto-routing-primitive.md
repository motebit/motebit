---
"@motebit/policy": minor
---

Land the BYOK auto-routing primitive — second-consumer half of the auto-router PR-2 arc (doctrine: `docs/doctrine/auto-routing-as-protocol-primitive.md` § "Three-instance endgame"). PR 1 (2026-05-13) shipped motebit-cloud-proxy as the first consumer; this commit lands the BYOK-side primitives in `@motebit/policy/byok-router.ts` so the second-consumer integration on web/desktop/mobile is a downward wire-up, not a fresh design.

The architectural payoff: validates that `dispatchRouting(TaskShape × ProviderCapability × Constraints) → RoutingDecision` is consumer-neutral as the doctrine claims. Same dispatcher, different catalog, no `balanceMicroUsd` field, no jurisdiction-pinned `US`-only filter — the BYOK consumer composes the protocol primitive with consumer-specific concerns layered outside it. Compounds with `protocol-primacy.md` ("does this work identically for a user who never subscribes?") and `feedback_sovereignty_orthogonal` (BYOK can't be subscription-gated).

New exports:

- `BYOK_MODEL_CATALOG: Record<ByokVendor, readonly ProviderCapability[]>` — per-vendor `ProviderCapability` catalog with pricing, jurisdiction, lab, host. Sourced from `services/proxy/src/validation.ts::MODEL_CONFIG` for the four vendors the proxy hosts (anthropic / openai / google / groq); DeepSeek added as the BYOK-only fifth vendor (jurisdiction `CN` — excluded from proxy by `MOTEBIT_CLOUD_ALLOWED_JURISDICTIONS`, accepted via the BYOK sovereignty path).
- `buildByokCatalog(vendor: ByokVendor)` — returns the vendor's catalog. `as const satisfies Record<ByokVendor, ...>` on the catalog enforces registry-mirror at the type system; a new `ByokVendor` addition in `@motebit/sdk` that's not mirrored here fails to compile.
- `extractTaskShape(text: string): TaskShape` — heuristic-mode TaskShape detector. BYOK consumers can't afford the LLM-classifier roundtrip the proxy uses (an extra Anthropic call per turn would double the user's vendor cost); heuristic detection stays cheap. Signal order: code (fenced block / function shape / HTML tag / refactor cue) → math (LaTeX / equation operators) → research (long-form cue + length > 800) → reasoning (chain-of-thought cues OR 400-800 char deliberation length) → creative (write a poem / imagine / pretend) → quick (< 80 chars) → chat (default). Consumers wanting classifier-level accuracy compose their own detector and pass the result directly to `dispatchRouting`.
- `dispatchByokRouting(text, vendor, constraints?)` — composes the above three into a single entry point. Returns the typed `RoutingDecision` (`route` | `fallback` | `deny`); surfaces handle all three per the drift-gate-enforced contract.
- `describeByokRoutingDecision(decision)` — pattern-matches every `RoutingDecision.kind` value, returning a non-empty human-readable summary for observability surfaces (chrome narration, audit logs, dev tools).

Coverage: 24 new tests under `__tests__/byok-router.test.ts`, pure-function, no mocks. Tests pin the catalog's vendor coverage + price-monotonicity invariant, the heuristic's signal ordering across the spectrum, and the composed dispatcher's output across all three `RoutingDecision` discriminator values.

New dependency: `@motebit/policy` adds `@motebit/sdk` as a workspace dep so `byok-router.ts` can import `ByokVendor` from the sdk where the closed registry lives (per the sdk CLAUDE.md, `ByokVendor` is the 4th instance of agility-as-role; it stays in sdk to remain a stable developer-contract surface). Downward dep — sdk is permissive-floor Layer 0; policy is BSL Layer 1+ — `check-deps` validates the edge.

What this commit deliberately defers to commit B (sibling, this week):

- Web runtime per-turn dispatch when `ByokProviderConfig.autoRoute === true`. The primitive is ready; the surface wiring + drift-gate `byok-runtime` consumer registration land in the next commit alongside the doctrine close.
- Desktop + mobile mirror. Same shape as web; cross-surface mirror follows per the one-pass-delivery doctrine.
- Doctrine `auto-routing-as-protocol-primitive.md` "PR 2 shipped" marker. Marks land alongside commit B when the end-to-end consumer is verifiable.
