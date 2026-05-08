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

The canonical tool names every conforming computer-use implementation registers. Renaming is a wire break.

- `computer` — observe or act on the user's computer. Input is a `ComputerActionRequest` (§5.1); output is a `ComputerObservationResult` (§5.2) for observation actions or a success/failure record for input actions.
- `request_control` — co-browse remediation companion. Surfaces that carry a co-browse `ControlState` machine (`virtual_browser` embodiment) MUST register this tool alongside `computer` so motebit's reasoning loop has a typed remediation when `computer` denies dispatch with `not_in_control` (§7.1). Input is `{ session_id?: string }`; output is a closed-set `RequestControlOutcome` discriminated by `kind`: `granted` | `denied` | `timeout` | `already_in_control` | `request_pending` | `session_paused`. Surfaces without a `ControlState` machine (`desktop_drive` today) MUST NOT register this tool — there is no machine to drive, and advertising the affordance would invite an AI tool call that cannot resolve.

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

### 5.5 — UserInputEvent (Slice 2c)

Wire format for **user-driven** input forwarded into a co-browse session. Available only on surfaces that carry a `ControlState` machine (`virtual_browser` embodiment); `desktop_drive` does not have this plane. Forwarding is gated at the runtime layer on `controlState.kind === "user"`; any other state rejects with `not_in_user_state`.

#### Wire format (foundation law)

```json
{ "event": { "kind": "click", "x": 320, "y": 200, "button": "left" } }
```

```json
{
  "event": {
    "kind": "key",
    "key": "c",
    "modifiers": { "ctrl": false, "meta": true, "alt": false, "shift": false }
  }
}
```

```json
{ "event": { "kind": "paste", "text": "<clipboard content>" } }
```

#### Event variants

