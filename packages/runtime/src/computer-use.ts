/**
 * Computer-use session manager — the TS-side seam between `spec/computer-
 * use-v1.md` and the platform-specific dispatcher (today: a Tauri Rust
 * bridge on desktop; tomorrow: additional surfaces as they gain OS
 * access).
 *
 * Why this exists. The spec pins wire format for session lifecycle,
 * action requests, observations, governance invariants. Without a
 * primitive that owns those invariants, each surface implementing
 * computer use would re-derive:
 *
 *   - session allocation + lifecycle
 *   - governance routing (classify → allow / require_approval / deny)
 *   - failure-reason normalization (10 values in §7.1)
 *   - user-preemption handling contract
 *   - approval-flow wiring
 *
 * Same failure mode as pre-primitive goal emission (three surfaces
 * constructing payloads inline, silent drift between them). This module
 * is the single authorship site; every surface's dispatcher plugs in
 * behind one contract.
 *
 * Layer. `@motebit/runtime` is Layer 5 BSL. Imports are Layer 0-1
 * (`@motebit/protocol`) + the runtime's own layer-local helpers.
 *
 * Seam with the existing pipelines:
 *
 *   - Signed observation/action receipts flow through the existing
 *     `ToolInvocationReceipt` pipeline: the `computer` tool in
 *     `@motebit/tools` receives the AI-loop invocation, delegates to
 *     this session manager's `executeAction`, and the runtime's tool-
 *     call signer emits the receipt as it does for every tool. This
 *     module does NOT mint receipts itself — that would duplicate the
 *     crypto path and diverge the audit trail.
 *
 *   - Session-lifecycle events (`ComputerSessionOpened`,
 *     `ComputerSessionClosed`) are returned as data from the manager's
 *     `openSession` / `closeSession` methods. The caller (typically
 *     the desktop surface's integration layer) wires them into the
 *     event log via `runtime.events`. Same separation-of-concerns
 *     pattern `runtime.goals` uses for `goal_created` etc.
 *
 *   - Governance routing delegates to a pluggable `classify` callback
 *     so the full policy-invariants integration can happen when
 *     `@motebit/policy-invariants` gets a `classifyComputerAction`
 *     surface. Default classifier is allow-all (dev mode).
 */

import type {
  ComputerAction,
  ComputerFailureReason,
  ComputerSessionClosed,
  ComputerSessionOpened,
} from "@motebit/sdk";

// ── Types ────────────────────────────────────────────────────────────

/**
 * Primary display info — queried at session open, echoed into the
 * `ComputerSessionOpened` event so the AI knows the coordinate space.
 * Logical pixels; `scaling_factor` is logical-to-physical.
 */
export interface ComputerDisplayInfo {
  readonly width: number;
  readonly height: number;
  readonly scaling_factor: number;
}

/**
 * Platform-specific bridge the session manager delegates to. Exactly
 * one per surface: desktop's Tauri Rust bridge is the initial
 * implementer; cloud-browser-on-web will be another when that ships.
 */
export interface ComputerPlatformDispatcher {
  /** Query primary-display metadata at session open. */
  queryDisplay(): Promise<ComputerDisplayInfo>;
  /**
   * Execute one action on the OS. Returns observation data for
   * observation actions (`screenshot`, `cursor_position`); returns
   * `void` or an implementation-defined ack for input actions.
   *
   * Throw `ComputerDispatcherError` for structured failures (the
   * reason is preserved). Generic `Error` throws map to
   * `platform_blocked`.
   *
   * `onChunk` is an opaque pass-through for streaming dispatchers
   * (e.g. cloud browser frame streams).
   */
  execute(action: ComputerAction, onChunk?: (chunk: unknown) => void): Promise<unknown>;
  /** Optional teardown when the session closes. */
  dispose?(sessionId: string): Promise<void>;
}

/**
 * Thrown from dispatcher implementations when a structured
 * `ComputerFailureReason` applies — `permission_denied`,
 * `target_not_found`, `platform_blocked`, etc. The session manager
 * unwraps this into the typed outcome envelope.
 */
