/**
 * `CoBrowseControlMachine` — pure state primitive for who's driving an
 * isolated browser session. Slice 0 of the co-browse arc: contract
 * before wire, gate before forwarding.
 *
 * Doctrine: `architecture_cobrowse_belongs_in_virtual_browser` (memory)
 * + `motebit-computer.md` §"Embodiment modes". Co-browse is a
 * *substate* of `virtual_browser`, parameterized by who holds drive
 * control. This module is the source of truth for that parameter.
 *
 * What lives here:
 *   - The eight transitions enumerated in `CoBrowseTransitionKind`.
 *   - Disconnect semantics: any state → `{kind: "user"}` (fail-closed
 *     revert; the user is the always-trusted party).
 *   - User reclaim: unilateral, no approval (the user can take their
 *     own browser back without asking the motebit).
 *   - Motebit-initiated transitions go through `handoff_pending` so
 *     the user grants explicitly.
 *   - Audit emission via injected `onTransition(payload)` so the
 *     event log records every change in shape verifiers can replay
 *     independently.
 *
 * What does NOT live here:
 *   - Pointer / keyboard wire forwarding. That's Slice 1+ — once
 *     `kind === "motebit"`, the dispatcher executes; once
 *     `kind === "user"`, app code forwards user input to the cloud
 *     Chromium. The state machine doesn't know about the wire.
 *   - Per-action governance. Irreversible actions still go through
 *     `ComputerSessionManager.executeAction` and its
 *     `policy-invariants` classifier even when `kind === "motebit"`.
 *   - UI. The slab reads `getState()` to render control affordances;
 *     this module exposes the read, not the render.
 *
 * Why a class with private state and pure methods, not a reducer
 * function. Apps need a single live instance per session that
 * downstream consumers (slab renderer, executeAction gate) read; a
 * reducer would need an external store, which is overkill for one
 * session-scoped state of finite size. The shape is small enough
 * that a class is the honest fit.
 */

import type {
  CoBrowseControlChangedPayload,
  CoBrowseTransitionKind,
  ControlHolder,
  ControlState,
} from "@motebit/sdk";

/**
 * Reasons a transition can fail to apply. Returned in the
 * `TransitionResult` so callers can act without throwing.
 */
export type CoBrowseTransitionError =
  | "invalid_from_state" // transition not legal from current state
  | "wrong_party"; // wrong party tried to drive a transition (e.g. user trying to grant their own request)

/**
 * Result of a transition attempt. `ok: true` means the state changed
 * (the audit event has fired); `ok: false` means the request was
 * rejected and state is unchanged. Caller logs the rejection or
 * propagates as an error to the originating UI.
 */
export type CoBrowseTransitionResult =
  | { readonly ok: true; readonly state: ControlState }
  | { readonly ok: false; readonly reason: CoBrowseTransitionError };

export interface CoBrowseControlMachineDeps {
  /** Session id this machine governs. Carried into every audit event. */
  readonly sessionId: string;
  /** Motebit id. Carried into every audit event. */
  readonly motebitId: string;
  /**
   * Audit emitter — invoked AFTER each successful transition with a
   * `CoBrowseControlChangedPayload`. The runtime wires this to its
   * event log; tests pass a vi.fn to assert audit shape.
   */
  readonly onTransition?: (payload: CoBrowseControlChangedPayload) => void;
  /**
   * Time source — injectable for deterministic test timestamps.
   * Defaults to `Date.now`.
   */
  readonly now?: () => number;
}

export interface CoBrowseControlMachine {
  /** Current state. Reads are non-mutating. */
  getState(): ControlState;

  /**
   * Motebit requests drive control from the user. From `{kind:
   * "user"}` only — re-requesting from `handoff_pending` or `paused`
   * is `invalid_from_state`. `motebit → motebit` is `wrong_party`
   * (motebit already has control; should `releaseControl` first if
   * the goal was a yield-then-reclaim).
   */
  requestControl(by: "motebit"): CoBrowseTransitionResult;

  /**
   * User grants the pending control request. Only the `current`
   * party of `handoff_pending` can grant (they're the one giving up
   * control). For Slice 0 only motebit can request, so `current`
   * is always `user` and `grant` is always issued by user.
   */
  grantControl(by: "user"): CoBrowseTransitionResult;

  /**
   * User denies the pending request. Same eligibility as `grant`.
   * Denied requests revert to whoever was driving (`current`); the
   * requesting party can re-issue if they still want control.
   */
  denyControl(by: "user"): CoBrowseTransitionResult;

  /**
   * User unilaterally reclaims control from motebit. No approval
   * required — the user's identity is the trust root, and they
   * never need to ask the motebit for permission to take their own
   * browser back. From `{kind: "motebit"}` only; from any other
   * state this is `invalid_from_state` (if user is already driving
   * or paused or in a pending handoff, there's nothing to reclaim).
   */
  reclaimControl(): CoBrowseTransitionResult;

  /**
   * Motebit voluntarily yields control back to the user. From
   * `{kind: "motebit"}` only. No approval needed — the motebit can
   * always drop the wheel.
   */
  releaseControl(by: "motebit"): CoBrowseTransitionResult;

