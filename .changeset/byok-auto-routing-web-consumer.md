---
"@motebit/sdk": minor
---

Add `autoRoute?: boolean` to `ByokProviderConfig` — opts the user into auto-routing across the vendor's available models per turn. When `true`, surface runtimes (web today; desktop/mobile mirror following) consume the second-consumer half of the auto-routing primitive (`@motebit/policy::dispatchByokRouting`) to pick the best model for each turn's `TaskShape` from the vendor's catalog. When `false` or omitted, the surface uses the single configured `model` (backward-compat default).

Closes the auto-routing PR 2 doctrine arc (`docs/doctrine/auto-routing-as-protocol-primitive.md` § "PR 2 — BYOK consumer"). The architectural payoff: with PR 1's motebit-cloud-proxy as the only consumer of `dispatchRouting`, the role-as-instance pattern was doctrine-shaped but unproven structurally. PR 2 validates that the dispatcher is consumer-neutral by landing a second concrete consumer with a different catalog source (`BYOK_MODEL_CATALOG[vendor]`), no balance filter (BYOK pays vendors directly), no jurisdiction filter, and heuristic shape detection instead of LLM classification — all via the same `dispatchRouting` entry point unchanged.

Web consumer site lives at `apps/web/src/web-app.ts::WebApp.sendMessageStreaming` (the natural intercept point where the BYOK config and StreamingProvider reference both live). Registered as the 2nd CONSUMER in the drift gate `check-routing-decision-coverage` (#95). Per the gate's structural enforcement, the consumer references every `RoutingDecision.kind` value (`route` | `fallback` | `deny`).

Per `feedback_sovereignty_orthogonal`: this flag is orthogonal to tier — BYOK auto-routing is never subscription-gated. The user already has the vendor's key; the surface's job is to compose the canonical dispatcher over it.

Deferred follow-ups (named in the doctrine, not deferred indefinitely):

- Desktop + mobile mirror of the web consumer wire-up. Same shape (`_byokAutoRouteVendor` + `_currentProvider` + `setModel` per turn); cross-surface mirror follows per the one-pass-delivery doctrine. Each surface adds its own `byok-runtime-{desktop,mobile}` entry to the drift gate's CONSUMERS registry.
- Settings-side UI toggle exposing `autoRoute`. The flag is in the config type and respected by the runtime; the BYOK settings panel doesn't yet surface a toggle. Users today opt-in by editing localStorage or via a future settings UI commit.
- Classifier-mode shape detection. The heuristic shape detector (`@motebit/policy::extractTaskShape`) is the cheap default; surfaces wanting LLM-classifier-level accuracy compose their own detector and pass directly to `dispatchRouting`.
