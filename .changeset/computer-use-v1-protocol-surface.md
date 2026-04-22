---
"@motebit/protocol": minor
"@motebit/wire-schemas": minor
"@motebit/tools": minor
---

Computer use — full-fidelity viewport protocol surface. Endgame pattern
from `docs/doctrine/workstation-viewport.md` §1: the Workstation plane
on surfaces that can reach the OS (today: desktop Tauri) shows a live
view of the user's computer; the motebit observes via screen capture +
accessibility APIs and acts via input injection, all under the signed
ToolInvocationReceipt pipeline. Every observation signed, every action
governance-gated, user-floor always preempts.

**This commit ships the contract.** The Rust-backed Tauri bridge that
actually captures pixels and injects input is deferred to a dedicated
implementation pass — that's platform work (`xcap`, `enigo`, macOS
Screen Recording + Accessibility permissions, Windows UIA, frame
streaming to the Workstation plane) that can't be verified from a
single session without on-device permission dialogs. Shipping the
protocol first means the Rust side has a stable target; every piece
downstream (governance, audit, UI wiring) builds against a locked
contract.

**Additions:**

- `spec/computer-use-v1.md` (Draft) — foundation law + action taxonomy
  - wire format + sensitivity boundary + conformance. Four payload
    types: `ComputerActionRequest`, `ComputerObservationResult`,
    `ComputerSessionOpened`, `ComputerSessionClosed`.
- `packages/protocol/src/computer-use.ts` — TypeScript types re-
  exported from `@motebit/protocol`.
- `packages/wire-schemas/src/computer-use.ts` — zod schemas + JSON
  Schema emitters + `_TYPE_PARITY` compile-time assertions. Registered
  in `scripts/build-schemas.ts`; committed JSON artifacts in
  `packages/wire-schemas/schema/`.
- `packages/tools/src/builtins/computer.ts` — the `computer` tool
  definition (one tool, action-discriminated, 9 action values covering
  observation + input). Handler factory `createComputerHandler` with
  optional `dispatcher` interface — surfaces without OS access register
  no dispatcher and get a structured `not_supported` error; the desktop
  surface will supply a dispatcher backed by its Tauri Rust bridge.
- `apps/docs/content/docs/operator/architecture.mdx` — spec tree +
  count updated to include `computer-use-v1.md`. Spec count: 15 → 16.

**Tests:** +4 in `packages/tools/src/__tests__/computer.test.ts`
covering tool definition parity, dispatcher-absent error path,
dispatcher-present pass-through, and thrown-error normalization.

**Not in this commit (by design):**

- Tauri Rust bridge — screen capture, input injection, OS
  accessibility integration, permission-dialog flow.
- Frame streaming from Rust to the Workstation plane's UI layer.
- Sensitivity-classification implementation (ML model / app-bundle
  allowlist). The protocol boundary is pinned; the classifier is
  implementation-defined in v1.
- Multi-monitor coordinate support (v2 extension).

All 28 drift gates pass. 171 tools tests green; 382 wire-schemas tests
green.
