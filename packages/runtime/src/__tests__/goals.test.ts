import { describe, it, expect } from "vitest";
import { EventType } from "@motebit/sdk";
import type { EventLogEntry } from "@motebit/sdk";
import { createGoalsController, type GoalLifecycleStatus } from "../goals.js";

/**
 * Minimal in-memory event store stub matching the slice of `EventStore`
 * the goals controller depends on. The shape is intentionally narrow —
 * exercise drift between the primitive and the event-log surface would
 * show up as a type error here before it reaches integration tests.
 */
function makeEventStub() {
  const entries: EventLogEntry[] = [];
  let clock = 0;
  return {
    entries,
    stub: {
      async append(entry: EventLogEntry): Promise<void> {
        entries.push(entry);
      },
      async getLatestClock(): Promise<number> {
        return clock;
      },
      async appendWithClock(partial: Omit<EventLogEntry, "version_clock">): Promise<number> {
        clock += 1;
        entries.push({ ...partial, version_clock: clock } as EventLogEntry);
        return clock;
      },
    },
  };
}

describe("createGoalsController — wire-format emission", () => {
  it("emits goal_created with the full payload intact", async () => {
    const ev = makeEventStub();
    const goals = createGoalsController({ motebitId: "mb-1", events: ev.stub });

    await goals.created({
      goal_id: "g-1",
      prompt: "Summarize my inbox.",
      interval_ms: 3_600_000,
      mode: "recurring",
    });

    expect(ev.entries).toHaveLength(1);
    expect(ev.entries[0]!.event_type).toBe(EventType.GoalCreated);
    expect(ev.entries[0]!.motebit_id).toBe("mb-1");
    expect(ev.entries[0]!.payload).toEqual({
      goal_id: "g-1",
      prompt: "Summarize my inbox.",
      interval_ms: 3_600_000,
      mode: "recurring",
    });
    expect(ev.entries[0]!.version_clock).toBe(1);
  });

  it("emits goal_executed with success metrics (no error field)", async () => {
    const ev = makeEventStub();
    const goals = createGoalsController({ motebitId: "mb-1", events: ev.stub });

    await goals.executed({ goal_id: "g-1", summary: "done", tool_calls: 3, memories: 1 });

    expect(ev.entries[0]!.event_type).toBe(EventType.GoalExecuted);
    expect(ev.entries[0]!.payload).toEqual({
      goal_id: "g-1",
      summary: "done",
      tool_calls: 3,
      memories: 1,
    });
    expect("error" in (ev.entries[0]!.payload as object)).toBe(false);
  });

  it("emits goal_executed with an error field on failure path (spec §9.1 fix)", async () => {
    const ev = makeEventStub();
    const goals = createGoalsController({ motebitId: "mb-1", events: ev.stub });

    await goals.executed({ goal_id: "g-1", error: "tool budget exhausted" });

    expect(ev.entries[0]!.event_type).toBe(EventType.GoalExecuted);
    expect(ev.entries[0]!.payload).toEqual({
      goal_id: "g-1",
      error: "tool budget exhausted",
    });
  });

  it("emits goal_progress, goal_completed, and goal_removed with their respective payloads", async () => {
    const ev = makeEventStub();
    const goals = createGoalsController({ motebitId: "mb-1", events: ev.stub });

    await goals.progress({ goal_id: "g-1", note: "halfway" });
    await goals.completed({ goal_id: "g-1", reason: "done by agent" });
    await goals.removed({ goal_id: "g-1", reason: "yaml_pruned" });

    expect(ev.entries.map((e) => e.event_type)).toEqual([
      EventType.GoalProgress,
      EventType.GoalCompleted,
      EventType.GoalRemoved,
    ]);
    expect(ev.entries[0]!.payload).toEqual({ goal_id: "g-1", note: "halfway" });
    expect(ev.entries[1]!.payload).toEqual({ goal_id: "g-1", reason: "done by agent" });
    expect(ev.entries[2]!.payload).toEqual({ goal_id: "g-1", reason: "yaml_pruned" });
  });
});

describe("createGoalsController — terminal-state guard (spec §3.4)", () => {
  it("drops goal_executed / goal_progress / goal_completed when the goal is already completed", async () => {
    const ev = makeEventStub();
    const status = new Map<string, GoalLifecycleStatus>([["g-done", "completed"]]);
    const warnings: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
    const goals = createGoalsController({
      motebitId: "mb-1",
      events: ev.stub,
      getGoalStatus: (id) => status.get(id) ?? null,
      logger: { warn: (msg, ctx) => warnings.push({ msg, ctx }) },
    });

    await goals.executed({ goal_id: "g-done" });
    await goals.progress({ goal_id: "g-done", note: "ignored" });
    await goals.completed({ goal_id: "g-done", reason: "double-complete" });

    expect(ev.entries).toHaveLength(0);
    expect(warnings).toHaveLength(3);
    expect(warnings.every((w) => w.msg.includes("suppressed"))).toBe(true);
  });

  it("allows goal_removed even when terminal — idempotent defensive removal is spec-permitted", async () => {
    const ev = makeEventStub();
    const goals = createGoalsController({
      motebitId: "mb-1",
      events: ev.stub,
      getGoalStatus: () => "completed",
    });

    await goals.removed({ goal_id: "g-done" });

    expect(ev.entries).toHaveLength(1);
    expect(ev.entries[0]!.event_type).toBe(EventType.GoalRemoved);
  });

  it("emits normally when no status resolver is configured (trust-the-caller mode)", async () => {
    const ev = makeEventStub();
    const goals = createGoalsController({ motebitId: "mb-1", events: ev.stub });

    await goals.executed({ goal_id: "g-1" });
    await goals.completed({ goal_id: "g-1" });

    expect(ev.entries).toHaveLength(2);
  });

  it("emits normally when the goal is active", async () => {
    const ev = makeEventStub();
    const goals = createGoalsController({
      motebitId: "mb-1",
      events: ev.stub,
      getGoalStatus: () => "active",
    });

    await goals.executed({ goal_id: "g-1" });
    await goals.progress({ goal_id: "g-1", note: "still going" });
    await goals.completed({ goal_id: "g-1", reason: "done" });

    expect(ev.entries).toHaveLength(3);
  });
});

describe("createGoalsController — failure tolerance", () => {
  it("logs a warning and swallows event store errors so callers don't crash on log write failures", async () => {
    const warnings: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
    const goals = createGoalsController({
      motebitId: "mb-1",
      events: {
        async append() {},
        async getLatestClock() {
          return 0;
        },
        async appendWithClock(): Promise<never> {
          throw new Error("db write failed");
        },
      },
      logger: { warn: (msg, ctx) => warnings.push({ msg, ctx }) },
    });

    await goals.created({ goal_id: "g-1", prompt: "test" });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.msg).toBe("goal event emission failed");
    expect(warnings[0]!.ctx).toMatchObject({
      event_type: EventType.GoalCreated,
      goal_id: "g-1",
      error: "db write failed",
    });
  });
});
