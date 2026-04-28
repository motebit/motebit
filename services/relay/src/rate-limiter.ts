/**
 * Rate limit quota information for a given key.
 * Exposed via `getInfo()` and returned (minus `limit`) from `check()`.
 */
export interface RateLimitInfo {
  /** Max requests allowed in the current window. */
  limit: number;
  /** Requests remaining in the current window. */
  remaining: number;
  /** Unix timestamp in seconds when the current window resets. */
  resetAt: number;
}

/**
 * Fixed-window rate limiter with per-key tracking.
 *
 * Each key gets an independent window that starts on first request and resets
 * after `windowMs`. Not a true sliding window (no per-request timestamp tracking),
 * but sufficient for API rate limiting where burst tolerance is acceptable.
 *
 * Used for both HTTP (keyed by IP) and WebSocket (keyed by connection ID) rate limiting.
 */
export class FixedWindowLimiter {
  private windows: Map<string, { count: number; resetAt: number }> = new Map();

  constructor(
    private maxRequests: number,
    private windowMs: number,
  ) {}

  /** The maximum number of requests allowed per window. */
  get limit(): number {
    return this.maxRequests;
  }

  check(key: string): { allowed: boolean; remaining: number; resetAt: number } {
    const now = Date.now();
    const entry = this.windows.get(key);

    if (!entry || entry.resetAt <= now) {
      const resetAt = now + this.windowMs;
      this.windows.set(key, { count: 1, resetAt });
      return { allowed: true, remaining: this.maxRequests - 1, resetAt };
    }

    entry.count++;
    const allowed = entry.count <= this.maxRequests;
    const remaining = Math.max(0, this.maxRequests - entry.count);
    return { allowed, remaining, resetAt: entry.resetAt };
  }

  /**
   * Get current quota information for a key without consuming a request.
   * Returns the window limit even if the key has no active window yet.
   */
  getInfo(key: string): RateLimitInfo {
    const now = Date.now();
    const entry = this.windows.get(key);

    if (!entry || entry.resetAt <= now) {
      return {
        limit: this.maxRequests,
        remaining: this.maxRequests,
        resetAt: Math.ceil((now + this.windowMs) / 1000),
      };
    }

    return {
      limit: this.maxRequests,
      remaining: Math.max(0, this.maxRequests - entry.count),
      resetAt: Math.ceil(entry.resetAt / 1000),
    };
  }

  /** Remove expired entries to prevent memory growth. */
  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.windows) {
      if (entry.resetAt <= now) {
        this.windows.delete(key);
      }
    }
  }
}