export class ComputerDispatcherError extends Error {
  constructor(
    public readonly reason: ComputerFailureReason,
    message?: string,
  ) {
    super(message ?? reason);
    this.name = "ComputerDispatcherError";
  }
}

/**
 * Governance classifier. Runs before every action. Return:
 *   - `"allow"` — dispatcher runs immediately.
 *   - `"require_approval"` — manager calls the approval flow; on
 *     consent the dispatcher runs; on denial the outcome is
 *     `approval_required`.
 *   - `"deny"` — dispatcher never runs; outcome is `policy_denied`.
 *
 * Default classifier (when not supplied) is allow-all — appropriate
 * for development; production desktop builds MUST wire a real
 * classifier backed by `@motebit/policy-invariants`.
 */
export interface ComputerGovernanceClassifier {
  classify(action: ComputerAction): Promise<"allow" | "require_approval" | "deny">;
}

/**
 * Invoked when governance returns `require_approval`. Return `true`
 * to authorize the action, `false` to deny it. When not supplied and
 * classifier returns `require_approval`, the outcome is
 * `approval_required` (conservative default).
 */
export type ComputerApprovalFlow = (action: ComputerAction) => Promise<boolean>;

/** Handle returned by `openSession`. */
export interface ComputerSessionHandle {
  readonly session_id: string;
  readonly motebit_id: string;
  readonly display: ComputerDisplayInfo;
  readonly opened_at: number;
}

/** Outcome of `executeAction`. */
export type ComputerActionOutcome =
  | { outcome: "success"; data: unknown }
  | { outcome: "failure"; reason: ComputerFailureReason; message?: string };

export interface ComputerSessionManager {
  /**
   * Allocate a new session. Queries the dispatcher for display info and
   * returns both the handle and the signed-event payload the caller
   * writes to the event log. A motebit MAY hold multiple concurrent
   * sessions; they don't share state.
   */
  openSession(motebitId: string): Promise<{
    handle: ComputerSessionHandle;
    event: ComputerSessionOpened;
  }>;

  /**
   * Close an open session. Returns the signed-event payload the caller
   * writes to the event log. Idempotent: closing an already-closed
   * session resolves with an event carrying the original close
   * timestamp, without re-invoking the dispatcher's dispose hook.
   */
  closeSession(sessionId: string, reason?: string): Promise<ComputerSessionClosed>;

  /**
   * Execute one action in the named session. Governance-gated;
   * dispatcher-routed; outcome-normalized. The caller wraps this
   * invocation in the tool-receipt pipeline (see
   * `@motebit/tools/computer`) so the signed audit happens upstream.
   */
  executeAction(
    sessionId: string,
    action: ComputerAction,
    onChunk?: (chunk: unknown) => void,
  ): Promise<ComputerActionOutcome>;

  /** Return an open session's handle, or `null` if not open. */
  getSession(sessionId: string): ComputerSessionHandle | null;

  /** IDs of currently-open sessions, in open order. */
  activeSessionIds(): readonly string[];

  /** Close all active sessions with `reason: "manager_disposed"`. */
  dispose(): void;
}

export interface ComputerSessionManagerDeps {
  dispatcher: ComputerPlatformDispatcher;
  /** Defaults to an allow-all classifier. Production MUST supply a real one. */
  governance?: ComputerGovernanceClassifier;
  /** Required when governance can return `require_approval`. */
  approvalFlow?: ComputerApprovalFlow;
  /** Injected for test determinism. */
  generateSessionId?: () => string;
  now?: () => number;
}

// ── Implementation ───────────────────────────────────────────────────

