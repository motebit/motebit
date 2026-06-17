import { describe, it, expect, vi, afterEach } from "vitest";
import { failureResponse, emitProxyFailure } from "../inference/failure-response";
import {
  motebitFailure,
  classifyProviderHttpFailure,
  classifyProviderTransportFailure,
} from "../inference/classify";

afterEach(() => vi.restoreAllMocks());

function captureLog(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  return lines;
}

describe("failureResponse — one event + traceable header", () => {
  it("emits exactly one structured event and stamps X-Motebit-Request-Id", async () => {
    const lines = captureLog();
    const res = failureResponse({
      requestId: "req_test_1",
      status: 402,
      bodyObj: { error: "insufficient_balance", balance: 0 },
      headers: { "Access-Control-Allow-Origin": "https://motebit.com" },
      mode: "proxy-token",
      failure: motebitFailure("motebit_balance", "balance_exhausted", 402),
    });

    expect(lines).toHaveLength(1);
    expect(res.status).toBe(402);
    expect(res.headers.get("X-Motebit-Request-Id")).toBe("req_test_1");
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://motebit.com");

    const body = await res.json();
    expect(body).toEqual({ error: "insufficient_balance", balance: 0 });

    const event = JSON.parse(lines[0]!);
    expect(event).toMatchObject({
      event: "proxy.balance_exhausted",
      schemaVersion: 1,
      requestId: "req_test_1",
      source: "motebit_balance",
      category: "balance_exhausted",
      status: 402,
    });
  });

  it("separates request rejections from model failures (metric hygiene)", () => {
    // A request never admitted to the model path → request_rejected, NOT a
    // model failure. A spike in expired tokens must not look like a model spike.
    const rejectLines = captureLog();
    failureResponse({
      requestId: "req_rej",
      status: 401,
      bodyObj: { error: "invalid_token" },
      headers: {},
      failure: motebitFailure("motebit_request", "authentication", 401),
    });
    expect(JSON.parse(rejectLines[0]!).event).toBe("proxy.request_rejected");
    vi.restoreAllMocks();

    // An OUR-side misconfiguration → internal_failure, NOT request_rejected:
    // an operator outage must not read as malformed client traffic.
    const infraLines = captureLog();
    failureResponse({
      requestId: "req_infra",
      status: 501,
      bodyObj: { error: "provider_not_configured" },
      headers: {},
      failure: motebitFailure("motebit_infrastructure", "not_configured", 501),
    });
    expect(JSON.parse(infraLines[0]!).event).toBe("proxy.internal_failure");
    vi.restoreAllMocks();

    // An upstream provider non-2xx → genuine inference failure.
    const failLines = captureLog();
    emitProxyFailure({
      requestId: "req_fail",
      failure: classifyProviderHttpFailure({
        provider: "anthropic",
        status: 429,
        body: { type: "error", error: { type: "rate_limit_error", message: "x" } },
        nowMs: 1_700_000_000_000,
      }),
    });
    expect(JSON.parse(failLines[0]!).event).toBe("proxy.inference_failure");
    vi.restoreAllMocks();

    // A transport throw → also a model-path failure.
    const txLines = captureLog();
    emitProxyFailure({
      requestId: "req_tx",
      failure: classifyProviderTransportFailure({ provider: "anthropic", errorName: "AbortError" }),
    });
    expect(JSON.parse(txLines[0]!).event).toBe("proxy.inference_failure");
  });

  it("never serializes identity, prompts, provider bodies, or keys", () => {
    const lines = captureLog();
    emitProxyFailure({
      requestId: "req_test_2",
      model: "claude-sonnet-4-6",
      mode: "proxy-token",
      failure: classifyProviderHttpFailure({
        provider: "anthropic",
        status: 429,
        headers: { "retry-after": "30", "request-id": "req_upstream" },
        body: { type: "error", error: { type: "rate_limit_error", message: "secret-ish detail" } },
        nowMs: 1_700_000_000_000,
      }),
    });

    const raw = lines[0]!;
    // The classified shape is present...
    expect(raw).toContain("rate_limited");
    expect(raw).toContain("req_upstream"); // provider request id IS retained (server telemetry)
    // ...but nothing identity- or content-bearing leaks.
    expect(raw).not.toContain("motebitId");
    expect(raw).not.toContain("mid");
    expect(raw).not.toContain("secret-ish"); // raw provider message never logged
    expect(raw).not.toContain("messages");
    expect(raw).not.toContain("x-api-key");

    const event = JSON.parse(raw);
    expect(event.providerCode).toBe("rate_limit_error");
    expect(event.retryAfterMs).toBe(30_000);
    expect(Object.keys(event)).not.toContain("motebitId");
  });
});
