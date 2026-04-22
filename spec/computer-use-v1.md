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
- **The user can reclaim the floor at any moment.** Physical keyboard/mouse input from the user interrupts motebit actions immediately. No modal "motebit is busy" state that traps the cursor. The surface implementation MUST yield to user input within the same input frame.
- **Sensitivity runs before AI.** Screen pixels that cross the governance layer are classified and, where indicated, redacted _before_ being passed to any external AI provider. The raw capture stays on-device; the AI sees a masked projection.
- **Coordinates are pixels in the primary display's coordinate space.** `(0, 0)` is top-left. Integer pixel coordinates. Scaling factors (Retina, HiDPI) are resolved by the surface implementation, not by the motebit or the external AI.

---

## 2. Scope and Non-Scope

**In scope:**

- Foundation law every conforming computer-use implementation must satisfy (§3).
- Action taxonomy — observation actions + input actions (§4).
- Wire format of every computer-use action payload and observation payload (§5).
- Sensitivity classification boundary (§6).
- Conformance requirements (§7).

**Out of scope:**

- Cloud-hosted browser (the sandbox-subset viewport) — specified in a future `browser-session-v1.md`. Cross-references via `session_kind` on `ComputerSession` are allowed.
- Accessibility-tree detail format (macOS `AXUIElementRef`, Windows UIA). The observation payload carries an opaque `accessibility` blob; the wire format does not pin its internal structure in v1.
- OS-level permission-grant flow (macOS Screen Recording + Accessibility permissions). Implementation detail of the Tauri surface; this spec assumes permissions are granted or returns a typed error when not.
- Multi-monitor coordinate systems. v1 pins the primary display only; multi-display is a v2 extension via an optional `display_id` field.

---

## 3. Foundation Law

### §3.1 Signed-observation invariant

Every observation (screenshot, cursor read, accessibility snapshot) MUST emit a `ToolInvocationReceipt` signed by the motebit's identity key. The receipt binds the observation bytes (as a SHA-256 digest) to the timestamp and the requesting `invocation_origin`. A replay of the signed log MUST reconstruct the same observation bytes given the stored artifacts.

### §3.2 Gated-action invariant

Every action (mouse, keyboard) MUST be classified by the governance layer before reaching the OS. The classification result (one of `allow | require_approval | deny`) is part of the signed receipt. A deny path MUST return `{ ok: false, reason: "policy_denied" }` without touching the OS; an `require_approval` path MUST pause until user consent is recorded (as a separate signed `approval_granted` receipt) before executing.

### §3.3 User-floor invariant

Physical keyboard or mouse input from the user MUST preempt any in-flight motebit action within the same input frame. The implementation MAY finish the current atomic action (one click, one keystroke) but MUST NOT begin the next queued action until the user's input stream has been quiet for at least 500 ms. This is the "user takes over at any time" guarantee from `docs/doctrine/workstation-viewport.md` §Governance boundary.

### §3.4 Redaction-before-AI invariant

Any screenshot that crosses the motebit's external-AI boundary MUST first pass the sensitivity-classification layer. Regions classified `medical | financial | secret` MUST be redacted (blurred or masked to a solid fill) in the image bytes handed to the AI. The raw unredacted capture stays on-device in the receipt artifact store; only the governance-gate-approved projection leaves.

### §3.5 Session identity binding

A computer-use session has a `session_id` and a `motebit_id`. Every observation and action in the session carries both. Session lifecycle (start, end) is itself a signed event pair. No action MAY fire outside an open session.

---

## 4. Action Taxonomy

A computer-use call is one of the following action kinds, discriminated by `action`. Two categories:

**Observation actions** — motebit reads OS state, returns a payload.

- `screenshot` — capture the primary display's current frame
- `cursor_position` — read the current cursor coordinates

**Input actions** — motebit writes OS state, returns success/failure.

- `click` — mouse click at `(x, y)` with button + modifiers
- `double_click` — two clicks at `(x, y)`
- `mouse_move` — move cursor to `(x, y)` without clicking
- `drag` — press at `(x0, y0)`, move to `(x1, y1)`, release
- `type` — keyboard input: string of characters
- `key` — keyboard combo: `"cmd+c"`, `"ctrl+shift+t"`, `"escape"`
- `scroll` — scroll at `(x, y)` by `(dx, dy)` wheel deltas

All actions are emitted through a single tool primitive: `computer` in `@motebit/tools`. The `action` field is the discriminator.

---

## 5. Wire Format

Every payload is canonical JSON. Pixel coordinates are unsigned integers. Timestamps are Unix milliseconds.

### 5.1 — ComputerActionRequest

#### Wire format (foundation law)

```json
{
  "session_id": "cs_01J...",
  "action": "click",
  "x": 512,
  "y": 384,
  "button": "left",
  "modifiers": ["cmd"]
}
```

Fields:

- `session_id` (string, required) — ULID of the open computer-use session.
- `action` (string, required) — discriminator. One of: `screenshot`, `cursor_position`, `click`, `double_click`, `mouse_move`, `drag`, `type`, `key`, `scroll`.
- `x`, `y` (integer, optional) — target pixel coordinates. Required for click/double_click/mouse_move and for the start of a drag.
- `x1`, `y1` (integer, optional) — drag end coordinates. Required when `action === "drag"`.
- `button` (string, optional) — `"left" | "right" | "middle"`. Defaults to `"left"` for click/double_click.
- `modifiers` (array of string, optional) — modifier keys held during the action: subset of `["cmd", "ctrl", "alt", "shift"]`.
- `text` (string, optional) — keyboard text. Required when `action === "type"`.
- `key` (string, optional) — key combination. Required when `action === "key"`.
- `dx`, `dy` (integer, optional) — scroll wheel deltas. Required when `action === "scroll"`.

