/**
 * cmdSelfTest — the `serving` flag gates the completion poll.
 *
 * The probe's security purpose (device auth + sybil defense) is proven the
 * moment the self-delegation task submits and returns a task_id. The completion
 * poll is a SECONDARY liveness check that can only resolve when the agent is a
 * serving worker. On a non-serving surface (web/desktop/mobile at onboarding,
 * spatial always) the poll could only run down its timeout — so `serving: false`
 * must terminate at `auth_verified`, not poll. Regression for the 2026-06-15
 * acceptance-test finding (every web launch ran a doomed 30s self-test).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { cmdSelfTest } from "../commands/self-test.js";
import type { MotebitRuntime } from "../index.js";

const runtime = {
  getToolRegistry: () => ({ list: () => [{ name: "echo" }] }),
} as unknown as MotebitRuntime;

const baseConfig = {
  relay: { relayUrl: "http://relay.test", authToken: "t", motebitId: "m1" },
  mintToken: async () => "tok",
};

afterEach(() => vi.restoreAllMocks());

function stubFetch(handler: (init?: RequestInit) => Response): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (_url: string, init?: RequestInit) => handler(init));
  vi.stubGlobal("fetch", fn);
  return fn;
}

const submitOk = (init?: RequestInit, pollStatus = "pending"): Response =>
  init?.method === "POST"
    ? new Response(JSON.stringify({ task_id: "t1" }), { status: 200 })
    : new Response(JSON.stringify({ status: pollStatus }), { status: 200 });

describe("cmdSelfTest — serving gates the completion poll", () => {
  it("NOT serving: a successful submission returns auth_verified with NO poll", async () => {
    const fetchFn = stubFetch((init) => submitOk(init));
    const r = await cmdSelfTest(runtime, { ...baseConfig, serving: false, timeoutMs: 5000 });
    expect(r.data?.status).toBe("auth_verified");
    expect(r.data?.served).toBe(false);
    // Only the submit POST fired — the poll (which would have run the full 5s
    // timeout on a non-serving surface) never happened.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("defaults to NOT serving when the flag is omitted → auth_verified, no poll", async () => {
    const fetchFn = stubFetch((init) => submitOk(init));
    const r = await cmdSelfTest(runtime, { ...baseConfig });
    expect(r.data?.status).toBe("auth_verified");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("serving: polls and returns passed when the task completes", async () => {
    const fetchFn = stubFetch((init) => submitOk(init, "completed"));
    const r = await cmdSelfTest(runtime, {
      ...baseConfig,
      serving: true,
      pollIntervalMs: 1,
      timeoutMs: 1000,
    });
    expect(r.data?.status).toBe("passed");
    expect(fetchFn.mock.calls.length).toBeGreaterThan(1); // submit + at least one poll
  });

  it("serving: times out when the task never completes (poll still works)", async () => {
    stubFetch((init) => submitOk(init, "pending"));
    const r = await cmdSelfTest(runtime, {
      ...baseConfig,
      serving: true,
      pollIntervalMs: 1,
      timeoutMs: 20,
    });
    expect(r.data?.status).toBe("timeout");
  });

  it("a submission rejection (403) is failed regardless of serving", async () => {
    stubFetch(() => new Response("nope", { status: 403 }));
    const r = await cmdSelfTest(runtime, { ...baseConfig, serving: false });
    expect(r.data?.status).toBe("failed");
  });
});
