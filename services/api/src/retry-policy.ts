/**
 * Exponential backoff with jitter for settlement retries.
 *
 * Retry schedule (default policy):
 *   Attempt 0:    5s  +/- 1s
 *   Attempt 1:   10s  +/- 2s
 *   Attempt 2:   20s  +/- 4s
 *   Attempt 3:   40s  +/- 8s
 *   Attempt 4:   80s  +/- 16s
 *   Attempt 5:  160s  +/- 32s
 *   Attempt 6:  320s  +/- 64s
 *   Attempt 7:  640s  +/- 128s
 *
 * After maxRetries: caller triggers auto-refund (return funds to delegator).
 *
 * Jitter prevents thundering herd when multiple retries fire simultaneously
 * (e.g. after a peer relay comes back online). The uniform random jitter
 * spreads retries across a window of +/- jitterFraction * delay.
 */

export interface RetryPolicy {
  /** Maximum number of retry attempts before giving up. Default: 8. */
  maxRetries: number;
  /** Base delay in milliseconds. First retry waits ~baseDelayMs. Default: 5_000 (5s). */
  baseDelayMs: number;
  /** Maximum delay cap in milliseconds. Default: 3_600_000 (1 hour). */
  maxDelayMs: number;
  /** Jitter fraction (0-1). Adds uniform random noise of +/- this fraction. Default: 0.2. */
  jitterFraction: number;
}

/** Default settlement retry policy. */
export const DEFAULT_RETRY_POLICY: Readonly<RetryPolicy> = {
  maxRetries: 8,
  baseDelayMs: 5_000,
  maxDelayMs: 3_600_000,
  jitterFraction: 0.2,
};

/**
 * Compute the next retry delay for a given attempt number.
 *
 * Formula: min(baseDelayMs * 2^attempt, maxDelayMs) +/- jitter
 *
 * @param attempt - Zero-based attempt number (0 = first retry after initial failure)
 * @param policy - Retry policy configuration
 * @param random - Random value in [0, 1) for jitter. Defaults to Math.random().
 *                 Exposed for deterministic testing.
 * @returns Delay in milliseconds (always >= 0)
 */
export function nextRetryDelay(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random: number = Math.random(),
): number {
  const exponential = Math.min(policy.baseDelayMs * Math.pow(2, attempt), policy.maxDelayMs);
  // Uniform jitter in [-jitterFraction, +jitterFraction] of the exponential delay
  const jitter = exponential * policy.jitterFraction * (random * 2 - 1);
  return Math.max(0, Math.round(exponential + jitter));
}
