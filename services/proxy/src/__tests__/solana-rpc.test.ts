/**
 * Solana RPC passthrough — the browser-never-holds-the-key law, as tests.
 * The fake upstream URL carries the incident's exact shape (`?api-key=<uuid>`);
 * every test asserts that value never appears in a response body, a response
 * header, or a captured log line.
 */
import { describe, it, expect } from "vitest";
import {
  SOLANA_RPC_MAX_BODY_BYTES,
  SOLANA_RPC_METHOD_ALLOWLIST,
  SOLANA_RPC_PER_MINUTE_LIMIT,
  createMemoryRateLimiter,
  handleSolanaRpcOptions,
  handleSolanaRpcPost,
  redactUrl,
  scrubUpstream,
  type RateLimiter,
  type SolanaRpcDeps,
} from "../solana-rpc";

const KEY = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const UPSTREAM = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;
const ORIGIN = "https://motebit.com";

interface Harness {
  deps: SolanaRpcDeps;
  logs: string[];
  forwarded: { url: string; body: string }[];
}

function harness(
  opts: {
    env?: Record<string, string | undefined>;
    limiter?: RateLimiter;
    upstream?: (body: string) => Response | Promise<Response>;
  } = {},
): Harness {
  const logs: string[] = [];
  const forwarded: { url: string; body: string }[] = [];
  const deps: SolanaRpcDeps = {
    env: opts.env ?? { SOLANA_RPC_UPSTREAM_URL: UPSTREAM },
    limiter: opts.limiter ?? createMemoryRateLimiter(),
    log: (l) => logs.push(l),
    now: () => 1_700_000_000_000,
    fetch: (async (url: string, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "";
      forwarded.push({ url, body });
      return opts.upstream
        ? opts.upstream(body)
        : new Response(JSON.stringify({ jsonrpc: "2.0", result: { value: 1 }, id: 1 }), {
            status: 200,
          });
    }) as typeof fetch,
  };
  return { deps, logs, forwarded };
}

function rpc(body: unknown, headers: Record<string, string> = {}, raw?: string): Request {
  return new Request("https://api.motebit.com/v1/solana-rpc", {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json", ...headers },
    body: raw ?? JSON.stringify(body),
  });
}

const call = (method: string, id: number | string = 1) => ({
  jsonrpc: "2.0",
  id,
  method,
  params: [],
});

async function assertNoKey(res: Response, logs: string[]): Promise<string> {
  const text = await res.clone().text();
  expect(text).not.toContain(KEY);
  expect(text).not.toContain("api-key");
  for (const [, v] of res.headers) expect(v).not.toContain(KEY);
  for (const l of logs) {
    expect(l).not.toContain(KEY);
    expect(l).not.toContain("api-key");
  }
  return text;
}

