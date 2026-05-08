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
  ComputerActionKind,
  ComputerFailureReason,
  ComputerSessionActionRecord,
  ComputerSessionClosed,
  ComputerSessionOpened,
  SignableComputerSessionReceipt,
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
 * Optional `classifyObservation` lets the classifier rewrite the
 * observation's `redaction` field before the data reaches the AI.
 * Return `undefined` to preserve whatever the dispatcher emitted
 * (e.g. for non-screenshot observations).
 *
 * Default classifier (when not supplied) is allow-all — appropriate
 * for development; production desktop builds MUST wire a real
 * classifier backed by `@motebit/policy-invariants`.
 */
export interface ComputerGovernanceClassifier {
  classify(action: ComputerAction): Promise<"allow" | "require_approval" | "deny">;
  classifyObservation?(data: unknown): Promise<ObservationRedaction | undefined>;
}

/**
 * Redaction metadata the classifier can attach to a screenshot
 * observation. Shape matches `ComputerRedaction` in `@motebit/protocol`
 * but declared here (not imported) so the runtime's inner loop stays
 * free of wire-format imports — the field names are the stable
 * contract.
 */
export interface ObservationRedaction {
  readonly applied: boolean;
  readonly projection_kind: string;
  readonly policy_version?: string;
  readonly classified_regions_count?: number;
  readonly classified_regions_digest?: string;
  /**
   * When `true`, the session manager strips bulky raw-bytes fields
   * (`bytes_base64`, `ocr_tokens`) from the observation before the AI
   * loop sees it. Fail-closed enforcement for the foundation-law rule
   * "medical/financial/secret never reach external AI." The artifact
   * metadata (`artifact_id`, `artifact_sha256`, dimensions, timestamp)
   * is retained so the audit trail still binds to the blocked capture.
   */
  readonly strip_bytes?: boolean;
  /**
   * Optional explicit sensitivity tier the classifier assigned to this
   * observation. Closed `SensitivityLevel` union by convention
   * (`"none" | "personal" | "medical" | "financial" | "secret"`).
   *
   * Used by the v1.5 session-summary receipt to fill `max_sensitivity`.
   * When absent, the runtime infers from `strip_bytes` (true →
   * `"financial"` as the conservative floor of the bytes-stripping
   * trio per CLAUDE.md "medical/financial/secret never reach external
   * AI"; false → `"none"`). Classifiers that know the tier should set
   * it explicitly so the receipt commits to the actual value.
   */
  readonly sensitivity_level?: string;
}

/**
 * Fields stripped from an observation when redaction says
 * `strip_bytes: true`. Kept as a frozen list so the set is auditable
 * and drift-gate-able if a future observation shape adds a new large
 * field that should also be withheld.
 */
