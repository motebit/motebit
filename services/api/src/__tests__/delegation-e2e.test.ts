/**
 * End-to-end integration test for the full delegation stack:
 *   PlanEngine → RelayDelegationAdapter → Relay → Worker device → Receipt → Plan completion
 *
 * Tests every seam in the delegation pipeline using a real Hono relay (in-memory SQLite)
 * with mocked WebSocket connections bridged to the RelayDelegationAdapter's event bus.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSyncRelay } from "../index.js";
import type { SyncRelay } from "../index.js";
import { PlanEngine, InMemoryPlanStore, RelayDelegationAdapter } from "@motebit/planner";
import type { PlanChunk } from "@motebit/planner";
import { DeviceCapability, StepStatus, PlanStatus } from "@motebit/sdk";
import type { ExecutionReceipt, MotebitId, DeviceId, AgentTask } from "@motebit/sdk";
import type { MotebitLoopDependencies } from "@motebit/ai-core";

// === Constants ===

const API_TOKEN = "test-token";
const AUTH_HEADER = { Authorization: `Bearer ${API_TOKEN}` };
const MOTEBIT_ID = "test-mote";

// === Helpers ===

function makeMockDeps(steps: Array<Record<string, unknown>>): MotebitLoopDependencies {
  return {
    provider: {
      generate: vi.fn().mockResolvedValue({
        text: JSON.stringify({ title: "E2E Test Plan", steps }),
      }),
    },
  } as unknown as MotebitLoopDependencies;
}

function makeReceipt(
  taskId: string,
  status: "completed" | "failed" = "completed",
  result = "Task executed successfully",
): ExecutionReceipt {
  return {
    task_id: taskId,
    motebit_id: MOTEBIT_ID as unknown as MotebitId,
    device_id: "worker-device" as unknown as DeviceId,
    submitted_at: Date.now(),
    completed_at: Date.now(),
    status,
    result,
    tools_used: ["shell_exec"],
    memories_formed: 0,
    prompt_hash: "abc123",
    result_hash: "def456",
    signature: "sig-valid",
  };
}

/**
 * Creates the bridge between the relay's WebSocket fan-out and RelayDelegationAdapter's
 * onCustomMessage callback. When the relay calls dispatcherWs.send(payload), the parsed
 * message is routed to all registered callbacks — exactly mimicking a real WebSocket connection.
 */
function createDispatcherBridge() {
  const callbacks = new Set<(msg: { type: string; [key: string]: unknown }) => void>();

  const ws = {
    send: vi.fn().mockImplementation((data: string) => {
      const msg = JSON.parse(data) as { type: string; [key: string]: unknown };
      for (const cb of callbacks) cb(msg);
    }),
    close: vi.fn(),
    readyState: 1,
  };

  const onCustomMessage = (
    cb: (msg: { type: string; [key: string]: unknown }) => void,
  ): (() => void) => {
    callbacks.add(cb);
    return () => callbacks.delete(cb);
  };

  return { ws, onCustomMessage };
}

// === Tests ===

