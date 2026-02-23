import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  MotebitRuntime,
  NullRenderer,
  createInMemoryStorage,
} from "../index";
import type { PlatformAdapters, PlanChunk } from "../index";
import type { StreamingProvider, AgenticChunk } from "@motebit/ai-core";
import type { AIResponse, ContextPack } from "@motebit/sdk";
import { PlanStatus, StepStatus } from "@motebit/sdk";
import { InMemoryPlanStore } from "@motebit/planner";

// === Mock ai-core: override runTurnStreaming, keep everything else real ===

const mockRunTurnStreaming = vi.fn();

vi.mock("@motebit/ai-core", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@motebit/ai-core");
  return {
    ...actual,
    runTurnStreaming: (...args: unknown[]) => mockRunTurnStreaming(...args) as AsyncGenerator<AgenticChunk>,
    // Stub summarization/reflection to avoid side effects
    summarizeConversation: vi.fn().mockResolvedValue(null),
    shouldSummarize: vi.fn().mockReturnValue(false),
    reflect: vi.fn().mockResolvedValue({ insights: [], planAdjustments: [], selfAssessment: "" }),
  };
});

// === Helpers ===

function createMockProvider(planSteps?: Array<{ description: string; prompt: string }>): StreamingProvider {
  const steps = planSteps ?? [
    { description: "Step 1: Research", prompt: "Research the topic" },
    { description: "Step 2: Summarize", prompt: "Summarize findings" },
  ];

  const decompositionResponse: AIResponse = {
    text: JSON.stringify({
      title: "Test plan",
      steps,
    }),
    confidence: 0.9,
    memory_candidates: [],
    state_updates: {},
  };

  const chatResponse: AIResponse = {
    text: "Hello from mock",
    confidence: 0.8,
    memory_candidates: [],
    state_updates: {},
  };

  return {
    model: "mock-model",
    setModel: vi.fn(),
    generate: vi.fn<(ctx: ContextPack) => Promise<AIResponse>>().mockImplementation(async (ctx) => {
      // Decomposition calls include "Decompose this goal" in user_message
      if (ctx.user_message.includes("Decompose this goal")) {
        return decompositionResponse;
      }
      return chatResponse;
    }),
    estimateConfidence: vi.fn<() => Promise<number>>().mockResolvedValue(0.9),
    extractMemoryCandidates: vi.fn<(r: AIResponse) => Promise<never[]>>().mockResolvedValue([]),
    async *generateStream(_ctx: ContextPack) {
      yield { type: "text" as const, text: "mock stream" };
      yield { type: "done" as const, response: chatResponse };
    },
  };
}

function createAdapters(provider?: StreamingProvider, planStore?: InMemoryPlanStore): PlatformAdapters {
  const storage = planStore
    ? { ...createInMemoryStorage(), planStore }
    : createInMemoryStorage();
  return {
    storage,
    renderer: new NullRenderer(),
    ai: provider,
  };
}

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
          attention: 0.5, processing: 0.1, confidence: 0.5,
          affect_valence: 0, affect_arousal: 0, social_distance: 0.5,
          curiosity: 0.5, trust_mode: "full" as never, battery_mode: "normal" as never,
        },
        cues: {
          hover_distance: 0.4, drift_amplitude: 0.02, glow_intensity: 0.3,
          eye_dilation: 0.3, smile_curvature: 0, speaking_activity: 0,
        },
      },
    };
  });
}

async function collectChunks(gen: AsyncGenerator<PlanChunk>): Promise<PlanChunk[]> {
  const chunks: PlanChunk[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

// === Tests ===

describe("MotebitRuntime.executePlan", () => {
  let runtime: MotebitRuntime;
  let provider: StreamingProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = createMockProvider();
    runtime = new MotebitRuntime(
      { motebitId: "plan-test", tickRateHz: 0 },
      createAdapters(provider),
    );
  });

  it("throws without AI provider", async () => {
    const headless = new MotebitRuntime(
      { motebitId: "no-ai" },
      createAdapters(),
    );
    await expect(async () => {
      for await (const _chunk of headless.executePlan("goal-1", "Do something")) { /* consume */ }
    }).rejects.toThrow("AI not initialized");
  });

  it("creates and executes a plan, streaming PlanChunks", async () => {
    setupStreamMock(["research result", "summary result"]);

    const chunks = await collectChunks(runtime.executePlan("goal-1", "Research and summarize"));

    const types = chunks.map((c) => c.type);
    expect(types).toContain("plan_created");
    expect(types).toContain("step_started");
    expect(types).toContain("step_completed");
    expect(types).toContain("plan_completed");
  });

  it("plan_created chunk includes plan and steps", async () => {
    setupStreamMock(["step 1 done", "step 2 done"]);

    const chunks = await collectChunks(runtime.executePlan("goal-2", "Build something"));

    const planCreated = chunks.find((c) => c.type === "plan_created");
    expect(planCreated).toBeDefined();
    if (planCreated && planCreated.type === "plan_created") {
      expect(planCreated.plan.goal_id).toBe("goal-2");
      expect(planCreated.plan.motebit_id).toBe("plan-test");
      expect(planCreated.plan.status).toBe(PlanStatus.Active);
      expect(planCreated.steps.length).toBe(2);
    }
  });

  it("yields step_chunk events with text content", async () => {
    setupStreamMock(["step 1 output", "step 2 output"]);

    const chunks = await collectChunks(runtime.executePlan("goal-3", "Do work"));

    const stepChunks = chunks.filter((c) => c.type === "step_chunk");
    expect(stepChunks.length).toBeGreaterThan(0);
  });

  it("completes plan with correct final status", async () => {
    setupStreamMock(["done 1", "done 2"]);

    const chunks = await collectChunks(runtime.executePlan("goal-4", "Finish task"));

    const planCompleted = chunks.find((c) => c.type === "plan_completed");
    expect(planCompleted).toBeDefined();
    if (planCompleted && planCompleted.type === "plan_completed") {
      expect(planCompleted.plan.status).toBe(PlanStatus.Completed);
    }
  });

  it("passes available tools to decomposition context", async () => {
    // Register a tool before executing a plan
    runtime.getToolRegistry().register(
      { name: "test_tool", description: "Test", inputSchema: {} },
      async () => ({ ok: true }),
    );

    setupStreamMock(["step done"]);

    // Execute plan — provider.generate will receive availableTools via the decomposition prompt
    const chunks = await collectChunks(
      runtime.executePlan("goal-5", "Use tools"),
    );

    // Verify plan was created (decomposition succeeded)
    expect(chunks.some((c) => c.type === "plan_created")).toBe(true);

    // The decomposition prompt should have included tool names
    const generateCalls = (provider.generate as ReturnType<typeof vi.fn>).mock.calls;
    const decompositionCall = generateCalls.find(
      (call: unknown[]) => (call[0] as ContextPack).user_message.includes("Available tools"),
    );
    expect(decompositionCall).toBeDefined();
  });
});

