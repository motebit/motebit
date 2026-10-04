export const runtime = "edge";

import {
  createMemoryRateLimiter,
  handleSolanaRpcOptions,
  handleSolanaRpcPost,
  type RateLimiter,
  type SolanaRpcDeps,
} from "../../../solana-rpc";

// Per-isolate floor for local dev only: in production (VERCEL_ENV=production)
// the handler refuses with 503 unless the limiter is the shared KV one.
const memoryLimiter = createMemoryRateLimiter();

/**
 * KV-backed limiter (per client, per /48, and the global upstream budget).
 * Unlike `/v1/embed` this FAILS CLOSED when KV is configured but errors: every
 * call here spends provider credits, which is exactly what the 2026-09-30
 * incident drained. Without KV it is the memory limiter and reports
 * `kind: "memory"`, which production refuses to serve on.
 */
const kvLimiter: RateLimiter = {
  get kind() {
    return process.env.KV_REST_API_URL ? "shared" : "memory";
  },
  async hit(key, limit) {
    if (!process.env.KV_REST_API_URL) return memoryLimiter.hit(key, limit);
    try {
      const { kv } = await import("@vercel/kv");
      const count = await kv.incr(key);
      if (count === 1) await kv.expire(key, 120);
      return count <= limit;
    } catch {
      return false;
    }
  },
};

function deps(): SolanaRpcDeps {
  return {
    env: process.env,
    fetch: (input, init) => fetch(input, init),
    limiter: kvLimiter,
    // Edge log sink; every line is pre-redacted (host only, never the query).
    log: (line) => console.warn(line),
  };
}

export function OPTIONS(request: Request): Response {
  return handleSolanaRpcOptions(request, deps());
}

export function POST(request: Request): Promise<Response> {
  return handleSolanaRpcPost(request, deps());
}
