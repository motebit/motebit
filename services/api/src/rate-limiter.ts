/**
 * Generic sliding-window rate limiter.
 *
 * Keys on an arbitrary string (IP address, peer relay ID, etc.).
 * One class, multiple instances with different limits.
 */
export class SlidingWindowLimiter {
  private windows: Map<string, { count: number; resetAt: number }> = new Map();

  constructor(
    private maxRequests: number,
    private windowMs: number,
  ) {}

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