- **click** — pointer click at logical-pixel `(x, y)` against the cloud Chromium viewport. `button ∈ {"left", "right", "middle"}`. Same coordinate system as motebit-side `ComputerAction.click`.
- **key** — keyboard press. `key` is the browser `KeyboardEvent.key` value (single character for printable input, named key for control keys, e.g. `"Enter"`, `"Backspace"`, `"ArrowUp"`). `modifiers` reports the four standard modifier states. Implementations route printable single-character `key` with no non-shift modifier through `page.keyboard.type(key)`; named keys and any non-shift modifier through `page.keyboard.press(combo)`.
- **paste** — clipboard paste. The wire carries raw text; v1 implementations dispatch via `page.keyboard.type(text)` (per-character). A future slice MAY upgrade to CDP `Input.insertText` for true paste semantics.
- **wheel** (Slice 2c-batching) — coalesced scroll. `(x, y)` is the cursor anchor (logical pixels); `(dx, dy)` are CSS-pixel scroll deltas matching `WheelEvent.deltaX`/`deltaY` (positive `dy` scrolls down, positive `dx` scrolls right). `event_count` reports how many native `WheelEvent`s the capture surface coalesced into this one. Server-side: `page.mouse.move(x, y) + page.mouse.wheel(dx, dy)`. **Capture surfaces MUST coalesce native wheel events at ≤60Hz** (one wire event per ~16ms window) — sustained scrolling at 100Hz native rate must NOT produce 100 wire events/sec.
- **navigate** (Slice 2d) — user-driven URL navigation from an address-bar surface. The wire carries the normalized URL; the address bar SHOULD normalize bare hostnames (`example.com` → `https://example.com`) before forwarding, but the server defensively re-normalizes via the same regex (`^[a-z][a-z0-9+.-]*:\/\/`). Server-side: `page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 })`. Single-phase wait — unlike motebit-side `ComputerAction.navigate` (which carries inline screenshot + heuristics for the AI loop's text response), the user-side variant relies on the screencast for visibility and returns `204 No Content` on success.

#### Discrete events + coalesced wheel (Slice 2c-batching scope)

Drag, continuous pointermove, selection-drag, and file-drag remain **out of v1**. Those classes need either burst-aggregated audit (one entry per drag rather than per frame) or a WebSocket-shaped substrate to sustain >60Hz, deferred to follow-up slices.

#### Audit format (foundation law)

Every forward attempt — successes and rejections — emits one `UserInputForwarded` event. The audit format is **redacted by construction**. Raw text, raw key values, and raw pixel coordinates do NOT appear:

| Field                         | Type                        | Notes                                                                                                              |
| ----------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `session_id`                  | string                      | Open computer-use session.                                                                                         |
| `motebit_id`                  | string                      | Identity binding.                                                                                                  |
| `outcome`                     | `"forwarded" \| "rejected"` | Forward attempt result.                                                                                            |
| `rejection_reason`            | enum, optional              | `"not_in_user_state" \| "session_closed" \| "transport_error" \| "not_supported"`. Present iff `outcome` rejected. |
| `control_state_at_forwarding` | `ControlState`              | Mirrors `control_state_at_denial` on motebit-side denials — verifiers reconstruct context without cross-reference. |
| `detail`                      | per-kind shape              | See below.                                                                                                         |
| `timestamp`                   | int                         | Unix millis.                                                                                                       |

Per-kind audit detail:

- **click** — `{ kind: "click", x_norm: float, y_norm: float, button: "left"\|"right"\|"middle" }`. Coordinates are normalized [0, 1] against the rendered screencast rect; raw logical pixels are NOT logged.
- **key** — `{ kind: "key", character_class, key_role, modifiers }`. `character_class ∈ {"letter","digit","punct","whitespace","control","modifier","unknown"}`. `key_role ∈ {"enter","tab","escape","backspace","arrow","shortcut","printable","unknown"}`. Raw key value is NOT logged. Multi-char unrecognized key names (e.g. IME composition strings) MUST collapse to `character_class: "unknown"` rather than being classified by their first character.
- **paste** — `{ kind: "paste", length: int, line_count: int, looks_like_url: bool }`. `looks_like_url` is `^https?://...` matching only. Content is NEVER logged.
- **wheel** — `{ kind: "wheel", x_norm: float, y_norm: float, dx: int, dy: int, event_count: int }`. Anchor coords are normalized [0, 1] like clicks. Deltas pass through unchanged — wheel deltas are CSS-pixel scroll amounts, not sensitivity-bearing content; logging them is not a privacy concern. `event_count` records interaction density (how many native events were coalesced into this one).
- **navigate** — `{ kind: "navigate", scheme: string, host: string, has_path: bool, has_query: bool }`. URL host preserved; **path and query stripped**. URLs commonly carry session tokens, bearer tokens, account ids, or sensitive identifiers (`?reset_token=...`, `/patient/12345`); the user's signed audit log is a more permanent artifact than a browser history, so conservative redaction is correct. `has_path` / `has_query` retain "did the user submit a deep link" without leaking the link contents. Malformed URLs collapse to `{ scheme: "unknown", host: "unknown", has_path: false, has_query: false }` (defensive — server-side dispatch will fail anyway).

#### Sensitivity boundary — Slice 2c does NOT change policy

User-driven screencast frames are still observations. The runtime's existing sensitivity-classification policy (§6) applies unchanged. Slice 2c documents this boundary explicitly: implementations SHOULD NOT silently treat user-driven frames as safe just because the user is the actor. Before medical / financial / secret session use of co-browse, implementations MUST run a policy pass on the screencast surface itself.

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
- `apps/desktop` — Tauri Rust bridge. Real screen capture (`xcap`), input injection (`enigo`), macOS Vision OCR for the redaction-classifier path.
- `@motebit/runtime` — the dispatcher seam (`ComputerPlatformDispatcher`) and the second producer (`CloudBrowserDispatcher`). See §8.1.
- `services/browser-sandbox` — the cloud-browser executor backing `CloudBrowserDispatcher`. See §8.1.

Surface matrix — **OS-reach** semantics. The "real OS" column answers: can this surface drive the user's actual operating system? It does not include the cloud-browser dispatcher, which is a different runtime backend (one that drives an isolated Chromium context, not the user's OS):

| Surface | OS-reach handler      | Notes                                                                                                       |
| ------- | --------------------- | ----------------------------------------------------------------------------------------------------------- |
| Desktop | Tauri Rust bridge     | Drives the user's real OS. `desktop_drive` embodiment.                                                      |
| Web     | `not_supported` error | Browser sandbox cannot reach OS. Use the cloud-browser dispatcher instead for `virtual_browser` embodiment. |
| Mobile  | `not_supported` error | Same.                                                                                                       |
| Spatial | `not_supported` error | Same.                                                                                                       |
| CLI     | `not_supported` error | No physical display to observe.                                                                             |

### 8.1 — Cloud browser dispatcher

The same wire format drives a second physical executor: an isolated cloud-browser session (Playwright-driven Chromium) hosted by `services/browser-sandbox`. The dispatcher is `CloudBrowserDispatcher` in `@motebit/runtime` (`packages/runtime/src/cloud-browser-dispatcher.ts`).

**What changes** (vs the desktop dispatcher):