describe("solana-rpc: method allowlist", () => {
  it("forwards every allowlisted method", async () => {
    for (const method of SOLANA_RPC_METHOD_ALLOWLIST.keys()) {
      const h = harness();
      const res = await handleSolanaRpcPost(rpc(call(method)), h.deps);
      expect(res.status).toBe(200);
      expect(JSON.parse(h.forwarded[0]!.body).method).toBe(method);
      await assertNoKey(res, h.logs);
    }
  });

  it.each([
    "requestAirdrop",
    "getProgramAccounts",
    "getClusterNodes",
    "simulateTransaction",
    "getBlock",
  ])("refuses non-allowlisted %s with 403 and never calls upstream", async (method) => {
    const h = harness();
    const res = await handleSolanaRpcPost(rpc(call(method, 7)), h.deps);
    expect(res.status).toBe(403);
    const body = JSON.parse(await assertNoKey(res, h.logs));
    expect(body).toEqual({
      jsonrpc: "2.0",
      error: { code: -32601, message: "method not allowed" },
      id: 7,
    });
    expect(h.forwarded).toHaveLength(0);
  });

  it("is exactly the enumerated browser set", () => {
    expect([...SOLANA_RPC_METHOD_ALLOWLIST.keys()].sort()).toEqual([
      "getAccountInfo",
      "getBalance",
      "getBlockHeight",
      "getEpochInfo",
      "getGenesisHash",
      "getLatestBlockhash",
      "getMinimumBalanceForRentExemption",
      "getSignatureStatuses",
      "getSignaturesForAddress",
      "getTransaction",
      "sendTransaction",
    ]);
  });

  it("refuses batches", async () => {
    const h = harness();
    const res = await handleSolanaRpcPost(rpc([call("getBalance"), call("getBalance", 2)]), h.deps);
    expect(res.status).toBe(400);
    expect(h.forwarded).toHaveLength(0);
  });

  it("refuses malformed JSON-RPC", async () => {
    for (const bad of [{ method: "getBalance" }, { jsonrpc: "2.0" }, 42, null]) {
      const h = harness();
      const res = await handleSolanaRpcPost(rpc(bad), h.deps);
      expect(res.status).toBe(400);
      expect(h.forwarded).toHaveLength(0);
    }
    const h = harness();
    expect((await handleSolanaRpcPost(rpc(null, {}, "{not json"), h.deps)).status).toBe(400);
    const p = harness();
    const r = await handleSolanaRpcPost(
      rpc({ jsonrpc: "2.0", id: 1, method: "getBalance", params: "x" }),
      p.deps,
    );
    expect(r.status).toBe(400);
  });

  it("forwards only the four JSON-RPC fields to the upstream", async () => {
    const h = harness();
    await handleSolanaRpcPost(rpc({ ...call("getBalance"), extra: "smuggled" }), h.deps);
    expect(h.forwarded[0]!.url).toBe(UPSTREAM);
    expect(JSON.parse(h.forwarded[0]!.body)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "getBalance",
      params: [],
    });
  });
});

