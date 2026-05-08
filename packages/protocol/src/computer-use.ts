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
 *
 * ── Release status ───────────────────────────────────────────────────
 *
 * Every export in this file carries `@alpha` — the wire format was revised
 * on 2026-04-22 in response to external principal review (commit 54158b11,
 * flat envelope → nested discriminated union) and has only soaked inside
 * the monorepo since. `@alpha` carves these types out of `@motebit/protocol`'s
 * SemVer contract for the 1.x series: the `check-api-surface` baseline still
 * tracks their shape so unintended drift is caught, but a shape reshape does
 * not force a major bump. Promote to `@beta` → `@public` once a second
 * producer (cloud-browser surface, federation peer replaying an audit log)
 * or a non-desktop-shim consumer exercises the format in anger.
 */

// ── Primitives ───────────────────────────────────────────────────────

/**
 * A point in primary-display logical pixel coordinates. `(0, 0)` = top-left.
 * @alpha
 */
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
 * @alpha
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

/**
 * Capture the primary display's current frame.
 * @alpha
 */
export interface ScreenshotAction {
  readonly kind: "screenshot";
}

/**
 * Read the current cursor coordinates.
 * @alpha
 */
export interface CursorPositionAction {
  readonly kind: "cursor_position";
}

/**
 * Single mouse click at `target`.
 * @alpha
 */
export interface ClickAction {
  readonly kind: "click";
  readonly target: ComputerPoint;
  /** `"left" | "right" | "middle"`. Defaults to `"left"`. */
  readonly button?: string;
  /** Subset of `["cmd", "ctrl", "alt", "shift"]`. */
  readonly modifiers?: readonly string[];
  readonly target_hint?: ComputerTargetHint;
}

/**
 * Two clicks in rapid succession at `target`.
 * @alpha
 */
export interface DoubleClickAction {
  readonly kind: "double_click";
  readonly target: ComputerPoint;
  readonly button?: string;
  readonly modifiers?: readonly string[];
  readonly target_hint?: ComputerTargetHint;
}

/**
 * Move cursor to `target` without clicking.
 * @alpha
 */
export interface MouseMoveAction {
  readonly kind: "mouse_move";
  readonly target: ComputerPoint;
  readonly target_hint?: ComputerTargetHint;
}

/**
 * Press at `from`, move to `to`, release.
 * @alpha
 */
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

/**
 * Keyboard text input.
 * @alpha
 */
export interface TypeAction {
  readonly kind: "type";
  readonly text: string;
  /**
   * Per-character delay in ms. Omitted = implementation default. Set to a
   * stable value for deterministic replay of typing cadence.
   */
  readonly per_char_delay_ms?: number;
}

/**
 * Keyboard combination. Example: `"cmd+c"`, `"ctrl+shift+t"`, `"escape"`.
 * @alpha
 */
export interface KeyAction {
  readonly kind: "key";
  readonly key: string;
}

/**
 * Scroll at `target` by `(dx, dy)` wheel deltas.
 * @alpha
 */
export interface ScrollAction {
  readonly kind: "scroll";
  readonly target: ComputerPoint;
  readonly dx: number;
  readonly dy: number;
}

/**
 * Navigate the active browser context to `url`. Cloud-browser-only in
 * v1: the headless Playwright runtime in `services/browser-sandbox`
 * has no address-bar UI for `key`/`type` to drive, so the spec
 * promotion path
 * (`spec/computer-use-v1.md` §"No new wire-format actions… real-usage-
 * driven, not speculative") fired when the AI hit "navigate to
 * tesla.com" against the cloud-browser dispatcher.
 *
 * Desktop dispatcher (`apps/desktop/src-tauri/src/computer_use.rs`)
 * does NOT implement this action — OS-level computer-use has no
 * notion of "the active browser context"; the user is in control of
 * which app is focused. The dispatcher-parity check at
 * `scripts/check-computer-use-dispatcher-parity.ts` carries an
 * ALLOWLIST entry naming desktop as deferred until an OS-level
 * navigation use-case proves itself.
 * @alpha
 */
