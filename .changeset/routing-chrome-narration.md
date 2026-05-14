---
"@motebit/policy": minor
---

Add `formatRoutingChip(decision: RoutingDecision): string | null` — pure helper that maps the typed dispatcher output to a short chip-string for chrome surfaces. Closes the auto-routing PR 4 doctrine arc (`docs/doctrine/auto-routing-as-protocol-primitive.md` § "PR 4 — chrome narration of routing decisions").

The architectural payoff: every `RoutingDecision` already carried a `reason` field whose purpose was observability per the doctrine ("the dispatcher's choice should always be human-legible, even when the choice is 'I couldn't pick anything.'"). Until PR 4, that doctrine was code-stated but render-absent — the field existed; no consumer read it. PR 4 closes the gap.

Helper contract:

- `route` → just the model name (`"claude-sonnet-4-6"`). Calm-default — routine path doesn't need decoration.
- `fallback` → `${backup} ↺` (e.g., `"claude-opus-4-7 ↺"`). The `↺` glyph signals a swap from the policy preference; the full `decision.reason` ("wanted X, used Y because Z") surfaces via `describeByokRoutingDecision`-shaped helpers on hover / inspector panel surfaces (future arc).
- `deny` → `null`. Calm-software default: the chrome doesn't fabricate a label when no routing happened (the consumer fell through to its configured default).

Web's slab chrome consumes the chip via the new `SlabChromeOpts.routingNarration?: string | null` option — surfaces pass the pre-formatted string, not the `RoutingDecision` object, so the chrome stays UX-agnostic of the dispatcher's discriminated union. The chip renders as a second narration source in the `motebit × virtual_browser` register alongside task-step narration: the two have distinct semantic registers (task-step = "what motebit is doing in the world"; routing = "which model the dispatcher chose under the hood"), so they surface separately rather than collapsed into a single narration string.

This validates `chrome-as-state-render.md`'s matrix-as-primitive abstraction handles multiple narration sources without forcing chrome-shape changes — the chrome doesn't fork by source-type; it grows additively by accepting more typed opts.

Three new tests pin the chip semantic across all `RoutingDecision.kind` values.

Deferred follow-ups (named in the doctrine):

- Desktop + mobile slab-chrome routing chip mirror. Today only web surfaces the chip; desktop/mobile chrome surfaces would mirror when they grow to match web's matrix-shape.
- Proxy/motebit-cloud routing reason consumer. PR 4a already shipped the `X-Motebit-Routing-Reason` header at the proxy; the consumer-side mirror (HTTP layer parses the header → emits a chunk → WebApp sets the chip text) is a follow-up. Today the chip only surfaces for BYOK + on-device (where the surface knows the decision locally).
- Hover-reveal of full `decision.reason`. PR 4's chip is informational; an interactive variant is the natural follow-up.
- Chat-log-level routing chip. PR 4 surfaces the chip in the slab chrome; chat-only flows would render the chip next to each AI response in the chat log. Separate surface arc.