  /**
   * Pause — neither party drives. Source-agnostic (could be the v1.2
   * halt gesture, the `/halt` slash command, or motebit's own stop
   * tool). `previousDriver` is preserved so `resume` restores
   * continuity; the user's pause-while-handoff-pending case
   * collapses to the requesting party's role being abandoned (a
   * resume returns to the previous holder, not the pending state —
   * the request is lost on pause; user can re-request after
   * resume).
   */
  pause(by: ControlHolder | "system"): CoBrowseTransitionResult;

  /**
   * Resume from pause. Restores `previousDriver` as the active
   * party. From `{kind: "paused"}` only.
   */
  resume(by: ControlHolder | "system"): CoBrowseTransitionResult;

  /**
   * Connection drop. Fail-closed revert-to-user from any state. The
   * runtime's transport layer (cloud-browser dispatcher's WS, screen-
   * cast stream, slab renderer) calls this when it observes a drop;
   * the user is the always-trusted party so reverting to their
   * control is always safe.
   *
   * No-op when already in `{kind: "user"}`.
   */
  disconnect(): CoBrowseTransitionResult;
}

/**
 * Construct a fresh control machine in `{kind: "user"}`. Sessions
 * always open with the user holding control — motebit must
 * explicitly request to take over.
 */
export function createCoBrowseControlMachine(
  deps: CoBrowseControlMachineDeps,
): CoBrowseControlMachine {
  const now = deps.now ?? Date.now;
  let state: ControlState = { kind: "user" };

  function commit(
    next: ControlState,
    transitionKind: CoBrowseTransitionKind,
    initiator: ControlHolder | "system",
  ): CoBrowseTransitionResult {
    const from = state;
    state = next;
    deps.onTransition?.({
      session_id: deps.sessionId,
      motebit_id: deps.motebitId,
      transition_kind: transitionKind,
      initiator,
      from,
      to: next,
      timestamp: now(),
    });
    return { ok: true, state: next };
  }

  return {
    getState: () => state,

    requestControl(by) {
      // Motebit requests from user-holding state. handoff_pending
      // and paused both reject with invalid_from_state — there's
      // already a pending action or no driver to take over from.
      // Motebit-already-holds is a no-op category-error.
      if (state.kind !== "user") {
        return { ok: false, reason: "invalid_from_state" };
      }
      if (by !== "motebit") {
        return { ok: false, reason: "wrong_party" };
      }
      return commit(
        { kind: "handoff_pending", current: "user", requesting: "motebit" },
        "request_control",
        "motebit",
      );
    },

    grantControl(by) {
      if (state.kind !== "handoff_pending") {
        return { ok: false, reason: "invalid_from_state" };
      }
      // Only the `current` party can grant (they're giving up control).
      if (by !== state.current) {
        return { ok: false, reason: "wrong_party" };
      }
      const requesting = state.requesting;
      // Concrete next state per requesting party. Discriminated-union
      // narrowing ensures the right "kind" lands at the type level.
      const next: ControlState = requesting === "user" ? { kind: "user" } : { kind: "motebit" };
      return commit(next, "grant_control", by);
    },

    denyControl(by) {
      if (state.kind !== "handoff_pending") {
        return { ok: false, reason: "invalid_from_state" };
      }
      if (by !== state.current) {
        return { ok: false, reason: "wrong_party" };
      }
      const current = state.current;
      const next: ControlState = current === "user" ? { kind: "user" } : { kind: "motebit" };
      return commit(next, "deny_control", by);
    },

    reclaimControl() {
      // User unilaterally takes control back. Legal from motebit-
      // holding only — every other state has nothing to reclaim.
      if (state.kind !== "motebit") {
        return { ok: false, reason: "invalid_from_state" };
      }
      return commit({ kind: "user" }, "reclaim_control", "user");
    },

    releaseControl(by) {
      if (state.kind !== "motebit") {
        return { ok: false, reason: "invalid_from_state" };
      }
      if (by !== "motebit") {
        return { ok: false, reason: "wrong_party" };
      }
      return commit({ kind: "user" }, "release_control", "motebit");
    },

    pause(by) {
      // Already paused → invalid (resume first if you want to
      // re-pause). handoff_pending → pause loses the request (per
      // the JSDoc on the interface); whoever was `current` becomes
      // the previousDriver.
      if (state.kind === "paused") {
        return { ok: false, reason: "invalid_from_state" };
      }
      const previousDriver: ControlHolder =
        state.kind === "user" ? "user" : state.kind === "motebit" ? "motebit" : state.current;
      return commit({ kind: "paused", previousDriver }, "pause", by);
    },

    resume(by) {
      if (state.kind !== "paused") {
        return { ok: false, reason: "invalid_from_state" };
      }
      const previousDriver = state.previousDriver;
      const next: ControlState = previousDriver === "user" ? { kind: "user" } : { kind: "motebit" };
      return commit(next, "resume", by);
    },

    disconnect() {
      // Fail-closed revert-to-user from any state, including user
      // (which is a no-op transition but still emits the audit
      // event so verifiers see the disconnect signal in the log).
      if (state.kind === "user") {
        // No-op — already at user. Don't emit a redundant audit
        // event; nothing changed.
        return { ok: true, state };
      }
      return commit({ kind: "user" }, "disconnect", "system");
    },
  };
}
