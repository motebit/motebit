/**
 * Pins, by execution, the shutdown-bound pieces `relay-close-bound.test.ts`
 * stays green without (each test here goes red when its fix is reverted):
 *
 *   (a) `abortGetSupportedOnShutdown` — with the REAL HTTP facilitator
 *       client against a loopback peer that never answers, nothing the
 *       relay started logs after `close()` resolves, through the client's
 *       own 30 s request timeout (driven by an injected clock: every
 *       `AbortSignal.timeout` the client arms is fired at once);
 *   (b) the deposit detector's default adapter is bounded at 10 s;
 *   (c) the mid-deadline abort: at `deadline - 100 ms` the shutdown signal
 *       aborts in-flight work, so it SETTLES inside the deadline — never
 *       abandoned;
 *   (d) the wrapper's pre-aborted branch starts no request at all, and a
 *       settled call leaves no abort listener on the shutdown signal;
 *   (e) close() aborts the shutdown signal even when boot work settled in
 *       time — a request a PERIODIC tick started (never startup work) is
 *       cancelled, not left to its own timeout;
 *   (f) settled startup work leaves no deadline timer behind;
 *   plus `shutdownDeadlineMs` validation.
 */
import { getEventListeners } from "node:events";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSyncRelay, type SyncRelay } from "../index.js";
import { DEPOSIT_RPC_REQUEST_TIMEOUT_MS, startDepositDetector } from "../deposit-detector.js";
import { abortGetSupportedOnShutdown } from "../x402-facilitator-shutdown.js";
import { TEST_RELAY_NETWORK, X402_TEST_CONFIG } from "./test-helpers.js";
import { fakeFacilitatorClient } from "./x402-fake-facilitator.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A TCP peer that accepts every connection and never writes a byte. */
async function startHungServer(): Promise<{ url: string; accepted(): number }> {
  const sockets = new Set<net.Socket>();
  let accepted = 0;
  const server = net.createServer((s) => {
    accepted++;
    sockets.add(s);
    s.on("error", () => {});
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(
    () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  );
  const { port } = server.address() as net.AddressInfo;
  return { url: `http://127.0.0.1:${port}`, accepted: () => accepted };
}

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Every line the relay's logger (stdout/stderr) or console writes while capturing. */
function captureOutput(): { lines: string[]; stop(): void } {
  const lines: string[] = [];
  const record = (chunk: unknown): boolean => {
    lines.push(String(chunk));
    return true;
  };
  const spies = [
    vi.spyOn(process.stdout, "write").mockImplementation(record),
    vi.spyOn(process.stderr, "write").mockImplementation(record),
    vi.spyOn(console, "log").mockImplementation(record),
    vi.spyOn(console, "warn").mockImplementation(record),
    vi.spyOn(console, "error").mockImplementation(record),
  ];
  return { lines, stop: () => spies.forEach((s) => s.mockRestore()) };
}

describe("(a) a hung facilitator's handshake says nothing after close()", () => {
  it("through the HTTP client's own 30 s timeout (+5 s), no log or console line", async () => {
    // Injected clock for the client's request deadline: every
    // AbortSignal.timeout it arms is recorded, and "35 s later" fires them.
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const armed: Array<{ ms: number; c: AbortController }> = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      if (ms > 35_000) return realTimeout(ms);
      const c = new AbortController();
      armed.push({ ms, c });
      return c.signal;
    });
    const hung = await startHungServer();
    const relay = await createSyncRelay({
      apiToken: "t",
      x402: { ...X402_TEST_CONFIG, facilitatorUrl: hung.url },
      x402ChainReader: null,
      depositDetectorRpc: null,
      drainGraceMs: 10,
      shutdownDeadlineMs: 400,
    });
    await until(() => hung.accepted() > 0 && armed.length > 0);
    await relay.close();

    const out = captureOutput();
    try {
      for (let elapsed = 0; elapsed <= 35_000; elapsed += 5_000) {
        for (const a of armed.splice(0)) {
          if (a.ms <= elapsed) {
            a.c.abort(new DOMException("The operation timed out.", "TimeoutError"));
          } else {
            armed.push(a);
          }
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      out.stop();
    }
    expect(out.lines).toEqual([]);
  }, 15_000);
});

describe("(b) the deposit detector's default adapter is bounded", () => {
  it(`aborts a request the RPC never answers at ${DEPOSIT_RPC_REQUEST_TIMEOUT_MS} ms`, async () => {
    const relay = await createSyncRelay({
      apiToken: "t",
      x402: X402_TEST_CONFIG,
      x402ChainReader: null,
      ...TEST_RELAY_NETWORK,
      drainGraceMs: 10,
    });
    cleanups.push(() => relay.close());
    const requests: Array<{ aborted: boolean }> = [];
    const hungFetch = ((_input: unknown, init?: RequestInit) => {
      const rec = { aborted: false };
      requests.push(rec);
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          rec.aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }) as typeof fetch;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    let boot: Promise<unknown> | undefined;
    const interval = startDepositDetector({
      db: relay.moteDb.db,
      chain: X402_TEST_CONFIG.network,
      fetch: hungFetch,
      intervalMs: 3_600_000,
      trackStartup: (w) => (boot = w),
    });
    cleanups.push(() => clearInterval(interval));
    await vi.advanceTimersByTimeAsync(0);
    expect(requests.length).toBe(1);
    await vi.advanceTimersByTimeAsync(DEPOSIT_RPC_REQUEST_TIMEOUT_MS - 1);
    expect(requests[0]!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(requests[0]!.aborted).toBe(true);
    await boot;
  });
});

describe("(c) the mid-deadline abort", () => {
  it("aborts in-flight boot I/O at deadline - 100 ms so it settles — never abandoned", async () => {
    const realFetch = globalThis.fetch;
    const requests: Array<{ aborted: boolean }> = [];
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url).hostname === "127.0.0.1") return realFetch(input, init);
      const rec = { aborted: false };
      requests.push(rec);
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          rec.aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });
    const relay: SyncRelay = await createSyncRelay({
      apiToken: "t",
      x402: X402_TEST_CONFIG,
      x402ChainReader: null,
      x402FacilitatorClient: fakeFacilitatorClient,
      drainGraceMs: 10,
      shutdownDeadlineMs: 600,
    });
    await until(() => requests.length > 0);
    const out = captureOutput();
    try {
      await relay.close();
    } finally {
      out.stop();
    }
    const text = out.lines.join("");
    expect(text).toContain("relay.shutdown.startup_work_aborted");
    expect(text).not.toContain("relay.shutdown.startup_work_abandoned");
    expect(requests.every((r) => r.aborted)).toBe(true);
  }, 15_000);
});

