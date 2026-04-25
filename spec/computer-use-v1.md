# motebit/computer-use@1.0

**Status:** Draft
**Version:** 1.0
**Date:** 2026-04-22

---

## 1. Overview

On a surface that can reach the operating system (today: the desktop Tauri app), a motebit can observe and act on the user's computer on their behalf — take screenshots, move the cursor, click, type, scroll. This is the **full-fidelity viewport** described in `docs/doctrine/workstation-viewport.md` §1: computer use is the endgame the Workstation plane opens onto. Sandboxed surfaces (web, mobile, spatial) receive the browser-subset (cloud-hosted browser) instead and are out of scope here.

This specification pins the **wire format** of every computer-use observation and action so a non-TypeScript implementer (native desktop shim, QA harness, federation peer replaying an audit log) emits and accepts identical payloads. Without the pin, a screenshot one implementation tags `"png"` and another tags `"image/png"` silently fractures the audit trail at the format boundary.

**Design principles:**

- **Every observation is a signed receipt.** A screenshot, a cursor-position read, an accessibility tree snapshot — each emits a `ToolInvocationReceipt` (`spec/execution-ledger-v1.md` §4) the same way a `read_url` call does. The audit trail for computer use is structurally identical to every other tool.
- **Every action is governance-gated.** Before any click or keystroke reaches the OS, the motebit's policy layer (`@motebit/policy-invariants`) classifies the target region's sensitivity and decides: execute, require approval, or deny. Medical/financial UI regions never reach the model unredacted; high-risk actions never fire without user consent.
- **The user can reclaim the floor at any moment.** Physical keyboard/mouse input from the user preempts motebit actions with mechanically testable semantics (see §3.3). No modal "motebit is busy" state that traps the cursor.
- **Sensitivity runs before AI.** Screen pixels that cross the governance layer are classified and, where indicated, redacted _before_ being passed to any external AI provider. The raw capture stays on-device; the AI sees a masked projection.
- **Coordinates are logical pixels in the primary display's coordinate space.** `(0, 0)` is top-left. Integer pixel coordinates. `display_width` / `display_height` on `ComputerSessionOpened` are the logical dimensions action coordinates live in. `scaling_factor` is the logical-to-physical ratio (Retina = 2.0, HiDPI variable); resolved by the surface, not by the motebit or the external AI. Screenshot `width` / `height` in the observation result match the logical dimensions.
- **Bytes live in the artifact store; payloads reference by hash.** Screenshot pixels are not embedded inline. Observation payloads carry `artifact_id + artifact_sha256` pointing into the receipt artifact store (`spec/execution-ledger-v1.md`). Signed receipts stay O(metadata), not O(image).
- **Actions are a nested discriminated union, not a flat envelope.** Each variant carries only the fields it needs; impossible states are structurally unrepresentable. Cross-language SDKs (Rust enums, Python tagged unions) map directly.

---

## 2. Scope and Non-Scope

**In scope:**

- Foundation law every conforming computer-use implementation must satisfy (§3).
- Action taxonomy — observation actions + input actions (§4).
- Wire format of every computer-use action payload and observation payload (§5).
- Sensitivity classification boundary (§6).
- Outcome taxonomy + conformance requirements (§7).

**Out of scope:**

- Cloud-hosted browser (the sandbox-subset viewport) — specified in a future `browser-session-v1.md`. Cross-references via `session_kind` on future session types are allowed.
- Accessibility-tree detail format (macOS `AXUIElementRef`, Windows UIA). Actions MAY carry an optional advisory `target_hint` (§4) but the full tree structure is not pinned in v1.
- OS-level permission-grant flow (macOS Screen Recording + Accessibility permissions; Windows elevation symmetry). This spec assumes permissions are granted or returns `permission_denied`.
- Multi-monitor coordinate systems. v1 pins the primary display only; multi-display is a v2 extension via an optional `display_id` field.
- Idempotency / sequencing fields on actions (`request_id`, `sequence_no`, `parent_event_id`). Deferred to v1.1 once replay-driven use cases inform the shape.
- Session-capabilities advertisement at open. Deferred to v1.1.

