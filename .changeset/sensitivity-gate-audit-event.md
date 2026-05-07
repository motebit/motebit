---
"@motebit/protocol": minor
"@motebit/sdk": minor
---

Sensitivity-gate audit event — turns the shipped fail-closed gate from invisible-but-correct into observable-and-provable.

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