export interface NavigateAction {
  readonly kind: "navigate";
  /**
   * Target URL. Implementations SHOULD normalize relative-looking
   * inputs (`example.com` → `https://example.com`) but MAY reject
   * malformed inputs with a `not_supported` failure.
   */
  readonly url: string;
}

/**
 * Full action taxonomy. Every concrete action the motebit can request is
 * one of these. Exhaustive discriminated union on `kind`.
 * @alpha
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
  | ScrollAction
  | NavigateAction;

/**
 * Discriminator values — useful for JSON Schema enum and runtime validation.
 * @alpha
 */
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
  "navigate",
] as const;

/** @alpha */
export type ComputerActionKind = (typeof COMPUTER_ACTION_KINDS)[number];

// ── Request envelope ─────────────────────────────────────────────────

/**
 * One invocation of the `computer` tool. The `action` field holds a nested
 * discriminated variant; all action-specific fields live inside that
 * object. Impossible states are structurally unrepresentable.
 * @alpha
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
 * @alpha
 */
export type ComputerObservationResult = ScreenshotObservation | CursorPositionObservation;

/**
 * Structured redaction metadata. Replaces a bare boolean — a verifier can
 * now prove *what* was redacted, under *which* policy version, and whether
 * the bytes the AI saw are raw or a projection.
 * @alpha
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
 * @alpha
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

/**
 * Cursor-position observation — single coordinate pair.
 * @alpha
 */
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
 * @alpha
 */
export interface ComputerSessionOpened {
  readonly session_id: string;
  readonly motebit_id: string;
  readonly display_width: number;
  readonly display_height: number;
  readonly scaling_factor: number;
  readonly opened_at: number;
}

/**
 * Signed event emitted when a computer-use session ends.
 * @alpha
 */
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
 * @alpha
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

/** @alpha */
export type ComputerFailureReason = (typeof COMPUTER_FAILURE_REASONS)[number];

// ── Session-summary receipt (v1.5) ───────────────────────────────────
//
// Closes the asymmetry where `ExecutionReceipt` and `ToolInvocationReceipt`
// commit to AI-loop work cryptographically but computer-use sessions
// emit only `ComputerSessionOpened` / `ComputerSessionClosed` lifecycle
// events. After v1.5 every session crystallizes at close into one
// signed `ComputerSessionReceipt` — counts, sensitivity envelope,
// approval / halt outcomes, and a SHA-256 over the canonical
// per-action structural roll-up. A verifier with the signer's public
// key can prove the session existed, ran exactly N actions in this
// shape, and produced this outcome distribution, without needing the
// raw observation bytes (which may be sensitive) or the relay.
//
// Same tactical pattern as `ToolInvocationReceipt`: structural facts
// only, hash-binds to detail held elsewhere, JCS canonicalization,
// Ed25519 under the canonical motebit suite. Sign / verify helpers
// live in `@motebit/crypto`'s `artifacts.ts` (sibling of
// `signToolInvocationReceipt`).

/**
 * Per-action structural roll-up entry. The runtime appends one of these
 * to the in-session log on every `executeAction` call, regardless of
 * outcome. The canonical JSON of the array (in dispatch order) is
 * hashed into `ComputerSessionReceipt.actions_hash` at session close.
 *
 * Carries kind + timing + outcome only — never targets, args, screenshot
 * bytes, OCR text, or any payload that could leak content. The
 * `failure_reason` is present iff `outcome === "failure"`.
 *
 * Why a separate type rather than reusing `ComputerActionRequest`:
 * the request type carries action-specific payloads (target points,
 * type strings, drag deltas). The receipt commits to *structure*, not
 * *intent* — the per-action ToolInvocationReceipt already commits to
 * the args via `args_hash`. Splitting the two keeps the session
 * receipt's privacy invariant (no leak surface) compositional with
 * the per-action receipt's audit invariant.
 * @alpha
 */
export interface ComputerSessionActionRecord {
  readonly kind: ComputerActionKind;
  readonly started_at: number;
  readonly completed_at: number;
  readonly outcome: "success" | "failure";
  readonly failure_reason?: ComputerFailureReason;
}