---

## 3. Foundation Law

### §3.1 Signed-observation invariant

Every observation (screenshot, cursor read, accessibility snapshot) MUST emit a `ToolInvocationReceipt` signed by the motebit's identity key. The receipt binds the observation's artifact(s) by SHA-256 and records the requesting `invocation_origin`. A replay of the signed log MUST reconstruct the same observation bytes given the stored artifacts.

### §3.2 Gated-action invariant

Every action (mouse, keyboard) MUST be classified by the governance layer before reaching the OS. The classification result (one of `allow | require_approval | deny`) is part of the signed receipt. A deny path MUST return a failure with `reason: "policy_denied"` without touching the OS; a `require_approval` path MUST pause until user consent is recorded (as a separate signed `approval_granted` receipt) before executing, or fail with `reason: "approval_required"` if no consent arrives within the surface's approval window.

### §3.3 User-floor invariant

Physical keyboard or mouse input from the user MUST preempt motebit dispatch. Conforming implementations satisfy **all** of:

- **Sampling.** The surface MUST sample a user-input signal (OS-level HID event tap, Tauri `event.listen`, equivalent) immediately before dispatching each synthetic event.
- **Atomic batch.** Maximum dispatch batch is one atomic event — one click, one keystroke, one scroll step. No multi-event bursts.
- **Detection latency.** The surface MUST halt further dispatch within 50 ms of detecting user input on the HID stream.
- **In-flight atomic.** The currently-in-flight atomic action (one click, one keystroke) MAY complete; no new dispatch begins until the quiet period elapses.
- **Quiet period.** The user's input stream MUST be quiet (zero user-originated HID events) for at least 500 ms before queued motebit actions resume.
- **Preemption emission.** A preempted action MUST emit a failure receipt with `reason: "user_preempted"` — the partial effect (if any) is still audited.

### §3.4 Redaction-before-AI invariant

Any screenshot that crosses the motebit's external-AI boundary MUST first pass the sensitivity-classification layer. Regions classified `medical | financial | secret` MUST be redacted in the image bytes handed to the AI (projection kinds: `masked`, `blurred`, `cropped`). The raw unredacted capture stays on-device in the receipt artifact store; only the governance-gate-approved projection leaves. The `ComputerRedaction` payload (§5.2) binds both raw and projection artifacts by hash so a verifier with appropriate authorization can inspect either.

### §3.5 Session identity binding

A computer-use session has a `session_id` and a `motebit_id`. Every observation and action in the session carries both. Session lifecycle (start, end) is itself a signed event pair (`ComputerSessionOpened`, `ComputerSessionClosed`). No action MAY fire outside an open session; attempting to do so MUST return `reason: "session_closed"`.

---

## 4. Action Taxonomy

Actions are a **nested discriminated union** on `kind`. Nine variants cover the full surface. Every action lives inside the `action` field of a `ComputerActionRequest` (§5.1).

**Observation actions** — motebit reads OS state, returns a structured payload.

- `screenshot` — capture the primary display's current frame.
- `cursor_position` — read the current cursor coordinates.

**Input actions** — motebit writes OS state, returns success/failure.

- `click` — single mouse click at a target point.
- `double_click` — two clicks in rapid succession at a target point.
- `mouse_move` — move cursor to a target point without clicking.
- `drag` — press at one point, move to another, release.
- `type` — keyboard text input.
- `key` — keyboard combination (e.g. `"cmd+c"`).
- `scroll` — wheel scroll at a target point.

Pointer actions (`click`, `double_click`, `mouse_move`, `drag`) MAY carry an optional `target_hint` with semantic information (accessibility role, label, source). Execution still happens at the pixel coordinates; the hint is advisory, used by verifiers and approval UX to explain the action.

