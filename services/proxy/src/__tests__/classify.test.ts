import { describe, it, expect } from "vitest";
import {
  classifyProviderHttpFailure,
  classifyProviderTransportFailure,
  motebitFailure,
  parseRetryAfterMs,
} from "../inference/classify";

// Redacted, table-driven fixtures of the real shapes the proxy sees. Bodies are
// the small JSON error envelopes providers return on non-2xx — no prompts, no
// keys, no user content.
const ANTHROPIC_429 = {
  type: "error",
  error: { type: "rate_limit_error", message: "rate limited" },
};
const ANTHROPIC_529 = { type: "error", error: { type: "overloaded_error", message: "overloaded" } };
const ANTHROPIC_500 = { type: "error", error: { type: "api_error", message: "internal" } };
const ANTHROPIC_401 = {
  type: "error",
  error: { type: "authentication_error", message: "bad key" },
};
const ANTHROPIC_403_BILLING = {
  type: "error",
  error: { type: "billing_error", message: "credits exhausted" },
};
const ANTHROPIC_400_CONTEXT = {
  type: "error",
  error: {
    type: "invalid_request_error",
    message: "prompt is too long: 250000 tokens > 200000 maximum",
  },
};
const ANTHROPIC_400_BAD = {
  type: "error",
  error: { type: "invalid_request_error", message: "messages: roles must alternate" },
};

const NOW = 1_700_000_000_000;

describe("classifyProviderHttpFailure — status → category", () => {
  const cases: Array<[number, unknown, string]> = [
    [429, ANTHROPIC_429, "rate_limited"],
    [529, ANTHROPIC_529, "overloaded"],
    [500, ANTHROPIC_500, "server_error"],
    [502, null, "server_error"],
    [503, null, "server_error"],
    [401, ANTHROPIC_401, "authentication"],
    [403, ANTHROPIC_403_BILLING, "provider_billing_exhausted"],
    [402, null, "provider_billing_exhausted"],
    [404, null, "model_unavailable"],
    [413, null, "context_overflow"],
    [400, ANTHROPIC_400_CONTEXT, "context_overflow"],
    [400, ANTHROPIC_400_BAD, "malformed_request"],
    [418, null, "unknown"],
  ];
  for (const [status, body, expected] of cases) {
    it(`status ${status} → ${expected}`, () => {
      const f = classifyProviderHttpFailure({ provider: "anthropic", status, body, nowMs: NOW });
      expect(f.source).toBe("provider");
      expect(f.category).toBe(expected);
      expect(f.status).toBe(status);
    });
  }

  it("captures provider error.type as providerCode", () => {
    const f = classifyProviderHttpFailure({
      provider: "anthropic",
      status: 429,
      body: ANTHROPIC_429,
      nowMs: NOW,
    });
    expect(f.providerCode).toBe("rate_limit_error");
  });

  it("classifies on status alone when body is non-JSON / null (raw body never required)", () => {
    const f = classifyProviderHttpFailure({
      provider: "anthropic",
      status: 429,
      body: null,
      nowMs: NOW,
    });
    expect(f.category).toBe("rate_limited");
    expect(f.providerCode).toBeUndefined();
  });
});

describe("retry-after parsing (delta-seconds AND HTTP-date)", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfterMs("30", NOW)).toBe(30_000);
  });
  it("parses an HTTP-date into a forward delta", () => {
    const future = new Date(NOW + 45_000).toUTCString();
    expect(parseRetryAfterMs(future, NOW)).toBe(45_000);
  });
  it("clamps a past HTTP-date to 0", () => {
    const past = new Date(NOW - 60_000).toUTCString();
    expect(parseRetryAfterMs(past, NOW)).toBe(0);
  });
  it("returns undefined for absent/garbage", () => {
    expect(parseRetryAfterMs(undefined, NOW)).toBeUndefined();
    expect(parseRetryAfterMs("", NOW)).toBeUndefined();
    expect(parseRetryAfterMs("soon", NOW)).toBeUndefined();
  });
  it("flows through to the failure on a 429", () => {
    const f = classifyProviderHttpFailure({
      provider: "anthropic",
      status: 429,
      headers: { "retry-after": "12" },
      body: ANTHROPIC_429,
      nowMs: NOW,
    });
    expect(f.retryAfterMs).toBe(12_000);
  });
});

describe("provider request-id header variants", () => {
  for (const h of ["request-id", "anthropic-request-id", "x-request-id"]) {
    it(`reads ${h}`, () => {
      const f = classifyProviderHttpFailure({
        provider: "anthropic",
        status: 500,
        headers: { [h]: "req_abc123" },
        body: null,
        nowMs: NOW,
      });
      expect(f.providerRequestId).toBe("req_abc123");
    });
  }
  it("falls back to body.request_id when no header present", () => {
    const f = classifyProviderHttpFailure({
      provider: "anthropic",
      status: 500,
      body: {
        type: "error",
        error: { type: "api_error", message: "x" },
        request_id: "req_from_body",
      },
      nowMs: NOW,
    });
    expect(f.providerRequestId).toBe("req_from_body");
  });
  it("reads headers case-insensitively from a Headers instance", () => {
    const headers = new Headers({ "Request-Id": "req_hdr" });
    const f = classifyProviderHttpFailure({
      provider: "anthropic",
      status: 500,
      headers,
      body: null,
      nowMs: NOW,
    });
    expect(f.providerRequestId).toBe("req_hdr");
  });
});

describe("classifyProviderTransportFailure", () => {
  it("maps abort/timeout error names to timeout", () => {
    expect(
      classifyProviderTransportFailure({ provider: "anthropic", errorName: "AbortError" }).category,
    ).toBe("timeout");
    expect(
      classifyProviderTransportFailure({ provider: "anthropic", errorName: "TimeoutError" })
        .category,
    ).toBe("timeout");
  });
  it("maps other throws to network", () => {
    const f = classifyProviderTransportFailure({ provider: "anthropic", errorName: "TypeError" });
    expect(f).toEqual({ source: "network", category: "network", provider: "anthropic" });
  });
  it("defaults to network with no error name", () => {
    expect(classifyProviderTransportFailure({ provider: "anthropic" }).category).toBe("network");
  });
});

describe("motebitFailure — motebit-originated, not provider", () => {
  it("constructs a balance failure", () => {
    expect(motebitFailure("motebit_balance", "balance_exhausted", 402)).toEqual({
      source: "motebit_balance",
      category: "balance_exhausted",
      status: 402,
    });
  });
  it("constructs a policy failure (jurisdiction)", () => {
    const f = motebitFailure("motebit_request", "model_unavailable", 451);
    expect(f.source).toBe("motebit_request");
    expect(f.provider).toBeUndefined(); // motebit failures carry no provider origin
  });
});
