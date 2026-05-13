/**
 * Co-browse — control state machine for the `virtual_browser`
 * embodiment.
 *
 * Doctrine: `motebit-computer.md` §"Embodiment modes" places co-browse
 * as a *substate* of `virtual_browser`, not a new mode. Same isolated
 * Chromium, same session-scoped consent boundary; what changes is who
 * holds the pointer/keyboard. The `ControlState` here is the typed
 * "who's driving" axis the runtime + slab + dispatcher all read.
 *
 * Why a discriminated union and not a flat enum. The four state names
 * (`user`, `motebit`, `handoff_pending`, `paused`) are stable; what
 * varies is the data each state carries. `handoff_pending` needs to
 * know who currently holds and who's requesting (so a deny resolves
 * to the right side); `paused` needs to remember who was driving so
 * `resume` doesn't lose continuity. Discriminated union keeps the
 * face of the type aligned with the four-state shape while making
 * the per-state shape a compile-time fact, not a "remember to
 * inspect this field when kind is X" comment.
 *
 * Why fail-closed-to-user on disconnect. The user is the always-
 * trusted party in motebit's trust model — every other party
 * (including the motebit itself, including any peer) is downstream of
 * the user's identity. A connection drop could mean the user has
 * actively stopped the session, lost network, or closed the tab; in
 * any of those cases the safest semantics is revert-to-user (the
 * motebit cannot continue acting on a page the user can no longer
 * observe). Doctrine: spec/computer-use-v1.md §3.3 user-floor
 * invariant, applied to control rather than dispatch.
 *
 * @alpha
 */

/**
 * Who currently holds (or is requesting) drive control of the
 * isolated browser. Two parties only — peers don't hold control via
 * this primitive (that's a different substate of `virtual_browser`
 * gated through the federation trust graph).
 * @alpha
 */
export type ControlHolder = "user" | "motebit";

/**
 * The "who's driving" state of a co-browse session. Discriminated by
 * `kind`:
 *
 *   - `user` — user drives. Motebit observes via screencast. The
 *     default state at session open.
 *   - `motebit` — motebit drives. User observes. AI-loop tool calls
 *     to `computer` execute action; the live screencast surfaces
 *     what the AI is doing.
 *   - `handoff_pending` — a control change has been requested and
 *     is awaiting approval. `current` is the party currently holding;
 *     `requesting` is the party asking to take over. The `current`
 *     party still drives until the request resolves.
 *   - `paused` — neither party acts. Sourced from the v1.2 user-
 *     floor halt primitive; `previousDriver` lets `resume` restore
 *     continuity.
 *
 * Transitions are pure: every state is reachable only by the typed
 * inputs declared in `CoBrowseTransitionKind`. No "anything → any"
 * fallbacks — drift here would mean the consent contract becomes a
 * thing you discover at runtime, not a thing you read off the type.
 * @alpha
 */
export type ControlState =
  | { readonly kind: "user" }
  | { readonly kind: "motebit" }
  | {
      readonly kind: "handoff_pending";
      readonly current: ControlHolder;
      readonly requesting: ControlHolder;
    }
  | { readonly kind: "paused"; readonly previousDriver: ControlHolder };

/**
 * Closed set of transitions the state machine accepts. Every audit
 * event for a control change carries one of these as its
 * `transition_kind`. Adding a new kind is a protocol change — the
 * audit event's structural set must stay closed so verifiers know
 * which transitions are valid history.
 * @alpha
 */
export const CO_BROWSE_TRANSITION_KINDS = [
  "request_control",
  "grant_control",
  "deny_control",
  "reclaim_control",
  "release_control",
  // Agent-surface pivot — user voluntarily yields drive back to
  // motebit. Symmetric to `release_control` (motebit yields to user),
  // and the protocol-level partner to the `/back` surface affordance.
  // No approval required: the user's identity is the trust root and
  // they unilaterally decide who drives, including handing control
  // back to motebit. From `{kind: "user"}` only; from any other state
  // this is `invalid_from_state`. Closes the cobrowser-default-polarity
  // asymmetry where the protocol named "user takes" but not "user
  // gives" — implicit when user was the always-default driver, named
  // now that motebit-default is the new register. Doctrine:
  // chrome-as-state-render.md § "Take-the-wheel affordance in PR 1"
  // + the cobrowse-as-mode reshape's `/back` slice.
  "yield_control",
  "pause",
  "resume",
  "disconnect",
] as const;

