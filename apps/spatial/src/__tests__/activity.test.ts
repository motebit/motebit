/**
 * Activity derivation tests. Locks the StreamChunk → label mapping and the
 * ActivityTracker contract so the HUD's "task" field behavior is pinned.
 */
import { describe, it, expect, vi } from "vitest";
import type { StreamChunk, PlanChunk } from "@motebit/runtime";
import { ActivityTracker, deriveStreamActivity, derivePlanActivity } from "../activity";

describe("deriveStreamActivity", () => {
  it("tool_status calling → tool: name", () => {
    const chunk: StreamChunk = { type: "tool_status", name: "web_search", status: "calling" };
    expect(deriveStreamActivity(chunk)).toBe("tool: web_search");
  });

  it("tool_status done → thinking", () => {
    const chunk: StreamChunk = { type: "tool_status", name: "web_search", status: "done" };
    expect(deriveStreamActivity(chunk)).toBe("thinking");
  });

  it("delegation_start → delegating → tool", () => {
    const chunk: StreamChunk = { type: "delegation_start", server: "svc", tool: "research" };
    expect(deriveStreamActivity(chunk)).toBe("delegating → research");
  });

  it("approval_request → approval: name", () => {
    const chunk: StreamChunk = {
      type: "approval_request",
      tool_call_id: "t1",
      name: "write_file",
      args: {},
    };
    expect(deriveStreamActivity(chunk)).toBe("approval: write_file");
  });

  it("result → null (clear)", () => {
    const chunk: StreamChunk = {
      type: "result",
      result: { response: "", tool_calls: [], memories_formed: [] } as never,
    };
    expect(deriveStreamActivity(chunk)).toBeNull();
  });

  it("text chunks don't change activity", () => {
    const chunk: StreamChunk = { type: "text", text: "hello" };
    expect(deriveStreamActivity(chunk)).toBeUndefined();
  });
});

describe("derivePlanActivity", () => {
  it("plan_created → planning", () => {
    const chunk = { type: "plan_created", plan: {} as never, steps: [] } as PlanChunk;
    expect(derivePlanActivity(chunk)).toBe("planning");
  });

  it("step_started → step: <desc>", () => {
    const chunk = {
      type: "step_started",
      step: { id: "s1", description: "gather sources" } as never,
    } as PlanChunk;
    expect(derivePlanActivity(chunk)).toBe("step: gather sources");
  });

  it("truncates long step descriptions", () => {
    const longDesc = "this is a very long step description that exceeds the limit";
    const chunk = {
      type: "step_started",
      step: { id: "s1", description: longDesc } as never,
    } as PlanChunk;
    const label = derivePlanActivity(chunk);
    expect(label).toMatch(/^step: /);
    expect(label!.length).toBeLessThanOrEqual("step: ".length + 36);
    expect(label!.endsWith("…")).toBe(true);
  });

  it("plan_completed → null", () => {
    const chunk = { type: "plan_completed", plan: {} as never } as PlanChunk;
    expect(derivePlanActivity(chunk)).toBeNull();
  });
});

describe("ActivityTracker", () => {
  it("starts null", () => {
    const t = new ActivityTracker();
    expect(t.label).toBeNull();
  });

  it("notifies on change", () => {
    const t = new ActivityTracker();
    const cb = vi.fn();
    t.onChange(cb);

    t.set("thinking");
    expect(cb).toHaveBeenCalledWith("thinking");

    t.set("thinking"); // idempotent
    expect(cb).toHaveBeenCalledTimes(1);

    t.set("tool: x");
    expect(cb).toHaveBeenCalledWith("tool: x");
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("unsubscribe stops notifications", () => {
    const t = new ActivityTracker();
    const cb = vi.fn();
    const unsub = t.onChange(cb);

    t.set("a");
    unsub();
    t.set("b");

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith("a");
  });

  it("clear sets null", () => {
    const t = new ActivityTracker();
    t.set("working");
    t.clear();
    expect(t.label).toBeNull();
  });

  it("multiple subscribers each get notified", () => {
    const t = new ActivityTracker();
    const a = vi.fn();
    const b = vi.fn();
    t.onChange(a);
    t.onChange(b);

    t.set("hello");
    expect(a).toHaveBeenCalledWith("hello");
    expect(b).toHaveBeenCalledWith("hello");
  });
});
