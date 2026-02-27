import { describe, it, expect, beforeEach, vi } from "vitest";
import { GoalScheduler } from "../scheduler.js";
import { createMotebitDatabase, type MotebitDatabase, type Goal } from "@motebit/persistence";
import { EventType, RiskLevel, SensitivityLevel } from "@motebit/sdk";
import type { ToolDefinition, ToolHandler, MemoryNode } from "@motebit/sdk";
import type { MotebitRuntime, StreamChunk } from "@motebit/runtime";
import type { PlanEngine, PlanStoreAdapter } from "@motebit/planner";
import { InMemoryPlanStore } from "@motebit/planner";

// Mock embedText — avoid loading HF pipeline in tests
vi.mock("@motebit/memory-graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@motebit/memory-graph")>();
  return {
    ...actual,
    embedText: vi.fn().mockResolvedValue(new Array(384).fill(0.1)),
  };
});

interface MockMemoryGraph {
  formMemory: ReturnType<typeof vi.fn>;
  retrieve: ReturnType<typeof vi.fn>;
}

interface MockRuntimeResult {
  runtime: MotebitRuntime;
  registeredTools: Map<string, ToolHandler>;
  eventsAppended: Array<{ event_type: string; payload: Record<string, unknown> }>;
  memoryGraph: MockMemoryGraph;
}

function createMockRuntime(opts: {
  yieldApproval?: boolean;
  onStream?: (registeredTools: Map<string, ToolHandler>) => Promise<void>;
  streamText?: string;
  relevantMemories?: MemoryNode[];
} = {}): MockRuntimeResult {
  let _hasPending = false;
  const registeredTools = new Map<string, ToolHandler>();
  const eventsAppended: Array<{ event_type: string; payload: Record<string, unknown> }> = [];

  const memoryGraph: MockMemoryGraph = {
    formMemory: vi.fn().mockResolvedValue({
      node_id: "mem-1",
      motebit_id: "mote-test",
      content: "test",
      embedding: [],
      confidence: 0.7,
      sensitivity: SensitivityLevel.None,
      created_at: Date.now(),
      last_accessed: Date.now(),
      half_life: 604800000,
      tombstoned: false,
      pinned: false,
    }),
    retrieve: vi.fn().mockResolvedValue(opts.relevantMemories ?? []),
  };

  const runtime = {
    get hasPendingApproval() {
      return _hasPending;
    },
    async *sendMessageStreaming(_text: string): AsyncGenerator<StreamChunk> {
      if (opts.onStream) {
        await opts.onStream(registeredTools);
      }
      yield { type: "text" as const, text: opts.streamText ?? "goal done" };
      yield { type: "result" as const, result: { memoriesFormed: [] } as any };
    },
    async *resumeAfterApproval(_approved: boolean): AsyncGenerator<StreamChunk> {
      _hasPending = false;
      yield { type: "result" as const, result: { memoriesFormed: [] } as any };
    },
    events: {
      getLatestClock: vi.fn().mockResolvedValue(0),
      append: vi.fn().mockImplementation(async (entry: any) => {
        eventsAppended.push({ event_type: entry.event_type, payload: entry.payload });
      }),
    },
    memory: memoryGraph,
    getToolRegistry: vi.fn().mockReturnValue({
      register: vi.fn().mockImplementation((def: ToolDefinition, handler: ToolHandler) => {
        registeredTools.set(def.name, handler);
      }),
      list: vi.fn().mockReturnValue([
        { name: "shell_exec", description: "Execute shell command" },
      ]),
    }),
    getLoopDeps: vi.fn().mockReturnValue({
      motebitId: "mote-test",
      eventStore: {} as never,
      memoryGraph: {} as never,
      stateEngine: { getState: vi.fn() } as never,
      behaviorEngine: { compute: vi.fn() } as never,
      provider: {
        model: "test-model",
        setModel: vi.fn(),
        generate: vi.fn().mockResolvedValue({
          text: "{}",
          confidence: 0.9,
          memory_candidates: [],
          state_updates: {},
        }),
        generateStream: vi.fn(),
        estimateConfidence: vi.fn().mockResolvedValue(0.9),
        extractMemoryCandidates: vi.fn().mockResolvedValue([]),
      },
    }),
    stop: vi.fn(),
    housekeeping: vi.fn().mockResolvedValue(undefined),
  } as unknown as MotebitRuntime;

  return { runtime, registeredTools, eventsAppended, memoryGraph };
}

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    goal_id: "goal-001",
    motebit_id: "mote-test",
    prompt: "check system health",
    interval_ms: 0, // always due
    last_run_at: null,
    enabled: true,
    created_at: Date.now(),
    mode: "recurring",
    status: "active",
    parent_goal_id: null,
    max_retries: 3,
    consecutive_failures: 0,
      wall_clock_ms: null,
      project_id: null,
    ...overrides,
  };
}