describe("MotebitRuntime.resumePlan", () => {
  let runtime: MotebitRuntime;
  let planStore: InMemoryPlanStore;

  beforeEach(() => {
    vi.clearAllMocks();
    planStore = new InMemoryPlanStore();
    const provider = createMockProvider();
    runtime = new MotebitRuntime(
      { motebitId: "resume-test", tickRateHz: 0 },
      {
        storage: { ...createInMemoryStorage(), planStore },
        renderer: new NullRenderer(),
        ai: provider,
      },
    );
  });

  it("throws without AI provider", async () => {
    const headless = new MotebitRuntime(
      { motebitId: "no-ai" },
      createAdapters(),
    );
    await expect(async () => {
      for await (const _chunk of headless.resumePlan("plan-1")) { /* consume */ }
    }).rejects.toThrow("AI not initialized");
  });

  it("resumes a plan from where it left off", async () => {
    // Set up a plan with one completed step and one pending step
    planStore.savePlan({
      plan_id: "plan-resume",
      goal_id: "goal-1",
      motebit_id: "resume-test",
      title: "Resume test plan",
      status: PlanStatus.Active,
      created_at: Date.now(),
      updated_at: Date.now(),
      current_step_index: 1,
      total_steps: 2,
    });

    planStore.saveStep({
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

    planStore.saveStep({
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

    setupStreamMock(["step 2 result"]);

    const chunks = await collectChunks(runtime.resumePlan("plan-resume"));

    // Should only start one step (the pending one)
    const stepStarteds = chunks.filter((c) => c.type === "step_started");
    expect(stepStarteds).toHaveLength(1);

    const types = chunks.map((c) => c.type);
    expect(types).toContain("step_completed");
    expect(types).toContain("plan_completed");

    // Verify final plan status
    const finalPlan = planStore.getPlan("plan-resume");
    expect(finalPlan!.status).toBe(PlanStatus.Completed);
  });

  it("throws when plan does not exist", async () => {
    await expect(async () => {
      for await (const _chunk of runtime.resumePlan("nonexistent")) { /* consume */ }
    }).rejects.toThrow("Plan not found");
  });

  it("throws when plan is not active", async () => {
    planStore.savePlan({
      plan_id: "plan-completed",
      goal_id: "goal-1",
      motebit_id: "resume-test",
      title: "Completed plan",
      status: PlanStatus.Completed,
      created_at: Date.now(),
      updated_at: Date.now(),
      current_step_index: 0,
      total_steps: 0,
    });

    await expect(async () => {
      for await (const _chunk of runtime.resumePlan("plan-completed")) { /* consume */ }
    }).rejects.toThrow("not active");
  });
});

describe("MotebitRuntime plan execution with custom PlanStoreAdapter", () => {
  it("uses planStore from StorageAdapters when provided", async () => {
    vi.clearAllMocks();
    const planStore = new InMemoryPlanStore();
    const provider = createMockProvider([
      { description: "Single step", prompt: "Do it" },
    ]);

    const runtime = new MotebitRuntime(
      { motebitId: "custom-store", tickRateHz: 0 },
      {
        storage: { ...createInMemoryStorage(), planStore },
        renderer: new NullRenderer(),
        ai: provider,
      },
    );

    setupStreamMock(["done"]);

    const chunks = await collectChunks(runtime.executePlan("goal-1", "Simple task"));

    const planCreated = chunks.find((c) => c.type === "plan_created");
    expect(planCreated).toBeDefined();

    // The plan should be stored in our custom planStore
    if (planCreated && planCreated.type === "plan_created") {
      const storedPlan = planStore.getPlan(planCreated.plan.plan_id);
      expect(storedPlan).not.toBeNull();
    }
  });

  it("defaults to InMemoryPlanStore when not provided", async () => {
    vi.clearAllMocks();
    const provider = createMockProvider([
      { description: "Single step", prompt: "Do it" },
    ]);

    const runtime = new MotebitRuntime(
      { motebitId: "default-store", tickRateHz: 0 },
      createAdapters(provider),
    );

    setupStreamMock(["done"]);

    // Should not throw — uses default InMemoryPlanStore
    const chunks = await collectChunks(runtime.executePlan("goal-1", "Simple task"));
    expect(chunks.some((c) => c.type === "plan_created")).toBe(true);
    expect(chunks.some((c) => c.type === "plan_completed")).toBe(true);
  });
});
