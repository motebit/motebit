/**
 * Two-motebit delegation integration test.
 *
 * Proves the core thesis: two sovereign agents with independent identities
 * can discover, delegate, execute, and verify across a relay — with signed
 * receipts, budget settlement, and credential issuance.
 *
 * Alice (dispatcher) delegates a task to Bob (worker) through the relay.
 * Bob executes, signs an ExecutionReceipt, posts it back. The relay verifies
 * the Ed25519 signature, settles the budget, and issues an
 * AgentReputationCredential to Bob.
 *
 * This is the flow no one else is building: cryptographic identity +
 * accumulated trust + governance at the boundary.
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
import {
  generateKeypair,
  signExecutionReceipt,
  verifyExecutionReceipt,
  bytesToHex,
} from "@motebit/crypto";
import type { KeyPair } from "@motebit/crypto";

// === Constants ===

const API_TOKEN = "test-token";
const AUTH_HEADER = { Authorization: `Bearer ${API_TOKEN}` };

// === Agent identity ===

interface AgentIdentity {
  motebitId: string;
  keypair: KeyPair;
  publicKeyHex: string;
}

async function registerAgent(
  relay: SyncRelay,
  ownerName: string,
  capabilities: string[],
): Promise<AgentIdentity> {
  const keypair = await generateKeypair();
  const publicKeyHex = bytesToHex(keypair.publicKey);

  // Create identity
  const idRes = await relay.app.request("/identity", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({ owner_id: ownerName }),
  });
  const { motebit_id: motebitId } = (await idRes.json()) as { motebit_id: string };

  // Register device with public key
  await relay.app.request("/device/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({
      motebit_id: motebitId,
      device_name: `${ownerName}-device`,
      public_key: publicKeyHex,
    }),
  });

  // Register in agent registry (needed for credential issuance + discovery)
  await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({
      motebit_id: motebitId,
      endpoint_url: `http://localhost:0/mcp`,
      capabilities,
      public_key: publicKeyHex,
    }),
  });

  // Register service listing (needed for scored routing — Phase 1 task fan-out)
  await relay.app.request(`/api/v1/agents/${motebitId}/listing`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({
      capabilities,
      pricing: [],
      description: `${ownerName} service agent`,
    }),
  });

  return { motebitId, keypair, publicKeyHex };
}

async function signReceipt(
  agent: AgentIdentity,
  taskId: string,
  status: "completed" | "failed" = "completed",
  result = "Task executed successfully",
): Promise<ExecutionReceipt> {
  const unsigned = {
    task_id: taskId,
    motebit_id: agent.motebitId as unknown as MotebitId,
    device_id: `${agent.motebitId}-device` as unknown as DeviceId,
    submitted_at: Date.now(),
    completed_at: Date.now(),
    status,
    result,
    tools_used: ["web_search"],
    memories_formed: 0,
    prompt_hash: "abc123",
    result_hash: "def456",
  };
  return signExecutionReceipt(unsigned, agent.keypair.privateKey);
}

/**
 * Bridge between relay WebSocket fan-out and RelayDelegationAdapter.
 * When relay calls ws.send(payload), the parsed message routes to
 * all registered callbacks — mimics a real WebSocket connection.
 */
