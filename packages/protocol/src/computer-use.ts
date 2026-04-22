/**
 * Computer-use payload types — wire format for `computer-use-v1.md`.
 *
 * A motebit with a desktop surface (Tauri) can observe and act on the user's
 * computer: screenshot, move, click, type, scroll. This spec pins the wire
 * format of each action and observation so the signed audit trail is
 * implementation-agnostic — a non-TypeScript verifier can validate payloads
 * against the committed JSON Schema rather than TypeScript's structural view.
 *
 * Shape: actions are a **nested discriminated union** (`action: { kind, ... }`)
 * not a flat envelope. Impossible states are structurally unrepresentable —
 * drag-only fields never appear on a click, type-only fields never appear on
 * a scroll. Cross-language SDKs (Rust enums, Python tagged unions) map
 * directly; JSON Schema emits clean `oneOf` branches; model output stays
 * rigorous.
 *
 * Observation results carry **artifact references** (`artifact_id +
 * artifact_sha256`) not inline bytes. The receipt artifact store (see
 * `spec/execution-ledger-v1.md`) holds the bytes; the observation payload
 * binds to them by hash. Keeps signed receipts O(bytes of metadata) instead
 * of O(bytes of image). Git / IPFS / S3+hash pattern.
 *
 * Every type named here is referenced by a `### X.Y — Name` section under a
 * `#### Wire format (foundation law)` block in `spec/computer-use-v1.md`,
 * so `check-spec-coverage` (invariant #9) keeps the spec and types in
 * lockstep.
 */

// ── Primitives ───────────────────────────────────────────────────────

/** A point in primary-display logical pixel coordinates. `(0, 0)` = top-left. */
export interface ComputerPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Optional semantic target information attached to pointer actions. When
 * available from the accessibility layer or DOM, it lets verifiers and
 * approval UX explain "motebit clicked the Send button" instead of only
 * "(512, 384)". Execution still happens at the pixel coordinates in
 * `target`; the hint is advisory.
 */
export interface ComputerTargetHint {
  /** Role name. Examples: `"button"`, `"link"`, `"textbox"`, `"menuitem"`. */
  readonly role?: string;
  /** Accessible label or visible text. */
  readonly label?: string;
  /**
   * Where the hint came from. `"accessibility"` (OS AX API), `"dom"`
   * (browser inspection), `"vision"` (OCR/ML), `"user_annotation"` (user
   * labeled the region in-session).
   */
  readonly source: string;
}

// ── Action variants ──────────────────────────────────────────────────

/** Capture the primary display's current frame. */
export interface ScreenshotAction {
  readonly kind: "screenshot";
}

/** Read the current cursor coordinates. */
export interface CursorPositionAction {
  readonly kind: "cursor_position";
}

/** Single mouse click at `target`. */
export interface ClickAction {
  readonly kind: "click";
  readonly target: ComputerPoint;
  /** `"left" | "right" | "middle"`. Defaults to `"left"`. */
  readonly button?: string;
  /** Subset of `["cmd", "ctrl", "alt", "shift"]`. */
  readonly modifiers?: readonly string[];
  readonly target_hint?: ComputerTargetHint;
}

/** Two clicks in rapid succession at `target`. */
export interface DoubleClickAction {
  readonly kind: "double_click";
  readonly target: ComputerPoint;
  readonly button?: string;
  readonly modifiers?: readonly string[];
  readonly target_hint?: ComputerTargetHint;
}

/** Move cursor to `target` without clicking. */
export interface MouseMoveAction {
  readonly kind: "mouse_move";
  readonly target: ComputerPoint;
  readonly target_hint?: ComputerTargetHint;
}

/** Press at `from`, move to `to`, release. */
export interface DragAction {
  readonly kind: "drag";
  readonly from: ComputerPoint;
  readonly to: ComputerPoint;
  readonly button?: string;
  readonly modifiers?: readonly string[];
  /** Total drag duration in ms. Implementation may interpolate intermediate points. */
  readonly duration_ms?: number;
  readonly target_hint?: ComputerTargetHint;
}

/** Keyboard text input. */
export interface TypeAction {
  readonly kind: "type";
  readonly text: string;
  /**
   * Per-character delay in ms. Omitted = implementation default. Set to a
   * stable value for deterministic replay of typing cadence.
   */
  readonly per_char_delay_ms?: number;
}

/** Keyboard combination. Example: `"cmd+c"`, `"ctrl+shift+t"`, `"escape"`. */
export interface KeyAction {
  readonly kind: "key";
  readonly key: string;
}

/** Scroll at `target` by `(dx, dy)` wheel deltas. */
export interface ScrollAction {
  readonly kind: "scroll";
  readonly target: ComputerPoint;
  readonly dx: number;
  readonly dy: number;
}

/**
 * Full action taxonomy. Every concrete action the motebit can request is
 * one of these. Exhaustive discriminated union on `kind`.
 */
export type ComputerAction =
  | ScreenshotAction
  | CursorPositionAction
  | ClickAction
  | DoubleClickAction
  | MouseMoveAction
  | DragAction
  | TypeAction
  | KeyAction
  | ScrollAction;

/** Discriminator values — useful for JSON Schema enum and runtime validation. */
export const COMPUTER_ACTION_KINDS = [
  "screenshot",
  "cursor_position",
  "click",
  "double_click",
  "mouse_move",
  "drag",
  "type",
  "key",
  "scroll",
] as const;

export type ComputerActionKind = (typeof COMPUTER_ACTION_KINDS)[number];

// ── Request envelope ─────────────────────────────────────────────────

