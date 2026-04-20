/**
 * PresenceController — state machine, subscriber notification,
 * watchdog stuck-guard.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PresenceController } from "../presence";

describe("PresenceController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts in idle with null lastTickAt", () => {
    const ctrl = new PresenceController();
    const state = ctrl.get();
    expect(state.mode).toBe("idle");
    if (state.mode === "idle") {
      expect(state.lastTickAt).toBeNull();
    }
  });

  it("canStartCycle is true only in idle", () => {
    const ctrl = new PresenceController();
    expect(ctrl.canStartCycle()).toBe(true);
    ctrl.enterTending("c1", "orient");
    expect(ctrl.canStartCycle()).toBe(false);
    ctrl.exitTending();
    expect(ctrl.canStartCycle()).toBe(true);
    ctrl.enterResponsive();
    expect(ctrl.canStartCycle()).toBe(false);
  });

  it("enterTending records phase, startedAt, cycleId", () => {
    const now = vi.fn(() => 1_000_000);
    const ctrl = new PresenceController({ now });
    ctrl.enterTending("cycle-abc", "orient");
    const state = ctrl.get();
    expect(state.mode).toBe("tending");
    if (state.mode === "tending") {
      expect(state.phase).toBe("orient");
      expect(state.cycleId).toBe("cycle-abc");
      expect(state.startedAt).toBe(1_000_000);
    }
  });

  it("advancePhase updates phase but preserves startedAt and cycleId", () => {
    const now = vi.fn(() => 1_000_000);
    const ctrl = new PresenceController({ now });
    ctrl.enterTending("cycle-xyz", "orient");
    now.mockReturnValue(1_005_000);
    ctrl.advancePhase("gather");
    const state = ctrl.get();
    expect(state.mode).toBe("tending");
    if (state.mode === "tending") {
      expect(state.phase).toBe("gather");
      expect(state.startedAt).toBe(1_000_000);
      expect(state.cycleId).toBe("cycle-xyz");
    }
  });

  it("advancePhase is a no-op when not in tending mode", () => {
    const ctrl = new PresenceController();
    ctrl.advancePhase("gather");
    expect(ctrl.get().mode).toBe("idle");
  });

  it("exitTending returns to idle and stamps lastTickAt", () => {
    const now = vi.fn(() => 1_000_000);
    const ctrl = new PresenceController({ now });
    ctrl.enterTending("c", "orient");
    now.mockReturnValue(1_002_000);
    ctrl.exitTending();
    const state = ctrl.get();
    expect(state.mode).toBe("idle");
    if (state.mode === "idle") expect(state.lastTickAt).toBe(1_002_000);
  });

  it("subscribers receive every transition", () => {
    const ctrl = new PresenceController();
    const sub = vi.fn();
    ctrl.subscribe(sub);
    ctrl.enterTending("c", "orient");
    ctrl.advancePhase("gather");
    ctrl.exitTending();
    ctrl.enterResponsive();
    expect(sub).toHaveBeenCalledTimes(4);
  });

  it("unsubscribe stops further notifications", () => {
    const ctrl = new PresenceController();
    const sub = vi.fn();
    const off = ctrl.subscribe(sub);
    ctrl.enterTending("c", "orient");
    off();
    ctrl.exitTending();
    expect(sub).toHaveBeenCalledTimes(1);
  });

  it("subscriber errors do not propagate", () => {
    const ctrl = new PresenceController();
    ctrl.subscribe(() => {
      throw new Error("subscriber blew up");
    });
    expect(() => ctrl.enterTending("c", "orient")).not.toThrow();
  });

  it("watchdog forces idle after timeout if exitTending was not called", () => {
    const onWatchdog = vi.fn();
    const ctrl = new PresenceController({ watchdogTimeoutMs: 1000, onWatchdogFired: onWatchdog });
    ctrl.enterTending("stuck-cycle", "consolidate");
    expect(ctrl.isWatchdogArmed()).toBe(true);
    vi.advanceTimersByTime(999);
    expect(ctrl.get().mode).toBe("tending");
    vi.advanceTimersByTime(2);
    expect(ctrl.get().mode).toBe("idle");
    expect(onWatchdog).toHaveBeenCalledWith("stuck-cycle", "consolidate");
    expect(ctrl.isWatchdogArmed()).toBe(false);
  });

  it("exitTending clears the watchdog", () => {
    const onWatchdog = vi.fn();
    const ctrl = new PresenceController({ watchdogTimeoutMs: 1000, onWatchdogFired: onWatchdog });
    ctrl.enterTending("c", "orient");
    ctrl.exitTending();
    expect(ctrl.isWatchdogArmed()).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(onWatchdog).not.toHaveBeenCalled();
  });

  it("enterResponsive does not clear the watchdog (cycle may still unwind)", () => {
    const ctrl = new PresenceController({ watchdogTimeoutMs: 1000 });
    ctrl.enterTending("c", "gather");
    ctrl.enterResponsive();
    expect(ctrl.isWatchdogArmed()).toBe(true);
  });

  it("enterTending while already tending re-arms the watchdog with the new cycle", () => {
    const onWatchdog = vi.fn();
    const ctrl = new PresenceController({ watchdogTimeoutMs: 1000, onWatchdogFired: onWatchdog });
    ctrl.enterTending("first", "orient");
    vi.advanceTimersByTime(500);
    ctrl.enterTending("second", "orient");
    vi.advanceTimersByTime(500);
    // First would have fired at t=1000 but was re-armed at t=500 → fires at t=1500
    expect(onWatchdog).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(onWatchdog).toHaveBeenCalledWith("second", "orient");
  });
});