/**
 * Body of a `ComputerSessionReceipt` *before* it is signed. The signer
 * stamps `suite` and `signature`. Embedded as the input shape of the
 * runtime's session summarizer; the signer (`@motebit/crypto`'s
 * `signComputerSessionReceipt`) consumes this and emits a
 * `ComputerSessionReceipt`.
 * @alpha
 */
export interface SignableComputerSessionReceipt {
  readonly receipt_id: string;
  readonly session_id: string;
  readonly motebit_id: string;
  readonly public_key?: string;
  /**
   * Embodiment mode the session ran under (`"virtual_browser"`,
   * `"desktop_drive"`, etc.). Free-typed string here for the same
   * reason `ToolDefinition.embodimentMode` is — the canonical
   * `EmbodimentMode` union lives in `@motebit/render-engine` and
   * promoting it into the protocol layer is a separate slice.
   * Production callers always pass a member of `EMBODIMENT_MODES`;
   * verifiers should treat unknown strings as opaque-but-valid.
   */
  readonly embodiment_mode: string;
  readonly display_width: number;
  readonly display_height: number;
  readonly scaling_factor: number;
  readonly opened_at: number;
  readonly closed_at: number;
  /** Free-text closure code from `ComputerSessionClosed.reason`. */
  readonly close_reason?: string;
  /** Total actions dispatched during the session. */
  readonly action_count: number;
  /** Action outcome counts. `success + failure === action_count`. */
  readonly outcomes_summary: {
    readonly success: number;
    readonly failure: number;
  };
  /**
   * Per-failure-reason counts. Closed key set
   * (`ComputerFailureReason`); absent keys mean zero. Sum of values
   * equals `outcomes_summary.failure`.
   */
  readonly failure_breakdown: { readonly [K in ComputerFailureReason]?: number };
  /**
   * True if `ComputerSessionManager.halt()` fired during this session
   * (spec §3.3 user-floor primitive). A halted session that resumed
   * and continued still has `was_halted: true` — the flag commits to
   * "the user paused at least once," not to terminal state.
   */
  readonly was_halted: boolean;
  /**
   * Highest sensitivity tier observed across all action observations
   * during the session. Closed `SensitivityLevel` union by
   * convention — encoded as the string value (e.g. `"financial"`).
   * The runtime's observation classifier sets this; absence implies
   * `"none"` (no observation rose above the floor).
   */
  readonly max_sensitivity: string;
  /**
   * SHA-256 hex digest of JCS-canonicalized
   * `ReadonlyArray<ComputerSessionActionRecord>` in dispatch order.
   * Verifiers with the per-action records recompute and match;
   * verifiers without the records still get the signature's commit
   * to the digest itself.
   */
  readonly actions_hash: string;
}

/**
 * Signed proof that a computer-use session ran with this exact
 * shape. Sibling of `ExecutionReceipt` and `ToolInvocationReceipt`.
 *
 *   - Self-verifiable: a third party with the signer's public key
 *     can verify without contacting any relay.
 *   - Structural-only: never carries observation bytes, OCR text,
 *     action targets, or any content that could leak. The
 *     `actions_hash` binds to a roll-up; per-action
 *     `ToolInvocationReceipt`s carry the args/result hashes.
 *   - Issued at session close. The runtime emits one per
 *     `closeSession()` call (including idempotent replays of an
 *     already-closed session).
 *   - Composes with delegation: a session whose outer task was
 *     delegated produces a `ComputerSessionReceipt` AND a
 *     `DelegationReceipt`. Verifiers can chain the two by
 *     `motebit_id` + timeframe.
 * @alpha
 */
export interface ComputerSessionReceipt extends SignableComputerSessionReceipt {
  /**
   * Cryptosuite discriminator. Always `"motebit-jcs-ed25519-b64-v1"`
   * today. Widening requires a registry change in `SuiteId` + a new
   * dispatch arm in `@motebit/crypto`, not a wire-format break.
   */
  readonly suite: "motebit-jcs-ed25519-b64-v1";
  readonly signature: string;
}
