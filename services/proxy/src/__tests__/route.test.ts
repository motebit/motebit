import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as validation from "../validation";
import type { ProxyTokenPayload } from "../validation";

// Partial-mock the validation module: keep every real function, override only
// `parseProxyToken` so we can drive the proxy-token balance path without minting
// a real signed token.
vi.mock("../validation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../validation")>();
  return { ...actual, parseProxyToken: vi.fn() };
});

// Import AFTER the mock is registered.
import { POST } from "../app/v1/messages/route";

const ORIGIN = "http://localhost:3000";

let logLines: string[];
beforeEach(() => {
  process.env.RELAY_PUBLIC_KEY = "test-pubkey";
  logLines = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logLines.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** All proxy.* failure events emitted this turn (excludes proxy.usage). */
function failureEvents(): Array<Record<string, unknown>> {
  return logLines
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((e): e is Record<string, unknown> => {
      const name = e?.event;
      return typeof name === "string" && name.startsWith("proxy.") && name !== "proxy.usage";
    });
}

function post(headers: Record<string, string>, body: string): Promise<Response> {
  return POST(
    new Request("https://proxy.example/api/v1/messages", { method: "POST", headers, body }),
  );
}

const BYOK = { origin: ORIGIN, "x-api-key": "sk-byok-test", "content-type": "application/json" };

describe("route POST — failure-event wiring", () => {
  it("invalid JSON → proxy.request_rejected (400), one event, trace header", async () => {
    const res = await post(BYOK, "{not valid json");
    expect(res.status).toBe(400);
    expect(res.headers.get("X-Motebit-Request-Id")).toBeTruthy();
    const events = failureEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe("proxy.request_rejected");
    expect(events[0]!.source).toBe("motebit_request");
  });

  it("zero balance → proxy.balance_exhausted (402)", async () => {
    vi.mocked(validation.parseProxyToken).mockResolvedValue({
      bal: 0,
      mid: "m_test",
      models: [],
    } as unknown as ProxyTokenPayload);
    const res = await post(
      { origin: ORIGIN, "x-proxy-token": "tok", "content-type": "application/json" },
      JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
    );
    expect(res.status).toBe(402);
    expect(res.headers.get("X-Motebit-Request-Id")).toBeTruthy();
    const events = failureEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe("proxy.balance_exhausted");
  });

  it("provider 429 → proxy.inference_failure, preserves status + Retry-After, no leakage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            type: "error",
            error: { type: "rate_limit_error", message: "secret detail" },
          }),
          { status: 429, headers: { "retry-after": "30", "request-id": "req_upstream" } },
        ),
      ),
    );
    const res = await post(
      BYOK,
      JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }] }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("X-Motebit-Request-Id")).toBeTruthy();
    expect(res.headers.get("Retry-After")).toBe("30");

    const events = failureEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe("proxy.inference_failure");
    expect(events[0]!.category).toBe("rate_limited");
    expect(events[0]!.retryAfterMs).toBe(30_000);

    // Telemetry leaks neither identity nor upstream content.
    const raw = logLines.find((l) => l.includes("proxy.inference_failure"))!;
    expect(raw).not.toContain("secret detail");
    expect(raw).not.toContain("sk-byok-test");
    expect(raw).not.toContain("motebitId");
  });

  it("operator misconfig (no provider key) → proxy.internal_failure (501), not request_rejected", async () => {
    // proxy-token path, funded balance, concrete model — but the operator API
    // key is absent. This is OUR fault, not the client's.
    const prevKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      vi.mocked(validation.parseProxyToken).mockResolvedValue({
        bal: 1_000_000,
        mid: "m_test",
        models: [],
      } as unknown as ProxyTokenPayload);
      const res = await post(
        { origin: ORIGIN, "x-proxy-token": "tok", "content-type": "application/json" },
        JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }] }),
      );
      expect(res.status).toBe(501);
      expect(res.headers.get("X-Motebit-Request-Id")).toBeTruthy();
      const events = failureEvents();
      expect(events).toHaveLength(1);
      expect(events[0]!.event).toBe("proxy.internal_failure");
      expect(events[0]!.source).toBe("motebit_infrastructure");
    } finally {
      if (prevKey != null) process.env.ANTHROPIC_API_KEY = prevKey;
    }
  });

  it("provider transport throw → proxy.inference_failure (502 provider_unreachable)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network down")));
    const res = await post(
      BYOK,
      JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }] }),
    );
    expect(res.status).toBe(502);
    expect(res.headers.get("X-Motebit-Request-Id")).toBeTruthy();
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("provider_unreachable");
    const events = failureEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe("proxy.inference_failure");
    expect(events[0]!.source).toBe("network");
  });
});