### 5.2 — ComputerObservationResult

Emitted in the result of observation actions. Not a separate tool call — it's the `data` field of a `screenshot` or `cursor_position` invocation's result.

#### Wire format (foundation law)

```json
{
  "session_id": "cs_01J...",
  "kind": "screenshot",
  "image_format": "png",
  "image_base64": "iVBORw0KGg...",
  "width": 2560,
  "height": 1440,
  "captured_at": 1777000000000,
  "redaction_applied": false
}
```

Fields:

- `session_id` (string, required) — session the observation belongs to.
- `kind` (string, required) — observation discriminator. `"screenshot"` or `"cursor_position"`.
- `image_format` (string, optional) — `"png" | "jpeg"`. Required for screenshot.
- `image_base64` (string, optional) — base64-encoded image bytes. Required for screenshot.
- `width`, `height` (integer, optional) — image dimensions in pixels. Required for screenshot.
- `x`, `y` (integer, optional) — cursor coordinates. Required for cursor_position.
- `captured_at` (integer, required) — Unix ms of the capture.
- `redaction_applied` (boolean, required) — `true` iff the sensitivity layer masked one or more regions in the returned bytes.

### 5.3 — ComputerSessionOpened

Signed event emitted when a session begins. Carries display metadata so the model knows the coordinate space.

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

Fields:

- `session_id` (string, required) — newly allocated session identifier.
- `motebit_id` (string, required) — identity binding.
- `display_width`, `display_height` (integer, required) — primary display logical dimensions.
- `scaling_factor` (number, required) — display scaling (Retina = 2.0, HiDPI variable).
- `opened_at` (integer, required) — Unix ms.

### 5.4 — ComputerSessionClosed

Signed event emitted when a session ends. No payload beyond identity + timestamp + optional reason.

#### Wire format (foundation law)

```json
{
  "session_id": "cs_01J...",
  "closed_at": 1777000060000,
  "reason": "user_closed"
}
```

Fields:

- `session_id` (string, required).
- `closed_at` (integer, required) — Unix ms.
- `reason` (string, optional) — `"user_closed" | "timeout" | "error"` or a free-text code.

---

## 6. Sensitivity Classification Boundary

Every screenshot MUST pass `@motebit/policy-invariants` classification before being handed to any external AI provider. The classification layer is implementation-defined in v1 (heuristic app-bundle allowlist, ML model, or hybrid) but MUST produce one of:

- **none** — no sensitive content detected; full frame forwarded.
- **personal** — low-sensitivity personal UI (email previews, calendar); forwarded by default, user policy may tighten.
- **medical | financial | secret** — MUST be region-redacted before the AI sees the bytes. Redaction is blur-to-solid or replacement with a solid color; the image bytes handed to the AI MUST NOT contain the original pixels of the classified region.

The `redaction_applied` boolean on `ComputerObservationResult` is the wire signal that the layer acted. The receipt artifact store MAY retain the unredacted bytes on-device; those bytes never cross the motebit's external boundary without an explicit user-consent receipt.

---

## 7. Conformance

A conforming implementation:

1. Emits signed receipts for every observation and every action (§3.1, §3.2).
2. Implements the governance gate before any action reaches the OS (§3.2).
3. Yields to user physical input within one frame (§3.3).
4. Redacts sensitive regions in screenshots before any AI call (§3.4).
5. Uses a session lifecycle with opened/closed events (§3.5).
6. Serializes action requests and observation results to the wire format pinned in §5.
7. Returns a typed error (one of `policy_denied | permission_denied | not_supported | session_closed`) rather than panicking when preconditions fail.

---

## 8. Implementing Packages

- `@motebit/protocol` — wire-format type definitions (this spec).
- `@motebit/wire-schemas` — zod + JSON schema artifacts.
- `@motebit/tools` — the `computer` tool definition. The handler on surfaces without OS access returns `{ ok: false, error: "not_supported", reason: "computer use requires a desktop surface" }`.
- `apps/desktop` — Tauri Rust bridge. Stub in v1; real screen capture + input injection + accessibility integration lands in a dedicated follow-up pass.

Surface matrix (`docs/doctrine/workstation-viewport.md` §Per-surface map):

| Surface | Computer-use handler  | Notes                                      |
| ------- | --------------------- | ------------------------------------------ |
| Desktop | Tauri Rust bridge     | Full implementation target. Stub in v1.    |
| Web     | `not_supported` error | Browser sandbox cannot reach OS.           |
| Mobile  | `not_supported` error | Same.                                      |
| Spatial | `not_supported` error | Same.                                      |
| CLI     | `not_supported` error | No physical display to observe in the CLI. |

---

## 9. Known Gaps

- Multi-monitor support (v2 extension via `display_id`).
- Accessibility tree detail format pinning (currently opaque blob).
- Sensitivity classification model details (implementation-defined in v1, standardized in v2).
- Cross-application app-bundle allowlist format (implementation-defined in v1).
