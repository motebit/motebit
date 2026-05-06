// Surface-agnostic state controller for the security self-test affordance.
//
// The third leg of the sovereignty-visible trifecta. Activity (sibling
// controller) shows what the motebit DID; Retention shows what the
// operator PROMISED; this controller shows that the protocol's
// security boundary STILL HOLDS — the user can probe it on demand.
//
// `cmdSelfTest` (in `@motebit/runtime`) is the canonical adversarial
// probe: submits a self-delegation task through the live relay,
// exercising the real device-auth + audience-token flow production
// agents use. If sybil defense, audience-binding, or device-auth
// breaks, the test fails. Per `CLAUDE.md` "Adversarial onboarding"
// and `docs/doctrine/security-boundaries.md`, this is the canonical
// boundary check the runtime ships.
//
// Today every surface runs `cmdSelfTest` once on onboarding, logs to
// console, and never surfaces it again. This controller exposes it
// as a one-click affordance: the user can re-probe at any time and
// see a green/red receipt — the calm-software cousin of "your
// security audit just ran, here's the result."
//
// Render — DOM button + status pill on web/desktop, RN Pressable on
// mobile, terminal print on CLI — stays surface-specific. The
// controller lifts:
//   1. Discrete status state (`idle | running | passed | failed |
//      task_failed | timeout | skipped`) so every surface renders the
//      same calm-software badge regardless of medium.
//   2. Summary + diagnostic surface (the relay's hint string when
//      the failure is informative — e.g. 401 → "device may not be
//      registered").
//   3. `lastRunAt` timestamp so a "passed 5 minutes ago" rendering
//      is consistent across surfaces.

// ── Result shape ──────────────────────────────────────────────────────
//
// Mirrors `cmdSelfTest`'s `CommandResult.data` discriminated union,
// projected into the controller's vocabulary. Surfaces wire the
// adapter's `runSelfTest()` to call `cmdSelfTest` and return one of
// these.

export type SelfTestStatus =
  | "passed" // probe completed; relay accepted, task ran, security boundary held
  | "failed" // relay rejected (auth/network/protocol error)
  | "task_failed" // probe submitted but task failed in execution
  | "timeout" // relay accepted but didn't return within deadline
  | "skipped"; // pre-flight check refused (e.g. no auth token available)

export interface SelfTestResult {
  status: SelfTestStatus;
  /** Human-readable one-line summary surfaces render as primary copy. */
  summary: string;
  /** Optional diagnostic hint the relay returned (e.g. "Fund the agent's budget"). */
  hint?: string;
  /** Relay HTTP status when the failure was relay-side. */
  httpStatus?: number;
  /** Task id for a `passed` / `task_failed` / `timeout` result, if known. */
  taskId?: string;
}

// ── Adapter ───────────────────────────────────────────────────────────

export interface SelfTestFetchAdapter {
  /**
   * Run the probe end-to-end. Surfaces wire this to `cmdSelfTest`
   * from `@motebit/runtime`, threading their own runtime + mintToken
   * helper. The controller treats the call as opaque — it only
   * cares about the structured result.
   *
   * Throws are caught by the controller and projected into a `failed`
   * state with the error message in `summary` — surfaces never see
   * a rejected promise from this adapter, only a `state.status ===
   * "failed"` transition.
   */
  runSelfTest(): Promise<SelfTestResult>;
}

// ── State ─────────────────────────────────────────────────────────────

export type SelfTestRunStatus = "idle" | "running" | SelfTestStatus;

export interface SelfTestState {
  /**
   * Discrete status the surface renders. `idle` is the never-run state;
   * `running` indicates a probe is in flight; the rest are the result
   * of the most recent run.
   */
  status: SelfTestRunStatus;
  /** Most recent summary; empty string until first run. */
  summary: string;
  hint: string | null;
  httpStatus: number | null;
  taskId: string | null;
  /** Wall-clock timestamp of the most recent run completion. null until run. */
  lastRunAt: number | null;
}

function initialState(): SelfTestState {
  return {
    status: "idle",
    summary: "",
    hint: null,
    httpStatus: null,
    taskId: null,
    lastRunAt: null,
  };
}

// ── Controller ────────────────────────────────────────────────────────

export interface SelfTestController {
  getState(): SelfTestState;
  subscribe(listener: (state: SelfTestState) => void): () => void;
  /**
   * Trigger a self-test run. Idempotent w.r.t. concurrent calls — if
   * a probe is already running (status === "running"), subsequent
   * calls return immediately and don't kick off a second run. Calm-
   * software: rapid-clicking the button doesn't fire multiple probes.
   */
  run(): Promise<void>;
  dispose(): void;
}

export function createSelfTestController(adapter: SelfTestFetchAdapter): SelfTestController {
  let state = initialState();
  const listeners = new Set<(s: SelfTestState) => void>();

  function emit(): void {
    for (const l of listeners) l(state);
  }
  function update(patch: Partial<SelfTestState>): void {
    state = { ...state, ...patch };
    emit();
  }

  async function run(): Promise<void> {
    if (state.status === "running") return;
    update({ status: "running", summary: "Running…", hint: null, httpStatus: null });

    let result: SelfTestResult;
    try {
      result = await adapter.runSelfTest();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      update({
        status: "failed",
        summary: `Self-test threw: ${message}`,
        hint: null,
        httpStatus: null,
        taskId: null,
        lastRunAt: Date.now(),
      });
      return;
    }

    update({
      status: result.status,
      summary: result.summary,
      hint: result.hint ?? null,
      httpStatus: result.httpStatus ?? null,
      taskId: result.taskId ?? null,
      lastRunAt: Date.now(),
    });
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    run,
    dispose() {
      listeners.clear();
    },
  };
}

// ── Display helpers ───────────────────────────────────────────────────

/**
 * Map the discrete run status to a calm-software badge label every
 * surface renders identically. Returning a stable string here keeps
 * the per-surface render symmetric — no two surfaces accidentally
 * showing different copy for the same state.
 */
export function selfTestBadgeLabel(status: SelfTestRunStatus): string {
  switch (status) {
    case "idle":
      return "not run";
    case "running":
      return "running";
    case "passed":
      return "passed";
    case "failed":
      return "failed";
    case "task_failed":
      return "task failed";
    case "timeout":
      return "timed out";
    case "skipped":
      return "skipped";
    default:
      return status;
  }
}
