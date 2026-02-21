import { describe, it, expect, vi, beforeEach } from "vitest";
import { PlanStatus, StepStatus } from "@motebit/sdk";
import type { Plan, PlanStep } from "@motebit/sdk";
import type { MotebitLoopDependencies } from "@motebit/ai-core";

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
        stateAfter: {
          attention: 0.5, processing: 0.1, confidence: 0.5,
          affect_valence: 0, affect_arousal: 0, social_distance: 0.5,
          curiosity: 0.5, trust_mode: "full" as never, battery_mode: "normal" as never,
        },
        cues: {
          hover_distance: 0.4, drift_amplitude: 0.02, glow_intensity: 0.3,
          eye_dilation: 0.3, smile_curvature: 0,
        },
      },
    };
  });
}

function makeMockDeps(): MotebitLoopDependencies {
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
        text: JSON.stringify({
          title: "Test plan",
          steps: [
            { description: "Step 1", prompt: "Do step 1" },
            { description: "Step 2", prompt: "Do step 2" },
          ],
        }),
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

describe("PlanEngine", () => {
  let store: InMemoryPlanStore;
  let engine: PlanEngine;

  beforeEach(() => {
    store = new InMemoryPlanStore();
    engine = new PlanEngine(store);
    mockRunTurnStreaming.mockReset();
  });

  it("creates a plan from goal decomposition", async () => {
    const deps = makeMockDeps();
    setupStreamMock(["step 1 result", "step 2 result"]);

    const plan = await engine.createPlan("goal-1", "mote-1", {
      goalPrompt: "Research competitors",
    }, deps);

    expect(plan.plan_id).toBeTruthy();
    expect(plan.goal_id).toBe("goal-1");
    expect(plan.motebit_id).toBe("mote-1");
    expect(plan.status).toBe(PlanStatus.Active);
    expect(plan.total_steps).toBe(2);

    const steps = store.getStepsForPlan(plan.plan_id);
    expect(steps).toHaveLength(2);
    expect(steps[0]!.status).toBe(StepStatus.Pending);
    expect(steps[0]!.ordinal).toBe(0);
    expect(steps[1]!.ordinal).toBe(1);
  });

  it("executes a plan and completes all steps", async () => {
    const deps = makeMockDeps();
    setupStreamMock(["step 1 done", "step 2 done"]);

    const plan = await engine.createPlan("goal-1", "mote-1", {
      goalPrompt: "Do something",
    }, deps);

    const chunks = await collectChunks(engine.executePlan(plan.plan_id, deps));

    const types = chunks.map((c) => c.type);
    expect(types).toContain("plan_created");
    expect(types).toContain("step_started");
    expect(types).toContain("step_completed");
    expect(types).toContain("plan_completed");

    // Check final plan status
    const finalPlan = store.getPlan(plan.plan_id);
    expect(finalPlan!.status).toBe(PlanStatus.Completed);

    // Check all steps completed
    const steps = store.getStepsForPlan(plan.plan_id);
    for (const step of steps) {
      expect(step.status).toBe(StepStatus.Completed);
    }
  });

  it("reports step failures and retries", async () => {
    const plan: Plan = {
      plan_id: "plan-retry",
      goal_id: "goal-1",
      motebit_id: "mote-1",
      title: "Retry test",
      status: PlanStatus.Active,
      created_at: Date.now(),
      updated_at: Date.now(),
      current_step_index: 0,
      total_steps: 1,
    };
    store.savePlan(plan);

    store.saveStep({
      step_id: "step-1",
      plan_id: "plan-retry",
      ordinal: 0,
      description: "Failing step",
      prompt: "This will fail",
      depends_on: [],
      optional: false,
      status: StepStatus.Pending,
      result_summary: null,
      error_message: null,
      tool_calls_made: 0,
      started_at: null,
      completed_at: null,
      retry_count: 0,
    });

    let callCount = 0;
    mockRunTurnStreaming.mockImplementation(async function* () {
      callCount++;
      throw new Error("Provider error");
    });

    const deps = makeMockDeps();
    const chunks = await collectChunks(engine.executePlan(plan.plan_id, deps));

    const types = chunks.map((c) => c.type);
    expect(types).toContain("step_failed");
    expect(types).toContain("plan_failed");

    // Should have retried (default maxStepRetries = 2, so 3 total attempts)
    expect(callCount).toBe(3);

    const finalPlan = store.getPlan(plan.plan_id);
    expect(finalPlan!.status).toBe(PlanStatus.Failed);
  });

  it("skips optional failed steps and continues", async () => {
    const plan: Plan = {
      plan_id: "plan-optional",
      goal_id: "goal-1",
      motebit_id: "mote-1",
      title: "Optional step test",
      status: PlanStatus.Active,
      created_at: Date.now(),
      updated_at: Date.now(),
      current_step_index: 0,
      total_steps: 2,
    };
    store.savePlan(plan);

    store.saveStep({
      step_id: "step-opt",
      plan_id: "plan-optional",
      ordinal: 0,
      description: "Optional failing step",
      prompt: "This might fail",
      depends_on: [],
      optional: true,
      status: StepStatus.Pending,
      result_summary: null,
      error_message: null,
      tool_calls_made: 0,
      started_at: null,
      completed_at: null,
      retry_count: 0,
    });

    store.saveStep({
      step_id: "step-req",
      plan_id: "plan-optional",
      ordinal: 1,
      description: "Required step",
      prompt: "This should work",
      depends_on: [],
      optional: false,
      status: StepStatus.Pending,
      result_summary: null,
      error_message: null,
      tool_calls_made: 0,
      started_at: null,
      completed_at: null,
      retry_count: 0,
    });

    let callCount = 0;
    mockRunTurnStreaming.mockImplementation(async function* () {
      callCount++;
      if (callCount <= 3) {
        throw new Error("Optional step error");
      }
      yield { type: "text" as const, text: "success" };
      yield {
        type: "result" as const,
        result: {
          response: "success",
          memoriesFormed: [],
          stateAfter: {} as never,
          cues: {} as never,
        },
      };
    });

    const deps = makeMockDeps();
    const chunks = await collectChunks(engine.executePlan(plan.plan_id, deps));

    const types = chunks.map((c) => c.type);
    expect(types).toContain("step_failed");
    expect(types).toContain("step_completed");
    expect(types).toContain("plan_completed");

    const finalPlan = store.getPlan(plan.plan_id);
    expect(finalPlan!.status).toBe(PlanStatus.Completed);

    const optStep = store.getStep("step-opt");
    expect(optStep!.status).toBe(StepStatus.Skipped);
  });

  it("resumes a plan from where it left off", async () => {
    const deps = makeMockDeps();
    setupStreamMock(["step 2 done"]);

    const plan: Plan = {
      plan_id: "plan-resume",
      goal_id: "goal-1",
      motebit_id: "mote-1",
      title: "Resume test",
      status: PlanStatus.Active,
      created_at: Date.now(),
      updated_at: Date.now(),
      current_step_index: 1,
      total_steps: 2,
    };
    store.savePlan(plan);

    store.saveStep({
      step_id: "step-done",
      plan_id: "plan-resume",
      ordinal: 0,
      description: "Already done",
      prompt: "Was already done",
      depends_on: [],
      optional: false,
      status: StepStatus.Completed,
      result_summary: "Previously completed",
      error_message: null,
      tool_calls_made: 1,
      started_at: Date.now() - 1000,
      completed_at: Date.now() - 500,
      retry_count: 0,
    });

    store.saveStep({
      step_id: "step-pending",
      plan_id: "plan-resume",
      ordinal: 1,
      description: "Still pending",
      prompt: "Do this next",
      depends_on: [],
      optional: false,
      status: StepStatus.Pending,
      result_summary: null,
      error_message: null,
      tool_calls_made: 0,
      started_at: null,
      completed_at: null,
      retry_count: 0,
    });

    const chunks = await collectChunks(engine.resumePlan(plan.plan_id, deps));

    // Should NOT re-run the completed step
    const stepStarteds = chunks.filter((c) => c.type === "step_started");
    expect(stepStarteds).toHaveLength(1);
    expect((stepStarteds[0] as { step: PlanStep }).step.step_id).toBe("step-pending");

    const types = chunks.map((c) => c.type);
    expect(types).toContain("plan_completed");
  });

  it("tracks isExecuting state", async () => {
    const deps = makeMockDeps();
    setupStreamMock(["done"]);

    const plan: Plan = {
      plan_id: "plan-exec",
      goal_id: "goal-1",
      motebit_id: "mote-1",
      title: "Exec test",
      status: PlanStatus.Active,
      created_at: Date.now(),
      updated_at: Date.now(),
      current_step_index: 0,
      total_steps: 1,
    };
    store.savePlan(plan);

    store.saveStep({
      step_id: "s1",
      plan_id: "plan-exec",
      ordinal: 0,
      description: "Single step",
      prompt: "Do it",
      depends_on: [],
      optional: false,
      status: StepStatus.Pending,
      result_summary: null,
      error_message: null,
      tool_calls_made: 0,
      started_at: null,
      completed_at: null,
      retry_count: 0,
    });

    expect(engine.isExecuting).toBe(false);

    // Collect all chunks — after completion, isExecuting should be false
    await collectChunks(engine.executePlan(plan.plan_id, deps));
    expect(engine.isExecuting).toBe(false);
  });

  it("throws when resuming a non-active plan", async () => {
    const deps = makeMockDeps();

    const plan: Plan = {
      plan_id: "plan-done",
      goal_id: "goal-1",
      motebit_id: "mote-1",
      title: "Done plan",
      status: PlanStatus.Completed,
      created_at: Date.now(),
      updated_at: Date.now(),
      current_step_index: 0,
      total_steps: 0,
    };
    store.savePlan(plan);

    await expect(async () => {
      for await (const _ of engine.resumePlan(plan.plan_id, deps)) {
        /* consume */
      }
    }).rejects.toThrow("not active");
  });
});
