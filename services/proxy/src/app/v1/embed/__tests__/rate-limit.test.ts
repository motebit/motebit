/**
 * Embed rate limiter — fail-OPEN behavior.
 *
 * Embedding is a best-effort enhancement (client falls back to a local hash
 * embedding) and the route is origin-gated, so a Vercel KV outage must NOT deny
 * embeddings platform-wide. The limiter allows when KV is unconfigured (local
 * dev) or unavailable (transient outage), and only denies a genuine over-limit.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let incrImpl: () => Promise<number>;
vi.mock("@vercel/kv", () => ({
  kv: {
    incr: () => incrImpl(),
    expire: () => Promise.resolve(),
  },
}));

import { checkRateLimit } from "../route";

describe("embed checkRateLimit (fail-open)", () => {
  beforeEach(() => {
    process.env.KV_REST_API_URL = "https://kv.test";
    incrImpl = () => Promise.resolve(1);
  });
  afterEach(() => {
    delete process.env.KV_REST_API_URL;
    vi.restoreAllMocks();
  });

  it("allows when KV is not configured (local dev)", async () => {
    delete process.env.KV_REST_API_URL;
    const r = await checkRateLimit("embed:1.2.3.4:2026-06-17", 1000);
    expect(r.allowed).toBe(true);
  });

  it("allows under the daily limit", async () => {
    incrImpl = () => Promise.resolve(5);
    expect((await checkRateLimit("k", 1000)).allowed).toBe(true);
  });

  it("denies once the daily limit is genuinely exceeded", async () => {
    incrImpl = () => Promise.resolve(1001);
    expect((await checkRateLimit("k", 1000)).allowed).toBe(false);
  });

  it("FAILS OPEN when KV is configured but unavailable (transient outage)", async () => {
    incrImpl = () => Promise.reject(new Error("KV down"));
    const r = await checkRateLimit("k", 1000);
    expect(r.allowed).toBe(true);
  });
});