const STRIPPED_FIELDS: ReadonlyArray<string> = ["bytes_base64", "ocr_tokens"];

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

  /**
   * Halt the manager — fail-closed user-floor invariant per
   * `spec/computer-use-v1.md` §3.3 + the doctrine's two-finger-hold
   * gesture in `motebit-computer.md` §"The user's touch — supervised
   * agency."
   *
   * Semantics: while halted, every new `executeAction` call returns
   * `{ outcome: "failure", reason: "user_preempted" }` WITHOUT
   * touching the dispatcher. In-flight atomic actions are NOT
   * cancelled — per spec §3.3, "in-flight atomic action MAY
   * complete; no new dispatch begins until the quiet period
   * elapses." Callers see the rejection at the session-manager
   * boundary; the dispatcher never hears about the halt.
   *
   * The motebit's AI loop, the slab's per-item lifecycle, the
   * proactive consolidation cycle — none of those are this
   * primitive's responsibility. Halt is the user's "stop dispatching
   * synthetic input" boundary, narrow and surgical. Higher-level
   * pause semantics (e.g. presence going `tending → halted`) compose
   * above this primitive; they don't live inside it.
   */
  halt(): void;

  /**
   * Resume from halt. New `executeAction` calls are honored again.
   * Idempotent — `resume()` on an already-resumed manager is a
   * no-op. The doctrine's gesture is "release to resume" — the
   * surface releasing the two-finger-hold (or `/resume` slash
   * command, or any other trigger) calls this primitive.
   */
  resume(): void;

  /** True when `halt()` was called more recently than `resume()`. */
  isHalted(): boolean;

  /**
   * v1.5 — produce the *unsigned* body of a `ComputerSessionReceipt`
   * for the named session. The signer (typically the runtime, which
   * owns the motebit's identity key) consumes this and emits the
   * signed receipt via `signComputerSessionReceipt` from
   * `@motebit/crypto`.
   *
   * The summary is built from per-action structural records the
   * manager appends on every `executeAction` call (kind, timing,
   * outcome, failure reason). Records carry no targets, args, or
   * observation bytes — the receipt commits to *structure*, the
   * per-action `ToolInvocationReceipt` already commits to args/result
   * hashes. Splitting the two preserves the privacy invariant of the
   * session-level receipt while keeping the audit invariant of the
   * per-call receipts intact.
   *
   * Available on both open and closed sessions (closed sessions are
   * tracked as long as their record is in memory). Returns `null`
   * when the session id is unknown — callers downstream of an
   * idempotent re-close should not error on that path.
   *
   * `actions_hash` is computed by JCS-canonicalizing the per-action
   * roll-up and SHA-256ing the bytes — same digest a third-party
   * verifier would compute from the per-action receipts. Keep
   * deterministic so signatures are stable.
   */
  summarize(
    sessionId: string,
    deps: ComputerSessionSummarizeDeps,
  ): Promise<Omit<SignableComputerSessionReceipt, "public_key"> | null>;
}

/**
 * Deps passed to `summarize()`. The manager doesn't hold the motebit's
 * identity, doesn't know how to canonical-JSON or hash, and doesn't
 * carry an embodiment-mode constant — those are the consumer's
 * concerns. Inversion of control keeps the manager pure runtime
 * plumbing; the BSL signer composes it with `@motebit/crypto`'s
 * `hashComputerSessionActions` and `signComputerSessionReceipt`.
 */
export interface ComputerSessionSummarizeDeps {
  /** Source of the receipt's `receipt_id` (UUID). */
  generateReceiptId: () => string;
  /**
   * Embodiment mode the session ran under. Apps stamp this at
   * registration time (`apps/web/src/computer-tool.ts` →
   * `"virtual_browser"`; `apps/desktop/src/computer-tool.ts` →
   * `"desktop_drive"`). Surfaces that haven't stamped one fall back
   * to `"tool_result"` per `tool-policy.ts`'s safe floor.
   */
  embodimentMode: string;
  /**
   * Hash the canonical-JSON of the per-action roll-up. Caller wires
   * this to `@motebit/crypto`'s `hashComputerSessionActions` so the
   * runtime layer doesn't take a direct crypto dep here.
   */
  hashActions: (actions: ReadonlyArray<ComputerSessionActionRecord>) => Promise<string>;
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
  /**
   * Per-action structural records (v1.5). Append-only during the
   * session's life; consumed by `summarize()`. Carries kind + timing
   * + outcome + failure_reason — never targets, args, or observation
   * payloads. Privacy invariant: any field added here MUST be
   * structural-only.
   */
  readonly actions: ComputerSessionActionRecord[];
  /**
   * Highest sensitivity tier observed on any action's classifier
   * pass during the session (v1.5). Persisted on the session object
   * so the summary commits to the envelope regardless of whether
   * each per-action observation gets retained downstream.
   * Encoded as a SensitivityLevel string (`"none"` baseline,
   * lifted by `applyObservationClassifier`).
   */
  max_sensitivity: string;
  /**
   * True if `halt()` fired at any point during the session — even
   * if `resume()` was called before close. The receipt commits to
   * "the user paused at least once," not to terminal halt state.
   */
  was_halted: boolean;
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
  // Closed sessions retained for v1.5 `summarize()` calls that happen
  // after `closeSession()` returns. Bounded to the most-recent N so a
  // long-running motebit doesn't accumulate unbounded closed-session
  // metadata; per session this is ~1KB even with 100 actions, so
  // retaining the last 64 closes is cheap and keeps the audit-event
  // append-then-summarize flow safe under any caller ordering.
  const closedSessions = new Map<string, InternalSession>();
  const CLOSED_SESSION_RETENTION_LIMIT = 64;
  // User-floor halt flag — see `halt()` / `resume()` / `isHalted()`
  // on the ComputerSessionManager interface for the semantics. While
  // true, executeAction returns user_preempted without touching the
  // dispatcher. Per spec §3.3 in-flight actions complete naturally;
  // this flag only blocks NEW dispatches.
  let halted = false;

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
      actions: [],
      max_sensitivity: "none",
      was_halted: false,
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
    // v1.5 — retain the closed session so `summarize()` works even
    // after closeSession returns. FIFO eviction keeps memory bounded.
    closedSessions.set(sessionId, session);
    if (closedSessions.size > CLOSED_SESSION_RETENTION_LIMIT) {
      const oldest = closedSessions.keys().next().value;
      if (oldest != null) closedSessions.delete(oldest);
    }
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
    const started_at = now();
    const session = sessions.get(sessionId);
    // v1.5 — every executeAction call appends a structural record to
    // the session's roll-up (when the session is open and resolvable).
    // Halt-without-session and session_closed paths still return their
    // typed outcomes but skip the record append; the session that
    // doesn't exist has no per-action ledger to commit to. Recording
    // happens in finishOutcome() so we capture all branches uniformly.
    const recordOutcome = (outcome: ComputerActionOutcome): ComputerActionOutcome => {
      if (session && session.closed_at == null) {
        const record: ComputerSessionActionRecord = {
          kind: action.kind as ComputerActionKind,
          started_at,
          completed_at: now(),
          outcome: outcome.outcome,
          ...(outcome.outcome === "failure" ? { failure_reason: outcome.reason } : {}),
        };
        session.actions.push(record);
      }
      return outcome;
    };

