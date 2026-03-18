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

  it("includes routing_choice in step summary for delegated steps", async () => {
    const planStore = new InMemoryPlanStore();
    const auditSink = new InMemoryAuditSink();
    const adapters = createTestAdapters(planStore, auditSink);
    const runtime = new MotebitRuntime({ motebitId: MOTEBIT_ID, tickRateHz: 0 }, adapters);

    const now = Date.now();
    const delegatedPlanId = "plan-delegated-1" as PlanId;
    const delegatedGoalId = "goal-delegated-1" as GoalId;
    const delegationTaskId = "task-delegated-abc";

    const routingChoice = {
      selected_agent: "agent-worker-42",
      composite_score: 0.92,
      sub_scores: {
        trust: 0.95,
        success_rate: 0.88,
        latency: 0.75,
        price_efficiency: 0.9,
        capability_match: 1.0,
        availability: 0.9,
      },
      routing_paths: [["agent-origin", "agent-worker-42"]],
      alternatives_considered: 5,
    };

    // Create plan with a delegated step
    planStore.savePlan({
      plan_id: delegatedPlanId,
      goal_id: delegatedGoalId,
      motebit_id: MOTEBIT_ID,
      title: "Delegation routing test",
      status: PlanStatus.Completed,
      created_at: now,
      updated_at: now + 5000,
      current_step_index: 1,
      total_steps: 1,
    });

    planStore.saveStep({
      step_id: "step-d1",
      plan_id: delegatedPlanId,
      ordinal: 0,
      description: "Remote capability step",
      prompt: "Execute remote task",
      depends_on: [],
      optional: false,
      status: StepStatus.Completed,
      result_summary: "Completed by remote agent",
      error_message: null,
      tool_calls_made: 0,
      started_at: now + 1000,
      completed_at: now + 3000,
      retry_count: 0,
      updated_at: now + 3000,
      delegation_task_id: delegationTaskId,
    });

    // Emit events including PlanStepDelegated with routing_choice
    const eventStore = adapters.storage.eventStore;

    await eventStore.append(
      makeEvent("ev-d1", EventType.GoalCreated, { goal_id: delegatedGoalId }, now),
    );
    await eventStore.append(
      makeEvent("ev-d2", EventType.GoalExecuted, { goal_id: delegatedGoalId }, now + 100),
    );
    await eventStore.append(
      makeEvent(
        "ev-d3",
        EventType.PlanCreated,
        { plan_id: delegatedPlanId, title: "Delegation routing test", total_steps: 1 },
        now + 200,
      ),
    );
    await eventStore.append(
      makeEvent(
        "ev-d4",
        EventType.PlanStepStarted,
        {
          plan_id: delegatedPlanId,
          step_id: "step-d1",
          ordinal: 0,
          description: "Remote capability step",
        },
        now + 1000,
      ),
    );
    await eventStore.append(
      makeEvent(
        "ev-d5",
        EventType.PlanStepDelegated,
        {
          plan_id: delegatedPlanId,
          step_id: "step-d1",
          ordinal: 0,
          task_id: delegationTaskId,
          routing_choice: routingChoice,
        },
        now + 1500,
      ),
    );
    await eventStore.append(
      makeEvent(
        "ev-d6",
        EventType.PlanStepCompleted,
        { plan_id: delegatedPlanId, step_id: "step-d1", ordinal: 0, tool_calls_made: 0 },
        now + 3000,
      ),
    );
    await eventStore.append(
      makeEvent("ev-d7", EventType.PlanCompleted, { plan_id: delegatedPlanId }, now + 3500),
    );
    await eventStore.append(
      makeEvent("ev-d8", EventType.GoalCompleted, { goal_id: delegatedGoalId }, now + 4000),
    );

    // Add a receipt event for the delegation
    await eventStore.append(
      makeEvent(
        "ev-d9",
        EventType.AgentTaskCompleted,
        {
          task_id: delegationTaskId,
          status: "completed",
          tools_used: ["web_search"],
          receipt: {
            task_id: delegationTaskId,
            motebit_id: "agent-worker-42",
            device_id: "dev-42",
            completed_at: now + 2500,
            status: "completed",
            signature: "sig-abc123def456",
          },
        },
        now + 2500,
      ),
    );

    // Replay and verify
    const manifest = await runtime.replayGoal(delegatedGoalId);
    expect(manifest).not.toBeNull();
    if (!manifest) return;

    // Verify spec and identity
    expect(manifest.spec).toBe("motebit/execution-ledger@1.0");
    expect(manifest.goal_id).toBe(delegatedGoalId);

    // Verify the timeline includes step_delegated with routing_choice
    const delegatedTimelineEntry = manifest.timeline.find((e) => e.type === "step_delegated");
    expect(delegatedTimelineEntry).toBeDefined();
    expect(delegatedTimelineEntry!.payload.routing_choice).toEqual(routingChoice);

    // Verify step summary includes routing_choice in delegation field
    expect(manifest.steps).toHaveLength(1);
    const step = manifest.steps[0]!;
    expect(step.delegation).toBeDefined();
    expect(step.delegation!.task_id).toBe(delegationTaskId);
    expect(step.delegation!.routing_choice).toEqual(routingChoice);
    expect(step.delegation!.routing_choice!.selected_agent).toBe("agent-worker-42");
    expect(step.delegation!.routing_choice!.composite_score).toBe(0.92);
    expect(step.delegation!.routing_choice!.alternatives_considered).toBe(5);
    expect(step.delegation!.routing_choice!.routing_paths).toEqual([
      ["agent-origin", "agent-worker-42"],
    ]);

    // Verify routing_choice is covered by the content hash (it's in the timeline)
    expect(manifest.content_hash).toMatch(/^[0-9a-f]{64}$/);

    // Verify the routing_choice is present in the timeline JSON (affects content hash)
    const timelineJson = manifest.timeline.map((e) => JSON.stringify(e)).join("");
    expect(timelineJson).toContain("agent-worker-42");
    expect(timelineJson).toContain("composite_score");

    // Verify delegation_receipts are populated
    expect(manifest.delegation_receipts).toHaveLength(1);
    expect(manifest.delegation_receipts[0]!.task_id).toBe(delegationTaskId);
    expect(manifest.delegation_receipts[0]!.motebit_id).toBe("agent-worker-42");
  });

  it("routing_choice in timeline is covered by content_hash signature", async () => {
    const planStore = new InMemoryPlanStore();
    const auditSink = new InMemoryAuditSink();
    const adapters = createTestAdapters(planStore, auditSink);
    const runtime = new MotebitRuntime({ motebitId: MOTEBIT_ID, tickRateHz: 0 }, adapters);

    const now = Date.now();
    const pId = "plan-hash-test" as PlanId;
    const gId = "goal-hash-test" as GoalId;

    planStore.savePlan({
      plan_id: pId,
      goal_id: gId,
      motebit_id: MOTEBIT_ID,
      title: "Hash test",
      status: PlanStatus.Completed,
      created_at: now,
      updated_at: now + 3000,
      current_step_index: 1,
      total_steps: 1,
    });

    planStore.saveStep({
      step_id: "step-h1",
      plan_id: pId,
      ordinal: 0,
      description: "Delegated step",
      prompt: "Do it",
      depends_on: [],
      optional: false,
      status: StepStatus.Completed,
      result_summary: "Done",
      error_message: null,
      tool_calls_made: 0,
      started_at: now + 500,
      completed_at: now + 1500,
      retry_count: 0,
      updated_at: now + 1500,
      delegation_task_id: "task-hash-1",
    });

    const eventStore = adapters.storage.eventStore;

    await eventStore.append(makeEvent("eh-1", EventType.GoalCreated, { goal_id: gId }, now));
    await eventStore.append(
      makeEvent(
        "eh-2",
        EventType.PlanCreated,
        { plan_id: pId, title: "Hash test", total_steps: 1 },
        now + 100,
      ),
    );
    await eventStore.append(
      makeEvent(
        "eh-3",
        EventType.PlanStepStarted,
        { plan_id: pId, step_id: "step-h1", ordinal: 0, description: "Delegated step" },
        now + 500,
      ),
    );
    await eventStore.append(
      makeEvent(
        "eh-4",
        EventType.PlanStepDelegated,
        {
          plan_id: pId,
          step_id: "step-h1",
          ordinal: 0,
          task_id: "task-hash-1",
          routing_choice: {
            selected_agent: "agent-x",
            composite_score: 0.5,
            sub_scores: {
              trust: 0.5,
              success_rate: 0.5,
              latency: 0.5,
              price_efficiency: 0.5,
              capability_match: 0.5,
              availability: 0.5,
            },
            routing_paths: [["a", "agent-x"]],
            alternatives_considered: 2,
          },
        },
        now + 600,
      ),
    );
    await eventStore.append(
      makeEvent(
        "eh-5",
        EventType.PlanStepCompleted,
        { plan_id: pId, step_id: "step-h1", ordinal: 0, tool_calls_made: 0 },
        now + 1500,
      ),
    );
    await eventStore.append(
      makeEvent("eh-6", EventType.PlanCompleted, { plan_id: pId }, now + 2000),
    );
    await eventStore.append(
      makeEvent("eh-7", EventType.GoalCompleted, { goal_id: gId }, now + 2500),
    );

    const manifest = await runtime.replayGoal(gId);
    expect(manifest).not.toBeNull();
    if (!manifest) return;

    // Verify content hash is computed (it covers routing_choice in the timeline)
    const hash1 = manifest.content_hash;
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);

    // Independently recompute the hash to verify it matches
    const { computeTimelineHash } = await import("../execution-ledger.js");
    const recomputedHash = await computeTimelineHash(manifest.timeline);
    expect(recomputedHash).toBe(hash1);
  });
});
