/**
 * debitRelay — retry + reconciliation behavior.
 *
 * The relay debit endpoint is idempotent on reference_id, so debitRelay retries
 * transient failures with backoff (using the same reference, which cannot
 * double-charge) and, only after exhausting them, emits a structured
 * `proxy.debit_failed` event so a dropped debit is reconcilable from logs
 * instead of silently lost (the old `void fetch(...).catch(() => {})` behavior).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { debitRelay, DEBIT_MAX_ATTEMPTS } from "../route";

const REF = "req-abc";
const MID = "mote-1";
const AMOUNT = 12_345;

let errLines: string[];

beforeEach(() => {
  process.env.RELAY_PROXY_SECRET = "secret";
  process.env.RELAY_API_URL = "https://relay.test";
  errLines = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errLines.push(a.map(String).join(" "));
  });
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.RELAY_PROXY_SECRET;
  delete process.env.RELAY_API_URL;
});

function mockFetch(
  ...responses: Array<{ ok: boolean; status: number } | Error>
): ReturnType<typeof vi.fn> {
  let i = 0;
  const fn = vi.fn(() => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve(r as Response);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function debitFailedEvents(): Array<Record<string, unknown>> {
  return errLines
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((e): e is Record<string, unknown> => e?.event === "proxy.debit_failed");
}

describe("debitRelay", () => {
  it("no-ops without a relay secret (no fetch, no failure event)", async () => {
    delete process.env.RELAY_PROXY_SECRET;
    const fetchFn = mockFetch({ ok: true, status: 200 });
    await debitRelay(MID, AMOUNT, REF);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(debitFailedEvents()).toHaveLength(0);
  });

  it("no-ops for a non-positive amount", async () => {
    const fetchFn = mockFetch({ ok: true, status: 200 });
    await debitRelay(MID, 0, REF);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("succeeds on the first attempt — one call, no retry, no failure event", async () => {
    const fetchFn = mockFetch({ ok: true, status: 200 });
    const p = debitRelay(MID, AMOUNT, REF);
    await vi.runAllTimersAsync();
    await p;
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(debitFailedEvents()).toHaveLength(0);
  });

  it("retries a transient 5xx and succeeds without a failure event", async () => {
    const fetchFn = mockFetch({ ok: false, status: 503 }, { ok: true, status: 200 });
    const p = debitRelay(MID, AMOUNT, REF);
    await vi.runAllTimersAsync();
    await p;
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(debitFailedEvents()).toHaveLength(0);
  });

  it("retries a network error and succeeds", async () => {
    const fetchFn = mockFetch(new Error("ECONNRESET"), { ok: true, status: 200 });
    const p = debitRelay(MID, AMOUNT, REF);
    await vi.runAllTimersAsync();
    await p;
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(debitFailedEvents()).toHaveLength(0);
  });

  it("exhausts retries on persistent 5xx and emits a reconcilable proxy.debit_failed", async () => {
    const fetchFn = mockFetch({ ok: false, status: 500 });
    const p = debitRelay(MID, AMOUNT, REF);
    await vi.runAllTimersAsync();
    await p;
    expect(fetchFn).toHaveBeenCalledTimes(DEBIT_MAX_ATTEMPTS);
    const events = debitFailedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "proxy.debit_failed",
      motebitId: MID,
      amountMicro: AMOUNT,
      requestId: REF,
      error: "HTTP 500",
    });
  });

  it("fails fast on a 4xx (no retry) but still records the dropped debit", async () => {
    const fetchFn = mockFetch({ ok: false, status: 401 });
    const p = debitRelay(MID, AMOUNT, REF);
    await vi.runAllTimersAsync();
    await p;
    expect(fetchFn).toHaveBeenCalledTimes(1); // 4xx not retried
    const events = debitFailedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.error).toBe("HTTP 401");
  });
});
