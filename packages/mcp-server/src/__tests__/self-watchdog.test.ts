/**
 * #459 ops leg: the self-watchdog turns "wedged-but-alive for 25 minutes
 * until a human noticed" into "exits non-zero, platform restarts it".
 * All seams injected — no real server, no real exit, no real timers
 * (checkOnce is driven directly).
 */
import { describe, it, expect } from "vitest";
import { startSelfWatchdog } from "../self-watchdog.js";

function harness(responses: Array<"ok" | "fail" | "throw">) {
  let i = 0;
  const exits: number[] = [];
  const logs: string[] = [];
  const handle = startSelfWatchdog({
    healthUrl: "http://127.0.0.1:9/health",
    intervalMs: 1_000_000, // interval never fires in tests — checkOnce drives
    maxConsecutiveFailures: 3,
    fetchFn: (async () => {
      const r = responses[Math.min(i++, responses.length - 1)]!;
      if (r === "throw") throw new Error("ECONNREFUSED");
      return { ok: r === "ok" } as Response;
    }) as typeof fetch,
    exitFn: (code) => exits.push(code),
    log: (m) => logs.push(m),
  });
  return { handle, exits, logs };
}

describe("startSelfWatchdog", () => {
  it("healthy checks never exit and reset the failure count", async () => {
    const { handle, exits } = harness(["ok", "fail", "ok", "fail", "fail"]);
    for (let n = 0; n < 5; n++) await handle.checkOnce();
    expect(exits).toEqual([]);
    expect(handle.consecutiveFailures).toBe(2); // fail,fail after the reset
    handle.stop();
  });

  it("exits non-zero after maxConsecutiveFailures — the wedge becomes a restart", async () => {
    const { handle, exits, logs } = harness(["throw", "throw", "throw"]);
    await handle.checkOnce();
    await handle.checkOnce();
    expect(exits).toEqual([]);
    await handle.checkOnce();
    expect(exits).toEqual([1]);
    expect(logs.join(" ")).toContain("self-watchdog");
  });

  it("a non-2xx self-response counts as a failure (unservable, not just unreachable)", async () => {
    const { handle, exits } = harness(["fail", "fail", "fail"]);
    for (let n = 0; n < 3; n++) await handle.checkOnce();
    expect(exits).toEqual([1]);
  });

  it("stop() halts checking — no exit after shutdown", async () => {
    const { handle, exits } = harness(["throw", "throw", "throw", "throw"]);
    await handle.checkOnce();
    handle.stop();
    await handle.checkOnce();
    await handle.checkOnce();
    await handle.checkOnce();
    expect(exits).toEqual([]);
  });
});
