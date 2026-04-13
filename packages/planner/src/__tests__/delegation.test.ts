import { describe, it, expect, vi } from "vitest";
import { PlanEngine } from "../plan-engine.js";
import { InMemoryPlanStore } from "../types.js";
import type { StepDelegationAdapter } from "../plan-engine.js";
import { DeviceCapability, StepStatus } from "@motebit/sdk";
import type {
  DelegatedStepResult,
  PlanStep,
  ExecutionReceipt,
  MotebitId,
  DeviceId,
} from "@motebit/sdk";
import type { MotebitLoopDependencies } from "@motebit/ai-core";

function makeMockDeps(steps: Array<Record<string, unknown>>): MotebitLoopDependencies {
  return {
    provider: {
      generate: vi.fn().mockResolvedValue({
        text: JSON.stringify({ title: "Test plan", steps }),
      }),
    },
  } as unknown as MotebitLoopDependencies;
}

function makeReceipt(
  taskId: string,
  status: "completed" | "failed" = "completed",
): ExecutionReceipt {
  return {
    task_id: taskId,
    motebit_id: "test-mote" as MotebitId,
    device_id: "test-device" as DeviceId,
    submitted_at: Date.now(),
    completed_at: Date.now(),
    status,
    result: "Delegated result text",
    tools_used: ["web_search"],
    memories_formed: 0,
    prompt_hash: "abc",
    result_hash: "def",
    suite: "motebit-jcs-ed25519-b64-v1",
    signature: "sig",
  };
}

