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
