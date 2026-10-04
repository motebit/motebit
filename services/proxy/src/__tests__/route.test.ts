import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as validation from "../validation";
import type { ProxyTokenPayload } from "../validation";
import { MOTEBIT_CLOUD_TOKEN_MODELS } from "@motebit/sdk";

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
  // Billing must be configured for motebit-cloud to serve at all (billing.ts).
  process.env.RELAY_API_URL = "https://relay.test";
  process.env.RELAY_PROXY_SECRET = "test-relay-proxy-secret";
  logLines = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logLines.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.RELAY_API_URL;
  delete process.env.RELAY_PROXY_SECRET;
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
    // The rate key is `proxy:rpm:<mid>:<minute>` with the minute taken from
    // the wall clock at admission. Assertions that rebuild that key from a
    // second clock read fail whenever a minute boundary falls between the
    // two reads, so the clock is frozen mid-minute (Date only; real timers).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T12:00:30.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    setSpendStoreForTests(undefined);
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.RELAY_PROXY_SECRET;
  });

  /**
   * Upstream SSE body whose chunks and close the test drives explicitly, plus
   * a relay `/debit` stub that resolves `debitCalled` on its first call and
   * holds its response until `finishDebit()`. With a relay secret set, the
   * debit call is the pump's own completion signal: accounting precedes it.
   */
  function controlledUpstream() {
    const enc = new TextEncoder();
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        upstream = c;
      },
    });
    let onDebit!: () => void;
    const debitCalled = new Promise<void>((r) => (onDebit = r));
    let finishDebit!: () => void;
    const debitResponse = new Promise<Response>(
      (r) => (finishDebit = () => r(new Response("{}", { status: 200 }))),
    );
    process.env.RELAY_PROXY_SECRET = "relay-secret-test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/debit")) {
          onDebit();
          return debitResponse;
        }
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }),
    );
    const sse = (event: unknown) => enc.encode(`data: ${JSON.stringify(event)}\n\n`);
    return { upstream, sse, debitCalled, finishDebit };
  }

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
    const { upstream, sse, debitCalled, finishDebit } = controlledUpstream();
    const res = await post(PROXY, BODY);
    expect(res.status).toBe(200);
    expect(store.map.get("proxy:active:mote-1")).toBe(1);

    upstream.enqueue(sse({ type: "message_start", message: { usage: { input_tokens: 1_000 } } }));
    upstream.enqueue(sse({ type: "message_delta", usage: { output_tokens: 500 } }));
    upstream.enqueue(sse({ type: "message_stop" }));
    upstream.close();
    // The client reads concurrently: its EOF follows the debit (billing.ts's
    // fee lands before the stream ends), so it cannot be awaited first.
    const eof = res.text();
    await debitCalled; // the pump reached the debit: accounting has completed

    const cost = validation.calculateCostMicro("claude-sonnet-4-6", 1_000, 500, 0, 0);
    expect(cost).toBeGreaterThan(0);
    expect(store.map.get("proxy:spent:jti-1")).toBe(cost);
    expect(store.map.get("proxy:active:mote-1")).toBe(0);
    expect(store.map.get(`proxy:rpm:mote-1:${Math.floor(Date.now() / 60_000)}`)).toBe(1);
    finishDebit();
    await eof;
  });

  it("frees the slot and records spend before the relay debit settles, not after its retries", async () => {
    vi.mocked(validation.parseProxyToken).mockResolvedValue(tokenFor());
    const { upstream, sse, debitCalled, finishDebit } = controlledUpstream();
    const res = await post(PROXY, BODY);

    upstream.enqueue(sse({ type: "message_start", message: { usage: { input_tokens: 1_000 } } }));
    upstream.enqueue(sse({ type: "message_delta", usage: { output_tokens: 20 } }));
    upstream.close();
    let eofReached = false;
    const eof = res.text().then((t) => {
      eofReached = true;
      return t;
    });
    await debitCalled;
    await new Promise((r) => setTimeout(r, 10));

    // The debit response is still outstanding (a slow relay, or a retry in
    // backoff), yet the identity's next request must already see this spend
    // and a free slot.
    expect(store.map.get("proxy:active:mote-1")).toBe(0);
    expect(store.map.get("proxy:spent:jti-1")).toBe(
      validation.calculateCostMicro("claude-sonnet-4-6", 1_000, 20, 0, 0),
    );
    // ...and the client's EOF waits on the debit: the fee is sent before the
    // stream ends, never left to post-response work the platform may drop.
    expect(eofReached).toBe(false);
    finishDebit();
    await eof;
    expect(eofReached).toBe(true);
  });

  it("releases the slot and records the FULL metered spend when the client aborts mid-stream", async () => {
    vi.mocked(validation.parseProxyToken).mockResolvedValue(tokenFor());
    const { upstream, sse, debitCalled, finishDebit } = controlledUpstream();
    const res = await post(PROXY, BODY);
    const client = res.body!.getReader();

    upstream.enqueue(sse({ type: "message_start", message: { usage: { input_tokens: 1_000 } } }));
    expect((await client.read()).done).toBe(false);
    await client.cancel(); // the user closed the tab / pressed stop
    // The pump learns of the abort on its next write, then keeps draining
    // upstream: the output usage Anthropic reports last is still billed.
    upstream.enqueue(sse({ type: "content_block_delta" }));
    upstream.enqueue(sse({ type: "message_delta", usage: { output_tokens: 500 } }));
    upstream.close();
    await debitCalled;

    expect(store.map.get("proxy:active:mote-1")).toBe(0);
    expect(store.map.get("proxy:spent:jti-1")).toBe(
      validation.calculateCostMicro("claude-sonnet-4-6", 1_000, 500, 0, 0),
    );
    finishDebit();
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

// ── Cloud admission is the sdk's one function (#654 cold review R2) ─────────
describe("model admission — motebitCloudAdmission is the route's rule", () => {
  let store: ReturnType<typeof memorySpendStore>;
  beforeEach(() => {
    store = memorySpendStore();
    setSpendStoreForTests(store);
    process.env.ANTHROPIC_API_KEY = "sk-server-test";
    process.env.OPENAI_API_KEY = "sk-openai-test";
  });
  afterEach(() => {
    setSpendStoreForTests(undefined);
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  it.each([
    ["claude-opus", "claude-opus-4-6"],
    ["claude-opus-4-20250115", "claude-opus-4-6"],
    ["gpt-4o", "gpt-5.4-mini"],
  ])("alias %s is admitted and routed upstream as %s", async (sent, routed) => {
    vi.mocked(validation.parseProxyToken).mockResolvedValue(tokenFor({ models: [] }));
    const fetchSpy = vi.fn().mockResolvedValue(new Response(sseBody(), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const res = await post(
      PROXY,
      JSON.stringify({ model: sent, messages: [{ role: "user", content: "hi" }] }),
    );
    await res.text();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]![1]?.body)).toContain(`"${routed}"`);
  });

  it.each([
    ["deposit", "llama-3.3-70b-versatile"],
    ["deposit", "openai/gpt-oss-120b"],
    ["free-credit", "claude-opus-4-6"],
    ["free-credit", "claude-opus"],
  ] as const)(
    "#654 R3: a %s token refuses %s with 400 — outside the relay-minted list",
    async (tier, sent) => {
      process.env.GROQ_API_KEY = "sk-groq-test";
      vi.mocked(validation.parseProxyToken).mockResolvedValue(
        tokenFor({ models: [...MOTEBIT_CLOUD_TOKEN_MODELS[tier]] }),
      );
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const res = await post(
        PROXY,
        JSON.stringify({ model: sent, messages: [{ role: "user", content: "hi" }] }),
      );
      delete process.env.GROQ_API_KEY;
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_model");
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it("an id outside the catalog (the BYOK default) is 451, never sent upstream", async () => {
    vi.mocked(validation.parseProxyToken).mockResolvedValue(tokenFor({ models: [] }));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await post(
      PROXY,
      JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] }),
    );
    expect(res.status).toBe(451);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
