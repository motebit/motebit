import { describe, it, expect } from "vitest";
import {
  createSelfTestController,
  selfTestBadgeLabel,
  type SelfTestFetchAdapter,
  type SelfTestResult,
} from "../controller";

function makeAdapter(opts: {
  result?: SelfTestResult;
  throws?: Error;
  delayMs?: number;
}): SelfTestFetchAdapter {
  return {
    runSelfTest: async () => {
      if (opts.delayMs !== undefined) {
        await new Promise((r) => setTimeout(r, opts.delayMs));
      }
      if (opts.throws !== undefined) throw opts.throws;
      return (
        opts.result ?? {
          status: "passed",
          summary: "Self-test passed — agent is a live network participant.",
        }
      );
    },
  };
}

// ── State machine ─────────────────────────────────────────────────────

describe("SelfTestController — state machine", () => {
  it("initial state is idle with empty summary", () => {
    const ctrl = createSelfTestController(makeAdapter({}));
    const s = ctrl.getState();
    expect(s.status).toBe("idle");
    expect(s.summary).toBe("");
    expect(s.lastRunAt).toBeNull();
    expect(s.taskId).toBeNull();
    expect(s.hint).toBeNull();
    expect(s.httpStatus).toBeNull();
  });

  it("passed result transitions idle → running → passed", async () => {
    const ctrl = createSelfTestController(
      makeAdapter({
        result: { status: "passed", summary: "passed!", taskId: "task-123" },
      }),
    );
    const seen: string[] = [];
    ctrl.subscribe((s) => seen.push(s.status));
    await ctrl.run();
    expect(seen).toEqual(["idle", "running", "passed"]);
    const s = ctrl.getState();
    expect(s.status).toBe("passed");
    expect(s.summary).toBe("passed!");
    expect(s.taskId).toBe("task-123");
    expect(s.lastRunAt).not.toBeNull();
  });

  it("failed result preserves hint + httpStatus from the relay", async () => {
    const ctrl = createSelfTestController(
      makeAdapter({
        result: {
          status: "failed",
          summary: "relay 401",
          hint: "Device may not be registered with relay.",
          httpStatus: 401,
        },
      }),
    );
    await ctrl.run();
    const s = ctrl.getState();
    expect(s.status).toBe("failed");
    expect(s.hint).toBe("Device may not be registered with relay.");
    expect(s.httpStatus).toBe(401);
  });

  it("adapter throw lands as failed with the error message in summary", async () => {
    const ctrl = createSelfTestController(makeAdapter({ throws: new Error("network down") }));
    await ctrl.run();
    const s = ctrl.getState();
    expect(s.status).toBe("failed");
    expect(s.summary).toContain("network down");
    expect(s.lastRunAt).not.toBeNull();
  });

  it("each non-passed status flows through unchanged", async () => {
    const statuses: Array<"task_failed" | "timeout" | "skipped"> = [
      "task_failed",
      "timeout",
      "skipped",
    ];
    for (const status of statuses) {
      const ctrl = createSelfTestController(
        makeAdapter({ result: { status, summary: `summary-${status}` } }),
      );
      await ctrl.run();
      expect(ctrl.getState().status).toBe(status);
      expect(ctrl.getState().summary).toBe(`summary-${status}`);
    }
  });

  it("concurrent run() calls coalesce — only one probe fires", async () => {
    let runCount = 0;
    const adapter: SelfTestFetchAdapter = {
      runSelfTest: async () => {
        runCount++;
        await new Promise((r) => setTimeout(r, 30));
        return { status: "passed", summary: "ok" };
      },
    };
    const ctrl = createSelfTestController(adapter);
    // Fire three in quick succession; the second + third should
    // return immediately because status === "running".
    const p1 = ctrl.run();
    const p2 = ctrl.run();
    const p3 = ctrl.run();
    await Promise.all([p1, p2, p3]);
    expect(runCount).toBe(1);
    expect(ctrl.getState().status).toBe("passed");
  });
});

// ── Subscribe lifecycle ───────────────────────────────────────────────

describe("SelfTestController — subscribe", () => {
  it("subscribe fires immediately with current state", () => {
    const ctrl = createSelfTestController(makeAdapter({}));
    const seen: string[] = [];
    ctrl.subscribe((s) => seen.push(s.status));
    expect(seen).toEqual(["idle"]);
  });

  it("unsubscribe stops listener fires", async () => {
    const ctrl = createSelfTestController(makeAdapter({}));
    const seen: string[] = [];
    const off = ctrl.subscribe((s) => seen.push(s.status));
    off();
    await ctrl.run();
    expect(seen).toEqual(["idle"]); // never grew past the initial fire
  });

  it("dispose clears every subscriber", () => {
    const ctrl = createSelfTestController(makeAdapter({}));
    let calls = 0;
    ctrl.subscribe(() => {
      calls++;
    });
    ctrl.subscribe(() => {
      calls++;
    });
    expect(calls).toBe(2); // immediate fires
    ctrl.dispose();
    void ctrl.run(); // no listeners → no further fires after dispose
    expect(calls).toBe(2);
  });
});

// ── Badge label projection ────────────────────────────────────────────

describe("selfTestBadgeLabel", () => {
  it("maps every status to a stable label string", () => {
    expect(selfTestBadgeLabel("idle")).toBe("not run");
    expect(selfTestBadgeLabel("running")).toBe("running");
    expect(selfTestBadgeLabel("passed")).toBe("passed");
    expect(selfTestBadgeLabel("failed")).toBe("failed");
    expect(selfTestBadgeLabel("task_failed")).toBe("task failed");
    expect(selfTestBadgeLabel("timeout")).toBe("timed out");
    expect(selfTestBadgeLabel("skipped")).toBe("skipped");
  });
});
