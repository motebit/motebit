---
"@motebit/runtime": minor
---

`StreamingManager` emits a signed `ToolInvocationReceipt` for every
matched `tool_status.calling` + `tool_status.done` pair in a turn.

Wired through:

- New optional `StreamingDeps` fields: `getDeviceId`,
  `getSigningPrivateKey`, `getSigningPublicKey`, `onToolInvocation`.
  All optional at the type level — legacy consumers pass none and
  the streaming path short-circuits before any hashing or signing
  cost.
- New optional `RuntimeConfig` fields: `deviceId` (defaults to
  `"runtime-default"`) and `onToolInvocation` (the public sink).
- `MotebitRuntime` stores `_deviceId` + `_onToolInvocation` at
  construction and wires them into the `StreamingManager` deps so
  the existing signing keys (`_signingKeys`) flow through to
  `signToolInvocationReceipt` via the same suite-dispatch path as
  `ExecutionReceipt`.

Inside `processStream`, a turn-scoped `Map<tool_call_id, {toolName,
args, startedAt}>` captures each `calling` chunk. When the matching
`done` chunk arrives, the manager composes a
`SignableToolInvocationReceipt`:

- `invocation_id` = the model-assigned `tool_call_id`
- `task_id` = the current `runId` (falls back to `invocation_id`)
- `args_hash` = JCS-canonical SHA-256 of the captured args
- `result_hash` = JCS-canonical SHA-256 of the (possibly redacted)
  result bytes — a verifier holding the same bytes recomputes and
  matches; pre-redaction bytes will not match, which is the honest
  signal that redaction happened
- `invocation_origin` = `"ai-loop"` (model-mediated dispatch)
- `suite` = `motebit-jcs-ed25519-b64-v1`
- `signature` over the canonical body

Fail-closed at every dependency boundary. No sink → no signing (no
background cost). Keys locked → no emission. Sign throws → warn + drop
(no partial artifact leaks). Sink throws → warn + swallow (isolated
from the streaming generator).

Tests: 7 new cases in `streaming.test.ts` covering one-receipt-per-call
emission, end-to-end verification against the runtime's public key,
silent fail-closed when signing keys are missing, no emission when the
sink is unwired, legacy streams without the new fields (skip
emission), multi-tool-call turns producing multiple receipts, and
sink-throw isolation.

This closes the workstation-surface substrate: the per-call audit
trail is now a stream of signed artifacts the panel controller
subscribes to. No sovereign behavior change for existing consumers
(no sink wired today), so the build is green without touching any
app code.
