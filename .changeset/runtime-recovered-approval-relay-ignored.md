---
"@motebit/ai-core": minor
"@motebit/runtime": minor
"@motebit/persistence": major
---

Recovered approvals carry their relay (design runtime-relay-binding 4b, PR 1). The CLI half is in `cli-recovered-approval-relay.md`.

- `@motebit/ai-core`: `MotebitLoopDependencies` gains `relayIdentity?: () => ApprovalRelayIdentity | null` and `isRelayBoundTool?: (name) => boolean`. Both `approval_request` emit sites stamp `relay` (read synchronously at the pause; `null` when the callback is absent, unbound or unpinnable) and `relay_bound` (absent when the callback is absent). New exported type `ApprovalRelayIdentity { pinKey, publicKey }`.
- `@motebit/runtime`: the runtime supplies both callbacks in its loop deps, so turn and plan-step approvals are stamped. `SimpleToolRegistry.registerRelayBound` / `isRelayBound` carry the relay-bound flag on the registry entry (kept across `replace`); the delegation tools register with it. `invokeLocalTool` takes `approvedUnderRelay?: ApprovalRelayIdentity`: a `humanApproved` call to a relay-bound tool without it, or with a relay that is not the bound one, is refused `relay_changed` before the tool runs; otherwise the runtime builds `{ ...OWNER_CALL, approvedRelayGeneration }` itself, so the handler's own generation check catches a rebind that lands during `execute`. New read-only `getRelayIdentity()` and `relayBoundToolStatus(name)`. Exports `sameRelayIdentity`, `isRelayChangedResult` (true only for a refusal the runtime minted — by object identity, never by its text, so a handler cannot forge it), `RELAY_CHANGED_RESULT` and the `ApprovalRelayIdentity` type. The `approval_request` `StreamChunk` gains `relay` and `relay_bound`.
- `@motebit/persistence`: `approval_queue` gains `relay_pin_key`, `relay_public_key`, `relay_bound` (migration #54). `SqliteApprovalStore.add` takes a `StoredApprovalItem` (`ApprovalItem & ApprovalRelayColumns`), so every writer must pass the relay columns; `get` / `listPending` / `listAll` return them (a pre-column row reads `null` / `null` / `null`).

## Migration

`SqliteApprovalStore.add` now requires the three relay columns. Copy them from the `approval_request` chunk that paused the call; a writer with no relay passes nulls.

Before:

```ts
approvalStore.add({
  approval_id,
  motebit_id,
  goal_id,
  tool_name,
  args_preview,
  args_hash,
  risk_level,
  status,
  created_at,
  expires_at,
  resolved_at: null,
  denied_reason: null,
});
```

After:

```ts
approvalStore.add({
  ...sameFieldsAsBefore,
  relay_pin_key: chunk.relay?.pinKey ?? null,
  relay_public_key: chunk.relay?.publicKey ?? null,
  relay_bound: chunk.relay_bound ?? null,
});
```

Why: a recovered approval must run only under the relay it was approved under, and the row is the only record of that relay once the process restarts. Making the columns required means a writer that forgets them does not compile.
