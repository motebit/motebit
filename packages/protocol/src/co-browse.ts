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
