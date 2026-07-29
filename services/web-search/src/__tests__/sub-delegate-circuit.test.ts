/**
 * #459: the sub-delegation failure circuit and the intent-stable
 * idempotency key — the two client-side halves of the amplification fix.
 * During the incident this service retried a down peer as fast as each
 * handler turn completed, minting a fresh relay task per attempt.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  recordSubDelegateOutcome,
  resetSubDelegateCircuitForTest,
  subDelegateCircuitState,
  stableSubmissionKey,
  SUB_DELEGATE_MAX_CONSECUTIVE_FAILURES,
  SUB_DELEGATE_COOLDOWN_MS,
} from "../index.js";

describe("sub-delegation failure circuit", () => {
  beforeEach(() => {
    resetSubDelegateCircuitForTest();
  });

  it("opens the cooldown at the consecutive-failure ceiling", () => {
    const now = 1_000_000;
    for (let i = 0; i < SUB_DELEGATE_MAX_CONSECUTIVE_FAILURES - 1; i++) {
      recordSubDelegateOutcome(false, now);
      expect(subDelegateCircuitState().cooldownUntil).toBe(0);
    }
    recordSubDelegateOutcome(false, now);
    expect(subDelegateCircuitState().cooldownUntil).toBe(now + SUB_DELEGATE_COOLDOWN_MS);
  });

  it("one success closes the circuit and clears the count", () => {
    recordSubDelegateOutcome(false, 1000);
    recordSubDelegateOutcome(false, 1000);
    recordSubDelegateOutcome(true, 2000);
    expect(subDelegateCircuitState()).toEqual({ failures: 0, cooldownUntil: 0 });
  });

  it("failures below the ceiling never open the cooldown", () => {
    recordSubDelegateOutcome(false, 1000);
    expect(subDelegateCircuitState().cooldownUntil).toBe(0);
  });
});

describe("stableSubmissionKey (#459 — retries replay, never mint new tasks)", () => {
  it("identical intent → identical key (the anti-amplification property)", () => {
    const a = stableSubmissionKey("caller-1", "target-1", "read https://example.com");
    const b = stableSubmissionKey("caller-1", "target-1", "read https://example.com");
    expect(a).toBe(b);
    expect(a).toMatch(/^sub-[0-9a-f]{32}$/);
  });

  it("any component change → different key (no cross-intent replay)", () => {
    const base = stableSubmissionKey("caller-1", "target-1", "read https://example.com");
    expect(stableSubmissionKey("caller-2", "target-1", "read https://example.com")).not.toBe(base);
    expect(stableSubmissionKey("caller-1", "target-2", "read https://example.com")).not.toBe(base);
    expect(stableSubmissionKey("caller-1", "target-1", "read https://other.io")).not.toBe(base);
  });
});
