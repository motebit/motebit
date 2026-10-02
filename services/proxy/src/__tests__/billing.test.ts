/**
 * billing — `resolveBillingConfig` + `debitRelay` outcome contract.
 *
 * The check this file exists for: `debitRelay` can never return without
 * either landing (`proxy.debit_landed`) or emitting a structured failure
 * (`proxy.debit_failed`). Every outcome path below — configuration, amount,
 * each relay answer, network failure, even a throwing `fetch` — asserts
 * EXACTLY ONE event, and that no event carries the secret. The production
 * evidence (2026-10-02): a silent `if (!secret) return;` let three months of
 * motebit-cloud usage go unbilled without one log line.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { debitRelay, DEBIT_MAX_ATTEMPTS, resolveBillingConfig } from "../billing";

const REF = "req-abc";
const MID = "mote-1";
const AMOUNT = 12_345;
const SECRET = "secret-never-logged";

let lines: string[];

beforeEach(() => {
  process.env.RELAY_PROXY_SECRET = SECRET;
  process.env.RELAY_API_URL = "https://relay.test/";
  lines = [];
  const push = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  vi.spyOn(console, "error").mockImplementation(push);
  vi.spyOn(console, "log").mockImplementation(push);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.RELAY_PROXY_SECRET;
  delete process.env.RELAY_API_URL;
});

type Answer = { status: number; body?: unknown; raw?: string } | Error;

function mockFetch(...answers: Answer[]): ReturnType<typeof vi.fn> {
  let i = 0;
  const fn = vi.fn(() => {
    const a = answers[Math.min(i, answers.length - 1)]!;
    i++;
    if (a instanceof Error) return Promise.reject(a);
    const text = a.raw ?? (a.body === undefined ? "" : JSON.stringify(a.body));
    return Promise.resolve(new Response(text === "" ? null : text, { status: a.status }));
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function debitEvents(): Array<Record<string, unknown>> {
  return lines
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter(
      (e): e is Record<string, unknown> =>
        e?.event === "proxy.debit_landed" || e?.event === "proxy.debit_failed",
    );
}

async function run(amount = AMOUNT) {
  const p = debitRelay(MID, amount, REF);
  await vi.runAllTimersAsync();
  return p;
}

describe("resolveBillingConfig", () => {
  it("requires both RELAY_API_URL and RELAY_PROXY_SECRET — no default relay URL", () => {
    expect(resolveBillingConfig({})).toEqual({
      ok: false,
      missing: ["RELAY_API_URL", "RELAY_PROXY_SECRET"],
    });
    expect(resolveBillingConfig({ RELAY_PROXY_SECRET: "s" })).toEqual({
      ok: false,
      missing: ["RELAY_API_URL"],
    });
    expect(resolveBillingConfig({ RELAY_API_URL: "https://r", RELAY_PROXY_SECRET: "  " })).toEqual({
      ok: false,
      missing: ["RELAY_PROXY_SECRET"],
    });
  });

  it("rejects a value that is not an http(s) URL", () => {
    for (const v of ["relay.motebit.com", "ftp://relay", "", "  "]) {
      expect(resolveBillingConfig({ RELAY_API_URL: v, RELAY_PROXY_SECRET: "s" }).ok).toBe(false);
    }
  });

  it("normalizes a trailing slash", () => {
    expect(
      resolveBillingConfig({
        RELAY_API_URL: "https://relay.motebit.com/",
        RELAY_PROXY_SECRET: "s",
      }),
    ).toEqual({ ok: true, config: { relayUrl: "https://relay.motebit.com", secret: "s" } });
  });
});

describe("debitRelay — every path ends in exactly one structured event", () => {
  const cases: Array<{
    name: string;
    setup: () => ReturnType<typeof vi.fn>;
    amount?: number;
    expect: Record<string, unknown>;
    calls: number;
  }> = [
    {
      name: "landed first try",
      setup: () => mockFetch({ status: 200, body: { success: true, balance: 5 } }),
      expect: { event: "proxy.debit_landed", balanceAfterMicro: 5, shortfallMicro: 0 },
      calls: 1,
    },
    {
      name: "landed with a shortfall (balance drained)",
      setup: () =>
        mockFetch({
          status: 200,
          body: { success: true, balance: 0, partial: true, shortfall: 7 },
        }),
      expect: { event: "proxy.debit_landed", shortfallMicro: 7 },
      calls: 1,
    },
    {
      name: "idempotent replay",
      setup: () =>
        mockFetch({ status: 200, body: { success: true, balance: 3, idempotent: true } }),
      expect: { event: "proxy.debit_landed", idempotent: true },
      calls: 1,
    },
    {
      name: "5xx then landed",
      setup: () => mockFetch({ status: 503 }, { status: 200, body: { success: true, balance: 1 } }),
      expect: { event: "proxy.debit_landed", attempts: 2 },
      calls: 2,
    },
    {
      name: "network error then landed",
      setup: () => mockFetch(new Error("ECONNRESET"), { status: 200, body: { success: true } }),
      expect: { event: "proxy.debit_landed", attempts: 2, balanceAfterMicro: null },
      calls: 2,
    },
    {
      name: "relay 200 success:false (nothing spendable)",
      setup: () => mockFetch({ status: 200, body: { success: false, balance: 0 } }),
      expect: { event: "proxy.debit_failed", reason: "insufficient_balance", status: 200 },
      calls: 1,
    },
    {
      name: "relay 200 non-JSON",
      setup: () => mockFetch({ status: 200, raw: "<html>ok</html>" }),
      expect: { event: "proxy.debit_failed", reason: "bad_response" },
      calls: 1,
    },
    {
      name: "relay 200 JSON without the contract",
      setup: () => mockFetch({ status: 200, body: { ok: 1 } }),
      expect: { event: "proxy.debit_failed", reason: "bad_response" },
      calls: 1,
    },
    {
      name: "401 (secret mismatch / unset at relay) — not retried",
      setup: () => mockFetch({ status: 401, body: { error: "unauthorized" } }),
      expect: { event: "proxy.debit_failed", reason: "unauthorized", status: 401 },
      calls: 1,
    },
    {
      name: "403",
      setup: () => mockFetch({ status: 403 }),
      expect: { event: "proxy.debit_failed", reason: "unauthorized", status: 403 },
      calls: 1,
    },
    {
      name: "404 (wrong relay URL / route) — not retried",
      setup: () => mockFetch({ status: 404 }),
      expect: { event: "proxy.debit_failed", reason: "rejected", status: 404 },
      calls: 1,
    },
    {
      name: "persistent 5xx",
      setup: () => mockFetch({ status: 500 }),
      expect: { event: "proxy.debit_failed", reason: "relay_error", status: 500 },
      calls: DEBIT_MAX_ATTEMPTS,
    },
    {
      name: "persistent network error",
      setup: () => mockFetch(new Error("getaddrinfo ENOTFOUND")),
      expect: {
        event: "proxy.debit_failed",
        reason: "unreachable",
        error: "getaddrinfo ENOTFOUND",
      },
      calls: DEBIT_MAX_ATTEMPTS,
    },
    {
      name: "zero amount (served turn, no metered usage)",
      setup: () => mockFetch({ status: 200, body: { success: true } }),
      amount: 0,
      expect: { event: "proxy.debit_failed", reason: "no_billable_amount" },
      calls: 0,
    },
    {
      name: "fractional amount",
      setup: () => mockFetch({ status: 200, body: { success: true } }),
      amount: 1.5,
      expect: { event: "proxy.debit_failed", reason: "no_billable_amount" },
      calls: 0,
    },
    {
      name: "secret unset at the proxy",
      setup: () => {
        delete process.env.RELAY_PROXY_SECRET;
        return mockFetch({ status: 200, body: { success: true } });
      },
      expect: {
        event: "proxy.debit_failed",
        reason: "not_configured",
        missing: ["RELAY_PROXY_SECRET"],
      },
      calls: 0,
    },
    {
      name: "relay URL unset at the proxy",
      setup: () => {
        delete process.env.RELAY_API_URL;
        return mockFetch({ status: 200, body: { success: true } });
      },
      expect: { event: "proxy.debit_failed", reason: "not_configured", missing: ["RELAY_API_URL"] },
      calls: 0,
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const fetchFn = c.setup();
      const outcome = await run(c.amount ?? AMOUNT);
      expect(fetchFn).toHaveBeenCalledTimes(c.calls);
      const events = debitEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        requestId: REF,
        motebitId: MID,
        amountMicro: c.amount ?? AMOUNT,
        ...c.expect,
      });
      expect(outcome.landed).toBe(c.expect.event === "proxy.debit_landed");
      expect(lines.join("\n")).not.toContain(SECRET);
    });
  }

  it("a fetch that throws synchronously still ends in one failure event", async () => {
    vi.stubGlobal("fetch", () => {
      throw new TypeError("boom");
    });
    const outcome = await run();
    expect(outcome.landed).toBe(false);
    expect(debitEvents()).toHaveLength(1);
  });

  it("posts the amount, reference and secret header to the encoded debit route", async () => {
    const fetchFn = mockFetch({ status: 200, body: { success: true } });
    const p = debitRelay("a/b", AMOUNT, REF);
    await vi.runAllTimersAsync();
    await p;
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://relay.test/api/v1/agents/a%2Fb/debit");
    expect((init.headers as Record<string, string>)["x-relay-secret"]).toBe(SECRET);
    expect(JSON.parse(init.body as string)).toEqual({
      amount: AMOUNT,
      reference_id: REF,
      description: "Cloud AI usage",
    });
  });
});
