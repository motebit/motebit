/**
 * Per-peer forward-health circuit breaker — a three-state machine.
 *
 *   CLOSED    → healthy, forwarding allowed
 *   OPEN      → failing, forwarding blocked until resetTimeoutMs elapses
 *   HALF_OPEN → probing: limited forwarding allowed; success closes, failure re-opens
 *
 * Generic enough for any outbound-call health guard (federation forwards,
 * MCP client retries, webhook delivery, RPC peers). Zero I/O, deterministic
 * when the clock is injected. Consumers supply an optional logger to emit
 * structured state transitions in whatever shape their platform uses.
 *
 * Integrates with — but does not replace — liveness signals like heartbeats:
 * liveness answers "is the peer reachable at all?"; the circuit breaker
 * answers "is forwarding through it likely to succeed right now?".
 */

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerConfig {
  /** Failures within the sliding window before transitioning CLOSED → OPEN. Default: 5. */
  failureThreshold: number;
  /** Successes in HALF_OPEN before transitioning back to CLOSED. Default: 2. */
  successThreshold: number;
  /** Time in OPEN (ms) before transitioning to HALF_OPEN for probing. Default: 60_000. */
  resetTimeoutMs: number;
  /** Sliding window (ms) for counting failures in CLOSED state. Default: 120_000. */
  windowMs: number;
}

export interface CircuitBreakerState {
  state: CircuitState;
  /** Failure timestamps within the current window (CLOSED) or total failures (OPEN/HALF_OPEN). */
  failures: number;
  /** Consecutive successes counted while in HALF_OPEN state. */
  successes: number;
  lastFailureAt: number;
  lastStateChangeAt: number;
}

/**
 * Minimal shape the circuit breaker needs from a logger. Any structured
 * logger with an `info(event, data)` signature satisfies it; callers pass
 * their platform logger (e.g., a module-scoped `createLogger("relay")`
 * adapter). Omit to get a silent default.
 */
export interface CircuitBreakerLogger {
  info(event: string, data: Record<string, unknown>): void;
}

export interface CircuitBreakerOptions {
  config?: Partial<CircuitBreakerConfig>;
  now?: () => number;
  logger?: CircuitBreakerLogger;
}

interface PeerEntry {
  state: CircuitState;
  /** Failure timestamps within the sliding window (for CLOSED state windowed counting). */
  failureTimestamps: number[];
  /** Consecutive successes in HALF_OPEN. */
  halfOpenSuccesses: number;
  lastFailureAt: number;
  lastStateChangeAt: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  successThreshold: 2,
  resetTimeoutMs: 60_000,
  windowMs: 120_000,
};

const NOOP_LOGGER: CircuitBreakerLogger = { info: () => {} };

export class CircuitBreaker {
  private readonly peers = new Map<string, PeerEntry>();
  private readonly config: CircuitBreakerConfig;
  private readonly _now: () => number;
  private readonly logger: CircuitBreakerLogger;

  constructor(options: CircuitBreakerOptions = {}) {
    this.config = { ...DEFAULT_CONFIG, ...options.config };
    this._now = options.now ?? (() => Date.now());
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  /**
   * Record a successful forward to a peer.
   * In HALF_OPEN: if successThreshold met, transition to CLOSED.
   * In CLOSED: prune stale failures from the window.
   */
  recordSuccess(peerId: string): void {
    const entry = this.peers.get(peerId);
    if (!entry) return;

    const now = this._now();

    if (entry.state === "half_open") {
      entry.halfOpenSuccesses++;
      if (entry.halfOpenSuccesses >= this.config.successThreshold) {
        this.transition(peerId, entry, "closed", now);
      }
    } else if (entry.state === "closed") {
      this.pruneWindow(entry, now);
    }
    // In OPEN: success shouldn't happen (canForward returns false);
    // the timeout path handles OPEN → HALF_OPEN.
  }

  /**
   * Record a failed forward to a peer.
   * In CLOSED: add to sliding window; if threshold met, transition to OPEN.
   * In HALF_OPEN: immediately transition back to OPEN.
   */
  recordFailure(peerId: string): void {
    const now = this._now();
    let entry = this.peers.get(peerId);

    if (!entry) {
      entry = {
        state: "closed",
        failureTimestamps: [now],
        halfOpenSuccesses: 0,
        lastFailureAt: now,
        lastStateChangeAt: now,
      };
      this.peers.set(peerId, entry);
      if (entry.failureTimestamps.length >= this.config.failureThreshold) {
        this.transition(peerId, entry, "open", now);
      }
      return;
    }

    entry.lastFailureAt = now;

    if (entry.state === "half_open") {
      this.transition(peerId, entry, "open", now);
    } else if (entry.state === "closed") {
      entry.failureTimestamps.push(now);
      this.pruneWindow(entry, now);
      if (entry.failureTimestamps.length >= this.config.failureThreshold) {
        this.transition(peerId, entry, "open", now);
      }
    }
    // In OPEN: failure is expected (we're not forwarding), ignore.
  }

  /**
   * Check if forwarding to a peer is allowed.
   * CLOSED → yes. OPEN → yes once resetTimeoutMs elapses (transitions to HALF_OPEN). HALF_OPEN → yes (probing).
   */
  canForward(peerId: string): boolean {
    const entry = this.peers.get(peerId);
    if (!entry) return true;

    if (entry.state === "closed") return true;
    if (entry.state === "half_open") return true;

    const now = this._now();
    if (now - entry.lastStateChangeAt >= this.config.resetTimeoutMs) {
      this.transition(peerId, entry, "half_open", now);
      return true;
    }

    return false;
  }

  /** Current observable state for a peer. */
  getState(peerId: string): CircuitBreakerState {
    const entry = this.peers.get(peerId);
    if (!entry) {
      return {
        state: "closed",
        failures: 0,
        successes: 0,
        lastFailureAt: 0,
        lastStateChangeAt: 0,
      };
    }

    if (entry.state === "closed") {
      this.pruneWindow(entry, this._now());
    }

    return {
      state: entry.state,
      failures: entry.failureTimestamps.length,
      successes: entry.halfOpenSuccesses,
      lastFailureAt: entry.lastFailureAt,
      lastStateChangeAt: entry.lastStateChangeAt,
    };
  }

  /** Forget a peer's state entirely (e.g., after manual intervention). */
  reset(peerId: string): void {
    this.peers.delete(peerId);
    this.logger.info("circuit_breaker.reset", { peerId });
  }

  /** Snapshot of every tracked peer. */
  getAllStates(): Map<string, CircuitBreakerState> {
    const result = new Map<string, CircuitBreakerState>();
    for (const peerId of this.peers.keys()) {
      result.set(peerId, this.getState(peerId));
    }
    return result;
  }

  private transition(peerId: string, entry: PeerEntry, newState: CircuitState, now: number): void {
    const oldState = entry.state;
    entry.state = newState;
    entry.lastStateChangeAt = now;

    if (newState === "closed") {
      entry.failureTimestamps = [];
      entry.halfOpenSuccesses = 0;
    } else if (newState === "half_open") {
      entry.halfOpenSuccesses = 0;
    } else {
      entry.failureTimestamps = [];
      entry.halfOpenSuccesses = 0;
    }

    this.logger.info("circuit_breaker.state_change", {
      peerId,
      from: oldState,
      to: newState,
    });
  }

  private pruneWindow(entry: PeerEntry, now: number): void {
    const cutoff = now - this.config.windowMs;
    entry.failureTimestamps = entry.failureTimestamps.filter((ts) => ts >= cutoff);
  }
}
