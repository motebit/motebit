---
"@motebit/runtime": patch
---

A foreign principal's turn never writes the owner's conversation (#904). Sibling: `foreign-turn-history-904.md` (the `motebit` package that bundles this runtime).

- `ConversationManager` takes an optional `isForeignPrincipalTurn` dep; while it is true, `pushExchange`, `pushActivation` and `injectIntermediateMessages` are no-ops — nothing enters the live history, nothing is appended to the conversation store (so nothing syncs to other devices), and no title or summary is derived. The runtime wires it from its per-turn foreign mark, so every door is covered: `sendMessage`, `sendMessageStreaming`, the approval resume, and `handleAgentTask` (which previously opened a fresh stored conversation holding the customer's prompt).
- A foreign approval resume continues over a private copy of its history; the approval timeout skips a foreign expiry.
- `check-memory-source-canonical` gains scan (d), which locks the floor textually.