- Source of perception: `isolated-browser` (per `EMBODIMENT_MODE_CONTRACTS.virtual_browser`), not the user's real OS.
- Embodiment mode: `virtual_browser`, not `desktop_drive`.
- Session lifecycle: `dispatcher.queryDisplay()` opens a Chromium context server-side and stashes the cloud session id; `dispatcher.dispose(sessionId)` tears it down. Idempotent; subsequent disposes are no-ops.
- Auth: caller-supplied bearer token via `getAuthToken` callback. The cloud-browser service verifies; the dispatcher is transport only.

**What stays identical:**

- Wire format. Every `ComputerActionKind` (`screenshot`, `cursor_position`, `click`, `double_click`, `mouse_move`, `drag`, `key`, `type`, `scroll`, `navigate`) is supported verbatim. The `navigate` kind was added when the cloud-browser sandbox's headless Playwright runtime hit "navigate to tesla.com" — there's no address bar in a headless viewport for `key`/`type` to drive, so the spec's promotion path (§"v1 limits — No new wire-format actions… real-usage-driven, not speculative") fired. Cloud-browser dispatcher implements via `page.goto(url)`; desktop dispatcher does not implement (no OS-level browser context — the user controls which app is focused). The dispatcher-parity check carries an explicit ALLOWLIST entry for desktop.
- Foundation-law invariants (§3.1 signed observations, §3.2 gated actions, §3.3 user-floor, §3.4 redaction-before-AI, §3.5 session identity). The session-manager hooks (`classify`, `classifyObservation`, `approvalFlow`) wrap the cloud dispatcher exactly as they wrap the desktop one.
- Outcome taxonomy (§7.1). HTTP errors map to `ComputerFailureReason` values: 401/403 → `permission_denied`, 404/409 → `session_closed`, 429 → `policy_denied`, 501 → `not_supported`, other 4xx/5xx → `platform_blocked`. Network failures → `platform_blocked`.

**Consent posture (`virtual_browser`):**

- Session-scoped grant for the bulk of browser operation: `screenshot`, `cursor_position`, scroll, navigation, typing in ordinary fields.
- Per-action approval for irreversible actions — clicks whose `target_hint.label` matches the irreversibility heuristics in `@motebit/policy-invariants` (`Submit`, `Buy`, `Pay`, `File application`, `Send message`, `Permanently delete`, `I agree`, `Authorize app`, `Upload`). Sandboxing the browser does not sandbox the consequences: a "Submit application" click on a USPTO form is a real legal filing; a "Buy now" click places a real order. The user confirms before motebit commits.

**Sensitivity classification:** the cloud dispatcher returns observations verbatim; the session-manager's `classifyObservation` hook applies the same OCR-aware classifier (`classifyScreenshotWithOcr` in `@motebit/policy-invariants`) used by the desktop path. URL classification is the cheap pre-check; **screenshot/page-text classification is the load-bearing one** — if the page content classifies as `medical` / `financial` / `secret`, the manager's redaction layer strips bytes before the AI sees the observation. Fail-closed: an unclassifiable observation defaults to stricter handling.

**v1 limits (kept honest):**

- One active cloud session per dispatcher instance per motebit. The contract grows a `session_id` parameter on `execute` for both backends when concurrent cloud sessions become a real consumer need.
- Motebit-driven only. The "user drives motebit's sandbox" pattern (co-browse) is a distinct future embodiment row, not a runtime mode of this dispatcher. `shared_gaze` continues to mean user-pre-existing-source crossing into perception, not user-driving-motebit's-sandbox.
- The `navigate(url)` action was added when real cloud-browser usage demanded it (see §"What stays identical" above). Future additions follow the same pattern — driven by a producer that needs the primitive, not by speculation.

**Promotion path:** this is the second producer the @alpha annotations on `packages/protocol/src/computer-use.ts` are gating on (the protocol release-status block names "cloud-browser surface" or "federation peer replaying an audit log"). When `services/browser-sandbox` is exercising the format in anger, `@alpha` promotes to `@beta`; `@public` follows when a federation peer also replays an audit log.

---

## 9. Known Gaps

- Idempotency / sequencing fields (`request_id`, `sequence_no`, `parent_event_id`) — deferred to v1.1 once implementation exposes retry/replay needs.
- Session-capabilities advertisement at `ComputerSessionOpened` — deferred to v1.1.
- Semantic observations (focused element, active app, window title, frontmost bundle id) — deferred to v1.1; cheaper than screenshots and high-signal.
- Multi-monitor support (v2 extension via `display_id`).
- Accessibility-tree full detail format (opaque in v1; `target_hint` is the interim hook).
- Sensitivity classification model specifics (implementation-defined in v1; standardized in v2).
