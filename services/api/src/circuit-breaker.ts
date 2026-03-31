/**
 * Federation Circuit Breaker — per-peer forward health tracking.
 *
 * Three-state machine per peer:
 *   CLOSED  → healthy, forwarding allowed
 *   OPEN    → failing, forwarding blocked until resetTimeout elapses
 *   HALF_OPEN → probing: limited forwarding allowed, success closes, failure re-opens
 *
 * Integrates with (but does not replace) heartbeat-based liveness tracking.
 * Heartbeat handles liveness (3 missed → suspend, 5 → remove).
 * Circuit breaker handles forward-path health.
 */

import { createLogger } from "./logger.js";

const logger = createLogger({ service: "relay", module: "circuit-breaker" });

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

export class CircuitBreaker {
  private readonly peers = new Map<string, PeerEntry>();
  private readonly config: CircuitBreakerConfig;
  private readonly _now: () => number;

  constructor(config?: Partial<CircuitBreakerConfig>, now?: () => number) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this._now = now ?? (() => Date.now());
  }

  /**
   * Record a successful forward to a peer.
   * In HALF_OPEN: if successThreshold met, transition to CLOSED.
   * In CLOSED: no-op (already healthy).
   */
  recordSuccess(peerId: string): void {
    const entry = this.peers.get(peerId);
    if (!entry) return; // No entry = never failed = closed

    const now = this._now();

    if (entry.state === "half_open") {
      entry.halfOpenSuccesses++;
      if (entry.halfOpenSuccesses >= this.config.successThreshold) {
        this.transition(peerId, entry, "closed", now);
      }
    } else if (entry.state === "closed") {
      // Success in closed state: prune stale failures from the window
      this.pruneWindow(entry, now);
    }
    // In OPEN state: success shouldn't happen (canForward returns false),
    // but if it does, ignore — the timeout path handles OPEN → HALF_OPEN.
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
      // Check threshold even for first entry (won't trigger with default threshold=5)
      if (entry.failureTimestamps.length >= this.config.failureThreshold) {
        this.transition(peerId, entry, "open", now);
      }
      return;
    }

    entry.lastFailureAt = now;

    if (entry.state === "half_open") {
      // Any failure in half_open immediately re-opens
      this.transition(peerId, entry, "open", now);
    } else if (entry.state === "closed") {
      entry.failureTimestamps.push(now);
      this.pruneWindow(entry, now);
      if (entry.failureTimestamps.length >= this.config.failureThreshold) {
        this.transition(peerId, entry, "open", now);
      }
    }
    // In OPEN state: failure is expected (we're not forwarding), ignore.
  }

  /**
   * Check if forwarding to a peer is allowed.
   * CLOSED → yes
   * OPEN → check if resetTimeout has elapsed → transition to HALF_OPEN → yes
   * HALF_OPEN → yes (probing)
   */
  canForward(peerId: string): boolean {
    const entry = this.peers.get(peerId);
    if (!entry) return true; // No entry = never failed = closed

    if (entry.state === "closed") return true;
    if (entry.state === "half_open") return true;

    // OPEN: check if enough time has passed to probe
    const now = this._now();
    if (now - entry.lastStateChangeAt >= this.config.resetTimeoutMs) {
      this.transition(peerId, entry, "half_open", now);
      return true;
    }

    return false;
  }

  /** Get the current circuit breaker state for a peer (observability). */
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

    // For closed state, prune the window to give accurate failure count
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

  /** Reset a peer's circuit breaker (e.g., after manual intervention). */
  reset(peerId: string): void {
    this.peers.delete(peerId);
    logger.info("circuit_breaker.reset", { peerId });
  }

  /** Get all tracked peers and their states. */
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
      // Reset all counters on close
      entry.failureTimestamps = [];
      entry.halfOpenSuccesses = 0;
    } else if (newState === "half_open") {
      // Reset half-open success counter
      entry.halfOpenSuccesses = 0;
    } else if (newState === "open") {
      // Clear window timestamps — they served their purpose
      entry.failureTimestamps = [];
      entry.halfOpenSuccesses = 0;
    }

    logger.info("circuit_breaker.state_change", {
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
