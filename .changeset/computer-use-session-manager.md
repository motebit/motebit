---
"@motebit/runtime": minor
---

`computer-use` session manager primitive — the TS-side seam between
`spec/computer-use-v1.md` and every surface-specific dispatcher
(desktop Tauri Rust bridge first; cloud-browser-on-web later).

**Why this module.** The spec pins wire format + foundation law. Each
surface's computer-use integration needs the same scaffolding — session
allocation, lifecycle, governance routing, failure-reason
normalization, approval-flow wiring. Without a primitive that owns
those invariants, every surface would re-derive them inline (the same
drift pattern `runtime.goals` fixed for goal events). This module is
the single authorship site.

**Public surface:**

- `createComputerSessionManager({ dispatcher, governance?, approvalFlow?, ... })`.
- `ComputerPlatformDispatcher` — the platform-specific bridge interface.
  `queryDisplay()` + `execute(action, onChunk?)` + optional `dispose()`.
- `ComputerDispatcherError` — dispatcher implementations throw this
  with a `ComputerFailureReason` to get structured outcome
  propagation; generic `Error` throws map to `platform_blocked`.
- `ComputerGovernanceClassifier` — classifies per-action as
  `allow | require_approval | deny`. Default is allow-all (dev mode);
  production desktop builds MUST wire `@motebit/policy-invariants`.
- `ComputerApprovalFlow` — invoked when governance returns
  `require_approval`; returns `true` to authorize.
- `ComputerSessionHandle` + `ComputerSessionManager.openSession /
closeSession / executeAction / getSession / activeSessionIds /
dispose`.

**Session-lifecycle events are returned as data, not emitted directly
from this module.** The caller (desktop surface's integration layer)
wires `ComputerSessionOpened` / `ComputerSessionClosed` into the event
log via `runtime.events`. Same separation `runtime.goals` uses for
`goal_created` etc.

**Action receipts flow through the existing `ToolInvocationReceipt`
pipeline.** The `computer` tool in `@motebit/tools` receives AI-loop
invocations, delegates to this session manager's `executeAction`, and
the runtime's tool-call signer emits the receipt as it does for every
tool. This module does NOT mint receipts — duplicating the crypto path
would diverge the audit trail.

**Tests:** +17. Coverage of all four invariants —

1. Session lifecycle (open, close, idempotent close, close-unknown,
   dispose-closes-all).
2. Governance gate (allow / deny → policy_denied /
   require_approval-without-flow → approval_required /
   require_approval-with-consent → success /
   require_approval-denied → approval_required).
3. Dispatcher error taxonomy (ComputerDispatcherError preserves
   reason, generic Error → platform_blocked, non-Error throws
   preserved).
4. Session validity (execute-without-open → session_closed,
   execute-after-close → session_closed).

Plus streaming pass-through and default session-id generator.

**Seam for the Tauri Rust bridge:** implement
`ComputerPlatformDispatcher` — `queryDisplay` via
ScreenCaptureKit/Windows APIs, `execute` via `enigo` + OS
accessibility. Throw `ComputerDispatcherError` with a typed reason on
failure. The rest — sessions, governance, failure normalization —
already works.

All 28 drift gates pass. 612 runtime tests green (+17 session manager).
