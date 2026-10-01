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
  SOLANA_RPC_PER_48_LIMIT,
  SOLANA_RPC_GLOBAL_PER_MINUTE_DEFAULT,
  INVALID_IP_BUCKET,
  createMemoryRateLimiter,
  globalBudget,
  rateLimitAggregateBucket,
  handleSolanaRpcOptions,
  handleSolanaRpcPost,
  rateLimitBucket,
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

  it("refuses batches with the batch error (not the generic invalid-request path)", async () => {
    for (const batch of [[call("getBalance"), call("getBalance", 2)], [], [call("getBalance")]]) {
      const h = harness();
      const res = await handleSolanaRpcPost(rpc(batch), h.deps);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        jsonrpc: "2.0",
        error: { code: -32600, message: "batch requests are not supported" },
        id: null,
      });
      expect(h.forwarded).toHaveLength(0);
    }
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

  it("scrubs a body-read failure that names the URL (the read is inside the try)", async () => {
    const h = harness({
      upstream: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0",'));
              controller.error(new TypeError(`terminated: socket reset reading ${UPSTREAM}`));
            },
          }),
          { status: 200 },
        ),
    });
    const res = await handleSolanaRpcPost(rpc(call("getBalance")), h.deps);
    expect(res.status).toBe(502);
    await assertNoKey(res, h.logs);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toContain("host=mainnet.helius-rpc.com");
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

  it("allows receipt.computer (apps/verify's deployed origin) by default", async () => {
    const h = harness();
    const res = await handleSolanaRpcPost(
      rpc(call("getSignaturesForAddress"), { Origin: "https://receipt.computer" }),
      h.deps,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://receipt.computer");
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

  it("buckets IPv6 clients by /64 — rotating the interface id buys no fresh budget", async () => {
    const h = harness();
    for (let i = 0; i < SOLANA_RPC_PER_MINUTE_LIMIT; i++) {
      const ip = `2001:db8:1:2:${(i + 1).toString(16)}::${(i % 7) + 1}`;
      expect(
        (await handleSolanaRpcPost(rpc(call("getBalance"), { "x-forwarded-for": ip }), h.deps))
          .status,
      ).toBe(200);
    }
    const same64 = await handleSolanaRpcPost(
      rpc(call("getBalance"), { "x-forwarded-for": "2001:0db8:0001:0002:ffff:ffff:ffff:ffff" }),
      h.deps,
    );
    expect(same64.status).toBe(429);
    const other64 = await handleSolanaRpcPost(
      rpc(call("getBalance"), { "x-forwarded-for": "2001:db8:1:3::1" }),
      h.deps,
    );
    expect(other64.status).toBe(200);
  });

  it("rateLimitBucket: IPv4 per address, IPv6 per /64, garbage shares one bucket", () => {
    expect(rateLimitBucket("203.0.113.9")).toBe("203.0.113.9");
    expect(rateLimitBucket("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(rateLimitBucket("2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(rateLimitBucket("[2001:db8:1:2::5]:443")).toBe("2001:db8:1:2::/64");
    expect(rateLimitBucket("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(rateLimitBucket("2001:db8::")).toBe("2001:db8:0:0::/64");
    expect(rateLimitBucket("::ffff:198.51.100.7")).toBe("198.51.100.7");
    expect(rateLimitBucket("::1")).toBe("0:0:0:0::/64");
    expect(rateLimitBucket("64:ff9b::192.0.2.33")).toBe("64:ff9b:0:0::/64");
    // Every non-IP string shares ONE bucket — a caller who controls the header
    // value can never mint a fresh budget by varying it.
    for (const bad of [
      "1::2::3",
      "zzzz::1",
      "2001:db8",
      "1:2:3:4:5:6:7:8:9::",
      "",
      "unknown",
      "garbage-1",
      "garbage-2",
      "1.2.3",
      "1.2.3.999",
      "01.2.3.4",
      "1.2.3.4.5",
      "::ffff:1.2.3.999",
      "1:2:3:4:5:6:7:8:9",
      "1:2:3:4:5:6:7",
      "1.2.3.4:5:6::",
    ]) {
      expect(rateLimitBucket(bad), bad).toBe(INVALID_IP_BUCKET);
    }
    expect(INVALID_IP_BUCKET).toBe("invalid");
  });

  it("non-IP forwarded-for strings share one budget (varying the string buys nothing)", async () => {
    const h = harness();
    for (let i = 0; i < SOLANA_RPC_PER_MINUTE_LIMIT; i++) {
      const res = await handleSolanaRpcPost(
        rpc(call("getBalance"), { "x-forwarded-for": `not-an-ip-${i}` }),
        h.deps,
      );
      expect(res.status).toBe(200);
    }
    const res = await handleSolanaRpcPost(
      rpc(call("getBalance"), { "x-forwarded-for": "yet-another-string" }),
      h.deps,
    );
    expect(res.status).toBe(429);
  });

  it("rateLimitAggregateBucket: IPv6 per /48, IPv4 and invalid have none", () => {
    expect(rateLimitAggregateBucket("2001:db8:1:2::1")).toBe("2001:db8:1::/48");
    expect(rateLimitAggregateBucket("2001:0db8:0001:ffff:aaaa::1")).toBe("2001:db8:1::/48");
    expect(rateLimitAggregateBucket("203.0.113.9")).toBeNull();
    expect(rateLimitAggregateBucket("::ffff:198.51.100.7")).toBeNull();
    expect(rateLimitAggregateBucket("garbage")).toBeNull();
  });

  it("aggregates IPv6 by /48 — rotating across 65,536 /64s buys no fresh budget", async () => {
    const h = harness();
    for (let i = 0; i < SOLANA_RPC_PER_48_LIMIT; i++) {
      const ip = `2001:db8:7:${(i + 1).toString(16)}::1`; // a fresh /64 every request
      const res = await handleSolanaRpcPost(
        rpc(call("getBalance"), { "x-forwarded-for": ip }),
        h.deps,
      );
      expect(res.status).toBe(200);
    }
    const same48 = await handleSolanaRpcPost(
      rpc(call("getBalance"), { "x-forwarded-for": "2001:db8:7:ffff::1" }),
      h.deps,
    );
    expect(same48.status).toBe(429);
    const other48 = await handleSolanaRpcPost(
      rpc(call("getBalance"), { "x-forwarded-for": "2001:db8:8:1::1" }),
      h.deps,
    );
    expect(other48.status).toBe(200);
  });

  it("a GLOBAL per-minute upstream budget caps every client together", async () => {
    const h = harness({
      env: { SOLANA_RPC_UPSTREAM_URL: UPSTREAM, SOLANA_RPC_GLOBAL_PER_MINUTE: "5" },
    });
    // Requests that are refused before forwarding do not spend the budget.
    for (let i = 0; i < 10; i++) {
      await handleSolanaRpcPost(
        rpc(call("requestAirdrop"), { "x-forwarded-for": `198.51.100.${i}` }),
        h.deps,
      );
    }
    for (let i = 0; i < 5; i++) {
      const res = await handleSolanaRpcPost(
        rpc(call("getBalance"), { "x-forwarded-for": `203.0.113.${i}` }),
        h.deps,
      );
      expect(res.status).toBe(200);
    }
    const res = await handleSolanaRpcPost(
      rpc(call("getBalance"), { "x-forwarded-for": "192.0.2.77" }),
      h.deps,
    );
    expect(res.status).toBe(429);
    expect(h.forwarded).toHaveLength(5);
    expect(h.logs.some((l) => l.includes("global upstream budget exhausted"))).toBe(true);
  });

  it("globalBudget: a positive integer overrides; anything else is the default (never unlimited)", () => {
    expect(SOLANA_RPC_GLOBAL_PER_MINUTE_DEFAULT).toBe(3000);
    expect(globalBudget({})).toBe(3000);
    expect(globalBudget({ SOLANA_RPC_GLOBAL_PER_MINUTE: "500" })).toBe(500);
    for (const bad of ["0", "-1", "1e9", "Infinity", "abc", "", "1.5", "9999999999"]) {
      expect(globalBudget({ SOLANA_RPC_GLOBAL_PER_MINUTE: bad }), bad).toBe(3000);
    }
  });

  it("production refuses (503) on a per-isolate memory limiter; serves on a shared one", async () => {
    const prodEnv = { SOLANA_RPC_UPSTREAM_URL: UPSTREAM, VERCEL_ENV: "production" };
    const mem = harness({ env: prodEnv });
    const res = await handleSolanaRpcPost(rpc(call("getBalance")), mem.deps);
    expect(res.status).toBe(503);
    expect(mem.forwarded).toHaveLength(0);
    await assertNoKey(res, mem.logs);
    const inner = createMemoryRateLimiter();
    const shared = harness({
      env: prodEnv,
      limiter: { kind: "shared", hit: (k, l) => inner.hit(k, l) },
    });
    expect((await handleSolanaRpcPost(rpc(call("getBalance")), shared.deps)).status).toBe(200);
    // Preview / local dev keep the memory floor.
    const preview = harness({ env: { SOLANA_RPC_UPSTREAM_URL: UPSTREAM, VERCEL_ENV: "preview" } });
    expect((await handleSolanaRpcPost(rpc(call("getBalance")), preview.deps)).status).toBe(200);
  });

  it("a limiter that fails closed denies", async () => {
    const h = harness({ limiter: { kind: "shared", hit: () => Promise.resolve(false) } });
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

  it("the memory limiter bounds its key set by evicting the OLDEST key, never every counter", async () => {
    const l = createMemoryRateLimiter(2);
    expect(l.kind).toBe("memory");
    await l.hit("a", 1);
    await l.hit("b", 1);
    expect(await l.hit("c", 1)).toBe(true); // evicts "a" only
    expect(await l.hit("c", 1)).toBe(false);
    // "b" kept its count: a clear-all would have handed it a fresh budget.
    expect(await l.hit("b", 1)).toBe(false);
    // "a" was evicted, so it starts over (and evicts the next-oldest).
    expect(await l.hit("a", 1)).toBe(true);
  });
});