/**
 * One invocation of the `computer` tool. The `action` field holds a nested
 * discriminated variant; all action-specific fields live inside that
 * object. Impossible states are structurally unrepresentable.
 */
export interface ComputerActionRequest {
  /** Open session the action belongs to. */
  readonly session_id: string;
  readonly action: ComputerAction;
}

// ── Observation results ──────────────────────────────────────────────

/**
 * Outcome of a successful observation action's execution. Returned as the
 * `data` field of a `ToolResult`. Discriminated by `kind`.
 */
export type ComputerObservationResult = ScreenshotObservation | CursorPositionObservation;

/**
 * Structured redaction metadata. Replaces a bare boolean — a verifier can
 * now prove *what* was redacted, under *which* policy version, and whether
 * the bytes the AI saw are raw or a projection.
 */
export interface ComputerRedaction {
  /** `true` iff any region was classified as sensitive and masked. */
  readonly applied: boolean;
  /**
   * Projection shape of the bytes the AI consumed. `"raw"` = unmodified
   * capture, `"masked"` = regions replaced with solid fill,
   * `"blurred"` = regions convolved, `"cropped"` = sensitive regions
   * removed from frame. Surfaces MAY add projection kinds in v1.1.
   */
  readonly projection_kind: string;
  /** Version string of the sensitivity-classification policy that ran. */
  readonly policy_version?: string;
  /** Number of regions classified as sensitive in the raw frame. */
  readonly classified_regions_count?: number;
  /**
   * SHA-256 digest of a canonical JSON array of classified regions
   * (each region: `{ x, y, w, h, classification }`). Lets a verifier
   * replay what was masked without exposing the region list in the
   * receipt if policy dictates.
   */
  readonly classified_regions_digest?: string;
}

/**
 * Screenshot observation. Bytes live in the receipt artifact store keyed
 * by `artifact_id` and bound by `artifact_sha256`. When redaction produces
 * a distinct projection (e.g. masked image), both the raw and projection
 * artifact IDs are referenced so a verifier can fetch either depending on
 * authorization.
 */
export interface ScreenshotObservation {
  readonly kind: "screenshot";
  readonly session_id: string;
  /** Artifact ID of the raw capture in the artifact store. */
  readonly artifact_id: string;
  /** SHA-256 of the raw capture's bytes. */
  readonly artifact_sha256: string;
  /** `"png" | "jpeg"`. */
  readonly image_format: string;
  /** Image width in logical pixels. */
  readonly width: number;
  /** Image height in logical pixels. */
  readonly height: number;
  /** Unix ms of the capture. */
  readonly captured_at: number;
  readonly redaction: ComputerRedaction;
  /**
   * Artifact ID of the redacted projection, when `redaction.applied` and
   * the projection differs from the raw capture. When absent, the AI saw
   * the raw bytes (redaction.projection_kind === "raw").
   */
  readonly projection_artifact_id?: string;
  /** SHA-256 of the projection bytes. Paired with `projection_artifact_id`. */
  readonly projection_artifact_sha256?: string;
}

/** Cursor-position observation — single coordinate pair. */
export interface CursorPositionObservation {
  readonly kind: "cursor_position";
  readonly session_id: string;
  readonly x: number;
  readonly y: number;
  readonly captured_at: number;
}

// ── Session lifecycle events ─────────────────────────────────────────

/**
 * Signed event emitted when a computer-use session begins. Carries the
 * primary display's dimensions and scaling factor so the AI knows the
 * coordinate space subsequent actions will operate in.
 *
 * `display_width` and `display_height` are logical pixels (the dimensions
 * action coordinates live in). `scaling_factor` is the logical-to-physical
 * ratio (Retina = 2.0). Screenshot dimensions returned in observations
 * match the logical dimensions, not the physical raster.
 */
export interface ComputerSessionOpened {
  readonly session_id: string;
  readonly motebit_id: string;
  readonly display_width: number;
  readonly display_height: number;
  readonly scaling_factor: number;
  readonly opened_at: number;
}

/** Signed event emitted when a computer-use session ends. */
export interface ComputerSessionClosed {
  readonly session_id: string;
  readonly closed_at: number;
  /** Free-text code. Examples: `"user_closed"`, `"timeout"`, `"error"`. */
  readonly reason?: string;
}

// ── Outcome taxonomy ─────────────────────────────────────────────────

/**
 * Structured failure reasons a computer-use action may return. Every
 * implementation MUST emit one of these (or a v1.1-extended value) on
 * failure so the motebit's reasoning loop and the governance audit can
 * discriminate cases deterministically.
 *
 *   policy_denied      — governance classified the action as deny
 *   approval_required  — governance classified as require_approval; no consent yet
 *   approval_expired   — consent was obtained but its window elapsed
 *   permission_denied  — OS refused (e.g. no Screen Recording permission on macOS)
 *   session_closed     — action fired outside an open session
 *   target_not_found   — element at `target` coords no longer exists (accessibility-verified fail)
 *   target_obscured    — element exists but is covered (menu over it, etc.)
 *   user_preempted     — physical user input interrupted mid-dispatch
 *   platform_blocked   — OS blocked synthetic input (secure password field, elevation boundary)
 *   not_supported      — surface cannot execute computer use at all
 */
export const COMPUTER_FAILURE_REASONS = [
  "policy_denied",
  "approval_required",
  "approval_expired",
  "permission_denied",
  "session_closed",
  "target_not_found",
  "target_obscured",
  "user_preempted",
  "platform_blocked",
  "not_supported",
] as const;

export type ComputerFailureReason = (typeof COMPUTER_FAILURE_REASONS)[number];
