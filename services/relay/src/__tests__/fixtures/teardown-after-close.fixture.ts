/**
 * Fixture for `relay-teardown-repro.test.ts` — NOT collected by the relay
 * suite (not `*.test.ts`); the repro runs it in its own vitest process.
 *
 * The flake: work a test relay started but `close()` abandoned (the x402
 * facilitator `initialize()` fetch) fails later and `console.warn`s. When that
 * lands between the worker's last awaited RPC and its close, vitest fails the
 * run with `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog"
 * was pending`. In the suite the landing is chance; here it is pinned:
 *
 *   1. every non-local fetch is held open (the sandbox with no network);
 *   2. the test opens and closes a test relay, THEN fails the held requests
 *      and waits for the abandoned work to finish;
 *   3. console output the relay produces AFTER `close()` resolved is captured
 *      and replayed on each RPC reply the worker receives after the file's
 *      last hook — exactly the teardown window.
 *
 * A relay whose `close()` awaits everything it started, and that never
 * reaches the network, produces no post-close output: nothing is replayed,
 * and the run is clean.
 */
import { afterAll, it, vi } from "vitest";
import { createTestRelay } from "../test-helpers.js";

const held: Array<() => void> = [];
const realFetch = globalThis.fetch;
vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url)) return realFetch(input, init);
  return new Promise<Response>((_, reject) =>
    held.push(() => reject(new TypeError(`fetch failed: ${url}`))),
  );
});

type Method = "log" | "info" | "warn" | "error" | "debug";
const lateOutput: Array<[Method, unknown[]]> = [];
const real = {} as Record<Method, (...args: unknown[]) => void>;
let closed = false;
for (const method of ["log", "info", "warn", "error", "debug"] as const) {
  real[method] = console[method].bind(console);
  console[method] = (...args: unknown[]) => {
    if (closed) lateOutput.push([method, args]);
    else real[method](...args);
  };
}

it("opens and closes a test relay", async () => {
  const relay = await createTestRelay();
  await relay.close();
  closed = true;
  held.splice(0).forEach((fail) => fail());
  await new Promise((resolve) => setTimeout(resolve, 100));
});

afterAll(() => {
  const late = lateOutput.splice(0);
  process.on("message", () => {
    for (const [method, args] of late) real[method](...args);
  });
});
