---
"@motebit/protocol": minor
"@motebit/crypto": minor
---

Add `ToolInvocationReceipt` — a per-tool-call signed artifact that
complements `ExecutionReceipt`. Where the task receipt commits to the
turn as a whole, the tool-invocation receipt commits to each individual
tool call inside the turn, letting the agent-workstation surface show
(and a third party verify) exactly which tool ran, with what argument
shape, and what it returned — one signature per call.

Why a sibling artifact instead of a nested field:

- Third-party verifiers checking a single tool's output do not need the
  enclosing task's receipt — the per-call receipt is independently
  self-verifiable with just the signer's public key.
- The workstation surface emits these live as tool calls complete,
  before the enclosing task finishes; nesting inside `ExecutionReceipt`
  would force the UI to wait for the outer receipt.
- Delegation is already recursive at the task level
  (`delegation_receipts`); keeping tool-invocation receipts separate
  avoids tangling two different recursion shapes in one artifact.

Commits to structural facts only: tool name, JCS-canonical SHA-256
hashes of the args and the result, the terminal status, the motebit +
device identities, and timestamps. The raw args and raw result bytes
are _not_ part of the receipt; a verifier who holds them can recompute
the hash and check it against the signature.

New exports — `@motebit/protocol`:

- `ToolInvocationReceipt` interface.

New exports — `@motebit/crypto`:

- `SignableToolInvocationReceipt` interface (structurally compatible
  with the protocol type; matches the existing `SignableReceipt`
  pattern).
- `TOOL_INVOCATION_RECEIPT_SUITE` constant.
- `signToolInvocationReceipt` — JCS canonicalize, dispatch through
  `signBySuite`, base64url-encode. Freezes the returned receipt.
- `verifyToolInvocationReceipt` — fails closed on unknown suite, bad
  base64, or signature mismatch; same rules as `verifyExecutionReceipt`.
- `hashToolPayload` — canonical SHA-256 helper for args/result hashing.

Tests: 12 new cases in `verify-artifacts.test.ts` covering round-trip,
tamper detection on `tool_name` / `result_hash` / `invocation_origin`,
wrong-key rejection, determinism, public-key embedding, fail-closed
suite check, and `hashToolPayload` canonicalization invariance.

This commit lands only the primitive. Emission (extending the
`tool_status` chunk in `@motebit/ai-core` with args + tool_call_id and
composing/signing the receipt in `@motebit/runtime`'s streaming
manager) follows in a separate change. No runtime behavior changes
yet — adding a new signed artifact to the toolbox.

Part of the agent-workstation surface work: receipts are the
motebit-unique layer underneath any execution mode. The workstation
panel subscribes to these as they land.