describe("PlanEngine delegation", () => {
  it("delegates step when local capabilities are insufficient", async () => {
    const store = new InMemoryPlanStore();
    const mockAdapter: StepDelegationAdapter = {
      delegateStep: vi.fn().mockImplementation(async (step: PlanStep) => {
        return {
          step_id: step.step_id,
          task_id: "delegated-task-1",
          receipt: makeReceipt("delegated-task-1"),
          result_text: "Delegated result text",
        } satisfies DelegatedStepResult;
      }),
    };

    const engine = new PlanEngine(store, {
      localCapabilities: [DeviceCapability.HttpMcp],
      delegationAdapter: mockAdapter,
    });

    // Only a single step that requires stdio_mcp — will be delegated
    const deps = makeMockDeps([
      { description: "Stdio step", prompt: "do stdio thing", required_capabilities: ["stdio_mcp"] },
    ]);
    const { plan } = await engine.createPlan("goal-1", "test-mote", { goalPrompt: "test" }, deps);
    const chunks: Array<{ type: string; [key: string]: unknown }> = [];

    for await (const chunk of engine.executePlan(plan.plan_id, deps)) {
      chunks.push(chunk);
    }

    expect(mockAdapter.delegateStep).toHaveBeenCalledOnce();
    const delegatedChunks = chunks.filter((c) => c.type === "step_delegated");
    expect(delegatedChunks).toHaveLength(1);
    expect((delegatedChunks[0] as unknown as { task_id: string }).task_id).toBe("delegated-task-1");

    // Plan should complete
    const completedChunks = chunks.filter((c) => c.type === "plan_completed");
    expect(completedChunks).toHaveLength(1);
  });

  it("does not delegate when capabilities are sufficient", async () => {
    const store = new InMemoryPlanStore();
    const mockAdapter: StepDelegationAdapter = {
      delegateStep: vi.fn(),
    };

    const engine = new PlanEngine(store, {
      localCapabilities: [DeviceCapability.HttpMcp, DeviceCapability.StdioMcp],
      delegationAdapter: mockAdapter,
    });

    // Step requires stdio_mcp but we have it locally
    const deps = makeMockDeps([
      { description: "Stdio step", prompt: "do stdio thing", required_capabilities: ["stdio_mcp"] },
    ]);
    const { plan } = await engine.createPlan("goal-1", "test-mote", { goalPrompt: "test" }, deps);

    // We just check that delegation was NOT called — the local execution will fail
    // due to incomplete mock deps, but that's fine for this test
    const chunks: Array<{ type: string }> = [];
    for await (const chunk of engine.executePlan(plan.plan_id, deps)) {
      chunks.push(chunk);
    }

    expect(mockAdapter.delegateStep).not.toHaveBeenCalled();
    expect(chunks.filter((c) => c.type === "step_delegated")).toHaveLength(0);
  });

  it("fails step when no delegation adapter and caps are insufficient", async () => {
    const store = new InMemoryPlanStore();
    const engine = new PlanEngine(store, {
      localCapabilities: [DeviceCapability.HttpMcp],
      // No delegationAdapter
    });

    const deps = makeMockDeps([
      { description: "Stdio step", prompt: "do stdio thing", required_capabilities: ["stdio_mcp"] },
    ]);
    const { plan } = await engine.createPlan("goal-1", "test-mote", { goalPrompt: "test" }, deps);

    const chunks: Array<{ type: string; error?: string }> = [];
    for await (const chunk of engine.executePlan(plan.plan_id, deps)) {
      chunks.push(chunk);
    }

    const failedSteps = chunks.filter((c) => c.type === "step_failed");
    expect(failedSteps).toHaveLength(1);
    expect(failedSteps[0]!.error).toContain("stdio_mcp");

    const planFailed = chunks.filter((c) => c.type === "plan_failed");
    expect(planFailed).toHaveLength(1);
  });

  it("delegation failure produces step_failed", async () => {
    const store = new InMemoryPlanStore();
    const mockAdapter: StepDelegationAdapter = {
      delegateStep: vi.fn().mockRejectedValue(new Error("Delegation timed out after 5000ms")),
    };

    const engine = new PlanEngine(store, {
      localCapabilities: [DeviceCapability.HttpMcp],
      delegationAdapter: mockAdapter,
    });

    const deps = makeMockDeps([
      { description: "Stdio step", prompt: "do stdio thing", required_capabilities: ["stdio_mcp"] },
    ]);
    const { plan } = await engine.createPlan("goal-1", "test-mote", { goalPrompt: "test" }, deps);

    const chunks: Array<{ type: string; error?: string }> = [];
    for await (const chunk of engine.executePlan(plan.plan_id, deps)) {
      chunks.push(chunk);
    }

    const failedSteps = chunks.filter((c) => c.type === "step_failed");
    expect(failedSteps).toHaveLength(1);
    expect(failedSteps[0]!.error).toContain("timed out");

    const planFailed = chunks.filter((c) => c.type === "plan_failed");
    expect(planFailed).toHaveLength(1);
  });

  it("optional delegated step failure doesn't fail plan", async () => {
    const store = new InMemoryPlanStore();
    const mockAdapter: StepDelegationAdapter = {
      delegateStep: vi.fn().mockRejectedValue(new Error("Remote device offline")),
    };

    const engine = new PlanEngine(store, {
      localCapabilities: [DeviceCapability.HttpMcp],
      delegationAdapter: mockAdapter,
    });

    // Only step is optional and requires delegation
    const deps = makeMockDeps([
      {
        description: "Optional stdio step",
        prompt: "do stdio thing",
        required_capabilities: ["stdio_mcp"],
        optional: true,
      },
    ]);

    const { plan } = await engine.createPlan("goal-1", "test-mote", { goalPrompt: "test" }, deps);

    const chunks: Array<{ type: string }> = [];
    for await (const chunk of engine.executePlan(plan.plan_id, deps)) {
      chunks.push(chunk);
    }

    // Delegation failed but plan should still complete (step is optional)
    const failedSteps = chunks.filter((c) => c.type === "step_failed");
    expect(failedSteps).toHaveLength(1);

    const planCompleted = chunks.filter((c) => c.type === "plan_completed");
    expect(planCompleted).toHaveLength(1);
  });

  it("step_delegated chunk is yielded with correct data", async () => {
    const store = new InMemoryPlanStore();
    const mockAdapter: StepDelegationAdapter = {
      delegateStep: vi.fn().mockImplementation(
        async (step: PlanStep) =>
          ({
            step_id: step.step_id,
            task_id: "task-abc",
            receipt: makeReceipt("task-abc"),
            result_text: "Result from delegation",
          }) satisfies DelegatedStepResult,
      ),
    };

    const engine = new PlanEngine(store, {
      localCapabilities: [],
      delegationAdapter: mockAdapter,
    });

    const deps = makeMockDeps([
      {
        description: "Remote step",
        prompt: "do remote thing",
        required_capabilities: ["file_system"],
      },
    ]);
    const { plan } = await engine.createPlan("goal-1", "test-mote", { goalPrompt: "test" }, deps);

    const chunks: Array<{ type: string; [key: string]: unknown }> = [];
    for await (const chunk of engine.executePlan(plan.plan_id, deps)) {
      chunks.push(chunk);
    }

    const delegated = chunks.filter((c) => c.type === "step_delegated");
    expect(delegated).toHaveLength(1);
    expect((delegated[0] as unknown as { task_id: string }).task_id).toBe("task-abc");

    // Step should be marked completed in store
    const steps = store.getStepsForPlan(plan.plan_id);
    expect(steps[0]!.status).toBe(StepStatus.Completed);
    expect(steps[0]!.result_summary).toBe("Result from delegation");
  });

  it("setLocalCapabilities and setDelegationAdapter work", () => {
    const store = new InMemoryPlanStore();
    const engine = new PlanEngine(store);

    engine.setLocalCapabilities([DeviceCapability.HttpMcp]);
    engine.setDelegationAdapter({ delegateStep: vi.fn() });
    engine.setDelegationAdapter(undefined);
  });

  it("delegation persists task_id via onTaskSubmitted callback", async () => {
    const store = new InMemoryPlanStore();
    const mockAdapter: StepDelegationAdapter = {
      delegateStep: vi
        .fn()
        .mockImplementation(
          async (step: PlanStep, _timeout: number, onTaskSubmitted?: (taskId: string) => void) => {
            // Simulate relay returning task_id
            onTaskSubmitted?.("relay-task-42");
            return {
              step_id: step.step_id,
              task_id: "relay-task-42",
              receipt: makeReceipt("relay-task-42"),
              result_text: "Done",
            } satisfies DelegatedStepResult;
          },
        ),
    };

    const engine = new PlanEngine(store, {
      localCapabilities: [],
      delegationAdapter: mockAdapter,
    });

    const deps = makeMockDeps([
      { description: "Remote step", prompt: "do it", required_capabilities: ["file_system"] },
    ]);
    const { plan } = await engine.createPlan("goal-1", "test-mote", { goalPrompt: "test" }, deps);

    for await (const _chunk of engine.executePlan(plan.plan_id, deps)) {
      // consume
    }

    // The step should have delegation_task_id persisted (even though it's now completed)
    const steps = store.getStepsForPlan(plan.plan_id);
    expect(steps[0]!.delegation_task_id).toBe("relay-task-42");
  });
});