    // User-floor halt check — runs BEFORE session validation and
    // governance classification. The two-finger-hold gesture (or
    // /halt slash command, or any other release-trigger) sets this
    // flag; the AI's next dispatched action lands here and gets
    // user_preempted per spec §3.3. Order matters: halt is the
    // user's stop button; it preempts everything else, including
    // an action that would otherwise be allow-ed by governance.
    if (halted) {
      return recordOutcome({
        outcome: "failure",
        reason: "user_preempted",
        message: "Manager is halted; user has paused dispatch.",
      });
    }

    if (!session || session.closed_at != null) {
      return recordOutcome({
        outcome: "failure",
        reason: "session_closed",
        message: `session ${sessionId} is not open`,
      });
    }

    const classification = await governance.classify(action);
    if (classification === "deny") {
      return recordOutcome({ outcome: "failure", reason: "policy_denied" });
    }
    if (classification === "require_approval") {
      if (!approvalFlow) {
        return recordOutcome({ outcome: "failure", reason: "approval_required" });
      }
      const approved = await approvalFlow(action);
      if (!approved) {
        return recordOutcome({ outcome: "failure", reason: "approval_required" });
      }
    }

    try {
      const data = await dispatcher.execute(action, onChunk);
      const finalData = await applyObservationClassifier(data, session);
      return recordOutcome({ outcome: "success", data: finalData });
    } catch (err: unknown) {
      if (err instanceof ComputerDispatcherError) {
        return recordOutcome({
          outcome: "failure",
          reason: err.reason,
          message: err.message,
        });
      }
      const msg = err instanceof Error ? err.message : String(err);
      return recordOutcome({
        outcome: "failure",
        reason: "platform_blocked",
        message: msg,
      });
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

  /**
   * Run the classifier's optional `classifyObservation` over the
   * dispatcher's returned data. If the classifier produces a redaction
   * and the data is an object, shallow-overwrite the `redaction` field
   * before returning. When `redaction.strip_bytes` is set the session
   * manager additionally removes `bytes_base64` / `ocr_tokens` — this
   * is the fail-closed path for "medical/financial/secret never reach
   * external AI." Non-objects pass through; a classifier throw is
   * itself fail-closed — we surface a minimal `applied: true,
   * projection_kind: "redacted_on_error", strip_bytes: true` envelope
   * so the AI cannot silently receive raw bytes when the classifier
   * malfunctioned.
   */
  async function applyObservationClassifier(
    data: unknown,
    session: InternalSession,
  ): Promise<unknown> {
    if (!governance.classifyObservation) return data;
    if (data === null || typeof data !== "object") return data;
    let redaction: ObservationRedaction | undefined;
    try {
      redaction = await governance.classifyObservation(data);
    } catch {
      redaction = {
        applied: true,
        projection_kind: "redacted_on_error",
        strip_bytes: true,
      };
    }
    if (!redaction) return data;
    // v1.5 sensitivity envelope — lift `session.max_sensitivity` to the
    // higher of (current, observed). Use the classifier's explicit
    // `sensitivity_level` when supplied; fall back to inferring from
    // `strip_bytes` (true → "financial" as the conservative floor of
    // medical/financial/secret). The receipt commits to the high-water
    // mark, never decays.
    const observed: string =
      typeof redaction.sensitivity_level === "string"
        ? redaction.sensitivity_level
        : redaction.strip_bytes
          ? "financial"
          : "none";
    if (sensitivityRank(observed) > sensitivityRank(session.max_sensitivity)) {
      session.max_sensitivity = observed;
    }
    const next: Record<string, unknown> = { ...(data as Record<string, unknown>), redaction };
    if (redaction.strip_bytes) {
      for (const field of STRIPPED_FIELDS) delete next[field];
    }
    return next;
  }

  // Local ordinal rank — same closed `SensitivityLevel` order as
  // `@motebit/protocol`'s `rankSensitivity`. Inlined to avoid a
  // protocol import for one closed-enum lookup. Unknown strings rank
  // 0 (treated as `"none"`) — fail-permissive on the inference path
  // because the doctrine's medical/financial/secret bytes-strip rule
  // is enforced by the strip itself, not by this rank.
  function sensitivityRank(level: string): number {
    switch (level) {
      case "personal":
        return 1;
      case "medical":
        return 2;
      case "financial":
        return 3;
      case "secret":
        return 4;
      default:
        return 0;
    }
  }

  function dispose(): void {
    const ids = [...sessions.keys()];
    for (const id of ids) {
      void closeSession(id, "manager_disposed");
    }
  }

  function halt(): void {
    halted = true;
    // v1.5 — sticky was_halted on every active session so the
    // receipt commits to "the user paused at least once," not to
    // terminal halt state. `resume()` does not clear this — the
    // history is the data the receipt is meant to preserve.
    for (const s of sessions.values()) {
      s.was_halted = true;
    }
  }

  function resume(): void {
    halted = false;
  }

  function isHalted(): boolean {
    return halted;
  }

  async function summarize(
    sessionId: string,
    summarizeDeps: ComputerSessionSummarizeDeps,
  ): Promise<Omit<SignableComputerSessionReceipt, "public_key"> | null> {
    const session = sessions.get(sessionId) ?? closedSessions.get(sessionId);
    if (!session) return null;
    let success = 0;
    let failure = 0;
    const failure_breakdown: Partial<Record<ComputerFailureReason, number>> = {};
    for (const a of session.actions) {
      if (a.outcome === "success") {
        success++;
      } else {
        failure++;
        if (a.failure_reason) {
          failure_breakdown[a.failure_reason] = (failure_breakdown[a.failure_reason] ?? 0) + 1;
        }
      }
    }
    const actions_hash = await summarizeDeps.hashActions(session.actions);
    return {
      receipt_id: summarizeDeps.generateReceiptId(),
      session_id: session.session_id,
      motebit_id: session.motebit_id,
      embodiment_mode: summarizeDeps.embodimentMode,
      display_width: session.display.width,
      display_height: session.display.height,
      scaling_factor: session.display.scaling_factor,
      opened_at: session.opened_at,
      closed_at: session.closed_at ?? now(),
      ...(session.close_reason ? { close_reason: session.close_reason } : {}),
      action_count: session.actions.length,
      outcomes_summary: { success, failure },
      failure_breakdown,
      was_halted: session.was_halted,
      max_sensitivity: session.max_sensitivity,
      actions_hash,
    };
  }

  return {
    openSession,
    closeSession,
    executeAction,
    getSession,
    activeSessionIds,
    dispose,
    halt,
    resume,
    isHalted,
    summarize,
  };
}
