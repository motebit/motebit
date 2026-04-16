/**
 * Three-state machine tests. Every transition path plus the two full lifecycles.
 * Clock is injected so time-based transitions are deterministic.
 */
import { describe, it, expect, vi } from "vitest";
import { CircuitBreaker, type CircuitBreakerLogger } from "../index.js";

describe("CircuitBreaker", () => {
  const PEER = "https://peer-a.example.com";

  // ── Initial state ──

  it("starts in closed state for unknown peers", () => {
    const cb = new CircuitBreaker();
    const state = cb.getState(PEER);
    expect(state.state).toBe("closed");
    expect(state.failures).toBe(0);
    expect(state.successes).toBe(0);
  });

  it("canForward returns true for unknown peers", () => {
    const cb = new CircuitBreaker();
    expect(cb.canForward(PEER)).toBe(true);
  });

  // ── CLOSED → OPEN transition ──

  it("opens circuit after failureThreshold failures", () => {
    const cb = new CircuitBreaker({ config: { failureThreshold: 3 } });
    cb.recordFailure(PEER);
    cb.recordFailure(PEER);
    expect(cb.getState(PEER).state).toBe("closed");
    expect(cb.canForward(PEER)).toBe(true);

    cb.recordFailure(PEER);
    expect(cb.getState(PEER).state).toBe("open");
    expect(cb.canForward(PEER)).toBe(false);
  });

  it("first failure can open the circuit when threshold is 1", () => {
    const cb = new CircuitBreaker({ config: { failureThreshold: 1 } });
    cb.recordFailure(PEER);
    expect(cb.getState(PEER).state).toBe("open");
  });

  it("does not open circuit if failures are outside the sliding window", () => {
    let now = 1000;
    const cb = new CircuitBreaker({
      config: { failureThreshold: 3, windowMs: 5000 },
      now: () => now,
    });

    cb.recordFailure(PEER); // t=1000
    now = 2000;
    cb.recordFailure(PEER); // t=2000

    // Advance past the window for the first failure
    now = 7000;
    cb.recordFailure(PEER); // t=7000 — first failure (t=1000) is outside window

    // Only 2 failures in window (t=2000, t=7000), threshold is 3
    expect(cb.getState(PEER).state).toBe("closed");
  });

  // ── OPEN → HALF_OPEN transition ──

  it("transitions to half_open after resetTimeout elapses", () => {
    let now = 0;
    const cb = new CircuitBreaker({
      config: { failureThreshold: 2, resetTimeoutMs: 10_000 },
      now: () => now,
    });

    cb.recordFailure(PEER);
    cb.recordFailure(PEER);
    expect(cb.getState(PEER).state).toBe("open");
    expect(cb.canForward(PEER)).toBe(false);

    now = 10_000;
    expect(cb.canForward(PEER)).toBe(true);
    expect(cb.getState(PEER).state).toBe("half_open");
  });

  it("stays open if resetTimeout has not elapsed", () => {
    let now = 0;
    const cb = new CircuitBreaker({
      config: { failureThreshold: 2, resetTimeoutMs: 10_000 },
      now: () => now,
    });

    cb.recordFailure(PEER);
    cb.recordFailure(PEER);

    now = 5000;
    expect(cb.canForward(PEER)).toBe(false);
    expect(cb.getState(PEER).state).toBe("open");
  });

  // ── HALF_OPEN → CLOSED transition ──

  it("closes circuit after successThreshold successes in half_open", () => {
    let now = 0;
    const cb = new CircuitBreaker({
      config: { failureThreshold: 2, successThreshold: 2, resetTimeoutMs: 5000 },
      now: () => now,
    });

    cb.recordFailure(PEER);
    cb.recordFailure(PEER);
    expect(cb.getState(PEER).state).toBe("open");

    now = 5000;
    expect(cb.canForward(PEER)).toBe(true);
    expect(cb.getState(PEER).state).toBe("half_open");

    cb.recordSuccess(PEER);
    expect(cb.getState(PEER).state).toBe("half_open");
    expect(cb.getState(PEER).successes).toBe(1);

    cb.recordSuccess(PEER);
    expect(cb.getState(PEER).state).toBe("closed");
    expect(cb.getState(PEER).failures).toBe(0);
    expect(cb.getState(PEER).successes).toBe(0);
  });

  // ── HALF_OPEN → OPEN transition ──

  it("re-opens circuit on failure in half_open state", () => {
    let now = 0;
    const cb = new CircuitBreaker({
      config: { failureThreshold: 2, resetTimeoutMs: 5000 },
      now: () => now,
    });

    cb.recordFailure(PEER);
    cb.recordFailure(PEER);

    now = 5000;
    cb.canForward(PEER); // triggers half_open
    expect(cb.getState(PEER).state).toBe("half_open");

    cb.recordFailure(PEER);
    expect(cb.getState(PEER).state).toBe("open");
    expect(cb.canForward(PEER)).toBe(false);
  });

  // ── OPEN is a no-op for recordSuccess / recordFailure ──

  it("recordSuccess is a no-op while OPEN (timeout path governs recovery)", () => {
    const cb = new CircuitBreaker({
      config: { failureThreshold: 2, resetTimeoutMs: 10_000 },
    });
    cb.recordFailure(PEER);
    cb.recordFailure(PEER);
    expect(cb.getState(PEER).state).toBe("open");

    cb.recordSuccess(PEER);
    expect(cb.getState(PEER).state).toBe("open");
  });

  it("canForward returns true on a subsequent call while HALF_OPEN (probing)", () => {
    let now = 0;
    const cb = new CircuitBreaker({
      config: { failureThreshold: 2, resetTimeoutMs: 5000 },
      now: () => now,
    });
    cb.recordFailure(PEER);
    cb.recordFailure(PEER);
    now = 5000;
    cb.canForward(PEER); // OPEN → HALF_OPEN (returns via OPEN branch)
    expect(cb.getState(PEER).state).toBe("half_open");
    // Second call hits the explicit half_open branch
    expect(cb.canForward(PEER)).toBe(true);
  });

  it("recordFailure while OPEN does not retrigger a transition", () => {
    let now = 0;
    const cb = new CircuitBreaker({
      config: { failureThreshold: 2, resetTimeoutMs: 10_000 },
      now: () => now,
    });
    cb.recordFailure(PEER);
    cb.recordFailure(PEER);
    const openedAt = cb.getState(PEER).lastStateChangeAt;

    now = 5000;
    cb.recordFailure(PEER);
    expect(cb.getState(PEER).state).toBe("open");
    expect(cb.getState(PEER).lastStateChangeAt).toBe(openedAt);
  });

  // ── Per-peer isolation ──

  it("tracks state independently per peer", () => {
    const PEER_B = "https://peer-b.example.com";
    const cb = new CircuitBreaker({ config: { failureThreshold: 2 } });

    cb.recordFailure(PEER);
    cb.recordFailure(PEER);
    expect(cb.getState(PEER).state).toBe("open");
    expect(cb.getState(PEER_B).state).toBe("closed");
    expect(cb.canForward(PEER_B)).toBe(true);
  });

  // ── Success in closed state ──

  it("success for an untracked peer is a no-op", () => {
    const cb = new CircuitBreaker();
    cb.recordSuccess(PEER);
    expect(cb.getState(PEER).state).toBe("closed");
  });

  it("success in closed state prunes stale failures from window", () => {
    let now = 0;
    const cb = new CircuitBreaker({
      config: { failureThreshold: 3, windowMs: 5000 },
      now: () => now,
    });

    cb.recordFailure(PEER); // t=0
    cb.recordFailure(PEER); // t=0
    expect(cb.getState(PEER).failures).toBe(2);

    now = 6000;
    cb.recordSuccess(PEER); // prunes failures older than t=1000
    expect(cb.getState(PEER).failures).toBe(0);
  });

  // ── Reset ──

  it("reset clears all state for a peer", () => {
    const cb = new CircuitBreaker({ config: { failureThreshold: 2 } });
    cb.recordFailure(PEER);
    cb.recordFailure(PEER);
    expect(cb.getState(PEER).state).toBe("open");

    cb.reset(PEER);
    expect(cb.getState(PEER).state).toBe("closed");
    expect(cb.getState(PEER).failures).toBe(0);
    expect(cb.canForward(PEER)).toBe(true);
  });

  // ── getAllStates ──

  it("getAllStates returns all tracked peers", () => {
    const PEER_B = "https://peer-b.example.com";
    const cb = new CircuitBreaker({ config: { failureThreshold: 2 } });
    cb.recordFailure(PEER);
    cb.recordFailure(PEER_B);

    const all = cb.getAllStates();
    expect(all.size).toBe(2);
    expect(all.get(PEER)!.state).toBe("closed");
    expect(all.get(PEER_B)!.state).toBe("closed");
  });

  // ── Full lifecycle ──

  it("full lifecycle: closed → open → half_open → closed", () => {
    let now = 0;
    const cb = new CircuitBreaker({
      config: {
        failureThreshold: 3,
        successThreshold: 2,
        resetTimeoutMs: 10_000,
        windowMs: 60_000,
      },
      now: () => now,
    });

    expect(cb.canForward(PEER)).toBe(true);
    cb.recordFailure(PEER);
    cb.recordFailure(PEER);
    cb.recordFailure(PEER);
    expect(cb.getState(PEER).state).toBe("open");
    expect(cb.canForward(PEER)).toBe(false);

    now = 10_000;
    expect(cb.canForward(PEER)).toBe(true);
    expect(cb.getState(PEER).state).toBe("half_open");

    cb.recordSuccess(PEER);
    expect(cb.getState(PEER).state).toBe("half_open");
    cb.recordSuccess(PEER);
    expect(cb.getState(PEER).state).toBe("closed");

    expect(cb.canForward(PEER)).toBe(true);
    expect(cb.getState(PEER).failures).toBe(0);
  });

  it("full lifecycle: closed → open → half_open → open (probe fails)", () => {
    let now = 0;
    const cb = new CircuitBreaker({
      config: { failureThreshold: 2, resetTimeoutMs: 5000 },
      now: () => now,
    });

    cb.recordFailure(PEER);
    cb.recordFailure(PEER);
    expect(cb.getState(PEER).state).toBe("open");

    now = 5000;
    cb.canForward(PEER); // → half_open
    cb.recordFailure(PEER); // → back to open
    expect(cb.getState(PEER).state).toBe("open");
    expect(cb.canForward(PEER)).toBe(false);

    now = 10_000;
    expect(cb.canForward(PEER)).toBe(true);
    expect(cb.getState(PEER).state).toBe("half_open");
  });

  // ── Default config ──

  it("uses default config values", () => {
    const cb = new CircuitBreaker();
    for (let i = 0; i < 4; i++) cb.recordFailure(PEER);
    expect(cb.getState(PEER).state).toBe("closed");

    cb.recordFailure(PEER); // 5th → open
    expect(cb.getState(PEER).state).toBe("open");
  });

  // ── Logger injection ──

  it("emits structured events to the injected logger on transitions", () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const logger: CircuitBreakerLogger = {
      info: (event, data) => events.push({ event, data }),
    };
    let now = 0;
    const cb = new CircuitBreaker({
      config: { failureThreshold: 2, resetTimeoutMs: 1000, successThreshold: 1 },
      now: () => now,
      logger,
    });

    cb.recordFailure(PEER);
    cb.recordFailure(PEER); // CLOSED → OPEN
    now = 1000;
    cb.canForward(PEER); // OPEN → HALF_OPEN
    cb.recordSuccess(PEER); // HALF_OPEN → CLOSED
    cb.reset(PEER);

    expect(events.map((e) => e.event)).toEqual([
      "circuit_breaker.state_change",
      "circuit_breaker.state_change",
      "circuit_breaker.state_change",
      "circuit_breaker.reset",
    ]);
    expect(events[0]!.data).toEqual({ peerId: PEER, from: "closed", to: "open" });
    expect(events[1]!.data).toEqual({ peerId: PEER, from: "open", to: "half_open" });
    expect(events[2]!.data).toEqual({ peerId: PEER, from: "half_open", to: "closed" });
    expect(events[3]!.data).toEqual({ peerId: PEER });
  });

  it("is silent when no logger is injected", () => {
    const spy = vi.spyOn(console, "log");
    const cb = new CircuitBreaker({ config: { failureThreshold: 1 } });
    cb.recordFailure(PEER);
    cb.reset(PEER);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
