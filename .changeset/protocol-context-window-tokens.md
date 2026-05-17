---
"@motebit/protocol": minor
---

`ProviderCapability` gains an optional `contextWindowTokens?: number` field per the new
[`intelligence-pluggability-contract`](../docs/doctrine/intelligence-pluggability-contract.md)
doctrine. Consumers performing pre-flight admission read this to decide whether the
selected model can carry the assembled prompt before invoking it:

```text
systemPromptBudget + toolSchemaBudget + renderedStateBudget + userMessageReserve + outputReserve
  ≤ providerCapability.contextWindowTokens
```

Auto-routing dispatch does not consume this field today — it is a sibling deny semantic to
auto-router deny: "I cannot pick among catalog entries" (auto-routing) vs "the picked
model cannot carry the assembled prompt" (admission). The two share one calm-software
surface via the chrome's `routingNarration` slot but answer different questions.

Additive + optional. No existing consumer or implementer breaks.
