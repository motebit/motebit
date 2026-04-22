---
"@motebit/panels": minor
---

New controller: `createWorkstationController` — surface-agnostic state
for the Workstation panel, the live view into what the motebit is
doing right now.

Follows the established Sovereign / Agents / Memory / Goals pattern:
an adapter inverts the dependency on `@motebit/runtime`; the host
surface (web, desktop, mobile) wires the runtime's `onToolInvocation`
sink into `adapter.subscribeToolInvocations`, then renders DOM / RN /
etc. from `getState()`.

Adapter contract:

- `subscribeToolInvocations(listener) → unsubscribe` — receives the
  signed `ToolInvocationReceipt` stream the runtime emits (one per
  matched tool_call calling→done pair). Returns an unsubscribe thunk
  the controller calls on `dispose()`.

State:

- `history: ToolInvocationReceiptLike[]` — completed tool calls in
  arrival order, trimmed FIFO to `maxHistory` (default 100). Each
  entry is the full signed receipt — a host UI can render a human-
  readable row from the fields and hand the receipt to a verifier on
  demand.
- `lastReceiptAt: number | null` — unix ms of the most recent receipt;
  null when none seen.
- `receiptCount: number` — monotonic lifetime counter (including
  trimmed entries) for "something new arrived" detection.

Actions: `clearHistory()` resets the view without dropping the
subscription (fresh-session UX); `dispose()` unsubscribes and freezes
state.

Design notes:

- `ToolInvocationReceiptLike` is duplicated from
  `@motebit/crypto/SignableToolInvocationReceipt` rather than imported
  — same strategy the Memory controller uses for `MemoryNode`, keeping
  this package at Layer 5 without pulling crypto into its deps. The
  two shapes match field-for-field; the host's adapter bridges at the
  type boundary.
- Listener exceptions are isolated. A subscriber that throws does not
  poison the controller's state or block sibling subscribers.
- `maxHistory` is clamped to ≥1 so a pathological config doesn't
  produce a no-op controller.

10 new tests cover: initial empty state, subscription at construction,
history append ordering, subscriber notification on each receipt,
unsubscribe-stops-notifications, FIFO trim at maxHistory, `clearHistory`
semantics, `dispose` unsubscribes-and-freezes, listener-exception
isolation, `maxHistory=0` clamp, and post-dispose receipt rejection.

Not yet consumed — web and desktop mounts land in follow-up commits.
