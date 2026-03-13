import { describe, it, expect } from "vitest";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";
import type { PlatformAdapters } from "../index";
import { EventType, PlanStatus, StepStatus } from "@motebit/sdk";
import type { EventLogEntry, MotebitId, EventId, PlanId, GoalId } from "@motebit/sdk";
import { InMemoryPlanStore } from "@motebit/planner";
import { InMemoryAuditSink } from "@motebit/policy";

const MOTEBIT_ID = "replay-test" as MotebitId;
const GOAL_ID = "goal-replay-1" as GoalId;
const PLAN_ID = "plan-replay-1" as PlanId;

function makeEvent(
  id: string,
  eventType: EventType,
  payload: Record<string, unknown>,
  timestamp: number,
): EventLogEntry {
  return {
    event_id: id as EventId,
    motebit_id: MOTEBIT_ID,
    timestamp,
    event_type: eventType,
    payload,
    version_clock: 1,
    tombstoned: false,
  };
}

function createTestAdapters(
  planStore: InMemoryPlanStore,
  auditSink: InMemoryAuditSink,
): PlatformAdapters {
  const storage = {
    ...createInMemoryStorage(),
    planStore,
    toolAuditSink: auditSink,
  };
  return {
    storage,
    renderer: new NullRenderer(),
  };
}