describe("(d) abortGetSupportedOnShutdown", () => {
  it("pre-aborted: rejects without starting a request", async () => {
    const getSupported = vi.fn(() => Promise.resolve({ kinds: [] }));
    const c = new AbortController();
    c.abort();
    const wrapped = abortGetSupportedOnShutdown({ getSupported }, c.signal);
    await expect(wrapped.getSupported()).rejects.toThrow(/relay shutting down/);
    expect(getSupported).not.toHaveBeenCalled();
  });

  it("aborted mid-call: rejects at once; otherwise passes the answer through", async () => {
    const c = new AbortController();
    const hung = abortGetSupportedOnShutdown(
      { getSupported: () => new Promise<never>(() => {}) },
      c.signal,
    );
    const pending = hung.getSupported();
    c.abort();
    await expect(pending).rejects.toThrow(/relay shutting down/);
    const ok = abortGetSupportedOnShutdown(
      { getSupported: () => Promise.resolve("v") },
      new AbortController().signal,
    );
    await expect(ok.getSupported()).resolves.toBe("v");
  });

  it("a settled call removes its abort listener (no leak per call)", async () => {
    const c = new AbortController();
    const ok = abortGetSupportedOnShutdown({ getSupported: () => Promise.resolve("v") }, c.signal);
    const failing = abortGetSupportedOnShutdown(
      { getSupported: () => Promise.reject(new Error("down")) },
      c.signal,
    );
    await ok.getSupported();
    await expect(failing.getSupported()).rejects.toThrow("down");
    expect(getEventListeners(c.signal, "abort")).toHaveLength(0);
  });
});

describe("(e) close() aborts the shutdown signal after boot work settled", () => {
  it("cancels a periodic deposit tick's in-flight request", async () => {
    const requests: Array<{ aborted: boolean; answer(): void }> = [];
    vi.stubGlobal("fetch", (_input: unknown, init?: RequestInit) => {
      const rec = { aborted: false, answer: () => {} };
      requests.push(rec);
      return new Promise<Response>((resolve, reject) => {
        rec.answer = () => resolve(new Response("down", { status: 503 }));
        init?.signal?.addEventListener("abort", () => {
          rec.aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const relay = await createSyncRelay({
      apiToken: "t",
      x402: X402_TEST_CONFIG,
      x402ChainReader: null,
      x402FacilitatorClient: fakeFacilitatorClient,
      drainGraceMs: 10,
    });
    // The boot tick's request is answered: startup work settles in time.
    await until(() => requests.length > 0);
    for (const r of requests) r.answer();
    const bootRequests = requests.length;
    // The next PERIODIC tick (15 s) dials and is left hanging.
    await vi.advanceTimersByTimeAsync(15_000);
    await until(() => requests.length > bootRequests);
    const periodic = requests.slice(bootRequests);
    const out = captureOutput();
    try {
      await relay.close();
    } finally {
      out.stop();
    }
    expect(out.lines.join("")).not.toContain("relay.shutdown.startup_work_aborted");
    expect(periodic.every((r) => r.aborted)).toBe(true);
  }, 15_000);
});

describe("(f) settlesWithin clears its deadline timer", () => {
  it("startup work that settles leaves no shutdown-deadline timer armed", async () => {
    const deadlineMs = 29_000;
    const realSetTimeout = globalThis.setTimeout;
    const armed: NodeJS.Timeout[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms?: number,
      ...rest: unknown[]
    ) => {
      const t = realSetTimeout(fn, ms, ...rest);
      if (ms === deadlineMs - 100) armed.push(t as unknown as NodeJS.Timeout);
      return t;
    }) as typeof setTimeout);
    const relay = await createSyncRelay({
      apiToken: "t",
      x402: X402_TEST_CONFIG,
      x402ChainReader: null,
      x402FacilitatorClient: fakeFacilitatorClient,
      depositDetectorRpc: null,
      drainGraceMs: 10,
      shutdownDeadlineMs: deadlineMs,
    });
    await relay.close();
    expect(armed.length).toBeGreaterThan(0);
    // A cleared Node timer is destroyed; one left armed would hold the
    // process for the whole deadline after close() resolved.
    for (const t of armed) expect((t as unknown as { _destroyed: boolean })._destroyed).toBe(true);
  });
});

describe("shutdownDeadlineMs validation", () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 30_001])("refuses %s", async (ms) => {
    await expect(
      createSyncRelay({
        apiToken: "t",
        x402: X402_TEST_CONFIG,
        ...TEST_RELAY_NETWORK,
        shutdownDeadlineMs: ms,
      }),
    ).rejects.toThrow(RangeError);
  });
});
