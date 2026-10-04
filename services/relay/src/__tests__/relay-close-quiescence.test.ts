/**
 * A test relay never reaches the network, and `close()` leaves nothing behind.
 *
 * The failure this pins: `createTestRelay` enables x402, and `createSyncRelay`
 * started `x402HTTPResourceServer.initialize()` — a REAL fetch to the x402
 * facilitator — without `close()` ever awaiting it. In a sandbox without
 * network the fetch failed and `@x402/core` `console.warn`ed asynchronously;
 * when that landed after the file's worker began tearing down, vitest failed
 * the whole run with `EnvironmentTeardownError: Closing rpc while
 * "onUserConsoleLog" was pending`, blamed on whichever short file lost the
 * race (fees, discovery, identity-binding-forgery …) while every test passed.
 * The deposit detector's boot tick did the same against the Base Sepolia RPC.
 *
 * The law:
 *   (a) a test relay never attempts a non-localhost request;
 *   (b) every fetch the relay started has settled by the time `close()`
 *       resolves, and nothing is logged after it;
 *   (c) a production-shaped relay whose facilitator is unreachable still
 *       starts, logs the failure once, and closes quiet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRelay, X402_TEST_CONFIG } from "./test-helpers.js";
import { createSyncRelay } from "../index.js";

/** How long a blocked (non-local) request takes to fail — long enough to outlive a naive close(). */
const BLOCKED_FETCH_DELAY_MS = 150;

interface FetchRecord {
  url: string;
  settled: boolean;
}

function isLocal(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return true; // a relative URL never leaves the process
  }
}

let fetches: FetchRecord[] = [];
let outputAfterClose: string[] = [];
/** Every line the relay wrote to stdout/stderr, before or after close. */
let written: string[] = [];
let closed = false;

function installNetworkBlock(): void {
  fetches = [];
  outputAfterClose = [];
  written = [];
  closed = false;
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const rec: FetchRecord = { url, settled: false };
    fetches.push(rec);
    if (isLocal(url)) {
      return realFetch(input, init).finally(() => {
        rec.settled = true;
      });
    }
    // The sandbox without network: the request fails, but not synchronously.
    return new Promise<Response>((_, reject) =>
      setTimeout(() => {
        rec.settled = true;
        reject(new TypeError(`fetch failed (network blocked in test): ${url}`));
      }, BLOCKED_FETCH_DELAY_MS),
    );
  });
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    const real = console[method].bind(console);
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      if (closed) outputAfterClose.push(`console.${method}: ${args.map(String).join(" ")}`);
      else real(...args);
    });
  }
  for (const stream of [process.stdout, process.stderr]) {
    const real = stream.write.bind(stream) as (...a: unknown[]) => boolean;
    vi.spyOn(stream, "write").mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      written.push(String(chunk));
      if (closed) {
        outputAfterClose.push(String(chunk).trim());
        return true;
      }
      return real(chunk, ...rest);
    }) as typeof stream.write);
  }
}

/** Wait past every blocked request's failure, so anything close() abandoned surfaces now. */
const pastBlockedFetches = () =>
  new Promise<void>((resolve) => setTimeout(resolve, BLOCKED_FETCH_DELAY_MS * 3));

describe("relay close() quiescence under a network-blocked fetch", () => {
  beforeEach(installNetworkBlock);
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("a test relay attempts no non-localhost request", async () => {
    const relay = await createTestRelay();
    await relay.close();
    closed = true;
    await pastBlockedFetches();
    expect(fetches.filter((f) => !isLocal(f.url)).map((f) => f.url)).toEqual([]);
  });

  it("a test relay's close() leaves no request in flight and nothing logs after it", async () => {
    const relay = await createTestRelay();
    await relay.close();
    closed = true;
    expect(fetches.filter((f) => !f.settled).map((f) => f.url)).toEqual([]);
    await pastBlockedFetches();
    expect(outputAfterClose).toEqual([]);
  });

  it("a relay with an unreachable facilitator still starts, logs the failure once, and close() awaits it", async () => {
    // Production shape: the real HTTP facilitator client, no in-process fake.
    const relay = await createSyncRelay({
      apiToken: "t",
      x402: X402_TEST_CONFIG,
      x402ChainReader: null,
      drainGraceMs: 10,
    });
    await relay.close();
    closed = true;
    expect(fetches.filter((f) => !f.settled).map((f) => f.url)).toEqual([]);
    expect(written.filter((l) => l.includes("x402.facilitator.init_failed"))).toHaveLength(1);
    await pastBlockedFetches();
    expect(outputAfterClose).toEqual([]);
  });
});