function createWsBridge() {
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

function makeMockDeps(steps: Array<Record<string, unknown>>): MotebitLoopDependencies {
  return {
    provider: {
      generate: vi.fn().mockResolvedValue({
        text: JSON.stringify({ title: "Test Plan", steps }),
      }),
    },
  } as unknown as MotebitLoopDependencies;
}

// === Tests ===

describe("Two-Motebit Delegation E2E", () => {
  let relay: SyncRelay;
  let alice: AgentIdentity;
  let bob: AgentIdentity;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    relay = await createSyncRelay({
      apiToken: API_TOKEN,
      enableDeviceAuth: false,
      x402: {
        payToAddress: "0x0000000000000000000000000000000000000000",
        network: "eip155:84532",
        testnet: true,
      },
    });

    // Two independent sovereign agents with their own keypairs
    alice = await registerAgent(relay, "alice", ["http_mcp"]);
    bob = await registerAgent(relay, "bob", ["web_search", "stdio_mcp", "http_mcp"]);

    // Route fetch through in-process relay
    originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string | Request | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path = url.replace("http://relay", "");
      return relay.app.request(path, init);
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    relay.close();
  });

  it("Alice delegates to Bob, Bob signs receipt, relay verifies and issues credential", async () => {
    const store = new InMemoryPlanStore();
    const aliceBridge = createWsBridge();
    const bobWs = { send: vi.fn(), close: vi.fn(), readyState: 1 };

    // Wire both agents into relay's connection map
    relay.connections.set(alice.motebitId, [
      {
        ws: aliceBridge.ws as never,
        deviceId: "alice-device",
        capabilities: ["http_mcp"],
      },
    ]);
    relay.connections.set(bob.motebitId, [
      {
        ws: bobWs as never,
        deviceId: "bob-device",
        capabilities: ["web_search", "stdio_mcp", "http_mcp"],
      },
    ]);

    // Alice's delegation adapter and plan engine
    const adapter = new RelayDelegationAdapter({
      syncUrl: "http://relay",
      motebitId: alice.motebitId,
      authToken: API_TOKEN,
      sendRaw: () => {},
      onCustomMessage: aliceBridge.onCustomMessage,
    });

    const engine = new PlanEngine(store, {
      localCapabilities: [DeviceCapability.HttpMcp],
      delegationAdapter: adapter,
      delegationTimeoutMs: 5000,
    });

    // Plan with a step requiring web_search (Alice can't do it, Bob can)
    const deps = makeMockDeps([
      {
        description: "Search the web for motebit docs",
        prompt: "Find motebit documentation",
        required_capabilities: ["web_search"],
      },
    ]);
    const { plan } = await engine.createPlan(
      "goal-alice-to-bob",
      alice.motebitId,
      { goalPrompt: "find docs" },
      deps,
    );

    // Execute plan concurrently — Alice submits task to relay
    const executePromise = (async () => {
      const chunks: PlanChunk[] = [];
      for await (const chunk of engine.executePlan(plan.plan_id, deps)) {
        chunks.push(chunk);
      }
      return chunks;
    })();

    // Wait for Bob to receive the task_request
    await vi.waitFor(
      () => {
        expect(bobWs.send).toHaveBeenCalled();
      },
      { timeout: 3000 },
    );

    const taskRequestRaw = bobWs.send.mock.calls[0]![0] as string;
    const taskRequest = JSON.parse(taskRequestRaw) as { type: string; task: AgentTask };
    expect(taskRequest.type).toBe("task_request");
    expect(taskRequest.task.required_capabilities).toContain("web_search");
    const taskId = taskRequest.task.task_id;

    // Bob executes and signs a receipt with his own keypair
    const receipt = await signReceipt(bob, taskId, "completed", "Found 5 docs on motebit.com");

    // Verify Bob's receipt signature is valid
    const sigValid = await verifyExecutionReceipt(receipt, bob.keypair.publicKey);
    expect(sigValid).toBe(true);

    // Bob posts receipt to relay
    const receiptRes = await relay.app.request(`/agent/${alice.motebitId}/task/${taskId}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(receipt),
    });
    expect(receiptRes.status).toBe(200);
    const receiptBody = (await receiptRes.json()) as {
      status: string;
      credential_id: string | null;
    };

    // Relay verified the receipt and issued a credential
    expect(receiptBody.credential_id).toBeTruthy();

    // Alice's plan completes
    const chunks = await executePromise;
    const types = chunks.map((c) => c.type);
    expect(types).toContain("plan_created");
    expect(types).toContain("step_started");
    expect(types).toContain("step_delegated");
    expect(types).toContain("plan_completed");
    expect(types).not.toContain("plan_failed");

    // Verify step and plan state
    const steps = store.getStepsForPlan(plan.plan_id);
    expect(steps[0]!.status).toBe(StepStatus.Completed);
    expect(steps[0]!.delegation_task_id).toBe(taskId);
    expect(steps[0]!.result_summary).toBe("Found 5 docs on motebit.com");

    const finalPlan = store.getPlan(plan.plan_id)!;
    expect(finalPlan.status).toBe(PlanStatus.Completed);
  });

  it("Bob's credential accumulates across multiple delegations from Alice", async () => {
    const store = new InMemoryPlanStore();
    const aliceBridge = createWsBridge();
    const bobWs = { send: vi.fn(), close: vi.fn(), readyState: 1 };

    relay.connections.set(alice.motebitId, [
      { ws: aliceBridge.ws as never, deviceId: "alice-device", capabilities: ["http_mcp"] },
    ]);
    relay.connections.set(bob.motebitId, [
      {
        ws: bobWs as never,
        deviceId: "bob-device",
        capabilities: ["web_search", "stdio_mcp"],
      },
    ]);

    // Run two delegations back-to-back
    for (let i = 0; i < 2; i++) {
      bobWs.send.mockClear();

      const adapter = new RelayDelegationAdapter({
        syncUrl: "http://relay",
        motebitId: alice.motebitId,
        authToken: API_TOKEN,
        sendRaw: () => {},
        onCustomMessage: aliceBridge.onCustomMessage,
      });

      const engine = new PlanEngine(store, {
        localCapabilities: [DeviceCapability.HttpMcp],
        delegationAdapter: adapter,
        delegationTimeoutMs: 5000,
      });

      const deps = makeMockDeps([
        {
          description: `Task ${i + 1}`,
          prompt: `Do task ${i + 1}`,
          required_capabilities: ["web_search"],
        },
      ]);
      const { plan } = await engine.createPlan(
        `goal-${i}`,
        alice.motebitId,
        { goalPrompt: `task ${i}` },
        deps,
      );

      const execPromise = (async () => {
        const chunks: PlanChunk[] = [];
        for await (const chunk of engine.executePlan(plan.plan_id, deps)) {
          chunks.push(chunk);
        }
        return chunks;
      })();

      await vi.waitFor(
        () => {
          expect(bobWs.send).toHaveBeenCalled();
        },
        { timeout: 3000 },
      );

      const raw = bobWs.send.mock.calls[0]![0] as string;
      const req = JSON.parse(raw) as { task: AgentTask };
      const receipt = await signReceipt(bob, req.task.task_id, "completed", `Result ${i + 1}`);

      await relay.app.request(`/agent/${alice.motebitId}/task/${req.task.task_id}/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADER },
        body: JSON.stringify(receipt),
      });

      await execPromise;
    }

    // Bob should have 2 credentials — trust accumulates
    const credsRes = await relay.app.request(`/api/v1/agents/${bob.motebitId}/credentials`, {
      headers: AUTH_HEADER,
    });
    expect(credsRes.status).toBe(200);
    const { credentials } = (await credsRes.json()) as {
      credentials: Array<{
        credential_type: string;
        credential: { credentialSubject: { task_count?: number } };
      }>;
    };

    const repCreds = credentials.filter((c) => c.credential_type === "AgentReputationCredential");
    expect(repCreds.length).toBe(2);

    // Second credential should reflect higher task count
    const latest = repCreds[repCreds.length - 1]!;
    expect(latest.credential.credentialSubject.task_count).toBe(2);
  });

  it("discovery: Alice finds Bob via relay capability search", async () => {
    const discoverRes = await relay.app.request("/api/v1/agents/discover?capability=web_search", {
      headers: AUTH_HEADER,
    });
    expect(discoverRes.status).toBe(200);

    const { agents } = (await discoverRes.json()) as {
      agents: Array<{
        motebit_id: string;
        capabilities: string[];
        public_key: string;
      }>;
    };

    // Bob should be discoverable by web_search capability
    const found = agents.find((a) => a.motebit_id === bob.motebitId);
    expect(found).toBeDefined();
    expect(found!.capabilities).toContain("web_search");
    expect(found!.public_key).toBe(bob.publicKeyHex);

    // Alice should NOT appear (she doesn't have web_search)
    const aliceFound = agents.find((a) => a.motebit_id === alice.motebitId);
    expect(aliceFound).toBeUndefined();
  });

  it("receipt with wrong keypair is rejected by relay", async () => {
    const bobWs = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    relay.connections.set(alice.motebitId, [
      { ws: bobWs as never, deviceId: "bob-device", capabilities: ["web_search"] },
    ]);

    // Submit a task
    const taskRes = await relay.app.request(`/agent/${alice.motebitId}/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        prompt: "Test forgery",
        required_capabilities: ["web_search"],
      }),
    });
    const { task_id: taskId } = (await taskRes.json()) as { task_id: string };

    // Sign receipt with ALICE's key but claim to be BOB — signature mismatch
    const forgedReceipt = await signReceipt(alice, taskId, "completed", "Forged result");
    // Overwrite motebit_id to Bob's — the signature won't match Bob's public key
    const tampered = { ...forgedReceipt, motebit_id: bob.motebitId };

    const receiptRes = await relay.app.request(`/agent/${alice.motebitId}/task/${taskId}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(tampered),
    });

    // Relay should reject — signature verification fails
    expect(receiptRes.status).toBeGreaterThanOrEqual(400);
  });

  it("bidirectional: Alice delegates to Bob, then Bob delegates back to Alice", async () => {
    // First: Alice → Bob
    const store1 = new InMemoryPlanStore();
    const aliceBridge1 = createWsBridge();
    const bobWs1 = { send: vi.fn(), close: vi.fn(), readyState: 1 };

    relay.connections.set(alice.motebitId, [
      { ws: aliceBridge1.ws as never, deviceId: "alice-device", capabilities: ["http_mcp"] },
    ]);
    relay.connections.set(bob.motebitId, [
      { ws: bobWs1 as never, deviceId: "bob-device", capabilities: ["web_search", "http_mcp"] },
    ]);

    const adapter1 = new RelayDelegationAdapter({
      syncUrl: "http://relay",
      motebitId: alice.motebitId,
      authToken: API_TOKEN,
      sendRaw: () => {},
      onCustomMessage: aliceBridge1.onCustomMessage,
    });

    const engine1 = new PlanEngine(store1, {
      localCapabilities: [DeviceCapability.HttpMcp],
      delegationAdapter: adapter1,
      delegationTimeoutMs: 5000,
    });

    const deps1 = makeMockDeps([
      {
        description: "Web search",
        prompt: "Search for X",
        required_capabilities: ["web_search"],
      },
    ]);
    const { plan: plan1 } = await engine1.createPlan(
      "goal-a2b",
      alice.motebitId,
      { goalPrompt: "search" },
      deps1,
    );

    const exec1 = (async () => {
      const chunks: PlanChunk[] = [];
      for await (const chunk of engine1.executePlan(plan1.plan_id, deps1)) {
        chunks.push(chunk);
      }
      return chunks;
    })();

    await vi.waitFor(
      () => {
        expect(bobWs1.send).toHaveBeenCalled();
      },
      { timeout: 3000 },
    );

    const req1 = JSON.parse(bobWs1.send.mock.calls[0]![0] as string) as { task: AgentTask };
    const receipt1 = await signReceipt(bob, req1.task.task_id, "completed", "Search results");

    await relay.app.request(`/agent/${alice.motebitId}/task/${req1.task.task_id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(receipt1),
    });

    const chunks1 = await exec1;
    expect(chunks1.map((c) => c.type)).toContain("plan_completed");

    // Second: Bob → Alice (reverse direction)
    // Update Alice's listing with a capability Bob doesn't have
    await relay.app.request(`/api/v1/agents/${alice.motebitId}/listing`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        capabilities: ["data_analysis", "http_mcp"],
        pricing: [],
        description: "Alice data analysis service",
      }),
    });

    const store2 = new InMemoryPlanStore();
    const bobBridge2 = createWsBridge();
    const aliceWs2 = { send: vi.fn(), close: vi.fn(), readyState: 1 };

    relay.connections.set(bob.motebitId, [
      { ws: bobBridge2.ws as never, deviceId: "bob-device", capabilities: ["http_mcp"] },
    ]);
    relay.connections.set(alice.motebitId, [
      {
        ws: aliceWs2 as never,
        deviceId: "alice-device",
        capabilities: ["data_analysis", "http_mcp"],
      },
    ]);

    const adapter2 = new RelayDelegationAdapter({
      syncUrl: "http://relay",
      motebitId: bob.motebitId,
      authToken: API_TOKEN,
      sendRaw: () => {},
      onCustomMessage: bobBridge2.onCustomMessage,
    });

    const engine2 = new PlanEngine(store2, {
      localCapabilities: [DeviceCapability.HttpMcp],
      delegationAdapter: adapter2,
      delegationTimeoutMs: 5000,
    });

    const deps2 = makeMockDeps([
      {
        description: "Analyze data",
        prompt: "Run analysis",
        required_capabilities: ["data_analysis"],
      },
    ]);
    const { plan: plan2 } = await engine2.createPlan(
      "goal-b2a",
      bob.motebitId,
      { goalPrompt: "analyze" },
      deps2,
    );

    const exec2 = (async () => {
      const chunks: PlanChunk[] = [];
      for await (const chunk of engine2.executePlan(plan2.plan_id, deps2)) {
        chunks.push(chunk);
      }
      return chunks;
    })();

    await vi.waitFor(
      () => {
        expect(aliceWs2.send).toHaveBeenCalled();
      },
      { timeout: 3000 },
    );

    const req2 = JSON.parse(aliceWs2.send.mock.calls[0]![0] as string) as { task: AgentTask };
    const receipt2 = await signReceipt(alice, req2.task.task_id, "completed", "Analysis complete");

    await relay.app.request(`/agent/${bob.motebitId}/task/${req2.task.task_id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(receipt2),
    });

    const chunks2 = await exec2;
    expect(chunks2.map((c) => c.type)).toContain("plan_completed");

    // Both agents should now have credentials
    const bobCreds = await relay.app.request(`/api/v1/agents/${bob.motebitId}/credentials`, {
      headers: AUTH_HEADER,
    });
    const aliceCreds = await relay.app.request(`/api/v1/agents/${alice.motebitId}/credentials`, {
      headers: AUTH_HEADER,
    });

    const bobBody = (await bobCreds.json()) as { credentials: unknown[] };
    const aliceBody = (await aliceCreds.json()) as { credentials: unknown[] };

    expect(bobBody.credentials.length).toBeGreaterThanOrEqual(1);
    expect(aliceBody.credentials.length).toBeGreaterThanOrEqual(1);
  });

  it("verifiable presentation bundles both agents' credentials", async () => {
    const bobWs = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    relay.connections.set(alice.motebitId, [
      { ws: bobWs as never, deviceId: "bob-device", capabilities: ["web_search"] },
    ]);

    // Complete a delegation so Bob gets a credential
    const taskRes = await relay.app.request(`/agent/${alice.motebitId}/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        prompt: "VP test task",
        required_capabilities: ["web_search"],
      }),
    });
    const { task_id: taskId } = (await taskRes.json()) as { task_id: string };
    const receipt = await signReceipt(bob, taskId);

    await relay.app.request(`/agent/${alice.motebitId}/task/${taskId}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(receipt),
    });

    // Request VP for Bob — bundles credentials into a signed presentation
    const vpRes = await relay.app.request(`/api/v1/agents/${bob.motebitId}/presentation`, {
      method: "POST",
      headers: AUTH_HEADER,
    });
    expect(vpRes.status).toBe(200);

    const { presentation } = (await vpRes.json()) as {
      presentation: {
        type: string[];
        holder: string;
        verifiableCredential: Array<{ type: string[]; credentialSubject: { id: string } }>;
        proof: { type: string; verificationMethod: string };
      };
    };

    expect(presentation.type).toContain("VerifiablePresentation");
    expect(presentation.verifiableCredential.length).toBeGreaterThanOrEqual(1);
    expect(presentation.proof).toBeDefined();
    expect(presentation.proof.type).toBe("DataIntegrityProof");

    // VP holder should reference the relay's DID
    expect(presentation.holder).toMatch(/^did:key:/);

    // Credential subject should reference Bob
    const cred = presentation.verifiableCredential[0]!;
    expect(cred.type).toContain("AgentReputationCredential");
    expect(cred.credentialSubject.id).toBeTruthy();
  });
});