function defaultGenerateSessionId(): string {
  // Not a formal ULID — per-process unique id stable enough for the
  // audit trail within a session. Real implementations (desktop Tauri
  // bridge) SHOULD inject a ULID generator via `generateSessionId`.
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `cs_${crypto.randomUUID()}`;
  return `cs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

const ALLOW_ALL: ComputerGovernanceClassifier = {
  classify() {
    return Promise.resolve("allow");
  },
};

interface InternalSession {
  readonly session_id: string;
  readonly motebit_id: string;
  readonly display: ComputerDisplayInfo;
  readonly opened_at: number;
  closed_at: number | null;
  close_reason: string | null;
}

export function createComputerSessionManager(
  deps: ComputerSessionManagerDeps,
): ComputerSessionManager {
  const {
    dispatcher,
    governance = ALLOW_ALL,
    approvalFlow,
    generateSessionId = defaultGenerateSessionId,
    now = () => Date.now(),
  } = deps;

  const sessions = new Map<string, InternalSession>();

  async function openSession(
    motebitId: string,
  ): Promise<{ handle: ComputerSessionHandle; event: ComputerSessionOpened }> {
    const display = await dispatcher.queryDisplay();
    const session_id = generateSessionId();
    const opened_at = now();
    const session: InternalSession = {
      session_id,
      motebit_id: motebitId,
      display,
      opened_at,
      closed_at: null,
      close_reason: null,
    };
    sessions.set(session_id, session);
    const handle: ComputerSessionHandle = {
      session_id,
      motebit_id: motebitId,
      display,
      opened_at,
    };
    const event: ComputerSessionOpened = {
      session_id,
      motebit_id: motebitId,
      display_width: display.width,
      display_height: display.height,
      scaling_factor: display.scaling_factor,
      opened_at,
    };
    return { handle, event };
  }

  async function closeSession(sessionId: string, reason?: string): Promise<ComputerSessionClosed> {
    const session = sessions.get(sessionId);
    if (!session) {
      // Idempotent — caller closing an unknown session gets a typed
      // close event anyway so the event log stays consistent. The
      // `reason` is set to "unknown_session" to distinguish from a
      // real close.
      return {
        session_id: sessionId,
        closed_at: now(),
        reason: "unknown_session",
      };
    }
    if (session.closed_at != null) {
      // Already closed — replay the original close event.
      return {
        session_id: sessionId,
        closed_at: session.closed_at,
        ...(session.close_reason ? { reason: session.close_reason } : {}),
      };
    }
    const closed_at = now();
    session.closed_at = closed_at;
    session.close_reason = reason ?? null;
    if (dispatcher.dispose) {
      try {
        await dispatcher.dispose(sessionId);
      } catch {
        // Dispatcher teardown failure must not prevent event emission.
      }
    }
    sessions.delete(sessionId);
    return {
      session_id: sessionId,
      closed_at,
      ...(reason ? { reason } : {}),
    };
  }

  async function executeAction(
    sessionId: string,
    action: ComputerAction,
    onChunk?: (chunk: unknown) => void,
  ): Promise<ComputerActionOutcome> {
    const session = sessions.get(sessionId);
    if (!session || session.closed_at != null) {
      return {
        outcome: "failure",
        reason: "session_closed",
        message: `session ${sessionId} is not open`,
      };
    }

    const classification = await governance.classify(action);
    if (classification === "deny") {
      return { outcome: "failure", reason: "policy_denied" };
    }
    if (classification === "require_approval") {
      if (!approvalFlow) {
        return { outcome: "failure", reason: "approval_required" };
      }
      const approved = await approvalFlow(action);
      if (!approved) {
        return { outcome: "failure", reason: "approval_required" };
      }
    }

    try {
      const data = await dispatcher.execute(action, onChunk);
      return { outcome: "success", data };
    } catch (err: unknown) {
      if (err instanceof ComputerDispatcherError) {
        return {
          outcome: "failure",
          reason: err.reason,
          message: err.message,
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        outcome: "failure",
        reason: "platform_blocked",
        message: msg,
      };
    }
  }

  function getSession(sessionId: string): ComputerSessionHandle | null {
    const s = sessions.get(sessionId);
    if (!s || s.closed_at != null) return null;
    return {
      session_id: s.session_id,
      motebit_id: s.motebit_id,
      display: s.display,
      opened_at: s.opened_at,
    };
  }

  function activeSessionIds(): readonly string[] {
    return [...sessions.keys()];
  }

  function dispose(): void {
    const ids = [...sessions.keys()];
    for (const id of ids) {
      void closeSession(id, "manager_disposed");
    }
  }

  return {
    openSession,
    closeSession,
    executeAction,
    getSession,
    activeSessionIds,
    dispose,
  };
}
