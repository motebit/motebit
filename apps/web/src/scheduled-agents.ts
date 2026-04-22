/**
 * Scheduled Agents — recurring tasks the motebit runs on cadence.
 *
 * The user creates a task: "every morning, brief me on the news." The
 * motebit fires it at the scheduled time, produces a signed
 * `ExecutionReceipt` for the run, and the workstation's audit log
 * shows every run verifiably.
 *
 * Current scope (MVP):
 *   - Storage: `localStorage` under one key (small JSON array).
 *   - Scheduler: a single `setInterval` tick on the web tab; fires
 *     agents whose `next_run_at` has passed while the tab is open.
 *   - Execution: drives the existing `sendMessageStreaming` path so
 *     the run goes through the normal chat pipeline and produces the
 *     same signed receipts as user-typed messages.
 *
 * Endgame (not in this slice):
 *   - Relay-side scheduler so runs fire even when no tab is open.
 *     This module's storage + public shape match the endgame — when
 *     relay scheduling lands, the runner becomes a subscription to
 *     relay-fired events rather than a tab-local interval. The UI
 *     and the data shape don't change.
 */

const STORAGE_KEY = "motebit.scheduled_agents";
const TICK_INTERVAL_MS = 30_000;
const CADENCE_INTERVAL_MS: Record<ScheduledAgentCadence, number> = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

export type ScheduledAgentCadence = "hourly" | "daily" | "weekly";

export interface ScheduledAgent {
  id: string;
  prompt: string;
  cadence: ScheduledAgentCadence;
  interval_ms: number;
  enabled: boolean;
  created_at: number;
  last_run_at: number | null;
  next_run_at: number;
}

/**
 * One invocation of a scheduled agent — the recurring task's audit
 * row inside the workstation. Receipts emitted by the underlying
 * chat pipeline are the cryptographic truth; this record is the
 * light-weight projection the UI renders without having to join
 * against the receipt log.
 */
export interface ScheduledRunRecord {
  run_id: string;
  agent_id: string;
  prompt: string;
  started_at: number;
  completed_at: number | null;
  /**
   * `running` — fire in flight.
   * `fired`   — completed; response captured.
   * `skipped` — deferred (e.g. user turn was in flight). No response.
   * `error`   — fire path threw. Errored before reaching the pipeline.
   */
  status: "running" | "fired" | "skipped" | "error";
  /** Truncated response preview; full response is on the signed receipt. */
  responsePreview: string | null;
  errorMessage: string | null;
}

/** Result the caller's `fire` returns — tells the runner how to
 *  advance scheduling state. */
export type ScheduledFireResult =
  | { status: "fired"; responsePreview?: string | null }
  | { status: "skipped" }
  | { status: "error"; error: string };

/**
 * Runtime API returned by `createScheduledAgentsRunner`. The workstation
 * panel consumes these actions; the runner owns scheduling + firing.
 */
export interface ScheduledAgentsRunner {
  list(): ScheduledAgent[];
  /** Subscribe to agent-list changes. Returns unsubscribe thunk. */
  subscribe(listener: (agents: ScheduledAgent[]) => void): () => void;
  /** Recent runs (most-recent-first, bounded to the last N). */
  listRuns(): ScheduledRunRecord[];
  /** Subscribe to run-history changes. Returns unsubscribe thunk. */
  subscribeRuns(listener: (runs: ScheduledRunRecord[]) => void): () => void;
  add(input: { prompt: string; cadence: ScheduledAgentCadence }): ScheduledAgent;
  setEnabled(id: string, enabled: boolean): void;
  remove(id: string): void;
  /** Manually fire an agent now (bypasses cadence; next_run_at resets on success). */
  runNow(id: string): void;
  /** Stop the scheduler and release listeners. */
  dispose(): void;
}

// ── Storage ─────────────────────────────────────────────────────────

function loadAgents(): ScheduledAgent[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isScheduledAgent);
  } catch {
    return [];
  }
}

