---
"@motebit/protocol": minor
"@motebit/wire-schemas": minor
"@motebit/tools": minor
---

`computer-use-v1.md` revision — applies Tier 1 + Tier 2 #9 of an
external expert review (Draft → Draft, breaking-to-Draft permitted).
Structural refactor; same governance posture, tighter protocol.

**Discriminated-union action shape.** `ComputerActionRequest.action`
is now a nested variant `{ kind, ... }`, not a flat envelope with
action-conditional optional fields. Nine variants:
`screenshot`, `cursor_position`, `click`, `double_click`,
`mouse_move`, `drag`, `type`, `key`, `scroll`. Impossible states
(drag fields on a click, type fields on a scroll) are structurally
unrepresentable. Zod `discriminatedUnion` emits clean JSON Schema
`oneOf` branches; the `computer` tool's `inputSchema` mirrors this
so modern AI models (Claude 4.x, GPT-5.x) generate rigorous tool
calls.

**Artifact references, not inline bytes.** Screenshot payloads now
carry `artifact_id + artifact_sha256` pointing into the receipt
artifact store (spec/execution-ledger-v1.md), not embedded
`image_base64`. Signed receipts stay O(metadata) instead of
O(image). Redacted projections add optional
`projection_artifact_id + projection_artifact_sha256` so a
verifier with authorization can fetch either raw or redacted bytes.

**Structured redaction metadata.** `redaction_applied: boolean`
replaced with a `ComputerRedaction` object:
`{ applied, projection_kind, policy_version?,
classified_regions_count?, classified_regions_digest? }`. A
verifier can now prove _what_ was redacted, under _which_ policy
version, and whether the AI saw raw or projected bytes.

**Optional `target_hint` on pointer actions.** Click, double_click,
mouse_move, drag variants can carry advisory
`{ role?, label?, source }`. Execution still happens at pixel
`target`; the hint lets verifiers and approval UX explain "motebit
clicked the Send button" instead of only "(512, 384)". Source
field tracks provenance ("accessibility", "dom", "vision",
"user_annotation"). Doesn't break the existing accessibility-tree
out-of-scope decision.

**Mechanically-testable user-floor invariant.** §3.3 replaces
"preempt within the same input frame" with six specific
requirements: sampling before each synthetic dispatch, max atomic
batch = 1, max detection latency = 50 ms, 500 ms quiet period,
in-flight atomic MAY complete, preempted actions emit
`reason: "user_preempted"` receipts.

**Outcome taxonomy.** New §7.1 table defines 10 structured failure
reasons (`policy_denied`, `approval_required`, `approval_expired`,
`permission_denied`, `session_closed`, `target_not_found`,
`target_obscured`, `user_preempted`, `platform_blocked`,
`not_supported`). `ComputerFailureReason` type + `COMPUTER_FAILURE_REASONS`
const exported from `@motebit/protocol`; tools package renames
`ComputerUnsupportedReason` → `ComputerFailureReason`.

**Platform realism.** New §7.2 acknowledges macOS permission
requirements (Screen Recording + Accessibility), Windows UIAccess

- elevation-symmetry constraints, and Linux variance (v1 MAY
  declare not_supported on Linux).

**Coordinate semantics clarified.** `display_width` /
`display_height` explicitly logical pixels; `scaling_factor` is
logical-to-physical; screenshot dimensions match logical.

**Deferred to v1.1 (acknowledged as gaps):**

- Idempotency / sequencing fields (`request_id`, `sequence_no`).
- Session-capabilities advertisement at open.
- Semantic observations (focused element, active app, window title).

Review credit: external principal-level reviewer. Rating before
revision: 8.4/10 draft, 6.8/10 interop. This revision targets the
interop score.

All 28 drift gates pass. 173 tools tests green (+6 vs. prior
computer.test.ts), 382 wire-schemas tests green. 3-way pin
(TS ↔ zod ↔ JSON Schema) holds across all four payload types.