/** @alpha */
export type CoBrowseTransitionKind = (typeof CO_BROWSE_TRANSITION_KINDS)[number];

/**
 * Audit-event payload for a co-browse control transition. Emitted on
 * every successful state change. Doctrine: every receipt is the
 * substrate of awareness — control transitions are receipt-level
 * events the agent can read back via `list_events` to reconstruct
 * "who was driving when."
 *
 * `from` and `to` are full `ControlState` values, so a verifier
 * replaying the event log can independently rebuild the state
 * machine without re-running the transition functions. `initiator`
 * is the party that requested the transition (for `disconnect` it's
 * `"system"` — the runtime detected the drop, not a party action).
 * @alpha
 */
export interface CoBrowseControlChangedPayload {
  readonly session_id: string;
  readonly motebit_id: string;
  readonly transition_kind: CoBrowseTransitionKind;
  readonly initiator: ControlHolder | "system";
  readonly from: ControlState;
  readonly to: ControlState;
  readonly timestamp: number;
}

// ── Slice 2c: user-driven input forwarding ─────────────────────────────
//
// When `controlState.kind === "user"`, the user drives the cloud
// Chromium directly via pointer + keyboard + paste events captured on
// the slab's screencast surface. These types pin both the wire
// format (what motebit's runtime forwards to the cloud-browser
// service) and the audit format (what lands in the signed event log).
//
// Two-layer discipline:
//
//   - **Wire format** (`UserInputEvent`) carries the raw data
//     Chromium needs to actually dispatch the input — exact text,
//     exact key, logical-pixel coordinates. Lives in transit, not in
//     audit storage.
//
//   - **Audit format** (`UserInputForwardedPayload`) is redacted by
//     construction. Keys log as character_class + key_role
//     (`letter`/`digit`/`enter`/`shortcut`/...), NOT raw text.
//     Pastes log length + line_count + looks_like_url, NOT content.
//     Pointer events log normalized [0, 1] coordinates (robust to
//     viewport resize, doesn't fingerprint cursor paths in
//     replayed logs).
//
// Discrete events only (Slice 2c scope): click, key, paste. Wheel,
// drag, continuous pointermove, selection-drag, file-drag are
// explicitly out — they require batching/coalescing that POST-per-
// event can't sustain at 30-100ms RTT × 50+ events/sec. Those slices
// follow once the substrate ships.

/**
 * Modifier keys held during a user input event. Booleans for each
 * standard modifier the AI loop's gate reads back; matches the
 * shape `KeyboardEvent` exposes in the browser.
 * @alpha
 */