function saveAgents(agents: ScheduledAgent[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(agents));
  } catch {
    // Quota exceeded / privacy mode — the UI will see stale state but
    // the runner keeps functioning against the in-memory copy.
  }
}

function isScheduledAgent(v: unknown): v is ScheduledAgent {
  if (v === null || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.prompt === "string" &&
    (r.cadence === "hourly" || r.cadence === "daily" || r.cadence === "weekly") &&
    typeof r.interval_ms === "number" &&
    typeof r.enabled === "boolean" &&
    typeof r.created_at === "number" &&
    (r.last_run_at === null || typeof r.last_run_at === "number") &&
    typeof r.next_run_at === "number"
  );
}

// ── Runner ──────────────────────────────────────────────────────────

/**
 * Dependencies the scheduler needs to actually fire agents. Injected
 * so the module doesn't hard-couple to `WebApp` (and can be unit-
 * tested with a mock fire function).
 */
export interface ScheduledAgentsDeps {
  /**
   * Fire a scheduled prompt through the motebit's chat pipeline. The
   * implementation typically drives `sendMessageStreaming` (with
   * suppressHistory so the response doesn't pollute the user's chat)
   * and returns a result that tells the runner how to advance
   * scheduling state:
   *
   *   - `"fired"` with optional responsePreview → advance next_run_at,
   *     record completed run.
   *   - `"skipped"` → DO NOT advance. Next 30s tick retries. Used
   *     when the user's turn is in flight so a missed fire waits
   *     30s, not a full cadence.
   *   - `"error"` with message → advance (one backoff) + record error
   *     row. Prevents a failing fire from looping every 30s.
   */
  fire(prompt: string): Promise<ScheduledFireResult>;
}

/** Max retained run records. Enough for a visible history without
 *  unbounded localStorage churn if we persist this later. */
const MAX_RUN_RECORDS = 50;