describe("MotebitRuntime.replayGoal", () => {
  it("returns null when no plan exists for the goal", async () => {
    const planStore = new InMemoryPlanStore();
    const auditSink = new InMemoryAuditSink();
    const runtime = new MotebitRuntime(
      { motebitId: MOTEBIT_ID, tickRateHz: 0 },
      createTestAdapters(planStore, auditSink),
    );

    const result = await runtime.replayGoal("nonexistent-goal");
    expect(result).toBeNull();
  });

  it("replays a completed goal execution into a GoalExecutionManifest", async () => {
    const planStore = new InMemoryPlanStore();
    const auditSink = new InMemoryAuditSink();
    const adapters = createTestAdapters(planStore, auditSink);
    const runtime = new MotebitRuntime({ motebitId: MOTEBIT_ID, tickRateHz: 0 }, adapters);

    const now = Date.now();

    // --- 1. Create plan and steps in plan store ---
    planStore.savePlan({
      plan_id: PLAN_ID,
      goal_id: GOAL_ID,
      motebit_id: MOTEBIT_ID,
      title: "Test replay plan",
      status: PlanStatus.Completed,
      created_at: now,
      updated_at: now + 5000,
      current_step_index: 2,
      total_steps: 2,
    });

    planStore.saveStep({
      step_id: "step-1",
      plan_id: PLAN_ID,
      ordinal: 0,
      description: "Research the topic",
      prompt: "Research the topic thoroughly",
      depends_on: [],
      optional: false,
      status: StepStatus.Completed,
      result_summary: "Found relevant information",
      error_message: null,
      tool_calls_made: 1,
      started_at: now + 1000,
      completed_at: now + 2000,
      retry_count: 0,
      updated_at: now + 2000,
    });

    planStore.saveStep({
      step_id: "step-2",
      plan_id: PLAN_ID,
      ordinal: 1,
      description: "Summarize findings",
      prompt: "Summarize the research",
      depends_on: [],
      optional: false,
      status: StepStatus.Completed,
      result_summary: "Summary complete",
      error_message: null,
      tool_calls_made: 0,
      started_at: now + 3000,
      completed_at: now + 4000,
      retry_count: 0,
      updated_at: now + 4000,
    });

    // --- 2. Add events to simulate goal execution ---
    const eventStore = adapters.storage.eventStore;

    await eventStore.append(makeEvent("ev-1", EventType.GoalCreated, { goal_id: GOAL_ID }, now));
    await eventStore.append(
      makeEvent("ev-2", EventType.GoalExecuted, { goal_id: GOAL_ID }, now + 100),
    );
    await eventStore.append(
      makeEvent(
        "ev-3",
        EventType.PlanCreated,
        { plan_id: PLAN_ID, title: "Test replay plan", total_steps: 2 },
        now + 200,
      ),
    );
    await eventStore.append(
      makeEvent(
        "ev-4",
        EventType.PlanStepStarted,
        { plan_id: PLAN_ID, step_id: "step-1", ordinal: 0, description: "Research the topic" },
        now + 1000,
      ),
    );
    await eventStore.append(
      makeEvent(
        "ev-5",
        EventType.PlanStepCompleted,
        { plan_id: PLAN_ID, step_id: "step-1", ordinal: 0, tool_calls_made: 1 },
        now + 2000,
      ),
    );
    await eventStore.append(
      makeEvent(
        "ev-6",
        EventType.PlanStepStarted,
        { plan_id: PLAN_ID, step_id: "step-2", ordinal: 1, description: "Summarize findings" },
        now + 3000,
      ),
    );
    await eventStore.append(
      makeEvent(
        "ev-7",
        EventType.PlanStepCompleted,
        { plan_id: PLAN_ID, step_id: "step-2", ordinal: 1, tool_calls_made: 0 },
        now + 4000,
      ),
    );
    await eventStore.append(
      makeEvent("ev-8", EventType.PlanCompleted, { plan_id: PLAN_ID }, now + 4500),
    );
    await eventStore.append(
      makeEvent("ev-9", EventType.GoalCompleted, { goal_id: GOAL_ID }, now + 5000),
    );

    // --- 3. Add tool audit entries with matching runId ---
    auditSink.append({
      turnId: "turn-1",
      runId: PLAN_ID,
      callId: "call-1",
      tool: "web_search",
      args: { query: "motebit architecture" },
      decision: { allowed: true, requiresApproval: false },
      result: { ok: true, durationMs: 350 },
      timestamp: now + 1500,
    });

    // --- 4. Call replayGoal and verify the manifest ---
    const manifest = await runtime.replayGoal(GOAL_ID);

    expect(manifest).not.toBeNull();
    if (!manifest) return; // type narrowing

    // Spec version
    expect(manifest.spec).toBe("motebit/execution-ledger@1.0");

    // Identity fields
    expect(manifest.motebit_id).toBe(MOTEBIT_ID);
    expect(manifest.goal_id).toBe(GOAL_ID);
    expect(manifest.plan_id).toBe(PLAN_ID);

    // Status
    expect(manifest.status).toBe("completed");

    // Timing
    expect(manifest.started_at).toBeLessThanOrEqual(manifest.completed_at);

    // Timeline contains expected entry types in chronological order
    const timelineTypes = manifest.timeline.map((e) => e.type);
    expect(timelineTypes).toContain("goal_started");
    expect(timelineTypes).toContain("plan_created");
    expect(timelineTypes).toContain("step_started");
    expect(timelineTypes).toContain("step_completed");
    expect(timelineTypes).toContain("tool_invoked");
    expect(timelineTypes).toContain("tool_result");
    expect(timelineTypes).toContain("plan_completed");
    expect(timelineTypes).toContain("goal_completed");

    // Timeline is sorted by timestamp
    for (let i = 1; i < manifest.timeline.length; i++) {
      expect(manifest.timeline[i]!.timestamp).toBeGreaterThanOrEqual(
        manifest.timeline[i - 1]!.timestamp,
      );
    }

    // goal_started comes first, goal_completed comes last
    expect(timelineTypes[0]).toBe("goal_started");
    expect(timelineTypes[timelineTypes.length - 1]).toBe("goal_completed");

    // Steps array is populated
    expect(manifest.steps).toHaveLength(2);
    const [step0, step1] = manifest.steps;
    expect(step0!.step_id).toBe("step-1");
    expect(step0!.ordinal).toBe(0);
    expect(step0!.description).toBe("Research the topic");
    expect(step0!.status).toBe(StepStatus.Completed);
    expect(step0!.tool_calls).toBe(1);
    expect(step0!.tools_used).toContain("web_search");

    expect(step1!.step_id).toBe("step-2");
    expect(step1!.ordinal).toBe(1);
    expect(step1!.description).toBe("Summarize findings");
    expect(step1!.tools_used).toHaveLength(0);

    // content_hash is a 64-char hex string (SHA-256)
    expect(manifest.content_hash).toMatch(/^[0-9a-f]{64}$/);

    // delegation_receipts is empty (no delegations in this test)
    expect(manifest.delegation_receipts).toEqual([]);
  });
});
