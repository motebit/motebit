/**
 * Idle-tick controller — scheduling primitive for proactive motebit
 * behavior (KAIROS-shape heartbeat).
 *
 * The pattern, extracted from the Claude Code source leak and
 * refitted to motebit's sovereign-interior posture:
 *
 *   1. Every N ms, the runtime asks itself "am I idle?"
 *   2. When idle, emit an `idle_tick_fired` event to the log.
 *   3. (Future) Downstream consumers wire an LLM call into the tick
 *      to produce proactive actions — surface-specific because a
 *      proactive action's UX (toast? notification? chat bubble?)
 *      differs per surface. Shipping the scheduling primitive now
 *      lets that wiring happen without retrofitting a scheduler
 *      later.
 *
 * "Idle" means: the runtime is not currently processing a turn AND
 * the last user message was at least `quietWindowMs` ago. Both
 * conditions matter — a processing-true runtime is mid-conversation,
 * a recently-active one would surprise the user with a proactive
 * action right after their message completes.
 *
 * Single-flight: at most one tick in flight at a time. A long-running
 * `onTick` callback cannot pile up against subsequent ticks.
 *
 * Errors thrown by `onTick` are caught and forwarded to the logger —
 * the scheduler continues. A broken proactive action must not stop
 * the heartbeat from firing in the future.
 */

export interface IdleTickDeps {
  /** How often to check idleness. Typical: 60_000 (one minute). */
  readonly intervalMs: number;
  /**
   * How long after the last user message a turn is considered "idle
   * enough to act." Typical: 30_000–120_000 (30s–2min). Short enough
   * that proactivity feels responsive, long enough that the user
   * isn't surprised by an action immediately after finishing a turn.
   */
  readonly quietWindowMs: number;
  /** True while the runtime is actively processing a turn. */
  isProcessing(): boolean;
  /** Millisecond timestamp of the last user-sent message, or null
   *  when the runtime has no user interaction yet this session. */
  lastUserMessageAt(): number | null;
  /** The per-tick action. May be async; subsequent ticks wait for
   *  the current one to finish (single-flight). */
  onTick(timestamp: number): void | Promise<void>;
  /** Optional logger for caught errors. Defaults to `console.warn`. */
  logger?: { warn(message: string, context?: Record<string, unknown>): void };
  /** Override `Date.now` for tests. */
  now?(): number;
}

export interface IdleTickController {
  /** Start the interval. Idempotent — already-started controllers no-op. */
  start(): void;
  /** Stop the interval. Idempotent — already-stopped controllers no-op. */
  stop(): void;
  /** True between `start()` and `stop()`. */
  isRunning(): boolean;
  /** Manually fire an idle check — used by tests + external triggers. */
  tickNow(): Promise<void>;
}

export function createIdleTickController(deps: IdleTickDeps): IdleTickController {
  const warn =
    deps.logger?.warn.bind(deps.logger) ??
    // eslint-disable-next-line no-console -- fallback when no logger injected
    ((msg: string, ctx?: Record<string, unknown>) => console.warn(msg, ctx));
  const now = (): number => (deps.now ? deps.now() : Date.now());

  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  async function tickNow(): Promise<void> {
    if (inFlight) return; // single-flight
    if (deps.isProcessing()) return;
    const last = deps.lastUserMessageAt();
    const currentTime = now();
    if (last != null && currentTime - last < deps.quietWindowMs) return;

    inFlight = true;
    try {
      await deps.onTick(currentTime);
    } catch (err: unknown) {
      warn("idle tick handler threw", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      inFlight = false;
    }
  }

  return {
    start() {
      if (timer !== null) return;
      timer = setInterval(() => {
        void tickNow();
      }, deps.intervalMs);
    },
    stop() {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },
    isRunning() {
      return timer !== null;
    },
    tickNow,
  };
}
