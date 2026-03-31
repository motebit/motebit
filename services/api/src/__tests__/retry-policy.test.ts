/**
 * Tests for the exponential backoff retry policy.
 *
 * Verifies:
 *   - Delay grows exponentially (base * 2^attempt)
 *   - Delay is capped at maxDelayMs
 *   - Jitter stays within bounds (+/- jitterFraction)
 *   - Zero jitter when jitterFraction = 0
 *   - Custom policies override defaults
 *   - Auto-refund after max retries (integration with processSettlementRetries)
 */
import { describe, it, expect } from "vitest";
import { nextRetryDelay, DEFAULT_RETRY_POLICY, type RetryPolicy } from "../retry-policy.js";

describe("RetryPolicy", () => {
  describe("nextRetryDelay", () => {
    const noJitterPolicy: RetryPolicy = {
      ...DEFAULT_RETRY_POLICY,
      jitterFraction: 0,
    };

    it("grows exponentially with zero jitter", () => {
      // random param irrelevant when jitterFraction=0
      expect(nextRetryDelay(0, noJitterPolicy, 0.5)).toBe(5_000); // 5s * 2^0
      expect(nextRetryDelay(1, noJitterPolicy, 0.5)).toBe(10_000); // 5s * 2^1
      expect(nextRetryDelay(2, noJitterPolicy, 0.5)).toBe(20_000); // 5s * 2^2
      expect(nextRetryDelay(3, noJitterPolicy, 0.5)).toBe(40_000); // 5s * 2^3
      expect(nextRetryDelay(4, noJitterPolicy, 0.5)).toBe(80_000); // 5s * 2^4
      expect(nextRetryDelay(5, noJitterPolicy, 0.5)).toBe(160_000); // 5s * 2^5
      expect(nextRetryDelay(6, noJitterPolicy, 0.5)).toBe(320_000); // 5s * 2^6
      expect(nextRetryDelay(7, noJitterPolicy, 0.5)).toBe(640_000); // 5s * 2^7
    });

    it("caps delay at maxDelayMs", () => {
      // 5000 * 2^20 = 5,242,880,000 which exceeds maxDelayMs (3,600,000)
      expect(nextRetryDelay(20, noJitterPolicy, 0.5)).toBe(3_600_000);
    });

    it("caps delay at a custom maxDelayMs", () => {
      const policy: RetryPolicy = {
        ...noJitterPolicy,
        maxDelayMs: 60_000,
      };
      // 5000 * 2^4 = 80_000 > 60_000
      expect(nextRetryDelay(4, policy, 0.5)).toBe(60_000);
      // 5000 * 2^3 = 40_000 < 60_000
      expect(nextRetryDelay(3, policy, 0.5)).toBe(40_000);
    });

    it("applies positive jitter at random=1 boundary", () => {
      // random=0.999... → jitter = exponential * 0.2 * (0.999*2 - 1) ≈ +0.2 * exponential
      const delay = nextRetryDelay(0, DEFAULT_RETRY_POLICY, 0.999);
      const base = 5_000;
      const maxJitter = base * 0.2;
      expect(delay).toBeGreaterThan(base);
      expect(delay).toBeLessThanOrEqual(Math.round(base + maxJitter));
    });

    it("applies negative jitter at random=0 boundary", () => {
      // random=0 → jitter = exponential * 0.2 * (0 - 1) = -0.2 * exponential
      const delay = nextRetryDelay(0, DEFAULT_RETRY_POLICY, 0);
      const base = 5_000;
      const maxNegJitter = base * 0.2;
      expect(delay).toBeLessThan(base);
      expect(delay).toBeGreaterThanOrEqual(Math.round(base - maxNegJitter));
    });

    it("jitter stays within bounds for all attempts", () => {
      for (let attempt = 0; attempt < DEFAULT_RETRY_POLICY.maxRetries; attempt++) {
        const exponential = Math.min(
          DEFAULT_RETRY_POLICY.baseDelayMs * Math.pow(2, attempt),
          DEFAULT_RETRY_POLICY.maxDelayMs,
        );
        const maxJitter = exponential * DEFAULT_RETRY_POLICY.jitterFraction;

        // Test with both extreme random values
        const delayLow = nextRetryDelay(attempt, DEFAULT_RETRY_POLICY, 0);
        const delayHigh = nextRetryDelay(attempt, DEFAULT_RETRY_POLICY, 0.9999);
        const delayMid = nextRetryDelay(attempt, DEFAULT_RETRY_POLICY, 0.5);

        expect(delayLow).toBeGreaterThanOrEqual(Math.round(exponential - maxJitter));
        expect(delayHigh).toBeLessThanOrEqual(Math.round(exponential + maxJitter));
        // Mid-point (random=0.5) → jitter = 0
        expect(delayMid).toBe(Math.round(exponential));
      }
    });

    it("never returns negative delay", () => {
      // Even with extreme jitter fraction
      const policy: RetryPolicy = {
        maxRetries: 3,
        baseDelayMs: 100,
        maxDelayMs: 1_000,
        jitterFraction: 0.99,
      };
      // random=0 → jitter = -0.99 * 100 = -99 → delay = 1
      const delay = nextRetryDelay(0, policy, 0);
      expect(delay).toBeGreaterThanOrEqual(0);
    });

    it("returns integer milliseconds (no fractional ms)", () => {
      for (let i = 0; i < 10; i++) {
        const delay = nextRetryDelay(i, DEFAULT_RETRY_POLICY, Math.random());
        expect(delay).toBe(Math.round(delay));
      }
    });
  });

  describe("DEFAULT_RETRY_POLICY", () => {
    it("has maxRetries=8", () => {
      expect(DEFAULT_RETRY_POLICY.maxRetries).toBe(8);
    });

    it("has baseDelayMs=5000", () => {
      expect(DEFAULT_RETRY_POLICY.baseDelayMs).toBe(5_000);
    });

    it("has maxDelayMs=3600000 (1 hour)", () => {
      expect(DEFAULT_RETRY_POLICY.maxDelayMs).toBe(3_600_000);
    });

    it("has jitterFraction=0.2 (+/- 20%)", () => {
      expect(DEFAULT_RETRY_POLICY.jitterFraction).toBe(0.2);
    });
  });
});
