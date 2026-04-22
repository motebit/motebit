/**
 * Computer-use payload types — wire format for `computer-use-v1.md`.
 *
 * A motebit with a desktop surface (Tauri) can observe and act on the user's
 * computer: screenshot, move, click, type, scroll. This spec pins the wire
 * format of each action and observation so the signed audit trail is
 * implementation-agnostic — a non-TypeScript verifier can validate payloads
 * against the committed JSON Schema rather than TypeScript's structural view.
 *
 * Four top-level payload types cover the full surface:
 *   1. `ComputerActionRequest`     — every observation/action invocation
 *   2. `ComputerObservationResult` — the data field of observation results
 *   3. `ComputerSessionOpened`     — session-start signed event
 *   4. `ComputerSessionClosed`     — session-end signed event
 *
 * Every type named here is referenced by a `### X.Y — Name` section under a
 * `#### Wire format (foundation law)` block in `spec/computer-use-v1.md`,
 * so `check-spec-coverage` (invariant #9) keeps the spec and types in
 * lockstep. Implementing package declarations live in
 * `packages/tools/package.json`'s `motebit.implements` array (tool surface)
 * plus `apps/desktop/package.json` (Tauri bridge), enforced by
 * `check-spec-impl-coverage` (invariant #31).
 */

/**
 * One invocation of the `computer` tool. Discriminated by `action`.
 *
 * Coordinates are unsigned integer pixels in the primary display's
 * coordinate space with `(0, 0)` at top-left. Scaling factors (Retina,
 * HiDPI) are resolved by the surface implementation, not the model or the
 * wire format. All fields except `session_id` and `action` are optional at
 * the wire level — specific `action` values make certain fields required
 * via runtime validation, see `@motebit/wire-schemas`.
 */
export interface ComputerActionRequest {
  /** Open session the action belongs to. */
  readonly session_id: string;
  /** Discriminator. One of: screenshot, cursor_position, click,
   *  double_click, mouse_move, drag, type, key, scroll. */
  readonly action: string;
  /** Target X pixel for click / double_click / mouse_move / drag-start / scroll. */
  readonly x?: number;
  /** Target Y pixel. */
  readonly y?: number;
  /** Drag-end X. Required when `action === "drag"`. */
  readonly x1?: number;
  /** Drag-end Y. */
  readonly y1?: number;
  /** Mouse button. Defaults to "left". */
  readonly button?: string;
  /** Modifier keys held during the action. Subset of `["cmd", "ctrl", "alt", "shift"]`. */
  readonly modifiers?: readonly string[];
  /** Keyboard text. Required when `action === "type"`. */
  readonly text?: string;
  /** Key combination. Required when `action === "key"`. Examples: `"cmd+c"`, `"escape"`. */
  readonly key?: string;
  /** Scroll wheel delta X. */
  readonly dx?: number;
  /** Scroll wheel delta Y. */
  readonly dy?: number;
}

/**
 * Returned in the `data` field of a successful observation action's
 * `ToolResult`. Carries either a screenshot blob or a cursor position,
 * discriminated by `kind`.
 *
 * For `kind === "screenshot"`: the image bytes are base64-encoded with the
 * format in `image_format`. If `redaction_applied` is `true`, the sensitivity
 * classification layer masked one or more regions in the returned bytes
 * before handing them to the caller (see spec §6).
 */
export interface ComputerObservationResult {
  /** Session the observation belongs to. */
  readonly session_id: string;
  /** Discriminator. `"screenshot"` or `"cursor_position"`. */
  readonly kind: string;
  /** Screenshot only. `"png"` or `"jpeg"`. */
  readonly image_format?: string;
  /** Screenshot only. Base64-encoded image bytes. */
  readonly image_base64?: string;
  /** Screenshot only. Image width in pixels. */
  readonly width?: number;
  /** Screenshot only. Image height in pixels. */
  readonly height?: number;
  /** Cursor-position only. Current cursor X in primary display coordinates. */
  readonly x?: number;
  /** Cursor-position only. Current cursor Y. */
  readonly y?: number;
  /** Unix ms when the capture was taken. */
  readonly captured_at: number;
  /**
   * `true` iff the sensitivity classification layer masked one or more
   * regions before these bytes left the OS-access boundary. The raw
   * unredacted capture stays on-device in the receipt artifact store.
   */
  readonly redaction_applied: boolean;
}

/**
 * Signed event emitted when a computer-use session begins. Carries the
 * primary display's dimensions and scaling factor so the AI knows the
 * coordinate space subsequent actions will operate in.
 */
export interface ComputerSessionOpened {
  /** Newly allocated session identifier (ULID). */
  readonly session_id: string;
  /** Identity binding. */
  readonly motebit_id: string;
  /** Primary display logical width in pixels. */
  readonly display_width: number;
  /** Primary display logical height in pixels. */
  readonly display_height: number;
  /** Display scaling factor (Retina = 2.0, HiDPI variable). */
  readonly scaling_factor: number;
  /** Unix ms. */
  readonly opened_at: number;
}

/**
 * Signed event emitted when a computer-use session ends. No payload beyond
 * identity + timestamp + optional reason; the event's presence in the
 * audit log is the signal.
 */
export interface ComputerSessionClosed {
  readonly session_id: string;
  readonly closed_at: number;
  /** Free-text code. Examples: `"user_closed"`, `"timeout"`, `"error"`. */
  readonly reason?: string;
}
