/**
 * Loop supervisor — observability for the relay's background loops.
 *
 * The relay boots ~15 setInterval loops (settlement retry, P2P verifier,
 * treasury reconcilers, deposit detector, batch withdrawal, sweep, anchoring,
 * heartbeat, …). They are the relay's autonomic nervous system: if the
 * settlement-retry or P2P-verifier loop silently stops doing useful work,
 * money stops settling and nothing alerts. `setInterval` does NOT die on a
 * thrown callback — so the real failure modes are invisible by construction:
 *
 *   - a tick that throws/rejects every cycle (e.g. a wedged RPC),
 *   - a tick that hangs forever (interval keeps firing, work never completes),
 *   - a loop that was never started because a config branch was false.
 *
 * This supervisor makes all three observable. Each loop reports through
 * `superviseInterval`; the in-memory state is surfaced at
 * `GET /api/v1/admin/health` (`loops`) so the operator console and any
 * external probe can see per-loop liveness, error rate, and staleness without
 * log-shipping. State is per-process and in-memory by design — the question is
 * "are THIS process's loops healthy right now"; a restart re-registers them.
 */

/** Public per-loop status. Raw counters + a single derived `status`. */
export interface LoopStatus {
  name: string;
  interval_ms: number;
  registered_at: number;
  /** Last time a tick BEGAN. */
  last_start_at: number | null;
  /** Last time a tick COMPLETED successfully. */
  last_ok_at: number | null;
  last_error_at: number | null;
  last_error: string | null;
  /** Last time the tick was skipped by its frozen-guard (a healthy state). */
  last_skip_at: number | null;
  tick_count: number;
  ok_count: number;
  error_count: number;
  skip_count: number;
  /** A tick is currently in flight (began, not yet completed/failed). */
  running: boolean;
  /**
   * Derived health:
   *   - `idle`     — registered, within a grace window, no tick yet.
   *   - `ok`       — completed (or was healthily skipped) within the freshness window.
   *   - `hung`     — a tick has been in flight longer than the freshness window.
   *   - `stale`    — no successful tick / skip within the freshness window (and not hung).
   *   - `erroring` — last tick errored and there has been no success since.
   */
  status: "idle" | "ok" | "hung" | "stale" | "erroring";
}

interface LoopRecord {
  name: string;
  intervalMs: number;
  registeredAt: number;
  lastStartAt: number | null;
  lastOkAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  lastSkipAt: number | null;
  tickCount: number;
  okCount: number;
  errorCount: number;
  skipCount: number;
  running: boolean;
}

export interface LoopSupervisorOptions {
  /** Injected for testability. */
  now?: () => number;
  /**
   * A loop is "fresh" if it completed (or was skipped) within
   * `staleFactor × intervalMs`. 3 tolerates two missed cycles before flagging.
   */
  staleFactor?: number;
}

export class LoopSupervisor {
  private readonly loops = new Map<string, LoopRecord>();
  private readonly now: () => number;
  private readonly staleFactor: number;

  constructor(opts: LoopSupervisorOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.staleFactor = opts.staleFactor ?? 3;
  }

  /** Register a loop. Idempotent — re-registering preserves existing counters. */
  register(name: string, intervalMs: number): void {
    if (this.loops.has(name)) return;
    this.loops.set(name, {
      name,
      intervalMs,
      registeredAt: this.now(),
      lastStartAt: null,
      lastOkAt: null,
      lastErrorAt: null,
      lastError: null,
      lastSkipAt: null,
      tickCount: 0,
      okCount: 0,
      errorCount: 0,
      skipCount: 0,
      running: false,
    });
  }

  markStart(name: string): void {
    const r = this.loops.get(name);
    if (!r) return;
    r.lastStartAt = this.now();
    r.tickCount += 1;
    r.running = true;
  }

