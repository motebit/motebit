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
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import { generateKeypair, signExecutionReceipt } from "@motebit/crypto";
import type { KeyPair } from "@motebit/crypto";

// === Constants ===

const API_TOKEN = "test-token";
const AUTH_HEADER = { Authorization: `Bearer ${API_TOKEN}` };
const MOTEBIT_ID = "test-mote";

// Worker agent identity — generated per test, registered in beforeEach
let workerKeypair: KeyPair;
let workerMotebitId: string;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

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

async function makeReceipt(
  taskId: string,
  status: "completed" | "failed" = "completed",
  result = "Task executed successfully",
): Promise<ExecutionReceipt> {
  const unsigned = {
    task_id: taskId,
    motebit_id: workerMotebitId as unknown as MotebitId,
    device_id: "worker-device" as unknown as DeviceId,
    submitted_at: Date.now(),
    completed_at: Date.now(),
    status,
    result,
    tools_used: ["shell_exec"],
    memories_formed: 0,
    prompt_hash: "abc123",
    result_hash: "def456",
  };
  return signExecutionReceipt(unsigned, workerKeypair.privateKey);
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

    // Generate a real Ed25519 keypair for the worker agent
    workerKeypair = await generateKeypair();
    const pubKeyHex = bytesToHex(workerKeypair.publicKey);

    // Register worker identity + device so relay can verify receipt signatures
    const idRes = await relay.app.request("/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ owner_id: "worker-owner" }),
    });
    const idBody = (await idRes.json()) as { motebit_id: string };
    workerMotebitId = idBody.motebit_id;

    await relay.app.request("/device/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        motebit_id: workerMotebitId,
        device_name: "Worker",
        public_key: pubKeyHex,
      }),
    });

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
    const receipt = await makeReceipt(taskId);
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
    const receipt = await makeReceipt(taskId, "completed", "Recovery result");
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

    const receipt = await makeReceipt(taskId, "completed", "CLI output: file1.txt file2.txt");
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
    const receipt = await makeReceipt(taskId, "failed", "Command not found: foobar");
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

  // === Credential Issuance & Verification ===

  it("credential issued on successful receipt delivery", async () => {
    // Register the worker agent in the agent registry so the relay can resolve its DID
    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        motebit_id: workerMotebitId,
        endpoint_url: "http://localhost:9999/mcp",
        capabilities: ["stdio_mcp"],
      }),
    });

    // Submit a task and post a successful receipt so the relay issues a credential
    const workerWs = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    relay.connections.set(MOTEBIT_ID, [
      { ws: workerWs as never, deviceId: "worker-device", capabilities: ["stdio_mcp"] },
    ]);

    const taskRes = await relay.app.request(`/agent/${MOTEBIT_ID}/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        prompt: "Run credential test",
        required_capabilities: ["stdio_mcp"],
      }),
    });
    expect(taskRes.status).toBe(201);
    const { task_id: taskId } = (await taskRes.json()) as { task_id: string };

    const receipt = await makeReceipt(taskId);
    const receiptRes = await relay.app.request(`/agent/${MOTEBIT_ID}/task/${taskId}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(receipt),
    });
    expect(receiptRes.status).toBe(200);
    const receiptBody = (await receiptRes.json()) as {
      status: string;
      credential_id: string | null;
    };
    expect(receiptBody.credential_id).toBeTruthy();

    // GET credentials for the worker agent
    const credsRes = await relay.app.request(`/api/v1/agents/${workerMotebitId}/credentials`, {
      headers: AUTH_HEADER,
    });
    expect(credsRes.status).toBe(200);
    const credsBody = (await credsRes.json()) as {
      motebit_id: string;
      credentials: Array<{
        credential_id: string;
        credential_type: string;
        credential: { type: string[]; credentialSubject: { id: string } };
      }>;
    };

    expect(credsBody.credentials.length).toBeGreaterThanOrEqual(1);
    const repCred = credsBody.credentials.find(
      (c) => c.credential_type === "AgentReputationCredential",
    );
    expect(repCred).toBeDefined();
    expect(repCred!.credential.type).toContain("AgentReputationCredential");
    // Subject should reference the executing agent via did:key or did:motebit
    expect(repCred!.credential.credentialSubject.id).toBeTruthy();
  });

  it("presentation bundles credentials into signed VP", async () => {
    // Set up: register worker, submit task, post receipt to get a credential issued
    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        motebit_id: workerMotebitId,
        endpoint_url: "http://localhost:9999/mcp",
        capabilities: ["stdio_mcp"],
      }),
    });

    const workerWs = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    relay.connections.set(MOTEBIT_ID, [
      { ws: workerWs as never, deviceId: "worker-device", capabilities: ["stdio_mcp"] },
    ]);

    const taskRes = await relay.app.request(`/agent/${MOTEBIT_ID}/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ prompt: "VP test", required_capabilities: ["stdio_mcp"] }),
    });
    const { task_id: taskId } = (await taskRes.json()) as { task_id: string };
    const receipt = await makeReceipt(taskId);
    await relay.app.request(`/agent/${MOTEBIT_ID}/task/${taskId}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(receipt),
    });

    // Request a VerifiablePresentation for the worker agent
    const vpRes = await relay.app.request(`/api/v1/agents/${workerMotebitId}/presentation`, {
      method: "POST",
      headers: AUTH_HEADER,
    });
    expect(vpRes.status).toBe(200);
    const vpBody = (await vpRes.json()) as {
      presentation: {
        "@context": string[];
        type: string[];
        holder: string;
        verifiableCredential: Array<{ type: string[] }>;
        proof: { type: string };
      };
      credential_count: number;
      relay_did: string;
    };

    expect(vpBody.presentation.type).toContain("VerifiablePresentation");
    expect(vpBody.presentation.verifiableCredential.length).toBeGreaterThanOrEqual(1);
    expect(vpBody.credential_count).toBeGreaterThanOrEqual(1);
    expect(vpBody.relay_did).toMatch(/^did:key:/);
    // The VP should include the reputation credential
    const hasRepCred = vpBody.presentation.verifiableCredential.some((vc) =>
      vc.type.includes("AgentReputationCredential"),
    );
    expect(hasRepCred).toBe(true);
  });

  it("credential verification via public endpoint", async () => {
    // Set up: register worker, submit task, post receipt
    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        motebit_id: workerMotebitId,
        endpoint_url: "http://localhost:9999/mcp",
        capabilities: ["stdio_mcp"],
      }),
    });

    const workerWs = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    relay.connections.set(MOTEBIT_ID, [
      { ws: workerWs as never, deviceId: "worker-device", capabilities: ["stdio_mcp"] },
    ]);

    const taskRes = await relay.app.request(`/agent/${MOTEBIT_ID}/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ prompt: "Verify test", required_capabilities: ["stdio_mcp"] }),
    });
    const { task_id: taskId } = (await taskRes.json()) as { task_id: string };
    const receipt = await makeReceipt(taskId);
    await relay.app.request(`/agent/${MOTEBIT_ID}/task/${taskId}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(receipt),
    });

    // Fetch the credential
    const credsRes = await relay.app.request(`/api/v1/agents/${workerMotebitId}/credentials`, {
      headers: AUTH_HEADER,
    });
    const credsBody = (await credsRes.json()) as {
      credentials: Array<{ credential: Record<string, unknown> }>;
    };
    expect(credsBody.credentials.length).toBeGreaterThanOrEqual(1);
    const credential = credsBody.credentials[0]!.credential;

    // Verify the credential via the public endpoint (no auth required)
    const verifyRes = await relay.app.request("/api/v1/credentials/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(credential),
    });
    expect(verifyRes.status).toBe(200);
    const verifyBody = (await verifyRes.json()) as {
      valid: boolean;
      issuer: string;
      subject: string;
    };
    expect(verifyBody.valid).toBe(true);
    expect(verifyBody.issuer).toMatch(/^did:key:/);
    expect(verifyBody.subject).toBeTruthy();
  });

  // === Execution Ledger Round-Trip ===

  it("execution ledger: POST and GET round-trip", async () => {
    const goalId = "goal-ledger-test";
    const planId = "plan-ledger-test";
    const now = Date.now();

    const timeline = [
      { timestamp: now, type: "goal_started", payload: { goal_id: goalId } },
      {
        timestamp: now + 10,
        type: "plan_created",
        payload: { plan_id: planId, title: "Ledger Test Plan", total_steps: 1 },
      },
      {
        timestamp: now + 20,
        type: "step_started",
        payload: { plan_id: planId, step_id: "step-1", ordinal: 0, description: "Run task" },
      },
      {
        timestamp: now + 30,
        type: "step_completed",
        payload: { plan_id: planId, step_id: "step-1", ordinal: 0, tool_calls_made: 2 },
      },
      { timestamp: now + 40, type: "plan_completed", payload: { plan_id: planId } },
      {
        timestamp: now + 50,
        type: "goal_completed",
        payload: { goal_id: goalId, status: "completed" },
      },
    ];

    // Compute content_hash per spec §5: canonical JSON per entry, joined by \n, SHA-256
    function canonicalJson(obj: unknown): string {
      if (obj === null || obj === undefined) return JSON.stringify(obj);
      if (typeof obj !== "object") return JSON.stringify(obj);
      if (Array.isArray(obj)) {
        return "[" + obj.map((item) => canonicalJson(item)).join(",") + "]";
      }
      const sorted = Object.keys(obj as Record<string, unknown>).sort();
      const entries = sorted.map(
        (key) => JSON.stringify(key) + ":" + canonicalJson((obj as Record<string, unknown>)[key]),
      );
      return "{" + entries.join(",") + "}";
    }

    const canonicalEntries = timeline.map((e) => canonicalJson(e));
    const joined = canonicalEntries.join("\n");
    const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(joined));
    const contentHash = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const ledger = {
      spec: "motebit/execution-ledger@1.0",
      motebit_id: MOTEBIT_ID,
      goal_id: goalId,
      plan_id: planId,
      started_at: now,
      completed_at: now + 50,
      status: "completed",
      timeline,
      steps: [
        {
          step_id: "step-1",
          ordinal: 0,
          description: "Run task",
          status: "completed",
          tools_used: ["shell_exec", "read_file"],
          tool_calls: 2,
          started_at: now + 20,
          completed_at: now + 30,
        },
      ],
      delegation_receipts: [],
      content_hash: contentHash,
    };

    // POST ledger
    const postRes = await relay.app.request(`/agent/${MOTEBIT_ID}/ledger`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(ledger),
    });
    expect(postRes.status).toBe(201);
    const postBody = (await postRes.json()) as { ledger_id: string; content_hash: string };
    expect(postBody.ledger_id).toBeTruthy();
    expect(postBody.content_hash).toBe(contentHash);

    // GET ledger back
    const getRes = await relay.app.request(`/agent/${MOTEBIT_ID}/ledger/${goalId}`, {
      headers: AUTH_HEADER,
    });
    expect(getRes.status).toBe(200);
    const retrieved = (await getRes.json()) as Record<string, unknown>;

    expect(retrieved.spec).toBe("motebit/execution-ledger@1.0");
    expect(retrieved.motebit_id).toBe(MOTEBIT_ID);
    expect(retrieved.goal_id).toBe(goalId);
    expect(retrieved.plan_id).toBe(planId);
    expect(retrieved.content_hash).toBe(contentHash);
    expect(retrieved.status).toBe("completed");
    expect(Array.isArray(retrieved.timeline)).toBe(true);
    expect((retrieved.timeline as unknown[]).length).toBe(6);
    expect(Array.isArray(retrieved.steps)).toBe(true);
    expect((retrieved.steps as unknown[]).length).toBe(1);
    expect(Array.isArray(retrieved.delegation_receipts)).toBe(true);
  });

  it("execution ledger: rejects invalid spec version", async () => {
    const res = await relay.app.request(`/agent/${MOTEBIT_ID}/ledger`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        spec: "motebit/execution-ledger@2.0",
        motebit_id: MOTEBIT_ID,
        goal_id: "goal-bad",
        content_hash: "abc123",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("execution-ledger@1.0");
  });

  it("execution ledger: rejects motebit_id mismatch", async () => {
    const res = await relay.app.request(`/agent/${MOTEBIT_ID}/ledger`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        spec: "motebit/execution-ledger@1.0",
        motebit_id: "wrong-motebit",
        goal_id: "goal-bad",
        content_hash: "abc123",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("does not match");
  });

  // === Budget Verification in Delegation Flow ===

  it("budget lock + settlement on delegation with priced service listing", async () => {
    // Register the worker agent with a service listing that includes pricing
    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        motebit_id: workerMotebitId,
        endpoint_url: "http://localhost:9999/mcp",
        capabilities: ["stdio_mcp"],
      }),
    });

    // Create a service listing with pricing for stdio_mcp
    await relay.app.request(`/api/v1/agents/${workerMotebitId}/listing`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        capabilities: ["stdio_mcp"],
        pricing: [{ capability: "stdio_mcp", unit_cost: 0.05, currency: "USD", per: "task" }],
        sla: { max_latency_ms: 3000, availability_guarantee: 0.99 },
        description: "Worker agent for budget test",
      }),
    });

    // Connect worker device to relay
    const workerWs = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    relay.connections.set(workerMotebitId, [
      { ws: workerWs as never, deviceId: "worker-device", capabilities: ["stdio_mcp"] },
    ]);

    // Submit task with max_budget — this should trigger budget lock
    const taskRes = await relay.app.request(`/agent/${MOTEBIT_ID}/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        prompt: "Budget test task",
        required_capabilities: ["stdio_mcp"],
        max_budget: 1.0,
      }),
    });
    expect(taskRes.status).toBe(201);
    const { task_id: taskId } = (await taskRes.json()) as { task_id: string };

    // Check budget BEFORE receipt — should show locked funds
    const budgetBeforeRes = await relay.app.request(`/agent/${MOTEBIT_ID}/budget`, {
      headers: AUTH_HEADER,
    });
    expect(budgetBeforeRes.status).toBe(200);
    const budgetBefore = (await budgetBeforeRes.json()) as {
      summary: { total_locked: number; total_settled: number };
      allocations: Array<Record<string, unknown>>;
    };
    expect(budgetBefore.summary.total_locked).toBeGreaterThan(0);

    // Worker posts successful receipt
    const receipt = await makeReceipt(taskId);
    const receiptRes = await relay.app.request(`/agent/${MOTEBIT_ID}/task/${taskId}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(receipt),
    });
    expect(receiptRes.status).toBe(200);

    // Check budget AFTER receipt — should show settlement
    const budgetAfterRes = await relay.app.request(`/agent/${MOTEBIT_ID}/budget`, {
      headers: AUTH_HEADER,
    });
    expect(budgetAfterRes.status).toBe(200);
    const budgetAfter = (await budgetAfterRes.json()) as {
      summary: { total_locked: number; total_settled: number };
      allocations: Array<Record<string, unknown>>;
    };
    // After settlement, locked amount should decrease (allocation moved from locked to settled)
    expect(budgetAfter.summary.total_locked).toBe(0);
    expect(budgetAfter.summary.total_settled).toBeGreaterThan(0);
    // At least one allocation should show settlement info
    const settledAlloc = budgetAfter.allocations.find((a) => a.settlement_id != null);
    expect(settledAlloc).toBeDefined();
  });
});
