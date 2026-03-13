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

    const { plan } = await engine.createPlan(
      "goal-1",
      "mote-1",
      {
        goalPrompt: "Research competitors",
      },
      deps,
    );

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

    const { plan } = await engine.createPlan(
      "goal-1",
      "mote-1",
      {
        goalPrompt: "Do something",
      },
      deps,
    );

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
      updated_at: Date.now(),
    });

    let callCount = 0;
    mockRunTurnStreaming.mockImplementation(async function* () {
      callCount++;
      yield { type: "text" as const, text: "" };
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
      updated_at: Date.now(),
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
      updated_at: Date.now(),
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
          memoriesRetrieved: [],
          stateAfter: {} as never,
          cues: {} as never,
          iterations: 1,
          toolCallsSucceeded: 0,
          toolCallsBlocked: 0,
          toolCallsFailed: 0,
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
      updated_at: Date.now(),
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
      updated_at: Date.now(),
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
      updated_at: Date.now(),
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
      for await (const _chunk of engine.resumePlan(plan.plan_id, deps)) {
        /* consume */
      }
    }).rejects.toThrow("not active");
  });

  describe("reflection", () => {
    it("emits reflection chunk after plan completion", async () => {
      const deps = makeMockDeps();

      // The provider.generate mock returns plan decomposition JSON by default.
      // For reflection, it will also be called — we need to make it return
      // reflection JSON on subsequent calls.
      let generateCallCount = 0;
      (
        deps.provider as unknown as { generate: ReturnType<typeof vi.fn> }
      ).generate.mockImplementation(async () => {
        generateCallCount++;
        if (generateCallCount === 1) {
          // First call: decomposition
          return {
            text: JSON.stringify({
              title: "Test plan",
              steps: [{ description: "Single step", prompt: "Do it" }],
            }),
            confidence: 0.9,
            memory_candidates: [],
            state_updates: {},
          };
        }
        // Subsequent calls: reflection
        return {
          text: JSON.stringify({
            summary: "Plan completed successfully.",
            memoryCandidates: ["Learned something useful"],
          }),
          confidence: 0.8,
          memory_candidates: [],
          state_updates: {},
        };
      });

      setupStreamMock(["step done"]);

      const { plan } = await engine.createPlan(
        "goal-1",
        "mote-1",
        {
          goalPrompt: "Do something",
        },
        deps,
      );

      const chunks = await collectChunks(engine.executePlan(plan.plan_id, deps));

      const types = chunks.map((c) => c.type);
      expect(types).toContain("plan_completed");
      expect(types).toContain("reflection");

      // Verify reflection comes after plan_completed
      const completedIdx = types.indexOf("plan_completed");
      const reflectionIdx = types.indexOf("reflection");
      expect(reflectionIdx).toBeGreaterThan(completedIdx);

      // Verify reflection content
      const reflectionChunk = chunks.find((c) => c.type === "reflection") as {
        type: "reflection";
        result: { summary: string; memoryCandidates: string[] };
      };
      expect(reflectionChunk.result.summary).toBe("Plan completed successfully.");
      expect(reflectionChunk.result.memoryCandidates).toEqual(["Learned something useful"]);
    });

    it("skips reflection when enableReflection is false", async () => {
      store = new InMemoryPlanStore();
      engine = new PlanEngine(store, { enableReflection: false });
      mockRunTurnStreaming.mockReset();

      const deps = makeMockDeps();
      setupStreamMock(["step done"]);

      const { plan } = await engine.createPlan(
        "goal-1",
        "mote-1",
        {
          goalPrompt: "Do something",
        },
        deps,
      );

      const chunks = await collectChunks(engine.executePlan(plan.plan_id, deps));

      const types = chunks.map((c) => c.type);
      expect(types).toContain("plan_completed");
      expect(types).not.toContain("reflection");
    });

    it("does not fail the plan if reflection provider throws", async () => {
      const deps = makeMockDeps();

      let generateCallCount = 0;
      (
        deps.provider as unknown as { generate: ReturnType<typeof vi.fn> }
      ).generate.mockImplementation(async () => {
        generateCallCount++;
        if (generateCallCount === 1) {
          return {
            text: JSON.stringify({
              title: "Test plan",
              steps: [{ description: "Single step", prompt: "Do it" }],
            }),
            confidence: 0.9,
            memory_candidates: [],
            state_updates: {},
          };
        }
        // Reflection call throws — reflectOnPlan catches and returns fallback
        throw new Error("Reflection provider error");
      });

      setupStreamMock(["step done"]);

      const { plan } = await engine.createPlan(
        "goal-1",
        "mote-1",
        {
          goalPrompt: "Do something",
        },
        deps,
      );

      const chunks = await collectChunks(engine.executePlan(plan.plan_id, deps));

      const types = chunks.map((c) => c.type);
      expect(types).toContain("plan_completed");
      // reflectOnPlan catches internally and returns fallback, so reflection chunk still emitted
      expect(types).toContain("reflection");

      // Verify it's the fallback content
      const reflectionChunk = chunks.find((c) => c.type === "reflection") as {
        type: "reflection";
        result: { summary: string; memoryCandidates: string[] };
      };
      expect(reflectionChunk.result.summary).toContain("Test plan");
      expect(reflectionChunk.result.memoryCandidates).toEqual([]);

      // Plan should still be completed
      const finalPlan = store.getPlan(plan.plan_id);
      expect(finalPlan!.status).toBe(PlanStatus.Completed);
    });
  });

  describe("adaptive re-planning", () => {
    it("retries with a new plan when a required step fails and ctx is provided", async () => {
      const deps = makeMockDeps();

      // Make provider.generate return different plans on successive calls
      let generateCallCount = 0;
      (
        deps.provider as unknown as { generate: ReturnType<typeof vi.fn> }
      ).generate.mockImplementation(async () => {
        generateCallCount++;
        if (generateCallCount === 1) {
          // First plan: has a step that will fail
          return {
            text: JSON.stringify({
              title: "Original plan",
              steps: [{ description: "Failing step", prompt: "Will fail" }],
            }),
            confidence: 0.9,
            memory_candidates: [],
            state_updates: {},
          };
        }
        if (generateCallCount === 2) {
          // Retry plan: simpler approach
          return {
            text: JSON.stringify({
              title: "Retry plan",
              steps: [{ description: "Alternative step", prompt: "Try differently" }],
            }),
            confidence: 0.9,
            memory_candidates: [],
            state_updates: {},
          };
        }
        // Reflection call
        return {
          text: JSON.stringify({
            summary: "Retry plan succeeded.",
            memoryCandidates: ["Alternative approach works better"],
          }),
          confidence: 0.8,
          memory_candidates: [],
          state_updates: {},
        };
      });

      // First step fails, second (retry plan) succeeds
      let streamCallCount = 0;
      mockRunTurnStreaming.mockImplementation(async function* () {
        streamCallCount++;
        if (streamCallCount <= 3) {
          // First 3 calls fail (original step + 2 retries)
          throw new Error("Step failed");
        }
        // Retry plan step succeeds
        yield { type: "text" as const, text: "retry success" };
        yield {
          type: "result" as const,
          result: {
            response: "retry success",
            memoriesFormed: [],
            memoriesRetrieved: [],
            stateAfter: {} as never,
            cues: {} as never,
            iterations: 1,
            toolCallsSucceeded: 0,
            toolCallsBlocked: 0,
            toolCallsFailed: 0,
          },
        };
      });

      const ctx = { goalPrompt: "Do something", availableTools: ["tool_a"] };
      const { plan } = await engine.createPlan("goal-1", "mote-1", ctx, deps);

      const chunks = await collectChunks(engine.executePlan(plan.plan_id, deps, ctx));

      const types = chunks.map((c) => c.type);
      expect(types).toContain("step_failed");
      expect(types).toContain("plan_retrying");
      expect(types).toContain("plan_completed");

      // Verify plan_retrying chunk has both plans
      const retryChunk = chunks.find((c) => c.type === "plan_retrying") as {
        type: "plan_retrying";
        failedPlan: Plan;
        newPlan: Plan;
      };
      expect(retryChunk.failedPlan.title).toBe("Original plan");
      expect(retryChunk.newPlan.title).toBe("Retry plan");

      // Original plan should be failed
      expect(retryChunk.failedPlan.status).toBe(PlanStatus.Failed);

      // New plan should be completed
      const newPlan = store.getPlan(retryChunk.newPlan.plan_id);
      expect(newPlan!.status).toBe(PlanStatus.Completed);
    });

    it("does not re-plan when no ctx is provided", async () => {
      const deps = makeMockDeps();

      const plan: Plan = {
        plan_id: "plan-no-ctx",
        goal_id: "goal-1",
        motebit_id: "mote-1",
        title: "No context plan",
        status: PlanStatus.Active,
        created_at: Date.now(),
        updated_at: Date.now(),
        current_step_index: 0,
        total_steps: 1,
      };
      store.savePlan(plan);

      store.saveStep({
        step_id: "step-fail",
        plan_id: "plan-no-ctx",
        ordinal: 0,
        description: "Failing step",
        prompt: "Will fail",
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
        yield { type: "text" as const, text: "" };
        throw new Error("Step error");
      });

      // No ctx parameter — should not attempt re-planning
      const chunks = await collectChunks(engine.executePlan(plan.plan_id, deps));

      const types = chunks.map((c) => c.type);
      expect(types).toContain("plan_failed");
      expect(types).not.toContain("plan_retrying");
    });

    it("respects maxPlanRetries limit", async () => {
      store = new InMemoryPlanStore();
      engine = new PlanEngine(store, { maxPlanRetries: 0 });
      mockRunTurnStreaming.mockReset();

      const deps = makeMockDeps();

      const plan: Plan = {
        plan_id: "plan-no-retry",
        goal_id: "goal-1",
        motebit_id: "mote-1",
        title: "No retry plan",
        status: PlanStatus.Active,
        created_at: Date.now(),
        updated_at: Date.now(),
        current_step_index: 0,
        total_steps: 1,
      };
      store.savePlan(plan);

      store.saveStep({
        step_id: "step-fail",
        plan_id: "plan-no-retry",
        ordinal: 0,
        description: "Failing step",
        prompt: "Will fail",
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
        yield { type: "text" as const, text: "" };
        throw new Error("Step error");
      });

      const ctx = { goalPrompt: "Do something" };
      const chunks = await collectChunks(engine.executePlan(plan.plan_id, deps, ctx));

      const types = chunks.map((c) => c.type);
      expect(types).toContain("plan_failed");
      expect(types).not.toContain("plan_retrying");
    });

    it("emits plan_failed for retry plan when retry also fails", async () => {
      const deps = makeMockDeps();

      // First generate: original plan, second: retry plan (decomposePlan catches errors)
      let generateCallCount = 0;
      (
        deps.provider as unknown as { generate: ReturnType<typeof vi.fn> }
      ).generate.mockImplementation(async () => {
        generateCallCount++;
        if (generateCallCount === 1) {
          return {
            text: JSON.stringify({
              title: "Original plan",
              steps: [{ description: "Failing step", prompt: "Will fail" }],
            }),
            confidence: 0.9,
            memory_candidates: [],
            state_updates: {},
          };
        }
        // Subsequent generate calls throw — decomposePlan catches and returns fallback plan
        throw new Error("Decomposition failed");
      });

      // All step executions fail
      mockRunTurnStreaming.mockImplementation(async function* () {
        yield { type: "text" as const, text: "" };
        throw new Error("Step error");
      });

      const ctx = { goalPrompt: "Do something" };
      const { plan } = await engine.createPlan("goal-1", "mote-1", ctx, deps);

      const chunks = await collectChunks(engine.executePlan(plan.plan_id, deps, ctx));

      const types = chunks.map((c) => c.type);
      // decomposePlan catches and returns fallback, so re-plan succeeds at creation
      expect(types).toContain("plan_retrying");
      // But the retry plan also fails (runTurnStreaming throws)
      expect(types).toContain("plan_failed");

      // Should not attempt a second re-plan (maxPlanRetries=1 exhausted)
      const retryCount = types.filter((t) => t === "plan_retrying").length;
      expect(retryCount).toBe(1);
    });
  });

  describe("collaborative plan execution", () => {
    it("runSteps skips steps assigned to other agents", async () => {
      store = new InMemoryPlanStore();
      engine = new PlanEngine(store, { localMotebitId: "local-mote", enableReflection: false });
      mockRunTurnStreaming.mockReset();
      setupStreamMock(["step 0 done", "step 1 done"]);

      const plan: Plan = {
        plan_id: "plan-collab",
        goal_id: "goal-collab",
        motebit_id: "local-mote",
        title: "Collaborative plan",
        status: PlanStatus.Active,
        created_at: Date.now(),
        updated_at: Date.now(),
        current_step_index: 0,
        total_steps: 3,
      };
      store.savePlan(plan);

      // Step 0: assigned to local agent
      store.saveStep({
        step_id: "step-local-0",
        plan_id: "plan-collab",
        ordinal: 0,
        description: "Local step 0",
        prompt: "Do local step 0",
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
        assigned_motebit_id: "local-mote" as never,
      });

      // Step 1: assigned to local agent
      store.saveStep({
        step_id: "step-local-1",
        plan_id: "plan-collab",
        ordinal: 1,
        description: "Local step 1",
        prompt: "Do local step 1",
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
        assigned_motebit_id: "local-mote" as never,
      });

      // Step 2: assigned to a remote agent (last, so no dependency issues)
      store.saveStep({
        step_id: "step-remote-2",
        plan_id: "plan-collab",
        ordinal: 2,
        description: "Remote step 2",
        prompt: "Do remote step 2",
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
        assigned_motebit_id: "remote-agent" as never,
      });

      const deps = makeMockDeps();
      const chunks = await collectChunks(engine.executePlan(plan.plan_id, deps));

      const types = chunks.map((c) => c.type);
      expect(types).toContain("plan_completed");

      // Steps 0 and 1 should have been executed (started + completed)
      const stepStarteds = chunks.filter((c) => c.type === "step_started") as Array<{
        type: "step_started";
        step: PlanStep;
      }>;
      const startedIds = stepStarteds.map((c) => c.step.step_id);
      expect(startedIds).toContain("step-local-0");
      expect(startedIds).toContain("step-local-1");
      expect(startedIds).not.toContain("step-remote-2");

      // Local steps should be completed
      const step0 = store.getStep("step-local-0");
      expect(step0!.status).toBe(StepStatus.Completed);
      const step1 = store.getStep("step-local-1");
      expect(step1!.status).toBe(StepStatus.Completed);

      // Remote step should still be pending — it was skipped by runSteps
      const step2 = store.getStep("step-remote-2");
      expect(step2!.status).toBe(StepStatus.Pending);
    });

    it("runSteps executes steps with no assigned_motebit_id (unassigned steps)", async () => {
      store = new InMemoryPlanStore();
      engine = new PlanEngine(store, { localMotebitId: "local-mote", enableReflection: false });
      mockRunTurnStreaming.mockReset();
      setupStreamMock(["unassigned done"]);

      const plan: Plan = {
        plan_id: "plan-unassigned",
        goal_id: "goal-u",
        motebit_id: "local-mote",
        title: "Unassigned plan",
        status: PlanStatus.Active,
        created_at: Date.now(),
        updated_at: Date.now(),
        current_step_index: 0,
        total_steps: 1,
      };
      store.savePlan(plan);

      // Step with no assigned_motebit_id — should still be executed
      store.saveStep({
        step_id: "step-unassigned",
        plan_id: "plan-unassigned",
        ordinal: 0,
        description: "Unassigned step",
        prompt: "Do unassigned step",
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

      const deps = makeMockDeps();
      const chunks = await collectChunks(engine.executePlan(plan.plan_id, deps));

      const types = chunks.map((c) => c.type);
      expect(types).toContain("step_completed");
      expect(types).toContain("plan_completed");

      const step = store.getStep("step-unassigned");
      expect(step!.status).toBe(StepStatus.Completed);
    });

    it("executeCollaborativeSteps only runs local steps and calls postStepResult", async () => {
      store = new InMemoryPlanStore();
      const mockPostStepResult = vi.fn().mockResolvedValue(undefined);
      const collaborativeAdapter = {
        submitProposal: vi.fn(),
        postStepResult: mockPostStepResult,
        onProposalResponse: vi.fn().mockReturnValue(() => {}),
        onStepResult: vi.fn().mockReturnValue(() => {}),
      };
      engine = new PlanEngine(store, {
        localMotebitId: "local-mote",
        collaborativeAdapter,
        enableReflection: false,
      });
      mockRunTurnStreaming.mockReset();
      setupStreamMock(["local step result"]);

      const plan: Plan = {
        plan_id: "plan-collab-exec",
        goal_id: "goal-collab-exec",
        motebit_id: "local-mote",
        title: "Collaborative exec plan",
        status: PlanStatus.Active,
        created_at: Date.now(),
        updated_at: Date.now(),
        current_step_index: 0,
        total_steps: 2,
        proposal_id: "proposal-123" as never,
      };
      store.savePlan(plan);

      // Step assigned to local agent
      store.saveStep({
        step_id: "step-mine",
        plan_id: "plan-collab-exec",
        ordinal: 0,
        description: "My step",
        prompt: "Do my step",
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
        assigned_motebit_id: "local-mote" as never,
      });

      // Step assigned to another agent
      store.saveStep({
        step_id: "step-theirs",
        plan_id: "plan-collab-exec",
        ordinal: 1,
        description: "Their step",
        prompt: "Do their step",
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
        assigned_motebit_id: "other-mote" as never,
      });

      const deps = makeMockDeps();
      const allSteps = store.getStepsForPlan("plan-collab-exec");
      const chunks = await collectChunks(
        engine.executeCollaborativeSteps(plan, allSteps, "local-mote", deps),
      );

      // Only the local step should have been started and completed
      const stepStarteds = chunks.filter((c) => c.type === "step_started") as Array<{
        type: "step_started";
        step: PlanStep;
      }>;
      expect(stepStarteds).toHaveLength(1);
      expect(stepStarteds[0]!.step.step_id).toBe("step-mine");

      const stepCompleteds = chunks.filter((c) => c.type === "step_completed") as Array<{
        type: "step_completed";
        step: PlanStep;
      }>;
      expect(stepCompleteds).toHaveLength(1);
      expect(stepCompleteds[0]!.step.step_id).toBe("step-mine");

      // The remote step should still be pending
      const theirStep = store.getStep("step-theirs");
      expect(theirStep!.status).toBe(StepStatus.Pending);

      // postStepResult should have been called for the local step
      expect(mockPostStepResult).toHaveBeenCalledTimes(1);
      expect(mockPostStepResult).toHaveBeenCalledWith("proposal-123", "step-mine", {
        status: "completed",
        result_summary: "local step result",
      });
    });

    it("executeCollaborativeSteps posts failure to relay when step fails", async () => {
      store = new InMemoryPlanStore();
      const mockPostStepResult = vi.fn().mockResolvedValue(undefined);
      const collaborativeAdapter = {
        submitProposal: vi.fn(),
        postStepResult: mockPostStepResult,
        onProposalResponse: vi.fn().mockReturnValue(() => {}),
        onStepResult: vi.fn().mockReturnValue(() => {}),
      };
      engine = new PlanEngine(store, {
        localMotebitId: "local-mote",
        collaborativeAdapter,
        enableReflection: false,
      });
      mockRunTurnStreaming.mockReset();

      // Make step execution fail
      mockRunTurnStreaming.mockImplementation(async function* () {
        yield { type: "text" as const, text: "" };
        throw new Error("Step execution error");
      });

      const plan: Plan = {
        plan_id: "plan-collab-fail",
        goal_id: "goal-collab-fail",
        motebit_id: "local-mote",
        title: "Collaborative fail plan",
        status: PlanStatus.Active,
        created_at: Date.now(),
        updated_at: Date.now(),
        current_step_index: 0,
        total_steps: 1,
        proposal_id: "proposal-456" as never,
      };
      store.savePlan(plan);

      store.saveStep({
        step_id: "step-fail",
        plan_id: "plan-collab-fail",
        ordinal: 0,
        description: "Failing step",
        prompt: "Will fail",
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
        assigned_motebit_id: "local-mote" as never,
      });

      const deps = makeMockDeps();
      const allSteps = store.getStepsForPlan("plan-collab-fail");
      const chunks = await collectChunks(
        engine.executeCollaborativeSteps(plan, allSteps, "local-mote", deps),
      );

      const types = chunks.map((c) => c.type);
      expect(types).toContain("step_failed");

      // Step should be marked as failed in store
      const failedStep = store.getStep("step-fail");
      expect(failedStep!.status).toBe(StepStatus.Failed);
      expect(failedStep!.error_message).toBe("Step execution error");

      // postStepResult should have been called with failure status
      expect(mockPostStepResult).toHaveBeenCalledTimes(1);
      expect(mockPostStepResult).toHaveBeenCalledWith("proposal-456", "step-fail", {
        status: "failed",
        result_summary: "Step execution error",
      });
    });

    it("executeCollaborativeSteps does not call postStepResult without proposal_id", async () => {
      store = new InMemoryPlanStore();
      const mockPostStepResult = vi.fn().mockResolvedValue(undefined);
      const collaborativeAdapter = {
        submitProposal: vi.fn(),
        postStepResult: mockPostStepResult,
        onProposalResponse: vi.fn().mockReturnValue(() => {}),
        onStepResult: vi.fn().mockReturnValue(() => {}),
      };
      engine = new PlanEngine(store, {
        localMotebitId: "local-mote",
        collaborativeAdapter,
        enableReflection: false,
      });
      mockRunTurnStreaming.mockReset();
      setupStreamMock(["step done"]);

      // Plan without proposal_id
      const plan: Plan = {
        plan_id: "plan-no-proposal",
        goal_id: "goal-np",
        motebit_id: "local-mote",
        title: "No proposal plan",
        status: PlanStatus.Active,
        created_at: Date.now(),
        updated_at: Date.now(),
        current_step_index: 0,
        total_steps: 1,
      };
      store.savePlan(plan);

      store.saveStep({
        step_id: "step-np",
        plan_id: "plan-no-proposal",
        ordinal: 0,
        description: "Step no proposal",
        prompt: "Do step",
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
        assigned_motebit_id: "local-mote" as never,
      });

      const deps = makeMockDeps();
      const allSteps = store.getStepsForPlan("plan-no-proposal");
      const chunks = await collectChunks(
        engine.executeCollaborativeSteps(plan, allSteps, "local-mote", deps),
      );

      const types = chunks.map((c) => c.type);
      expect(types).toContain("step_completed");

      // postStepResult should NOT have been called (no proposal_id)
      expect(mockPostStepResult).not.toHaveBeenCalled();
    });
  });
});
