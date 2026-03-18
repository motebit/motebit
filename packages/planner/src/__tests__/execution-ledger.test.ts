import { describe, it, expect, vi, beforeEach } from "vitest";
import { PlanStatus, StepStatus, DeviceCapability } from "@motebit/sdk";
import type {
  Plan,
  PlanStep,
  DelegatedStepResult,
  ExecutionReceipt,
  MotebitId,
  DeviceId,
} from "@motebit/sdk";
import type { MotebitLoopDependencies } from "@motebit/ai-core";
import type { StepDelegationAdapter } from "../plan-engine.js";

// Mock runTurnStreaming at the module level
vi.mock("@motebit/ai-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@motebit/ai-core")>();
  return {
    ...actual,
    runTurnStreaming: vi.fn(),
  };
});

import { runTurnStreaming } from "@motebit/ai-core";
import { PlanEngine } from "../plan-engine.js";
import { InMemoryPlanStore } from "../types.js";
import type { PlanChunk } from "../plan-engine.js";

const mockRunTurnStreaming = vi.mocked(runTurnStreaming);

function setupStreamMock(responses: string[]): void {
  let callIndex = 0;
  mockRunTurnStreaming.mockImplementation(async function* () {
    const response = responses[callIndex] ?? "default response";
    callIndex++;
    yield { type: "text" as const, text: response };
    yield {
      type: "result" as const,
      result: {
        response,
        memoriesFormed: [],
        memoriesRetrieved: [],
        stateAfter: {
          attention: 0.5,
          processing: 0.1,
          confidence: 0.5,
          affect_valence: 0,
          affect_arousal: 0,
          social_distance: 0.5,
          curiosity: 0.5,
          trust_mode: "full" as never,
          battery_mode: "normal" as never,
        },
        cues: {
          hover_distance: 0.4,
          drift_amplitude: 0.02,
          glow_intensity: 0.3,
          eye_dilation: 0.3,
          smile_curvature: 0,
          speaking_activity: 0,
        },
        iterations: 1,
        toolCallsSucceeded: 0,
        toolCallsBlocked: 0,
        toolCallsFailed: 0,
      },
    };
  });
}

function setupStreamMockWithTools(steps: Array<{ response: string; tools?: string[] }>): void {
  let callIndex = 0;
  mockRunTurnStreaming.mockImplementation(async function* () {
    const step = steps[callIndex] ?? { response: "default" };
    callIndex++;

    // Emit tool events if specified
    if (step.tools) {
      for (const toolName of step.tools) {
        yield { type: "tool_status" as const, name: toolName, status: "calling" as const };
        yield {
          type: "tool_status" as const,
          name: toolName,
          status: "done" as const,
          result: "ok",
        };
      }
    }

    yield { type: "text" as const, text: step.response };
    yield {
      type: "result" as const,
      result: {
        response: step.response,
        memoriesFormed: [],
        memoriesRetrieved: [],
        stateAfter: {
          attention: 0.5,
          processing: 0.1,
          confidence: 0.5,
          affect_valence: 0,
          affect_arousal: 0,
          social_distance: 0.5,
          curiosity: 0.5,
          trust_mode: "full" as never,
          battery_mode: "normal" as never,
        },
        cues: {
          hover_distance: 0.4,
          drift_amplitude: 0.02,
          glow_intensity: 0.3,
          eye_dilation: 0.3,
          smile_curvature: 0,
          speaking_activity: 0,
        },
        iterations: 1,
        toolCallsSucceeded: step.tools?.length ?? 0,
        toolCallsBlocked: 0,
        toolCallsFailed: 0,
      },
    };
  });
}

function makeMockDeps(stepCount = 2): MotebitLoopDependencies {
  const steps = Array.from({ length: stepCount }, (_, i) => ({
    description: `Step ${i + 1}`,
    prompt: `Do step ${i + 1}`,
  }));
  return {
    motebitId: "test-motebit",
    eventStore: {} as never,
    memoryGraph: {} as never,
    stateEngine: { getState: vi.fn() } as never,
    behaviorEngine: { compute: vi.fn() } as never,
    provider: {
      model: "test-model",
      setModel: vi.fn(),
      generate: vi.fn().mockResolvedValue({
        text: JSON.stringify({ title: "Test plan", steps }),
        confidence: 0.9,
        memory_candidates: [],
        state_updates: {},
      }),
      generateStream: vi.fn(),
      estimateConfidence: vi.fn().mockResolvedValue(0.9),
      extractMemoryCandidates: vi.fn().mockResolvedValue([]),
    } as never,
  };
}