describe("PlanEngine recovery", () => {
  it("recoverDelegatedSteps resolves orphaned completed step", async () => {
    const store = new InMemoryPlanStore();
    const mockAdapter: StepDelegationAdapter = {
      delegateStep: vi.fn(),
      pollTaskResult: vi.fn().mockResolvedValue({
        step_id: "step-1",
        task_id: "task-orphan",
        receipt: makeReceipt("task-orphan"),
        result_text: "Completed while tab was closed",
      } satisfies DelegatedStepResult),
    };

    const engine = new PlanEngine(store, {
      localCapabilities: [],
      delegationAdapter: mockAdapter,
    });

    // Manually create a plan with a Running step that has delegation_task_id
    // (simulates state after tab close during delegation)
    const deps = makeMockDeps([
      { description: "Remote step", prompt: "do it", required_capabilities: ["file_system"] },
    ]);
    const { plan } = await engine.createPlan("goal-1", "test-mote", { goalPrompt: "test" }, deps);

    // Manually set step to Running with delegation_task_id (simulating mid-delegation crash)
    const steps = store.getStepsForPlan(plan.plan_id);
    store.updateStep(steps[0]!.step_id, {
      status: StepStatus.Running,
      delegation_task_id: "task-orphan",
    });

    const chunks: Array<{ type: string }> = [];
    for await (const chunk of engine.recoverDelegatedSteps("test-mote", deps)) {
      chunks.push(chunk);
    }

    expect(mockAdapter.pollTaskResult).toHaveBeenCalledWith("task-orphan", steps[0]!.step_id);
    expect(chunks.filter((c) => c.type === "step_delegated")).toHaveLength(1);
    expect(chunks.filter((c) => c.type === "step_completed")).toHaveLength(1);

    // Step should be Completed in store
    const updatedStep = store.getStep(steps[0]!.step_id);
    expect(updatedStep!.status).toBe(StepStatus.Completed);
  });

  it("recoverDelegatedSteps handles failed receipt", async () => {
    const store = new InMemoryPlanStore();
    const mockAdapter: StepDelegationAdapter = {
      delegateStep: vi.fn(),
      pollTaskResult: vi.fn().mockResolvedValue({
        step_id: "step-1",
        task_id: "task-fail",
        receipt: makeReceipt("task-fail", "failed"),
        result_text: "Task crashed",
      } satisfies DelegatedStepResult),
    };

    const engine = new PlanEngine(store, {
      localCapabilities: [],
      delegationAdapter: mockAdapter,
    });

    const deps = makeMockDeps([
      { description: "Remote step", prompt: "do it", required_capabilities: ["file_system"] },
    ]);
    const { plan } = await engine.createPlan("goal-1", "test-mote", { goalPrompt: "test" }, deps);

    const steps = store.getStepsForPlan(plan.plan_id);
    store.updateStep(steps[0]!.step_id, {
      status: StepStatus.Running,
      delegation_task_id: "task-fail",
    });

    const chunks: Array<{ type: string }> = [];
    for await (const chunk of engine.recoverDelegatedSteps("test-mote", deps)) {
      chunks.push(chunk);
    }

    expect(chunks.filter((c) => c.type === "step_failed")).toHaveLength(1);
    expect(chunks.filter((c) => c.type === "plan_failed")).toHaveLength(1);

    const updatedStep = store.getStep(steps[0]!.step_id);
    expect(updatedStep!.status).toBe(StepStatus.Failed);
  });

  it("recoverDelegatedSteps skips steps without delegation_task_id", async () => {
    const store = new InMemoryPlanStore();
    const mockAdapter: StepDelegationAdapter = {
      delegateStep: vi.fn(),
      pollTaskResult: vi.fn(),
    };

    const engine = new PlanEngine(store, {
      localCapabilities: [],
      delegationAdapter: mockAdapter,
    });

    const deps = makeMockDeps([
      { description: "Local step", prompt: "do it", required_capabilities: ["file_system"] },
    ]);
    const { plan } = await engine.createPlan("goal-1", "test-mote", { goalPrompt: "test" }, deps);

    // Step is Running but has no delegation_task_id — it was a local execution, not delegated
    const steps = store.getStepsForPlan(plan.plan_id);
    store.updateStep(steps[0]!.step_id, { status: StepStatus.Running });

    const chunks: Array<{ type: string }> = [];
    for await (const chunk of engine.recoverDelegatedSteps("test-mote", deps)) {
      chunks.push(chunk);
    }

    expect(mockAdapter.pollTaskResult).not.toHaveBeenCalled();
    expect(chunks).toHaveLength(0);
  });

  it("recoverDelegatedSteps is no-op when adapter lacks pollTaskResult", async () => {
    const store = new InMemoryPlanStore();
    const mockAdapter: StepDelegationAdapter = {
      delegateStep: vi.fn(),
      // No pollTaskResult
    };

    const engine = new PlanEngine(store, {
      localCapabilities: [],
      delegationAdapter: mockAdapter,
    });

    const deps = makeMockDeps([
      { description: "Remote step", prompt: "do it", required_capabilities: ["file_system"] },
    ]);
    await engine.createPlan("goal-1", "test-mote", { goalPrompt: "test" }, deps);

    const chunks: Array<{ type: string }> = [];
    for await (const chunk of engine.recoverDelegatedSteps("test-mote", deps)) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(0);
  });
});

