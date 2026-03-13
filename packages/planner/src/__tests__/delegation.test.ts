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