export interface KeyModifiers {
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

/**
 * Wire format for a user-driven input event forwarded into the cloud
 * Chromium. Carries the raw data Chromium needs to dispatch (text,
 * coordinates) — the audit shape (`UserInputForwardedPayload`)
 * redacts before logging.
 *
 * Coordinate system: `click.x` and `click.y` are logical-pixel
 * coordinates against the cloud Chromium viewport (same coordinate
 * system `ComputerAction.click` uses for motebit-side dispatch).
 * The capture surface is responsible for translating screen pixels
 * to logical pixels via the screencast's natural dimensions.
 *
 * @alpha
 */
export type UserInputEvent =
  /**
   * Pointer click. Logical-pixel coordinates against the cloud
   * Chromium viewport.
   */
  | {
      readonly kind: "click";
      readonly x: number;
      readonly y: number;
      readonly button: "left" | "right" | "middle";
    }
  /**
   * Keyboard event. `key` is the browser `KeyboardEvent.key`
   * value — single character for printable input ("a"), named
   * key for control keys ("Enter", "Backspace"), Playwright-
   * compatible combo for shortcuts ("Control+a"). The cloud-browser
   * service maps:
   *   - Single printable char + no modifiers → `page.keyboard.type(key)`.
   *   - Named key OR any modifier present → `page.keyboard.press(combo)`.
   */
  | {
      readonly kind: "key";
      readonly key: string;
      readonly modifiers: KeyModifiers;
    }
  /**
   * Clipboard paste. The wire carries raw text; the audit logs only
   * length + line_count + looks_like_url (never content). Server-
   * side: dispatched as `page.keyboard.type(text)` for v1, which
   * synthesizes per-character keypresses. A future slice may
   * upgrade to CDP `Input.insertText` for true paste semantics.
   */
  | {
      readonly kind: "paste";
      readonly text: string;
    }
  /**
   * Mouse wheel scroll. Logical-pixel `(x, y)` is the cursor anchor
   * for the scroll (Playwright requires the cursor over the
   * scrollable element); `(dx, dy)` are the scroll deltas in CSS
   * pixels matching the browser `WheelEvent.deltaX`/`deltaY` axis
   * convention (positive `dy` scrolls down, positive `dx` scrolls
   * right). `event_count` tracks how many native wheel events the
   * capture surface coalesced into this one — kept in the wire so
   * the audit can record interaction density without inflating the
   * log to one entry per native event.
   *
   * Slice 2c-batching scope: the capture surface MUST coalesce
   * native wheel events at ≤60Hz (one wire event per ~16ms window).
   * Server-side: `page.mouse.move(x, y) + page.mouse.wheel(dx, dy)`.
   */
  | {
      readonly kind: "wheel";
      readonly x: number;
      readonly y: number;
      readonly dx: number;
      readonly dy: number;
      readonly event_count: number;
    }
  /**
   * User-driven navigation. The wire carries the normalized URL
   * (the address-bar surface MUST normalize before forwarding —
   * `^[a-z][a-z0-9+.-]*:\/\/` passes through, otherwise prepend
   * `https://`). Server-side: `page.goto(url, { waitUntil:
   * "domcontentloaded" })`. The screencast surface reflects the
   * new page automatically; navigate does not return a screenshot
   * payload (unlike motebit-side `ComputerAction.navigate`, which
   * carries inline heuristics for the AI loop's text response).
   *
   * Slice 2d scope: URL navigation only. Genuine search ("best
   * laptops 2026" → DuckDuckGo) deferred; the address-bar surface
   * is responsible for narrowing to URL-shaped input in v1.
   */
  | {
      readonly kind: "navigate";
      readonly url: string;
    }
  /**
   * Slice 2e — browser history navigation. The triple `back` /
   * `forward` / `reload` map to Playwright's `page.goBack` /
   * `page.goForward` / `page.reload` and complete the
   * "Chrome-feel" minimum on the user-driveable side. Each is a
   * parameter-less event — the cursor anchor / URL / etc. don't
   * apply.
   *
   * Empty-history semantics: `back` / `forward` against a session
   * with no matching history MUST be a no-op (Playwright returns
   * null; the wire treats null + thrown identically as success).
   * The user's UX is "I clicked the button and nothing changed,"
   * which matches a real browser at the start of its history.
   */
  | { readonly kind: "back" }
  | { readonly kind: "forward" }
  | { readonly kind: "reload" };

/**
 * Outcome of a `forwardUserInput` call. `forwarded` means the wire
 * landed at Chromium; `rejected` means the runtime denied dispatch
 * before the wire (gate, missing dispatcher) or the transport
 * failed.
 * @alpha
 */
export type UserInputForwardOutcome = "forwarded" | "rejected";

/**
 * Closed set of reasons a user-input forward can be rejected.
 * Verifiers discriminate on this exhaustively.
 * @alpha
 */
export type UserInputRejectionReason =
  /** Gate denied: `controlState.kind !== "user"` at forward time. */
  | "not_in_user_state"
  /** Session is closed; nowhere to forward to. */
  | "session_closed"
  /** Dispatcher transport failed (HTTP error, network drop). */
  | "transport_error"
  /** Surface dispatcher does not implement input forwarding. */
  | "not_supported";

/**
 * Character class for a key audit entry. The redaction default —
 * raw characters NEVER land in the audit log; the class survives.
 * @alpha
 */
export type CharacterClass =
  | "letter"
  | "digit"
  | "punct"
  | "whitespace"
  | "control"
  | "modifier"
  | "unknown";

/**
 * Semantic role of a key for audit purposes. Coarser-grained than
 * `key_code` would be — "the user pressed something that submits
 * a form" rather than "the user pressed Return on a U.S. layout."
 * @alpha
 */
export type KeyRole =
  | "enter"
  | "tab"
  | "escape"
  | "backspace"
  | "arrow"
  | "shortcut"
  | "printable"
  | "unknown";

/**
 * Per-kind audit detail. The wire-format `UserInputEvent` is
 * mapped through redaction at the runtime layer to produce one of
 * these shapes; raw text/keys/pixel coordinates do NOT appear here.
 * @alpha
 */
export type UserInputForwardedDetail =
  | {
      readonly kind: "click";
      /** Normalized [0, 1] x against the rendered screencast rect. */
      readonly x_norm: number;
      /** Normalized [0, 1] y against the rendered screencast rect. */
      readonly y_norm: number;
      readonly button: "left" | "right" | "middle";
    }
  | {
      readonly kind: "key";
      readonly character_class: CharacterClass;
      readonly key_role: KeyRole;
      readonly modifiers: KeyModifiers;
    }
  | {
      readonly kind: "paste";
      readonly length: number;
      readonly line_count: number;
      readonly looks_like_url: boolean;
    }
  | {
      readonly kind: "wheel";
      /** Normalized [0, 1] x of the wheel anchor against the rendered screencast rect. */
      readonly x_norm: number;
      /** Normalized [0, 1] y of the wheel anchor. */
      readonly y_norm: number;
      /**
       * Scroll deltas in CSS pixels — wire-format passthrough. Wheel
       * deltas don't carry sensitivity (they're cursor-anchored
       * scroll amounts, not text); logging them is not a privacy
       * concern.
       */
      readonly dx: number;
      readonly dy: number;
      /** Native wheel events coalesced into this one (interaction density). */
      readonly event_count: number;
    }
  /**
   * URL-redacted navigate detail. The wire carries the full URL;
   * the audit logs only the **scheme + host** plus presence flags
   * for path / query. Mirrors browser-history privacy: "where did
   * the user go" survives the audit, "what specifically did they
   * fetch" does not.
   *
   * Why redact the path/query: URLs commonly carry session tokens,
   * bearer tokens, account ids, or sensitive identifiers
   * (`?reset_token=...`, `/patient/12345`). The user's signed
   * audit log is a more permanent artifact than a browser history;
   * conservative is correct.
   *
   * Malformed URLs (URL parser threw) collapse to
   * `{ scheme: "unknown", host: "unknown", has_path: false,
   *   has_query: false }` — defensive.
   */
  | {
      readonly kind: "navigate";
      readonly scheme: string;
      readonly host: string;
      readonly has_path: boolean;
      readonly has_query: boolean;
    }
  /**
   * Slice 2e — history-navigation audit shapes. Parameter-less
   * events; the audit just records that the user pressed
   * back/forward/reload. No path/url to redact; no anchor coords
   * to normalize.
   */
  | { readonly kind: "back" }
  | { readonly kind: "forward" }
  | { readonly kind: "reload" };

/**
 * Audit-event payload for a user-driven input forward. Emitted on
 * every forward attempt — both successes and rejections — so the
 * audit trail records who tried to drive when. Sibling of
 * `CoBrowseControlChangedPayload`; same `EventType`-keyed event
 * stream the runtime already threads through `appendWithClock`.
 *
 * `control_state_at_forwarding` mirrors the `control_state_at_denial`
 * field on motebit-side denials (Slice 1) — verifiers replaying
 * the log don't have to cross-reference adjacent control events to
 * answer "what state were we in when this fired."
 * @alpha
 */
export interface UserInputForwardedPayload {
  readonly session_id: string;
  readonly motebit_id: string;
  readonly outcome: UserInputForwardOutcome;
  /** Present iff `outcome === "rejected"`. */
  readonly rejection_reason?: UserInputRejectionReason;
  readonly control_state_at_forwarding: ControlState;
  readonly detail: UserInputForwardedDetail;
  readonly timestamp: number;
}