// ── Spend controls (motebit-cloud path) ───────────────────────────────────────
import {
  setSpendStoreForTests,
  memorySpendStore,
  DEPOSIT_RPM_LIMIT,
  DEPOSIT_CONCURRENCY_LIMIT,
} from "../spend-controls";

const PROXY = { origin: ORIGIN, "x-proxy-token": "tok", "content-type": "application/json" };
const BODY = JSON.stringify({
  model: "claude-sonnet-4-6",
  messages: [{ role: "user", content: "hi" }],
});
function tokenFor(over: Partial<ProxyTokenPayload> = {}): ProxyTokenPayload {
  return {
    mid: "mote-1",
    jti: "jti-1",
    bal: 100_000,
    models: ["claude-sonnet-4-6"],
    iat: Date.now(),
    exp: Date.now() + 3_600_000,
    ...over,
  };
}
/** A minimal Anthropic SSE body with usage on message_start / message_delta. */
function sseBody(input = 100, output = 50): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const lines = [
    `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: input } } })}\n\n`,
    `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: output } })}\n\n`,
    `data: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  ];
  return new ReadableStream({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(l));
      c.close();
    },
  });
}

describe("spend controls — the token snapshot is not the bound", () => {
  let store: ReturnType<typeof memorySpendStore>;
  beforeEach(() => {
    store = memorySpendStore();
    setSpendStoreForTests(store);
    process.env.ANTHROPIC_API_KEY = "sk-server-test";
  });
  afterEach(() => {
    setSpendStoreForTests(undefined);
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("refuses with 402 before any provider call once this token's recorded spend reaches its balance", async () => {
    vi.mocked(validation.parseProxyToken).mockResolvedValue(tokenFor({ bal: 5_000 }));
    store.map.set("proxy:spent:jti-1", 5_000);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await post(PROXY, BODY);
    expect(res.status).toBe(402);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(failureEvents().some((e) => JSON.stringify(e).includes("balance_exhausted"))).toBe(true);
  });

  it("refuses with 429 + Retry-After when the per-identity per-minute budget is exceeded", async () => {
    vi.mocked(validation.parseProxyToken).mockResolvedValue(tokenFor());
    const minute = Math.floor(Date.now() / 60_000);
    store.map.set(`proxy:rpm:mote-1:${minute}`, DEPOSIT_RPM_LIMIT);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await post(PROXY, BODY);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses with 429 when the concurrency slots are full, and does not leak a slot", async () => {
    vi.mocked(validation.parseProxyToken).mockResolvedValue(tokenFor());
    store.map.set("proxy:active:mote-1", DEPOSIT_CONCURRENCY_LIMIT);
    vi.stubGlobal("fetch", vi.fn());
    const res = await post(PROXY, BODY);
    expect(res.status).toBe(429);
    expect(store.map.get("proxy:active:mote-1")).toBe(DEPOSIT_CONCURRENCY_LIMIT);
  });

  it("fails CLOSED (503) when the store is configured but failing — money path, not best-effort", async () => {
    vi.mocked(validation.parseProxyToken).mockResolvedValue(tokenFor());
    setSpendStoreForTests({
      ...store,
      get: async () => {
        throw new Error("kv down");
      },
    });
    vi.stubGlobal("fetch", vi.fn());
    const res = await post(PROXY, BODY);
    expect(res.status).toBe(503);
  });

  it("records the metered cost against the token and releases the slot after a streamed response", async () => {
    vi.mocked(validation.parseProxyToken).mockResolvedValue(tokenFor());
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/debit")) return new Response("{}", { status: 200 });
        return new Response(sseBody(1_000, 500), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }),
    );
    const res = await post(PROXY, BODY);
    expect(res.status).toBe(200);
    await res.text(); // drain the pump so the finally runs
    await new Promise((r) => setTimeout(r, 20));
    const spent = store.map.get("proxy:spent:jti-1") ?? 0;
    expect(spent).toBeGreaterThan(0);
    expect(spent).toBe(validation.calculateCostMicro("claude-sonnet-4-6", 1_000, 500, 0, 0));
    expect(store.map.get("proxy:active:mote-1")).toBe(0);
    expect(store.map.get(`proxy:rpm:mote-1:${Math.floor(Date.now() / 60_000)}`)).toBe(1);
  });

  it("releases the slot when the upstream answers non-2xx before any stream", async () => {
    vi.mocked(validation.parseProxyToken).mockResolvedValue(tokenFor());
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { type: "overloaded_error" } }), { status: 529 }),
      ),
    );
    const res = await post(PROXY, BODY);
    expect(res.status).toBe(529);
    expect(store.map.get("proxy:active:mote-1")).toBe(0);
  });

  it("the BYOK path never touches the spend store (the caller's key, the caller's money)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(sseBody(), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
      ),
    );
    const res = await post(BYOK, BODY);
    expect(res.status).toBe(200);
    expect(store.map.size).toBe(0);
  });
});