export function createScheduledAgentsRunner(deps: ScheduledAgentsDeps): ScheduledAgentsRunner {
  let agents = loadAgents();
  let runs: ScheduledRunRecord[] = [];
  const listeners = new Set<(agents: ScheduledAgent[]) => void>();
  const runListeners = new Set<(runs: ScheduledRunRecord[]) => void>();
  /**
   * Agent IDs with an in-flight `fireAgent`. Prevents a second tick
   * from starting a fresh fire on an agent whose previous call is
   * still running (e.g. a slow LLM response overlapping the next
   * 30s tick).
   */
  const inFlight = new Set<string>();
  let disposed = false;

  function emit(): void {
    saveAgents(agents);
    const snapshot = agents.map((a) => ({ ...a }));
    for (const l of listeners) {
      try {
        l(snapshot);
      } catch {
        // Subscriber faults are isolated.
      }
    }
  }

  function emitRuns(): void {
    const snapshot = runs.map((r) => ({ ...r }));
    for (const l of runListeners) {
      try {
        l(snapshot);
      } catch {
        // Subscriber faults are isolated.
      }
    }
  }

  function upsertRun(record: ScheduledRunRecord): void {
    const idx = runs.findIndex((r) => r.run_id === record.run_id);
    if (idx === -1) {
      runs = [record, ...runs].slice(0, MAX_RUN_RECORDS);
    } else {
      runs = runs.map((r) => (r.run_id === record.run_id ? record : r));
    }
    emitRuns();
  }

  function list(): ScheduledAgent[] {
    return agents.map((a) => ({ ...a }));
  }

  function listRuns(): ScheduledRunRecord[] {
    return runs.map((r) => ({ ...r }));
  }

  function subscribe(listener: (agents: ScheduledAgent[]) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function subscribeRuns(listener: (runs: ScheduledRunRecord[]) => void): () => void {
    runListeners.add(listener);
    return () => {
      runListeners.delete(listener);
    };
  }

  function add(input: { prompt: string; cadence: ScheduledAgentCadence }): ScheduledAgent {
    const interval_ms = CADENCE_INTERVAL_MS[input.cadence];
    const now = Date.now();
    const agent: ScheduledAgent = {
      id: newId(),
      prompt: input.prompt,
      cadence: input.cadence,
      interval_ms,
      enabled: true,
      created_at: now,
      last_run_at: null,
      // First fire at the next cadence interval — not immediately. The
      // user just created it; give them a moment. Manual `runNow`
      // exists for "fire it right away."
      next_run_at: now + interval_ms,
    };
    agents = [...agents, agent];
    emit();
    return agent;
  }

  function setEnabled(id: string, enabled: boolean): void {
    agents = agents.map((a) => (a.id === id ? { ...a, enabled } : a));
    emit();
  }

  function remove(id: string): void {
    agents = agents.filter((a) => a.id !== id);
    emit();
  }

  function runNow(id: string): void {
    const agent = agents.find((a) => a.id === id);
    if (!agent) return;
    void fireAgent(agent);
  }

  async function fireAgent(agent: ScheduledAgent): Promise<void> {
    if (inFlight.has(agent.id)) return;
    inFlight.add(agent.id);
    const runId = newId();
    const startedAt = Date.now();
    // Record the run in-flight so the workstation shows "running…"
    // state immediately, before the response arrives.
    upsertRun({
      run_id: runId,
      agent_id: agent.id,
      prompt: agent.prompt,
      started_at: startedAt,
      completed_at: null,
      status: "running",
      responsePreview: null,
      errorMessage: null,
    });

    let result: ScheduledFireResult;
    try {
      result = await deps.fire(agent.prompt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result = { status: "error", error: msg };
    }
    const completedAt = Date.now();
    inFlight.delete(agent.id);

    // Record the terminal state for the UI.
    upsertRun({
      run_id: runId,
      agent_id: agent.id,
      prompt: agent.prompt,
      started_at: startedAt,
      completed_at: completedAt,
      status: result.status,
      responsePreview: result.status === "fired" ? (result.responsePreview ?? null) : null,
      errorMessage: result.status === "error" ? result.error : null,
    });

    // Scheduling advancement:
    //   - `fired` / `error` → advance next_run_at (prevents error loops).
    //   - `skipped` → leave next_run_at alone so the next 30s tick retries.
    //     This is how a missed fire during a user turn waits ~30s rather
    //     than a full cadence interval.
    if (result.status === "fired" || result.status === "error") {
      agents = agents.map((a) =>
        a.id === agent.id
          ? { ...a, last_run_at: startedAt, next_run_at: completedAt + a.interval_ms }
          : a,
      );
      emit();
    }
  }

  function tick(): void {
    if (disposed) return;
    const now = Date.now();
    const due = agents.filter((a) => a.enabled && a.next_run_at <= now && !inFlight.has(a.id));
    for (const a of due) {
      void fireAgent(a);
    }
  }

  // Fire immediately on start for any agents that were due while the
  // tab was closed — then settle into the regular interval.
  const timerId = setInterval(tick, TICK_INTERVAL_MS);
  // Run one tick on the next turn so a just-opened tab catches up
  // without waiting the full 30s interval. Deferred via setTimeout so
  // the caller's subscription can be wired before the first fire.
  const initialTimerId = setTimeout(tick, 2_000);

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    clearInterval(timerId);
    clearTimeout(initialTimerId);
    listeners.clear();
  }

  return {
    list,
    subscribe,
    listRuns,
    subscribeRuns,
    add,
    setEnabled,
    remove,
    runNow,
    dispose,
  };
}

// ── Utilities ───────────────────────────────────────────────────────

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `sch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Human-readable "fires in 3h 12m" style label. */
export function formatCountdownUntil(targetMs: number, nowMs: number = Date.now()): string {
  const diff = targetMs - nowMs;
  if (diff <= 0) return "any moment";
  const s = Math.round(diff / 1000);
  if (s < 60) return `in ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h < 24) return mm === 0 ? `in ${h}h` : `in ${h}h ${mm}m`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return hh === 0 ? `in ${d}d` : `in ${d}d ${hh}h`;
}