describe("Delegation E2E", () => {
  let relay: SyncRelay;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    relay = await createSyncRelay({ apiToken: API_TOKEN, enableDeviceAuth: false });

    // Route RelayDelegationAdapter's fetch calls through the in-process Hono relay
    originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string | Request | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      // Strip the fake origin, keep the path
      const path = url.replace("http://relay", "");
      return relay.app.request(path, init);
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    relay.close();
  });

  it("full delegation: PlanEngine → Relay → Worker → Receipt → Plan completion", async () => {
    const store = new InMemoryPlanStore();
    const dispatcher = createDispatcherBridge();

    // Worker device with stdio_mcp capability
    const workerWs = { send: vi.fn(), close: vi.fn(), readyState: 1 };

    // Inject both devices into relay's connection map
    relay.connections.set(MOTEBIT_ID, [
      { ws: dispatcher.ws as never, deviceId: "dispatcher-device", capabilities: ["http_mcp"] },
      {
        ws: workerWs as never,
        deviceId: "worker-device",
        capabilities: ["stdio_mcp", "http_mcp", "file_system"],
      },
    ]);

    const adapter = new RelayDelegationAdapter({
      syncUrl: "http://relay",
      motebitId: MOTEBIT_ID,
      authToken: API_TOKEN,
      sendRaw: () => {},
      onCustomMessage: dispatcher.onCustomMessage,
    });

    const engine = new PlanEngine(store, {
      localCapabilities: [DeviceCapability.HttpMcp],
      delegationAdapter: adapter,
      delegationTimeoutMs: 5000,
    });

    // Plan with one step requiring stdio_mcp (must be delegated)
    const deps = makeMockDeps([
      {
        description: "Run CLI command",
        prompt: "Execute shell command to list files",
        required_capabilities: ["stdio_mcp"],
      },
    ]);
    const { plan } = await engine.createPlan(
      "goal-e2e",
      MOTEBIT_ID,
      { goalPrompt: "list files" },
      deps,
    );

    // Run executePlan concurrently with worker simulation
    const executePromise = (async () => {
      const chunks: PlanChunk[] = [];
      for await (const chunk of engine.executePlan(plan.plan_id, deps)) {
        chunks.push(chunk);
      }
      return chunks;
    })();

    // Wait for the POST to complete and task_request to reach the worker
    await vi.waitFor(
      () => {
        expect(workerWs.send).toHaveBeenCalled();
      },
      { timeout: 2000 },
    );

    // Worker received task_request
    const taskRequestRaw = workerWs.send.mock.calls[0]![0] as string;
    const taskRequest = JSON.parse(taskRequestRaw) as { type: string; task: AgentTask };
    expect(taskRequest.type).toBe("task_request");
    expect(taskRequest.task.required_capabilities).toContain("stdio_mcp");
    expect(taskRequest.task.step_id).toBeTruthy();
    const taskId = taskRequest.task.task_id;

    // Worker posts receipt to relay
    const receipt = makeReceipt(taskId);
    const receiptRes = await relay.app.request(`/agent/${MOTEBIT_ID}/task/${taskId}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(receipt),
    });
    expect(receiptRes.status).toBe(200);

    // executePlan should now resolve
    const chunks = await executePromise;

    // Verify the full chunk sequence
    const types = chunks.map((c) => c.type);
    expect(types).toContain("plan_created");
    expect(types).toContain("step_started");
    expect(types).toContain("step_delegated");
    expect(types).toContain("plan_completed");
    expect(types).not.toContain("plan_failed");

    // Verify step state
    const steps = store.getStepsForPlan(plan.plan_id);
    expect(steps[0]!.status).toBe(StepStatus.Completed);
    expect(steps[0]!.delegation_task_id).toBe(taskId);
    expect(steps[0]!.result_summary).toBe("Task executed successfully");

    // Verify plan state
    const finalPlan = store.getPlan(plan.plan_id)!;
    expect(finalPlan.status).toBe(PlanStatus.Completed);
  });

  it("capability-filtered fan-out: only capable device receives task_request", async () => {
    // Device A: http_mcp only (cannot run stdio tasks)
    const deviceA = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    // Device B: stdio_mcp + http_mcp (can run stdio tasks)
    const deviceB = { send: vi.fn(), close: vi.fn(), readyState: 1 };

    relay.connections.set(MOTEBIT_ID, [
      { ws: deviceA as never, deviceId: "device-a", capabilities: ["http_mcp"] },
      { ws: deviceB as never, deviceId: "device-b", capabilities: ["stdio_mcp", "http_mcp"] },
    ]);

    // Submit a task requiring stdio_mcp
    const res = await relay.app.request(`/agent/${MOTEBIT_ID}/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        prompt: "Run a shell command",
        required_capabilities: ["stdio_mcp"],
      }),
    });
    expect(res.status).toBe(201);

    // Only Device B should receive the task_request
    expect(deviceA.send).not.toHaveBeenCalled();
    expect(deviceB.send).toHaveBeenCalledOnce();

    const msg = JSON.parse(deviceB.send.mock.calls[0]![0] as string) as {
      type: string;
      task: AgentTask;
    };
    expect(msg.type).toBe("task_request");
    expect(msg.task.required_capabilities).toContain("stdio_mcp");
  });

  it("recovery via pollTaskResult: orphaned step resolved on reconnect", async () => {
    const store = new InMemoryPlanStore();
    const dispatcher = createDispatcherBridge();

    const adapter = new RelayDelegationAdapter({
      syncUrl: "http://relay",
      motebitId: MOTEBIT_ID,
      authToken: API_TOKEN,
      sendRaw: () => {},
      onCustomMessage: dispatcher.onCustomMessage,
    });

    const engine = new PlanEngine(store, {
      localCapabilities: [],
      delegationAdapter: adapter,
    });

    // Create a plan and manually set up an orphaned Running step (simulating crash mid-delegation)
    const deps = makeMockDeps([
      {
        description: "Remote task",
        prompt: "do remote thing",
        required_capabilities: ["file_system"],
      },
    ]);
    const { plan } = await engine.createPlan(
      "goal-recovery",
      MOTEBIT_ID,
      { goalPrompt: "test" },
      deps,
    );
    const steps = store.getStepsForPlan(plan.plan_id);
    const stepId = steps[0]!.step_id;

    // Submit a task to the relay (as if delegation had started before crash)
    const taskRes = await relay.app.request(`/agent/${MOTEBIT_ID}/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        prompt: "do remote thing",
        required_capabilities: ["file_system"],
        step_id: stepId,
      }),
    });
    const { task_id: taskId } = (await taskRes.json()) as { task_id: string };

    // Simulate the crash state: step is Running with delegation_task_id
    store.updateStep(stepId, {
      status: StepStatus.Running,
      started_at: Date.now(),
      delegation_task_id: taskId,
    });

    // Worker completed while we were "crashed" — receipt already on relay
    const receipt = makeReceipt(taskId, "completed", "Recovery result");
    await relay.app.request(`/agent/${MOTEBIT_ID}/task/${taskId}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(receipt),
    });

    // On "reconnect": recoverDelegatedSteps polls the relay and resolves the orphaned step
    const recoveryChunks: PlanChunk[] = [];
    for await (const chunk of engine.recoverDelegatedSteps(MOTEBIT_ID, deps)) {
      recoveryChunks.push(chunk);
    }

    expect(recoveryChunks.filter((c) => c.type === "step_delegated")).toHaveLength(1);
    expect(recoveryChunks.filter((c) => c.type === "step_completed")).toHaveLength(1);

    // Step should be Completed in store
    const updatedStep = store.getStep(stepId)!;
    expect(updatedStep.status).toBe(StepStatus.Completed);
    expect(updatedStep.result_summary).toBe("Recovery result");
  });

  it("delegation timeout: no worker responds, step fails", async () => {
    const store = new InMemoryPlanStore();
    const dispatcher = createDispatcherBridge();

    const adapter = new RelayDelegationAdapter({
      syncUrl: "http://relay",
      motebitId: MOTEBIT_ID,
      authToken: API_TOKEN,
      sendRaw: () => {},
      onCustomMessage: dispatcher.onCustomMessage,
    });

    // Inject dispatcher but NO worker — nobody to execute
    relay.connections.set(MOTEBIT_ID, [
      { ws: dispatcher.ws as never, deviceId: "dispatcher-device", capabilities: ["http_mcp"] },
    ]);

    const engine = new PlanEngine(store, {
      localCapabilities: [DeviceCapability.HttpMcp],
      delegationAdapter: adapter,
      delegationTimeoutMs: 200, // Short timeout for test speed
    });

    const deps = makeMockDeps([
      { description: "Stdio step", prompt: "do stdio thing", required_capabilities: ["stdio_mcp"] },
    ]);
    const { plan } = await engine.createPlan(
      "goal-timeout",
      MOTEBIT_ID,
      { goalPrompt: "test" },
      deps,
    );

    const chunks: PlanChunk[] = [];
    for await (const chunk of engine.executePlan(plan.plan_id, deps)) {
      chunks.push(chunk);
    }

    const types = chunks.map((c) => c.type);
    expect(types).toContain("step_started");
    expect(types).toContain("step_failed");
    expect(types).toContain("plan_failed");
    expect(types).not.toContain("step_delegated");

    const steps = store.getStepsForPlan(plan.plan_id);
    expect(steps[0]!.status).toBe(StepStatus.Failed);
    expect(steps[0]!.error_message).toContain("timed out");
  });

  it("mixed plan: completed local step + delegated step resumes correctly", async () => {
    const store = new InMemoryPlanStore();
    const dispatcher = createDispatcherBridge();
    const workerWs = { send: vi.fn(), close: vi.fn(), readyState: 1 };

    relay.connections.set(MOTEBIT_ID, [
      { ws: dispatcher.ws as never, deviceId: "dispatcher-device", capabilities: ["http_mcp"] },
      { ws: workerWs as never, deviceId: "worker-device", capabilities: ["stdio_mcp", "http_mcp"] },
    ]);

    const adapter = new RelayDelegationAdapter({
      syncUrl: "http://relay",
      motebitId: MOTEBIT_ID,
      authToken: API_TOKEN,
      sendRaw: () => {},
      onCustomMessage: dispatcher.onCustomMessage,
    });

    const engine = new PlanEngine(store, {
      localCapabilities: [DeviceCapability.HttpMcp],
      delegationAdapter: adapter,
      delegationTimeoutMs: 5000,
    });

    // Create a plan with 2 steps: step 1 (local, no caps), step 2 (delegation)
    const deps = makeMockDeps([
      { description: "Web search", prompt: "Search for information" },
      { description: "Run CLI", prompt: "Execute command", required_capabilities: ["stdio_mcp"] },
    ]);
    const { plan } = await engine.createPlan(
      "goal-mixed",
      MOTEBIT_ID,
      { goalPrompt: "test" },
      deps,
    );

    // Pre-mark step 1 as completed (simulating local execution already done)
    const steps = store.getStepsForPlan(plan.plan_id);
    store.updateStep(steps[0]!.step_id, {
      status: StepStatus.Completed,
      completed_at: Date.now(),
      result_summary: "Found 3 results",
    });

    // Resume plan — step 1 skipped (completed), step 2 delegated
    const executePromise = (async () => {
      const chunks: PlanChunk[] = [];
      for await (const chunk of engine.resumePlan(plan.plan_id, deps)) {
        chunks.push(chunk);
      }
      return chunks;
    })();

    // Wait for worker to receive task_request (step 2 delegation)
    await vi.waitFor(
      () => {
        expect(workerWs.send).toHaveBeenCalled();
      },
      { timeout: 2000 },
    );

    // Worker handles the delegated step
    const taskRequestRaw = workerWs.send.mock.calls[0]![0] as string;
    const taskRequest = JSON.parse(taskRequestRaw) as { type: string; task: AgentTask };
    const taskId = taskRequest.task.task_id;

    const receipt = makeReceipt(taskId, "completed", "CLI output: file1.txt file2.txt");
    await relay.app.request(`/agent/${MOTEBIT_ID}/task/${taskId}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(receipt),
    });

    const chunks = await executePromise;
    const types = chunks.map((c) => c.type);

    // Step 2 should have been delegated
    expect(types).toContain("step_delegated");
    expect(types).toContain("plan_completed");

    // Verify step 2 completed via delegation
    const updatedSteps = store.getStepsForPlan(plan.plan_id);
    const delegatedStep = updatedSteps.find((s) => s.description === "Run CLI");
    expect(delegatedStep!.status).toBe(StepStatus.Completed);
    expect(delegatedStep!.delegation_task_id).toBe(taskId);
    expect(delegatedStep!.result_summary).toBe("CLI output: file1.txt file2.txt");

    // Step 1 should still be completed (not re-executed)
    const localStep = updatedSteps.find((s) => s.description === "Web search");
    expect(localStep!.status).toBe(StepStatus.Completed);
    expect(localStep!.result_summary).toBe("Found 3 results");
  });

  it("failed receipt: worker fails task, plan fails for required step", async () => {
    const store = new InMemoryPlanStore();
    const dispatcher = createDispatcherBridge();
    const workerWs = { send: vi.fn(), close: vi.fn(), readyState: 1 };

    relay.connections.set(MOTEBIT_ID, [
      { ws: dispatcher.ws as never, deviceId: "dispatcher-device", capabilities: ["http_mcp"] },
      { ws: workerWs as never, deviceId: "worker-device", capabilities: ["stdio_mcp"] },
    ]);

    const adapter = new RelayDelegationAdapter({
      syncUrl: "http://relay",
      motebitId: MOTEBIT_ID,
      authToken: API_TOKEN,
      sendRaw: () => {},
      onCustomMessage: dispatcher.onCustomMessage,
      maxDelegationRetries: 0, // No retries — test verifies single failure propagation
    });

    const engine = new PlanEngine(store, {
      localCapabilities: [DeviceCapability.HttpMcp],
      delegationAdapter: adapter,
      delegationTimeoutMs: 5000,
    });

    const deps = makeMockDeps([
      { description: "Stdio step", prompt: "do thing", required_capabilities: ["stdio_mcp"] },
    ]);
    const { plan } = await engine.createPlan("goal-fail", MOTEBIT_ID, { goalPrompt: "test" }, deps);

    const executePromise = (async () => {
      const chunks: PlanChunk[] = [];
      for await (const chunk of engine.executePlan(plan.plan_id, deps)) {
        chunks.push(chunk);
      }
      return chunks;
    })();

    await vi.waitFor(
      () => {
        expect(workerWs.send).toHaveBeenCalled();
      },
      { timeout: 2000 },
    );

    const taskRequestRaw = workerWs.send.mock.calls[0]![0] as string;
    const taskRequest = JSON.parse(taskRequestRaw) as { type: string; task: AgentTask };
    const taskId = taskRequest.task.task_id;

    // Worker fails the task
    const receipt = makeReceipt(taskId, "failed", "Command not found: foobar");
    await relay.app.request(`/agent/${MOTEBIT_ID}/task/${taskId}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(receipt),
    });

    const chunks = await executePromise;
    const types = chunks.map((c) => c.type);

    expect(types).toContain("step_started");
    expect(types).toContain("step_failed");
    expect(types).toContain("plan_failed");
    expect(types).not.toContain("step_delegated");

    const steps = store.getStepsForPlan(plan.plan_id);
    expect(steps[0]!.status).toBe(StepStatus.Failed);
  });
});
