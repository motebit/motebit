import { afterEach, describe, expect, it, vi } from "vitest";
import { selectAndRunDelegation } from "@motebit/runtime";
import {
  faultingFetch,
  installTaskPollFault,
  parseTaskPollFault,
  taskPollId,
} from "../fault-injection.js";

const RELAY = "https://relay.test";
const ME = "019df0f4-084e-7910-90a8-3492ced8fb8f";
const TASK = "task-433";

describe("parseTaskPollFault", () => {
  it("is off when unset or blank", () => {
    expect(parseTaskPollFault(undefined)).toBeNull();
    expect(parseTaskPollFault("  ")).toBeNull();
  });
  it("reads 503x<N> and lost", () => {
    expect(parseTaskPollFault("503x3")).toEqual({ kind: "transient", count: 3 });
    expect(parseTaskPollFault("lost")).toEqual({ kind: "lost" });
  });
  it("refuses anything else, so a typo never runs a real hire unfaulted", () => {
    for (const bad of ["503", "503x0", "503x1000", "LOST", "404", "true"]) {
      expect(() => parseTaskPollFault(bad), bad).toThrow(/not a fault/);
    }
  });
});

describe("taskPollId", () => {
  it("matches only the delegator's GET result poll", () => {
    expect(taskPollId(`${RELAY}/agent/${ME}/task/${TASK}`, "GET")).toBe(TASK);
    expect(taskPollId(`${RELAY}/agent/${ME}/task/${TASK}`, "POST")).toBeNull();
    expect(taskPollId(`${RELAY}/agent/${ME}/task`, "POST")).toBeNull();
    expect(taskPollId(`${RELAY}/agent/${ME}/task/${TASK}/result`, "POST")).toBeNull();
    expect(taskPollId(`${RELAY}/agent/${ME}/task/${TASK}/result`, "GET")).toBeNull();
    expect(taskPollId(`${RELAY}/api/v1/agents/${ME}/listing`, "GET")).toBeNull();
  });
});

describe("installTaskPollFault", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });
  it("leaves fetch untouched and says nothing when the variable is unset", () => {
    const announce = vi.fn();
    expect(installTaskPollFault({}, announce)).toBeNull();
    expect(globalThis.fetch).toBe(original);
    expect(announce).not.toHaveBeenCalled();
  });
  it("announces itself when on", () => {
    const announce = vi.fn();
    installTaskPollFault({ MOTEBIT_FAULT_TASK_POLL: "lost" }, announce);
    expect(globalThis.fetch).not.toBe(original);
    expect(announce).toHaveBeenCalledWith(expect.stringMatching(/FAULT INJECTION ON/));
  });
});

// The fault reaches the runtime's REAL poll loop: a stub relay under a
// faulting fetch, driven through the exported delegation entry point.
describe("fault injection through selectAndRunDelegation (relay mode)", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
    vi.useRealTimers();
  });

  function stubRelay(): { fetch: typeof fetch; polls: () => number; submits: () => number } {
    let polls = 0;
    let submits = 0;
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url).pathname;
      if (init?.method === "POST" && path === `/agent/${ME}/task`) {
        submits++;
        return Response.json({ task_id: TASK });
      }
      if ((init?.method ?? "GET") === "GET" && path === `/agent/${ME}/task/${TASK}`) {
        polls++;
        return Response.json({
          task: { status: "completed" },
          receipt: { task_id: TASK, status: "completed", result: "done" },
        });
      }
      return new Response("not stubbed", { status: 500 });
    }) as typeof fetch;
    return { fetch: f, polls: () => polls, submits: () => submits };
  }

  /** Install `f` as the global fetch, counting the result polls that reach it. */
  function pollAttempts(f: typeof fetch): () => number {
    let n = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (taskPollId(url, init?.method ?? "GET") != null) n++;
      return f(input, init);
    }) as typeof fetch;
    return () => n;
  }

  async function run(timeoutMs: number) {
    const p = selectAndRunDelegation({
      motebitId: ME,
      syncUrl: RELAY,
      authToken: async () => "token",
      prompt: "research X",
      timeoutMs,
      logger: { warn: () => {} },
    });
    await vi.advanceTimersByTimeAsync(timeoutMs + 5_000);
    return p;
  }

  it("503x2: the real relay's answer still arrives after two transient failures — one submit", async () => {
    vi.useFakeTimers();
    const relay = stubRelay();
    const attempts = pollAttempts(faultingFetch(relay.fetch, { kind: "transient", count: 2 }));
    const r = await run(30_000);
    expect(r.ok).toBe(true);
    expect(relay.submits()).toBe(1);
    expect(attempts()).toBe(3); // two answered 503 by the fault …
    expect(relay.polls()).toBe(1); // … and only the third reached the relay
  });

  it("lost: every poll is 404 — the delegation ends unretrieved, never resubmitted", async () => {
    vi.useFakeTimers();
    const relay = stubRelay();
    const attempts = pollAttempts(faultingFetch(relay.fetch, { kind: "lost" }));
    const r = await run(10_000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("timeout");
    expect(relay.submits()).toBe(1);
    expect(attempts()).toBeGreaterThan(1); // the loop kept polling …
    expect(relay.polls()).toBe(0); // … and every poll was answered by the fault
  });

  it("without the fault the same stub delivers on the first poll (control)", async () => {
    vi.useFakeTimers();
    const relay = stubRelay();
    globalThis.fetch = relay.fetch;
    const r = await run(30_000);
    expect(r.ok).toBe(true);
    expect(relay.polls()).toBe(1);
  });
});