// ── RelayDelegationAdapter retry with failover ──

import { RelayDelegationAdapter } from "../delegation-adapter.js";

describe("RelayDelegationAdapter retry with failover", () => {
  function makeStep(overrides: Partial<PlanStep> = {}): PlanStep {
    return {
      step_id: "step-1",
      plan_id: "plan-1" as import("@motebit/sdk").PlanId,
      ordinal: 0,
      description: "Test step",
      prompt: "Do the thing",
      depends_on: [],
      optional: false,
      status: StepStatus.Pending,
      required_capabilities: [DeviceCapability.HttpMcp],
      result_summary: null,
      error_message: null,
      tool_calls_made: 0,
      started_at: null,
      completed_at: null,
      retry_count: 0,
      updated_at: Date.now(),
      ...overrides,
    };
  }

  it("succeeds on first attempt without retry", async () => {
    let fetchCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      fetchCount++;
      return new Response(JSON.stringify({ task_id: "task-1" }), { status: 200 });
    });
    vi.stubGlobal("fetch", mockFetch);

    const receipt = makeReceipt("task-1");
    const adapter = new RelayDelegationAdapter({
      syncUrl: "http://localhost:3000",
      motebitId: "test-mote",
      sendRaw: vi.fn(),
      onCustomMessage: (cb) => {
        // Simulate immediate success
        setTimeout(() => {
          cb({ type: "task_result", task_id: "task-1", receipt });
        }, 10);
        return () => {};
      },
    });

    const result = await adapter.delegateStep(makeStep(), 5000);
    expect(result.task_id).toBe("task-1");
    expect(result.receipt.status).toBe("completed");
    expect(fetchCount).toBe(1);

    vi.unstubAllGlobals();
  });

  it("retries on failure and excludes failed agent", async () => {
    let fetchCount = 0;
    const fetchBodies: unknown[] = [];
    const mockFetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      fetchCount++;
      fetchBodies.push(JSON.parse(init.body as string));
      return new Response(JSON.stringify({ task_id: `task-${fetchCount}` }), { status: 200 });
    });
    vi.stubGlobal("fetch", mockFetch);

    const cbRef: { current: ((msg: { type: string; [key: string]: unknown }) => void) | null } = {
      current: null,
    };
    const failedReceipt: ExecutionReceipt = {
      ...makeReceipt("task-1", "failed"),
      motebit_id: "agent-bad" as MotebitId,
      result: "Service error",
    };
    const successReceipt = makeReceipt("task-2");

    const adapter = new RelayDelegationAdapter({
      syncUrl: "http://localhost:3000",
      motebitId: "test-mote",
      sendRaw: vi.fn(),
      onCustomMessage: (cb) => {
        cbRef.current = cb;
        return () => {
          cbRef.current = null;
        };
      },
      maxDelegationRetries: 2,
    });

    const resultPromise = adapter.delegateStep(makeStep(), 5000);

    // Wait for first attempt to register
    await new Promise((r) => setTimeout(r, 20));
    // First attempt fails
    cbRef.current?.({ type: "task_result", task_id: "task-1", receipt: failedReceipt });

    // Wait for retry
    await new Promise((r) => setTimeout(r, 20));
    // Second attempt succeeds
    cbRef.current?.({ type: "task_result", task_id: "task-2", receipt: successReceipt });

    const result = await resultPromise;
    expect(result.task_id).toBe("task-2");
    expect(fetchCount).toBe(2);

    // Second attempt should include exclude_agents
    const secondBody = fetchBodies[1] as { exclude_agents?: string[] };
    expect(secondBody.exclude_agents).toEqual(["agent-bad"]);

    vi.unstubAllGlobals();
  });

  it("calls onDelegationFailure on each failed attempt", async () => {
    let fetchCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        fetchCount++;
        return new Response(JSON.stringify({ task_id: `task-${fetchCount}` }), { status: 200 });
      }),
    );

    const cbRef: { current: ((msg: { type: string; [key: string]: unknown }) => void) | null } = {
      current: null,
    };
    const failures: Array<{ attempt: number; error: string; agentId?: string }> = [];

    const adapter = new RelayDelegationAdapter({
      syncUrl: "http://localhost:3000",
      motebitId: "test-mote",
      sendRaw: vi.fn(),
      onCustomMessage: (cb) => {
        cbRef.current = cb;
        return () => {
          cbRef.current = null;
        };
      },
      maxDelegationRetries: 1,
      onDelegationFailure: (_step, attempt, error, agentId) => {
        failures.push({ attempt, error, agentId });
      },
    });

    const failedReceipt: ExecutionReceipt = {
      ...makeReceipt("task-1", "failed"),
      motebit_id: "agent-a" as MotebitId,
      result: "Oops",
    };
    const successReceipt = makeReceipt("task-2");

    const resultPromise = adapter.delegateStep(makeStep(), 5000);

    await new Promise((r) => setTimeout(r, 20));
    cbRef.current?.({ type: "task_result", task_id: "task-1", receipt: failedReceipt });

    await new Promise((r) => setTimeout(r, 20));
    cbRef.current?.({ type: "task_result", task_id: "task-2", receipt: successReceipt });

    await resultPromise;

    expect(failures).toHaveLength(1);
    expect(failures[0]!.attempt).toBe(0);
    expect(failures[0]!.agentId).toBe("agent-a");

    vi.unstubAllGlobals();
  });

  it("fails after exhausting all retries", async () => {
    let fetchCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        fetchCount++;
        return new Response(JSON.stringify({ task_id: `task-${fetchCount}` }), { status: 200 });
      }),
    );

    const cbRef: { current: ((msg: { type: string; [key: string]: unknown }) => void) | null } = {
      current: null,
    };

    const adapter = new RelayDelegationAdapter({
      syncUrl: "http://localhost:3000",
      motebitId: "test-mote",
      sendRaw: vi.fn(),
      onCustomMessage: (cb) => {
        cbRef.current = cb;
        return () => {
          cbRef.current = null;
        };
      },
      maxDelegationRetries: 1, // 2 total attempts
    });

    const makeFailReceipt = (taskId: string, agentId: string) => ({
      ...makeReceipt(taskId, "failed"),
      motebit_id: agentId as MotebitId,
      result: "Error",
    });

    const resultPromise = adapter.delegateStep(makeStep(), 5000);

    await new Promise((r) => setTimeout(r, 20));
    cbRef.current?.({
      type: "task_result",
      task_id: "task-1",
      receipt: makeFailReceipt("task-1", "agent-a"),
    });

    await new Promise((r) => setTimeout(r, 20));
    cbRef.current?.({
      type: "task_result",
      task_id: "task-2",
      receipt: makeFailReceipt("task-2", "agent-b"),
    });

    await expect(resultPromise).rejects.toThrow(/failed after 2 attempt/);
    expect(fetchCount).toBe(2);

    vi.unstubAllGlobals();
  });

  it("does not retry on submission failure (non-retryable)", async () => {
    let fetchCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        fetchCount++;
        return new Response("Internal Server Error", { status: 500 });
      }),
    );

    const adapter = new RelayDelegationAdapter({
      syncUrl: "http://localhost:3000",
      motebitId: "test-mote",
      sendRaw: vi.fn(),
      onCustomMessage: () => () => {},
      maxDelegationRetries: 2,
    });

    await expect(adapter.delegateStep(makeStep(), 5000)).rejects.toThrow(
      /Relay task submission failed/,
    );
    // Should NOT retry — submission failures are not retryable
    expect(fetchCount).toBe(1);

    vi.unstubAllGlobals();
  });

  it("surfaces HTTP 402 with parsed JSON message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: "Budget exhausted", estimated_cost: 0.5 }), {
          status: 402,
        }),
      ),
    );

    const adapter = new RelayDelegationAdapter({
      syncUrl: "http://localhost:3000",
      motebitId: "test-mote",
      sendRaw: vi.fn(),
      onCustomMessage: () => () => {},
      maxDelegationRetries: 0,
    });

    await expect(adapter.delegateStep(makeStep(), 5000)).rejects.toThrow(
      /Payment required.*Budget exhausted/,
    );

    vi.unstubAllGlobals();
  });

  it("surfaces HTTP 402 with raw text when JSON parse fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Payment required plain text", { status: 402 })),
    );

    const adapter = new RelayDelegationAdapter({
      syncUrl: "http://localhost:3000",
      motebitId: "test-mote",
      sendRaw: vi.fn(),
      onCustomMessage: () => () => {},
      maxDelegationRetries: 0,
    });

    await expect(adapter.delegateStep(makeStep(), 5000)).rejects.toThrow(
      /Payment required.*plain text/,
    );

    vi.unstubAllGlobals();
  });

  it("pollTaskResult returns result when receipt exists", async () => {
    const receipt = makeReceipt("task-poll");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            task: { status: "completed" },
            receipt,
          }),
          { status: 200 },
        ),
      ),
    );

    const adapter = new RelayDelegationAdapter({
      syncUrl: "http://localhost:3000",
      motebitId: "test-mote",
      sendRaw: vi.fn(),
      onCustomMessage: () => () => {},
    });

    const result = await adapter.pollTaskResult("task-poll", "step-1");
    expect(result).not.toBeNull();
    expect(result!.task_id).toBe("task-poll");
    expect(result!.step_id).toBe("step-1");

    vi.unstubAllGlobals();
  });

  it("pollTaskResult returns null when receipt is null (still pending)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            task: { status: "running" },
            receipt: null,
          }),
          { status: 200 },
        ),
      ),
    );

    const adapter = new RelayDelegationAdapter({
      syncUrl: "http://localhost:3000",
      motebitId: "test-mote",
      sendRaw: vi.fn(),
      onCustomMessage: () => () => {},
    });

    const result = await adapter.pollTaskResult("task-1", "step-1");
    expect(result).toBeNull();

    vi.unstubAllGlobals();
  });

  it("pollTaskResult returns null on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Not found", { status: 404 })));

    const adapter = new RelayDelegationAdapter({
      syncUrl: "http://localhost:3000",
      motebitId: "test-mote",
      sendRaw: vi.fn(),
      onCustomMessage: () => () => {},
    });

    const result = await adapter.pollTaskResult("task-1", "step-1");
    expect(result).toBeNull();

    vi.unstubAllGlobals();
  });

  it("pollTaskResult returns null on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network failure")));

    const adapter = new RelayDelegationAdapter({
      syncUrl: "http://localhost:3000",
      motebitId: "test-mote",
      sendRaw: vi.fn(),
      onCustomMessage: () => () => {},
    });

    const result = await adapter.pollTaskResult("task-1", "step-1");
    expect(result).toBeNull();

    vi.unstubAllGlobals();
  });

  it("uses function authToken to mint fresh tokens", async () => {
    const tokenFactory = vi.fn().mockResolvedValue("fresh-token-123");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ task_id: "task-1" }), { status: 200 })),
    );

    const receipt = makeReceipt("task-1");
    const adapter = new RelayDelegationAdapter({
      syncUrl: "http://localhost:3000",
      motebitId: "test-mote",
      authToken: tokenFactory,
      sendRaw: vi.fn(),
      onCustomMessage: (cb) => {
        setTimeout(() => cb({ type: "task_result", task_id: "task-1", receipt }), 10);
        return () => {};
      },
    });

    await adapter.delegateStep(makeStep(), 5000);
    expect(tokenFactory).toHaveBeenCalledWith("task:submit");

    vi.unstubAllGlobals();
  });
});
