export const runtime = "edge";

import {
  createMemoryRateLimiter,
  handleSolanaRpcOptions,
  handleSolanaRpcPost,
  type RateLimiter,
  type SolanaRpcDeps,
} from "../../../solana-rpc";

// Per-isolate floor; the KV limiter is the shared one in production.
const memoryLimiter = createMemoryRateLimiter();

/**
 * KV-backed per-IP limiter. Unlike `/v1/embed` this FAILS CLOSED when KV is
 * configured but errors: every call here spends provider credits, which is
 * exactly what the 2026-09-30 incident drained. Without KV (local dev) the
 * in-memory limiter still applies.
 */
const kvLimiter: RateLimiter = {
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
