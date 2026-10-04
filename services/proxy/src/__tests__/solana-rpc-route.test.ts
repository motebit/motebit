/**
 * The deployed `/v1/solana-rpc` route (route.ts), by execution — not the pure
 * handler with an injected limiter. Two guarantees live ONLY in route.ts's
 * `kvLimiter` glue, so the handler's own tests cannot see them (cold review R3):
 *   - KV configured but erroring ⇒ the limiter FAILS CLOSED (429, nothing
 *     forwarded). A `catch { return true }` would forward on every KV outage.
 *   - production (VERCEL_ENV=production) without KV ⇒ `kind` is "memory" and
 *     the handler refuses with 503. A `kind` getter that always says "shared"
 *     would serve production on per-isolate budgets.
 * `@vercel/kv` is mocked; the upstream fetch is a stub that records calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const kvMock = vi.hoisted(() => ({
  incr: vi.fn<(key: string) => Promise<number>>(),
  expire: vi.fn<(key: string, s: number) => Promise<number>>(),
}));
vi.mock("@vercel/kv", () => ({ kv: kvMock }));

import { POST } from "../app/v1/solana-rpc/route";

const KEY = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const UPSTREAM = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;

function rpc(): Request {
  return new Request("https://api.motebit.com/v1/solana-rpc", {
    method: "POST",
    headers: {
      Origin: "https://motebit.com",
      "Content-Type": "application/json",
      "x-forwarded-for": "203.0.113.7",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [] }),
  });
}

let upstreamCalls: string[];

beforeEach(() => {
  upstreamCalls = [];
  kvMock.incr.mockReset();
  kvMock.expire.mockReset().mockResolvedValue(1);
  vi.stubEnv("SOLANA_RPC_UPSTREAM_URL", UPSTREAM);
  vi.stubEnv("KV_REST_API_URL", "");
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubGlobal("fetch", (url: string) => {
    upstreamCalls.push(url);
    return Promise.resolve(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 7 }), { status: 200 }),
    );
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("route.ts kvLimiter: fails closed on a KV error", () => {
  it("KV configured, kv.incr throws ⇒ 429 and nothing reaches the upstream", async () => {
    vi.stubEnv("KV_REST_API_URL", "https://kv.example");
    kvMock.incr.mockRejectedValue(new Error("kv unreachable"));
    const res = await POST(rpc());
    expect(res.status).toBe(429);
    expect(upstreamCalls).toEqual([]);
    expect(await res.text()).not.toContain(KEY);
  });

  it("KV configured, kv.expire throws on a fresh window ⇒ 429, nothing forwarded", async () => {
    vi.stubEnv("KV_REST_API_URL", "https://kv.example");
    kvMock.incr.mockResolvedValue(1);
    kvMock.expire.mockRejectedValue(new Error("kv unreachable"));
    const res = await POST(rpc());
    expect(res.status).toBe(429);
    expect(upstreamCalls).toEqual([]);
  });

  it("positive control: KV healthy under the limit ⇒ forwarded (200), counters expire", async () => {
    vi.stubEnv("KV_REST_API_URL", "https://kv.example");
    kvMock.incr.mockResolvedValue(1);
    const res = await POST(rpc());
    expect(res.status).toBe(200);
    expect(upstreamCalls).toEqual([UPSTREAM]);
    expect(kvMock.expire).toHaveBeenCalled();
  });

  it("KV healthy but over the limit ⇒ 429, nothing forwarded", async () => {
    vi.stubEnv("KV_REST_API_URL", "https://kv.example");
    kvMock.incr.mockResolvedValue(1_000_000);
    const res = await POST(rpc());
    expect(res.status).toBe(429);
    expect(upstreamCalls).toEqual([]);
  });
});

describe("route.ts kvLimiter.kind: production without KV refuses (503)", () => {
  it("VERCEL_ENV=production, no KV_REST_API_URL ⇒ 503, KV never touched, nothing forwarded", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const res = await POST(rpc());
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("rate limiter not configured");
    expect(upstreamCalls).toEqual([]);
    expect(kvMock.incr).not.toHaveBeenCalled();
  });

  it("VERCEL_ENV=production WITH KV ⇒ served through the shared limiter", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("KV_REST_API_URL", "https://kv.example");
    kvMock.incr.mockResolvedValue(1);
    const res = await POST(rpc());
    expect(res.status).toBe(200);
    expect(kvMock.incr).toHaveBeenCalled();
  });

  it("preview/local without KV ⇒ the per-isolate memory floor serves (no 503)", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const res = await POST(rpc());
    expect(res.status).toBe(200);
    expect(kvMock.incr).not.toHaveBeenCalled();
  });
});