  markOk(name: string): void {
    const r = this.loops.get(name);
    if (!r) return;
    r.lastOkAt = this.now();
    r.okCount += 1;
    r.running = false;
  }

  markError(name: string, err: unknown): void {
    const r = this.loops.get(name);
    if (!r) return;
    r.lastErrorAt = this.now();
    r.lastError = err instanceof Error ? err.message : String(err);
    r.errorCount += 1;
    r.running = false;
  }

  markSkip(name: string): void {
    const r = this.loops.get(name);
    if (!r) return;
    r.lastSkipAt = this.now();
    r.skipCount += 1;
  }

  /** Compute the derived status for a record at time `now`. */
  private statusOf(r: LoopRecord, now: number): LoopStatus["status"] {
    const freshness = r.intervalMs * this.staleFactor;
    // A tick in flight longer than the freshness window is hung.
    if (r.running && r.lastStartAt != null && now - r.lastStartAt > freshness) return "hung";
    // Most recent healthy signal: a successful tick OR a healthy frozen-skip.
    const lastHealthy = Math.max(r.lastOkAt ?? 0, r.lastSkipAt ?? 0);
    if (lastHealthy > 0) {
      if (now - lastHealthy <= freshness) return "ok";
      // No healthy signal recently: erroring if the last tick errored, else stale.
      if (r.lastErrorAt != null && r.lastErrorAt >= lastHealthy) return "erroring";
      return "stale";
    }
    // Never completed a healthy tick.
    if (r.lastErrorAt != null) return "erroring";
    // No activity yet — idle within the grace window, stale after.
    if (now - r.registeredAt <= freshness) return "idle";
    return "stale";
  }

  snapshot(): LoopStatus[] {
    const now = this.now();
    return [...this.loops.values()]
      .map((r) => ({
        name: r.name,
        interval_ms: r.intervalMs,
        registered_at: r.registeredAt,
        last_start_at: r.lastStartAt,
        last_ok_at: r.lastOkAt,
        last_error_at: r.lastErrorAt,
        last_error: r.lastError,
        last_skip_at: r.lastSkipAt,
        tick_count: r.tickCount,
        ok_count: r.okCount,
        error_count: r.errorCount,
        skip_count: r.skipCount,
        running: r.running,
        status: this.statusOf(r, now),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** True if any registered loop is not `ok`/`idle` — the alerting signal. */
  anyUnhealthy(): boolean {
    return this.snapshot().some(
      (l) => l.status === "stale" || l.status === "erroring" || l.status === "hung",
    );
  }
}

/**
 * Start a supervised interval. The canonical way to launch a relay background
 * loop. Owns the `setInterval`, applies the optional frozen-guard, and reports
 * each tick's lifecycle to the supervisor. `tick` may be sync or async — the
 * returned promise (if any) is awaited so async errors are captured as
 * `markError` rather than escaping as an unhandled rejection (the prior
 * `void asyncWork()` shape leaked these).
 *
 * Backward compatible: when `supervisor` is undefined it degrades to a plain
 * frozen-guarded interval, so a loop module's unit tests that call it without
 * a supervisor behave exactly as before.
 */
export function superviseInterval(
  supervisor: LoopSupervisor | undefined,
  name: string,
  intervalMs: number,
  tick: () => void | Promise<void>,
  opts: { isFrozen?: () => boolean } = {},
): ReturnType<typeof setInterval> {
  supervisor?.register(name, intervalMs);
  return setInterval(() => {
    if (opts.isFrozen?.()) {
      supervisor?.markSkip(name);
      return;
    }
    if (supervisor === undefined) {
      // Plain path — preserve the original fire-and-forget shape exactly.
      void Promise.resolve()
        .then(tick)
        .catch(() => {});
      return;
    }
    supervisor.markStart(name);
    Promise.resolve()
      .then(tick)
      .then(() => supervisor.markOk(name))
      .catch((err: unknown) => supervisor.markError(name, err));
  }, intervalMs);
}