async function collectChunks(gen: AsyncGenerator<PlanChunk>): Promise<PlanChunk[]> {
  const chunks: PlanChunk[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

describe("PlanEngine execution ledger timeline", () => {
  let store: InMemoryPlanStore;
  let engine: PlanEngine;

  beforeEach(() => {
    store = new InMemoryPlanStore();
    engine = new PlanEngine(store);
    mockRunTurnStreaming.mockReset();
  });

  it("records timeline events for a successful execution", async () => {
    const deps = makeMockDeps(2);
    setupStreamMock(["step 1 done", "step 2 done"]);

    const { plan } = await engine.createPlan(
      "goal-1",
      "mote-1",
      { goalPrompt: "Do something" },
      deps,
    );

    await collectChunks(engine.executePlan(plan.plan_id, deps));
    const timeline = engine.takeTimeline();

    // Verify event types in order
    const types = timeline.map((e) => e.type);
    expect(types[0]).toBe("plan_created");

    // Should have step_started/step_completed pairs for each step
    const stepStarted = timeline.filter((e) => e.type === "step_started");
    const stepCompleted = timeline.filter((e) => e.type === "step_completed");
    expect(stepStarted).toHaveLength(2);
    expect(stepCompleted).toHaveLength(2);

    // Plan should be completed
    const planCompleted = timeline.filter((e) => e.type === "plan_completed");
    expect(planCompleted).toHaveLength(1);
    expect(planCompleted[0]!.payload.plan_id).toBe(plan.plan_id);

    // All events should have timestamps
    for (const entry of timeline) {
      expect(entry.timestamp).toBeGreaterThan(0);
      expect(entry.type).toBeTruthy();
      expect(entry.payload).toBeDefined();
    }
  });

  it("records step metadata in timeline payloads", async () => {
    const deps = makeMockDeps(1);
    setupStreamMock(["result"]);

    const { plan } = await engine.createPlan("goal-1", "mote-1", { goalPrompt: "Test" }, deps);

    await collectChunks(engine.executePlan(plan.plan_id, deps));
    const timeline = engine.takeTimeline();

    const planCreated = timeline.find((e) => e.type === "plan_created")!;
    expect(planCreated.payload.plan_id).toBe(plan.plan_id);
    expect(planCreated.payload.title).toBe("Test plan");
    expect(planCreated.payload.total_steps).toBe(1);

    const stepStarted = timeline.find((e) => e.type === "step_started")!;
    expect(stepStarted.payload.plan_id).toBe(plan.plan_id);
    expect(stepStarted.payload.ordinal).toBe(0);
    expect(stepStarted.payload.description).toBe("Step 1");

    const stepCompleted = timeline.find((e) => e.type === "step_completed")!;
    expect(stepCompleted.payload.plan_id).toBe(plan.plan_id);
    expect(stepCompleted.payload.ordinal).toBe(0);
    expect(stepCompleted.payload.tool_calls_made).toBe(0);
  });

  it("records tool invocation events from stream", async () => {
    const deps = makeMockDeps(1);
    setupStreamMockWithTools([
      { response: "searched and read", tools: ["web_search", "read_url"] },
    ]);

    const { plan } = await engine.createPlan("goal-1", "mote-1", { goalPrompt: "Search" }, deps);

    await collectChunks(engine.executePlan(plan.plan_id, deps));
    const timeline = engine.takeTimeline();

    const toolInvoked = timeline.filter((e) => e.type === "tool_invoked");
    const toolResult = timeline.filter((e) => e.type === "tool_result");

    expect(toolInvoked).toHaveLength(2);
    expect(toolResult).toHaveLength(2);

    expect(toolInvoked[0]!.payload.tool).toBe("web_search");
    expect(toolInvoked[1]!.payload.tool).toBe("read_url");

    // Tool args should be hashed (empty string placeholder since audit data not available)
    expect(toolInvoked[0]!.payload.args_hash).toBe("");
  });

  it("records plan_failed event when a required step fails", async () => {
    // Set up a plan with 1 step, then make the step throw
    const plan: Plan = {
      plan_id: "plan-fail",
      goal_id: "goal-fail",
      motebit_id: "mote-1",
      title: "Fail test",
      status: PlanStatus.Active,
      created_at: Date.now(),
      updated_at: Date.now(),
      current_step_index: 0,
      total_steps: 1,
    };
    store.savePlan(plan);
    store.saveStep({
      step_id: "step-fail-1",
      plan_id: "plan-fail",
      ordinal: 0,
      description: "Failing step",
      prompt: "Fail",
      depends_on: [],
      optional: false,
      status: StepStatus.Pending,
      result_summary: null,
      error_message: null,
      tool_calls_made: 0,
      started_at: null,
      completed_at: null,
      retry_count: 0,
      updated_at: Date.now(),
    });

    mockRunTurnStreaming.mockImplementation(async function* () {
      throw new Error("Step execution error");
    });

    const deps = makeMockDeps(1);
    await collectChunks(engine.executePlan("plan-fail", deps));
    const timeline = engine.takeTimeline();

    const types = timeline.map((e) => e.type);
    expect(types).toContain("plan_created");
    expect(types).toContain("step_started");
    expect(types).toContain("step_failed");
    expect(types).toContain("plan_failed");

    const stepFailed = timeline.find((e) => e.type === "step_failed")!;
    expect(stepFailed.payload.error).toBe("Step execution error");

    const planFailed = timeline.find((e) => e.type === "plan_failed")!;
    expect(planFailed.payload.plan_id).toBe("plan-fail");
    expect(planFailed.payload.reason).toContain("Step execution error");
  });

  it("resets timeline between executions", async () => {
    const deps = makeMockDeps(1);
    setupStreamMock(["done"]);

    const { plan } = await engine.createPlan("goal-1", "mote-1", { goalPrompt: "Test" }, deps);

    await collectChunks(engine.executePlan(plan.plan_id, deps));
    const timeline1 = engine.takeTimeline();
    expect(timeline1.length).toBeGreaterThan(0);

    // Second takeTimeline should return empty
    const timeline2 = engine.takeTimeline();
    expect(timeline2).toHaveLength(0);
  });

  it("records tool_result ok as boolean", async () => {
    const deps = makeMockDeps(1);
    setupStreamMockWithTools([{ response: "done", tools: ["my_tool"] }]);

    const { plan } = await engine.createPlan("goal-1", "mote-1", { goalPrompt: "Tool test" }, deps);

    await collectChunks(engine.executePlan(plan.plan_id, deps));
    const timeline = engine.takeTimeline();

    const toolResult = timeline.find((e) => e.type === "tool_result")!;
    expect(typeof toolResult.payload.ok).toBe("boolean");
    expect(toolResult.payload.ok).toBe(true);
    expect(typeof toolResult.payload.duration_ms).toBe("number");
  });

  it("timeline events are in chronological order", async () => {
    const deps = makeMockDeps(2);
    setupStreamMock(["step 1", "step 2"]);

    const { plan } = await engine.createPlan(
      "goal-1",
      "mote-1",
      { goalPrompt: "Order test" },
      deps,
    );

    await collectChunks(engine.executePlan(plan.plan_id, deps));
    const timeline = engine.takeTimeline();

    for (let i = 1; i < timeline.length; i++) {
      expect(timeline[i]!.timestamp).toBeGreaterThanOrEqual(timeline[i - 1]!.timestamp);
    }
  });

  it("records routing_choice in step_delegated timeline event and chunk", async () => {
    const store = new InMemoryPlanStore();
    const routingChoice = {
      selected_agent: "agent-worker-1",
      composite_score: 0.87,
      sub_scores: {
        trust: 0.9,
        success_rate: 0.95,
        latency: 0.7,
        price_efficiency: 0.8,
        capability_match: 1.0,
        availability: 0.85,
      },
      routing_paths: [["agent-origin", "agent-worker-1"]],
      alternatives_considered: 3,
    };

    const mockAdapter: StepDelegationAdapter = {
      delegateStep: vi.fn().mockImplementation(async (step: PlanStep) => {
        return {
          step_id: step.step_id,
          task_id: "delegated-task-route",
          receipt: {
            task_id: "delegated-task-route",
            motebit_id: "agent-worker-1" as MotebitId,
            device_id: "dev-1" as DeviceId,
            submitted_at: Date.now(),
            completed_at: Date.now(),
            status: "completed",
            result: "Routed result",
            tools_used: ["web_search"],
            memories_formed: 0,
            prompt_hash: "abc",
            result_hash: "def",
            signature: "sig",
          } satisfies ExecutionReceipt,
          result_text: "Routed result",
          routing_choice: routingChoice,
        } satisfies DelegatedStepResult;
      }),
    };

    const engine = new PlanEngine(store, {
      localCapabilities: [DeviceCapability.HttpMcp],
      delegationAdapter: mockAdapter,
    });

    const deps = makeMockDeps(1);
    // Override to produce a step requiring delegation
    (deps.provider as unknown as { generate: ReturnType<typeof vi.fn> }).generate = vi
      .fn()
      .mockResolvedValue({
        text: JSON.stringify({
          title: "Routing test plan",
          steps: [
            {
              description: "Remote step",
              prompt: "do remote thing",
              required_capabilities: ["stdio_mcp"],
            },
          ],
        }),
      });

    const { plan } = await engine.createPlan("goal-route", "mote-1", { goalPrompt: "Route" }, deps);

    const chunks: PlanChunk[] = [];
    for await (const chunk of engine.executePlan(plan.plan_id, deps)) {
      chunks.push(chunk);
    }

    // 1. Verify the step_delegated chunk carries routing_choice
    const delegatedChunks = chunks.filter((c) => c.type === "step_delegated");
    expect(delegatedChunks).toHaveLength(1);
    const delegatedChunk = delegatedChunks[0]!;
    expect(delegatedChunk.type).toBe("step_delegated");
    if (delegatedChunk.type === "step_delegated") {
      expect(delegatedChunk.routing_choice).toEqual(routingChoice);
    }

    // 2. Verify the timeline event includes routing_choice
    const timeline = engine.takeTimeline();
    const stepDelegatedEvent = timeline.find((e) => e.type === "step_delegated");
    expect(stepDelegatedEvent).toBeDefined();
    expect(stepDelegatedEvent!.payload.routing_choice).toEqual(routingChoice);

    // 3. Verify routing_choice is included in canonical JSON (affects content hash)
    const canonical = JSON.stringify(stepDelegatedEvent);
    expect(canonical).toContain("agent-worker-1");
    expect(canonical).toContain("composite_score");
  });

  it("step_delegated timeline event omits routing_choice when not provided", async () => {
    const store = new InMemoryPlanStore();

    const mockAdapter: StepDelegationAdapter = {
      delegateStep: vi.fn().mockImplementation(async (step: PlanStep) => {
        return {
          step_id: step.step_id,
          task_id: "delegated-task-no-route",
          receipt: {
            task_id: "delegated-task-no-route",
            motebit_id: "agent-basic" as MotebitId,
            device_id: "dev-1" as DeviceId,
            submitted_at: Date.now(),
            completed_at: Date.now(),
            status: "completed",
            result: "Basic result",
            tools_used: [],
            memories_formed: 0,
            prompt_hash: "abc",
            result_hash: "def",
            signature: "sig",
          } satisfies ExecutionReceipt,
          result_text: "Basic result",
          // No routing_choice
        } satisfies DelegatedStepResult;
      }),
    };

    const engine = new PlanEngine(store, {
      localCapabilities: [DeviceCapability.HttpMcp],
      delegationAdapter: mockAdapter,
    });

    const deps = makeMockDeps(1);
    (deps.provider as unknown as { generate: ReturnType<typeof vi.fn> }).generate = vi
      .fn()
      .mockResolvedValue({
        text: JSON.stringify({
          title: "No-route plan",
          steps: [
            {
              description: "Remote step",
              prompt: "do thing",
              required_capabilities: ["stdio_mcp"],
            },
          ],
        }),
      });

    const { plan } = await engine.createPlan(
      "goal-no-route",
      "mote-1",
      { goalPrompt: "Test" },
      deps,
    );

    for await (const _chunk of engine.executePlan(plan.plan_id, deps)) {
      // consume
    }

    const timeline = engine.takeTimeline();
    const stepDelegatedEvent = timeline.find((e) => e.type === "step_delegated");
    expect(stepDelegatedEvent).toBeDefined();
    // routing_choice should be undefined (not present)
    expect(stepDelegatedEvent!.payload.routing_choice).toBeUndefined();
  });
});