All actions are emitted through a single tool primitive: `computer` in `@motebit/tools`.

#### Tools (foundation law)

The canonical tool name every conforming computer-use implementation registers. Renaming is a wire break.

- `computer` — observe or act on the user's computer. Input is a `ComputerActionRequest` (§5.1); output is a `ComputerObservationResult` (§5.2) for observation actions or a success/failure record for input actions.

---

## 5. Wire Format

Every payload is canonical JSON. Logical pixel coordinates are signed integers (supporting negative offsets in multi-monitor future extensions). Timestamps are Unix milliseconds.

### 5.1 — ComputerActionRequest

The tool call envelope. `action` is a nested variant.

#### Wire format (foundation law)

```json
{
  "session_id": "cs_01J...",
  "action": {
    "kind": "click",
    "target": { "x": 512, "y": 384 },
    "button": "left",
    "modifiers": ["cmd"],
    "target_hint": {
      "role": "button",
      "label": "Send",
      "source": "accessibility"
    }
  }
}
```

Top-level fields:

- `session_id` (string, required) — ULID of the open computer-use session.
- `action` (object, required) — one of the nine variants below.

**Variant: `screenshot`**

```json
{ "kind": "screenshot" }
```

**Variant: `cursor_position`**

```json
{ "kind": "cursor_position" }
```

**Variant: `click`** and **`double_click`** (same shape)

```json
{
  "kind": "click",
  "target": { "x": 512, "y": 384 },
  "button": "left",
  "modifiers": ["cmd"],
  "target_hint": { "role": "button", "label": "Send", "source": "accessibility" }
}
```

- `target` (object, required) — `{ x, y }` in logical pixels.
- `button` (string, optional) — `"left" | "right" | "middle"`. Defaults to `"left"`.
- `modifiers` (array of string, optional) — subset of `["cmd", "ctrl", "alt", "shift"]`.
- `target_hint` (object, optional) — advisory semantic info.

**Variant: `mouse_move`**

```json
{
  "kind": "mouse_move",
  "target": { "x": 512, "y": 384 },
  "target_hint": { "role": "link", "source": "accessibility" }
}
```

**Variant: `drag`**

```json
{
  "kind": "drag",
  "from": { "x": 100, "y": 200 },
  "to": { "x": 800, "y": 900 },
  "button": "left",
  "modifiers": [],
  "duration_ms": 400
}
```

- `from`, `to` (object, required).
- `duration_ms` (integer, optional) — total drag duration; implementation MAY interpolate.

**Variant: `type`**

```json
{
  "kind": "type",
  "text": "hello",
  "per_char_delay_ms": 25
}
```

- `text` (string, required).
- `per_char_delay_ms` (integer, optional) — implementation default when absent.

**Variant: `key`**

```json
{ "kind": "key", "key": "cmd+c" }
```

- `key` (string, required) — combination string.

**Variant: `scroll`**

```json
{
  "kind": "scroll",
  "target": { "x": 512, "y": 384 },
  "dx": 0,
  "dy": -120
}
```

- `dx`, `dy` (integer, required).

### 5.2 — ComputerObservationResult

Returned in the `data` field of a successful observation action's `ToolResult`. Discriminated by `kind`.

#### Wire format (foundation law)

**Variant: `screenshot`** — bytes live in the artifact store; the payload binds by hash.

```json
{
  "kind": "screenshot",
  "session_id": "cs_01J...",
  "artifact_id": "art_01J...",
  "artifact_sha256": "b6f2...1d3a",
  "image_format": "png",
  "width": 2560,
  "height": 1440,
  "captured_at": 1777000000000,
  "redaction": {
    "applied": true,
    "projection_kind": "masked",
    "policy_version": "sensitivity-v3",
    "classified_regions_count": 2,
    "classified_regions_digest": "e7b1...4f02"
  },
  "projection_artifact_id": "art_01J..._redacted",
  "projection_artifact_sha256": "9a08...7c11"
}
```