describe("GoalScheduler — learning loop", () => {
  let moteDb: MotebitDatabase;

  beforeEach(() => {
    moteDb = createMotebitDatabase(":memory:");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  describe("goal outcome → memory", () => {
    it("forms a memory from completed goal outcome", async () => {
      const { runtime, memoryGraph } = createMockRuntime({ streamText: "System health check passed. All services running." });
      moteDb.goalStore.add(makeGoal());

      const scheduler = new GoalScheduler(
        runtime, moteDb.goalStore, moteDb.approvalStore, moteDb.goalOutcomeStore,
        "mote-test", RiskLevel.R3_EXECUTE,
      );
      scheduler.registerGoalTools();
      await scheduler.tickOnce();

      // Goal should have completed
      const outcomes = moteDb.goalOutcomeStore.listForGoal("goal-001");
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]!.status).toBe("completed");

      // Memory should be formed with [goal_outcome] prefix
      expect(memoryGraph.formMemory).toHaveBeenCalled();
      const call = memoryGraph.formMemory.mock.calls[0]!;
      expect(call[0].content).toContain("[goal_outcome]");
      expect(call[0].content).toContain("check system health");
      expect(call[0].content).toContain("System health check passed");
      expect(call[0].confidence).toBe(0.6);
      expect(call[0].sensitivity).toBe(SensitivityLevel.None);
    });

    it("does not form memory when response is empty", async () => {
      const { runtime, memoryGraph } = createMockRuntime({ streamText: "" });
      moteDb.goalStore.add(makeGoal());

      const scheduler = new GoalScheduler(
        runtime, moteDb.goalStore, moteDb.approvalStore, moteDb.goalOutcomeStore,
        "mote-test", RiskLevel.R3_EXECUTE,
      );
      scheduler.registerGoalTools();
      await scheduler.tickOnce();

      // formGoalOutcomeMemory returns early when responseText is empty
      expect(memoryGraph.formMemory).not.toHaveBeenCalled();
    });
  });

  describe("plan reflection → memory", () => {
    it("persists memory candidates from plan reflection chunks", async () => {
      const { runtime, memoryGraph, eventsAppended } = createMockRuntime();
      moteDb.goalStore.add(makeGoal());

      // Create a mock PlanEngine that yields a reflection chunk
      const planStore = new InMemoryPlanStore();
      const mockPlanEngine = {
        isExecuting: false,
        createPlan: vi.fn().mockImplementation(async () => {
          const plan = {
            plan_id: "plan-1",
            goal_id: "goal-001",
            motebit_id: "mote-test",
            title: "Health check plan",
            status: "active",
            created_at: Date.now(),
            updated_at: Date.now(),
            current_step_index: 0,
            total_steps: 1,
          };
          return { plan };
        }),
        executePlan: vi.fn().mockImplementation(async function* () {
          yield {
            type: "plan_created",
            plan: { plan_id: "plan-1", title: "Health check plan" },
            steps: [{ step_id: "s1", ordinal: 0, description: "Check health" }],
          };
          yield {
            type: "step_started",
            step: { plan_id: "plan-1", step_id: "s1", ordinal: 0, description: "Check health" },
          };
          yield {
            type: "step_chunk",
            chunk: { type: "text", text: "All healthy" },
          };
          yield {
            type: "step_completed",
            step: { plan_id: "plan-1", step_id: "s1", ordinal: 0, tool_calls_made: 0 },
          };
          yield {
            type: "plan_completed",
            plan: { plan_id: "plan-1" },
          };
          yield {
            type: "reflection",
            result: {
              summary: "System health verified successfully.",
              memoryCandidates: [
                "All API endpoints respond under 200ms",
                "Database connection pool is healthy",
              ],
            },
          };
        }),
        resumePlan: vi.fn(),
      } as unknown as PlanEngine;

      const scheduler = new GoalScheduler(
        runtime, moteDb.goalStore, moteDb.approvalStore, moteDb.goalOutcomeStore,
        "mote-test", RiskLevel.R3_EXECUTE,
      );
      scheduler.registerGoalTools();
      scheduler.setPlanEngine(mockPlanEngine, planStore as unknown as PlanStoreAdapter);
      await scheduler.tickOnce();

      // 2 reflection memories + 1 goal outcome memory = 3 total
      expect(memoryGraph.formMemory).toHaveBeenCalledTimes(3);

      // First two: plan reflection learning memories
      expect(memoryGraph.formMemory.mock.calls[0]![0]).toMatchObject({
        content: "[goal_learning] All API endpoints respond under 200ms",
        confidence: 0.7,
        sensitivity: SensitivityLevel.None,
      });
      expect(memoryGraph.formMemory.mock.calls[1]![0]).toMatchObject({
        content: "[goal_learning] Database connection pool is healthy",
        confidence: 0.7,
      });

      // Third: goal outcome memory
      expect(memoryGraph.formMemory.mock.calls[2]![0]).toMatchObject({
        content: expect.stringContaining("[goal_outcome]"),
        confidence: 0.6,
      });

      // ReflectionCompleted event should be logged
      const reflectionEvents = eventsAppended.filter(
        (e) => e.event_type === EventType.ReflectionCompleted,
      );
      expect(reflectionEvents).toHaveLength(1);
      expect(reflectionEvents[0]!.payload).toMatchObject({
        source: "plan_reflection",
        summary: "System health verified successfully.",
        memories_stored: 2,
      });
    });

    it("handles empty memory candidates gracefully", async () => {
      const { runtime, memoryGraph } = createMockRuntime();
      moteDb.goalStore.add(makeGoal());

      const planStore = new InMemoryPlanStore();
      const mockPlanEngine = {
        isExecuting: false,
        createPlan: vi.fn().mockResolvedValue({
          plan: {
            plan_id: "plan-2", goal_id: "goal-001", motebit_id: "mote-test",
            title: "Empty reflection", status: "active",
            created_at: Date.now(), updated_at: Date.now(),
            current_step_index: 0, total_steps: 1,
          },
        }),
        executePlan: vi.fn().mockImplementation(async function* () {
          yield { type: "plan_created", plan: { plan_id: "plan-2", title: "Empty" }, steps: [] };
          yield { type: "plan_completed", plan: { plan_id: "plan-2" } };
          yield {
            type: "reflection",
            result: { summary: "Nothing to report.", memoryCandidates: [] },
          };
        }),
        resumePlan: vi.fn(),
      } as unknown as PlanEngine;

      const scheduler = new GoalScheduler(
        runtime, moteDb.goalStore, moteDb.approvalStore, moteDb.goalOutcomeStore,
        "mote-test", RiskLevel.R3_EXECUTE,
      );
      scheduler.registerGoalTools();
      scheduler.setPlanEngine(mockPlanEngine, planStore as unknown as PlanStoreAdapter);
      await scheduler.tickOnce();

      // No memories should be formed
      expect(memoryGraph.formMemory).not.toHaveBeenCalled();
    });
  });

  describe("memory-informed planning", () => {
    it("retrieves relevant memories and passes them to plan decomposition", async () => {
      const relevantMemories: MemoryNode[] = [
        {
          node_id: "n1", motebit_id: "mote-test",
          content: "[goal_learning] Health check takes ~5 seconds",
          embedding: [], confidence: 0.7, sensitivity: "none" as any,
          created_at: Date.now(), last_accessed: Date.now(),
          half_life: 604800000, tombstoned: false, pinned: false,
        },
        {
          node_id: "n2", motebit_id: "mote-test",
          content: "[goal_outcome] Previous health check found slow DB queries",
          embedding: [], confidence: 0.6, sensitivity: "none" as any,
          created_at: Date.now(), last_accessed: Date.now(),
          half_life: 604800000, tombstoned: false, pinned: false,
        },
      ];

      const { runtime, memoryGraph } = createMockRuntime({ relevantMemories });
      moteDb.goalStore.add(makeGoal());

      const planStore = new InMemoryPlanStore();
      const createPlanSpy = vi.fn().mockResolvedValue({
        plan: {
          plan_id: "plan-3", goal_id: "goal-001", motebit_id: "mote-test",
          title: "Informed plan", status: "active",
          created_at: Date.now(), updated_at: Date.now(),
          current_step_index: 0, total_steps: 1,
        },
      });

      const mockPlanEngine = {
        isExecuting: false,
        createPlan: createPlanSpy,
        executePlan: vi.fn().mockImplementation(async function* () {
          yield { type: "plan_created", plan: { plan_id: "plan-3", title: "Informed" }, steps: [] };
          yield { type: "plan_completed", plan: { plan_id: "plan-3" } };
        }),
        resumePlan: vi.fn(),
      } as unknown as PlanEngine;

      const scheduler = new GoalScheduler(
        runtime, moteDb.goalStore, moteDb.approvalStore, moteDb.goalOutcomeStore,
        "mote-test", RiskLevel.R3_EXECUTE,
      );
      scheduler.registerGoalTools();
      scheduler.setPlanEngine(mockPlanEngine, planStore as unknown as PlanStoreAdapter);
      await scheduler.tickOnce();

      // memory.retrieve should have been called with the goal prompt
      expect(memoryGraph.retrieve).toHaveBeenCalledTimes(1);

      // createPlan should have been called with relevantMemories
      expect(createPlanSpy).toHaveBeenCalledTimes(1);
      const decompositionCtx = createPlanSpy.mock.calls[0]![2];
      expect(decompositionCtx.relevantMemories).toEqual([
        "[goal_learning] Health check takes ~5 seconds",
        "[goal_outcome] Previous health check found slow DB queries",
      ]);
    });

    it("passes undefined relevantMemories when memory retrieval returns empty", async () => {
      const { runtime } = createMockRuntime({ relevantMemories: [] });
      moteDb.goalStore.add(makeGoal());

      const planStore = new InMemoryPlanStore();
      const createPlanSpy = vi.fn().mockResolvedValue({
        plan: {
          plan_id: "plan-4", goal_id: "goal-001", motebit_id: "mote-test",
          title: "No memories", status: "active",
          created_at: Date.now(), updated_at: Date.now(),
          current_step_index: 0, total_steps: 1,
        },
      });

      const mockPlanEngine = {
        isExecuting: false,
        createPlan: createPlanSpy,
        executePlan: vi.fn().mockImplementation(async function* () {
          yield { type: "plan_created", plan: { plan_id: "plan-4", title: "Empty" }, steps: [] };
          yield { type: "plan_completed", plan: { plan_id: "plan-4" } };
        }),
        resumePlan: vi.fn(),
      } as unknown as PlanEngine;

      const scheduler = new GoalScheduler(
        runtime, moteDb.goalStore, moteDb.approvalStore, moteDb.goalOutcomeStore,
        "mote-test", RiskLevel.R3_EXECUTE,
      );
      scheduler.registerGoalTools();
      scheduler.setPlanEngine(mockPlanEngine, planStore as unknown as PlanStoreAdapter);
      await scheduler.tickOnce();

      const decompositionCtx = createPlanSpy.mock.calls[0]![2];
      expect(decompositionCtx.relevantMemories).toBeUndefined();
    });

    it("gracefully handles memory retrieval failure", async () => {
      const { runtime, memoryGraph } = createMockRuntime();
      memoryGraph.retrieve.mockRejectedValue(new Error("Embedding pipeline failed"));
      moteDb.goalStore.add(makeGoal());

      const planStore = new InMemoryPlanStore();
      const createPlanSpy = vi.fn().mockResolvedValue({
        plan: {
          plan_id: "plan-5", goal_id: "goal-001", motebit_id: "mote-test",
          title: "Fallback plan", status: "active",
          created_at: Date.now(), updated_at: Date.now(),
          current_step_index: 0, total_steps: 1,
        },
      });

      const mockPlanEngine = {
        isExecuting: false,
        createPlan: createPlanSpy,
        executePlan: vi.fn().mockImplementation(async function* () {
          yield { type: "plan_created", plan: { plan_id: "plan-5", title: "Fallback" }, steps: [] };
          yield { type: "plan_completed", plan: { plan_id: "plan-5" } };
        }),
        resumePlan: vi.fn(),
      } as unknown as PlanEngine;

      const scheduler = new GoalScheduler(
        runtime, moteDb.goalStore, moteDb.approvalStore, moteDb.goalOutcomeStore,
        "mote-test", RiskLevel.R3_EXECUTE,
      );
      scheduler.registerGoalTools();
      scheduler.setPlanEngine(mockPlanEngine, planStore as unknown as PlanStoreAdapter);

      // Should not throw — retrieveRelevantMemories catches and returns []
      await scheduler.tickOnce();

      // createPlan should still have been called, with no memories
      expect(createPlanSpy).toHaveBeenCalledTimes(1);
      const decompositionCtx = createPlanSpy.mock.calls[0]![2];
      expect(decompositionCtx.relevantMemories).toBeUndefined();
    });
  });
});