describe("solana-rpc: the key never crosses", () => {
  it("scrubs an upstream body that echoes the key", async () => {
    const h = harness({
      upstream: () =>
        new Response(JSON.stringify({ error: `bad request to ${UPSTREAM}`, key: KEY }), {
          status: 400,
        }),
    });
    const res = await handleSolanaRpcPost(rpc(call("getBalance")), h.deps);
    expect(res.status).toBe(502);
    await assertNoKey(res, h.logs);
    expect(h.logs.some((l) => l.includes("host=mainnet.helius-rpc.com"))).toBe(true);
  });

  it("scrubs a network error that names the URL (log + response)", async () => {
    const h = harness({
      upstream: () => {
        throw new TypeError(`fetch failed: ${UPSTREAM}`);
      },
    });
    const res = await handleSolanaRpcPost(rpc(call("getBalance")), h.deps);
    expect(res.status).toBe(502);
    await assertNoKey(res, h.logs);
    expect(h.logs).toHaveLength(1);
  });

  it("never passes upstream headers through", async () => {
    const h = harness({
      upstream: () =>
        new Response("{}", {
          status: 200,
          headers: { "x-upstream-url": UPSTREAM, "set-cookie": `k=${KEY}` },
        }),
    });
    const res = await handleSolanaRpcPost(rpc(call("getBalance")), h.deps);
    await assertNoKey(res, h.logs);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("fails closed with 503 when the upstream is unset", async () => {
    for (const env of [{}, { SOLANA_RPC_UPSTREAM_URL: "  " }]) {
      const h = harness({ env });
      const res = await handleSolanaRpcPost(rpc(call("getBalance")), h.deps);
      expect(res.status).toBe(503);
      expect(await res.text()).toContain("not configured");
      expect(h.forwarded).toHaveLength(0);
    }
  });

  it("redaction helpers keep host only / strip every secret part", () => {
    expect(redactUrl(UPSTREAM)).toBe("mainnet.helius-rpc.com");
    expect(redactUrl("not a url")).toBe("<unparseable-url>");
    const basic = "https://user:hunter2hunter2@rpc.example.com/v2/abcdefabcdefabcdefabcdef";
    const s = scrubUpstream(`x ${basic} hunter2hunter2 abcdefabcdefabcdefabcdef`, basic);
    expect(s).not.toContain("hunter2hunter2");
    expect(s).not.toContain("abcdefabcdefabcdefabcdef");
  });
});

describe("solana-rpc: CORS", () => {
  it("preflight allows motebit origins with the web3.js header", () => {
    const h = harness();
    const res = handleSolanaRpcOptions(
      new Request("https://api.motebit.com/v1/solana-rpc", {
        method: "OPTIONS",
        headers: { Origin: ORIGIN },
      }),
      h.deps,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("access-control-allow-headers")).toContain("solana-client");
  });

  it("refuses foreign or missing origins (preflight and POST)", async () => {
    for (const origin of ["https://evil.example", ""]) {
      const h = harness();
      const headers: Record<string, string> = origin ? { Origin: origin } : {};
      const pre = handleSolanaRpcOptions(
        new Request("https://api.motebit.com/v1/solana-rpc", { method: "OPTIONS", headers }),
        h.deps,
      );
      expect(pre.status).toBe(403);
      const req = new Request("https://api.motebit.com/v1/solana-rpc", {
        method: "POST",
        headers,
        body: JSON.stringify(call("getBalance")),
      });
      const res = await handleSolanaRpcPost(req, h.deps);
      expect(res.status).toBe(403);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(h.forwarded).toHaveLength(0);
    }
  });

  it("SOLANA_RPC_ALLOWED_ORIGINS appends https origins only", async () => {
    const env = {
      SOLANA_RPC_UPSTREAM_URL: UPSTREAM,
      SOLANA_RPC_ALLOWED_ORIGINS: "https://receipts.motebit.com, http://evil.example",
    };
    const ok = harness({ env });
    const r1 = await handleSolanaRpcPost(
      rpc(call("getBalance"), { Origin: "https://receipts.motebit.com" }),
      ok.deps,
    );
    expect(r1.status).toBe(200);
    const bad = harness({ env });
    const r2 = await handleSolanaRpcPost(
      rpc(call("getBalance"), { Origin: "http://evil.example" }),
      bad.deps,
    );
    expect(r2.status).toBe(403);
  });
});

describe("solana-rpc: rate limit + size cap", () => {
  it("429s past the per-IP per-minute limit", async () => {
    const h = harness();
    const headers = { "x-forwarded-for": "203.0.113.9" };
    for (let i = 0; i < SOLANA_RPC_PER_MINUTE_LIMIT; i++) {
      expect((await handleSolanaRpcPost(rpc(call("getBalance"), headers), h.deps)).status).toBe(
        200,
      );
    }
    const res = await handleSolanaRpcPost(rpc(call("getBalance"), headers), h.deps);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    // A different IP is unaffected.
    const other = await handleSolanaRpcPost(
      rpc(call("getBalance"), { "x-forwarded-for": "203.0.113.10" }),
      h.deps,
    );
    expect(other.status).toBe(200);
  });

  it("a limiter that fails closed denies", async () => {
    const h = harness({ limiter: { hit: () => Promise.resolve(false) } });
    expect((await handleSolanaRpcPost(rpc(call("getBalance")), h.deps)).status).toBe(429);
    expect(h.forwarded).toHaveLength(0);
  });

  it("413s a body over the cap (declared or streamed)", async () => {
    const big = JSON.stringify({
      ...call("sendTransaction"),
      params: ["A".repeat(SOLANA_RPC_MAX_BODY_BYTES)],
    });
    const h = harness();
    expect((await handleSolanaRpcPost(rpc(null, {}, big), h.deps)).status).toBe(413);
    const lying = harness();
    const res = await handleSolanaRpcPost(rpc(null, { "content-length": "10" }, big), lying.deps);
    expect(res.status).toBe(413);
    expect(lying.forwarded).toHaveLength(0);
  });

  it("the memory limiter bounds its key set", async () => {
    const l = createMemoryRateLimiter(2);
    await l.hit("a", 1);
    await l.hit("b", 1);
    expect(await l.hit("c", 1)).toBe(true);
    expect(await l.hit("c", 1)).toBe(false);
  });
});