Fields:

- `kind` (string, required) — `"screenshot"`.
- `session_id` (string, required).
- `artifact_id` (string, required) — ID of the raw capture artifact.
- `artifact_sha256` (string, required) — SHA-256 of the raw bytes.
- `image_format` (string, required) — `"png" | "jpeg"`.
- `width`, `height` (integer, required) — logical pixels.
- `captured_at` (integer, required) — Unix ms.
- `redaction` (object, required) — structured metadata (see `ComputerRedaction` below).
- `projection_artifact_id`, `projection_artifact_sha256` (string, optional) — present when the AI received a distinct redacted projection (when `redaction.projection_kind !== "raw"`).

`ComputerRedaction`:

- `applied` (boolean, required) — `true` iff one or more regions were classified as sensitive.
- `projection_kind` (string, required) — `"raw" | "masked" | "blurred" | "cropped"`. Describes the shape of bytes the AI consumed.
- `policy_version` (string, optional) — version of the classification policy that ran.
- `classified_regions_count` (integer, optional) — number of sensitive regions classified.
- `classified_regions_digest` (string, optional) — SHA-256 of a canonical JSON array of classified regions (`{ x, y, w, h, classification }[]`).

**Variant: `cursor_position`**

```json
{
  "kind": "cursor_position",
  "session_id": "cs_01J...",
  "x": 512,
  "y": 384,
  "captured_at": 1777000000000
}
```

### 5.3 — ComputerSessionOpened

Signed event emitted when a session begins.

#### Wire format (foundation law)

```json
{
  "session_id": "cs_01J...",
  "motebit_id": "mot_01J...",
  "display_width": 2560,
  "display_height": 1440,
  "scaling_factor": 2.0,
  "opened_at": 1777000000000
}
```

- `display_width`, `display_height` are logical pixels (action coordinates live in this space).
- `scaling_factor` is logical-to-physical. Screenshot `width`/`height` in `ScreenshotObservation` match the logical dimensions.

### 5.4 — ComputerSessionClosed

Signed event emitted when a session ends.

#### Wire format (foundation law)

```json
{
  "session_id": "cs_01J...",
  "closed_at": 1777000060000,
  "reason": "user_closed"
}
```

- `reason` (string, optional) — `"user_closed" | "timeout" | "error"` or an implementation-specific code.

---

## 6. Sensitivity Classification Boundary

Every screenshot MUST pass `@motebit/policy-invariants` classification before being handed to any external AI provider. The classification layer is implementation-defined in v1 (heuristic app-bundle allowlist, ML model, or hybrid) but MUST produce one of:

- **none** — no sensitive content detected; full frame forwarded with `redaction.applied = false`, `projection_kind = "raw"`.
- **personal** — low-sensitivity personal UI (email previews, calendar); forwarded by default, user policy may tighten. `redaction.applied = false` unless policy-tightened.
- **medical | financial | secret** — MUST be region-redacted before the AI sees the bytes. `redaction.applied = true`, `projection_kind ∈ {"masked", "blurred", "cropped"}`. The raw capture artifact stays in the on-device receipt store; the projection artifact is what the AI receives.

The `redaction` object on `ScreenshotObservation` is the wire signal that classification ran. A verifier with access to the artifact store can fetch both raw and projection artifacts, recompute the classified regions from the raw frame, and verify `classified_regions_digest` — making what left the device fully auditable.

---

## 7. Conformance

### 7.1 Outcome taxonomy

Every computer-use action returns success (`ok: true`) or a failure with one of these structured reasons. Implementations MAY extend in v1.1 but MUST NOT emit a reason outside this list in v1:

| Reason              | Meaning                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `policy_denied`     | Governance classified the action as deny. No OS contact.                                      |
| `approval_required` | Governance classified as require_approval; consent window elapsed with no consent.            |
| `approval_expired`  | Consent was obtained but its window elapsed before execution.                                 |
| `permission_denied` | OS refused — no Screen Recording permission (macOS), no accessibility permission, etc.        |
| `session_closed`    | Action fired outside an open session, or session was torn down mid-action.                    |
| `target_not_found`  | Element at `target` coordinates no longer exists (accessibility-verified).                    |
| `target_obscured`   | Element exists but is covered (menu over it, window above, etc.).                             |
| `user_preempted`    | Physical user input interrupted mid-dispatch per §3.3.                                        |
| `platform_blocked`  | OS blocked synthetic input — secure password field, elevation boundary, UIAccess restriction. |
| `not_supported`     | Surface cannot execute computer use at all (web/mobile/spatial).                              |

### 7.2 Platform realism

Implementations MUST acknowledge platform-specific constraints:

- **macOS.** Screen capture via ScreenCaptureKit requires first-run Screen Recording permission. Input injection via CGEventPost requires Accessibility permission. System-owned surfaces (Touch ID prompts, secure password fields, Gatekeeper dialogs) are non-interactable — actions targeting them MUST return `platform_blocked`.
- **Windows.** UI Automation across privilege boundaries is constrained: automating elevated targets from a non-elevated process MUST fail with `platform_blocked`. UIAccess is a restricted path (signing + manifest + install requirements) and is not the default strategy.
- **Linux.** v1 is implementation-defined per display server (X11 vs. Wayland vs. others); a conforming v1 implementation MAY declare `not_supported` on Linux entirely.

### 7.3 Conformance checklist

A conforming implementation:

1. Emits signed receipts for every observation and every action (§3.1, §3.2).
2. Implements the governance gate before any action reaches the OS (§3.2).
3. Yields to user physical input with the mechanical semantics in §3.3 (sampling + atomic batch + 50 ms detection + 500 ms quiet + preemption emission).
4. Redacts sensitive regions in screenshots before any AI call, emitting structured `ComputerRedaction` metadata (§3.4, §5.2).
5. Uses a session lifecycle with opened/closed events (§3.5).
6. Serializes action requests and observation results to the wire format pinned in §5 (nested discriminated union; artifact refs for screenshots, not inline bytes).
7. Returns one of the outcome reasons in §7.1 on failure.

---

## 8. Implementing Packages

- `@motebit/protocol` — wire-format type definitions (this spec).
- `@motebit/wire-schemas` — zod + JSON Schema artifacts.
- `@motebit/tools` — the `computer` tool definition. Handler on surfaces without OS access returns `{ ok: false, error: "not_supported" }`.
- `apps/desktop` — Tauri Rust bridge. Stub in v1; real screen capture + input injection + accessibility integration lands in a dedicated follow-up pass.

Surface matrix (`docs/doctrine/workstation-viewport.md` §Per-surface map):

| Surface | Computer-use handler  | Notes                                   |
| ------- | --------------------- | --------------------------------------- |
| Desktop | Tauri Rust bridge     | Full implementation target. Stub in v1. |
| Web     | `not_supported` error | Browser sandbox cannot reach OS.        |
| Mobile  | `not_supported` error | Same.                                   |
| Spatial | `not_supported` error | Same.                                   |
| CLI     | `not_supported` error | No physical display to observe.         |

---

## 9. Known Gaps

- Idempotency / sequencing fields (`request_id`, `sequence_no`, `parent_event_id`) — deferred to v1.1 once implementation exposes retry/replay needs.
- Session-capabilities advertisement at `ComputerSessionOpened` — deferred to v1.1.
- Semantic observations (focused element, active app, window title, frontmost bundle id) — deferred to v1.1; cheaper than screenshots and high-signal.
- Multi-monitor support (v2 extension via `display_id`).
- Accessibility-tree full detail format (opaque in v1; `target_hint` is the interim hook).
- Sensitivity classification model specifics (implementation-defined in v1; standardized in v2).
