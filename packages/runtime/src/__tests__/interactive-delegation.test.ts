import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  MotebitRuntime,
  NullRenderer,
  createInMemoryStorage,
  InMemoryAgentTrustStore,
} from "../index";
import type { PlatformAdapters, StreamChunk } from "../index";
import type { StreamingProvider, AgenticChunk, TurnResult } from "@motebit/ai-core";
import type { AIResponse, ContextPack, ExecutionReceipt, AgentTask } from "@motebit/sdk";
import { TrustMode, BatteryMode, AgentTaskStatus, AgentTrustLevel } from "@motebit/sdk";
import type { AgentServiceListing } from "@motebit/sdk";
import { generateKeypair } from "@motebit/encryption";
import type { ServiceListingStoreAdapter } from "../index";

// === Mock ai-core: intercept runTurnStreaming to simulate AI calling delegate_to_agent ===

const mockRunTurnStreaming = vi.fn();

vi.mock("@motebit/ai-core", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@motebit/ai-core");
  return {
    ...actual,
    runTurnStreaming: (...args: unknown[]) =>
      mockRunTurnStreaming(...args) as AsyncGenerator<AgenticChunk>,
    summarizeConversation: vi.fn().mockResolvedValue("mock summary"),
    shouldSummarize: vi.fn().mockReturnValue(false),
  };
});

// === Mock fetch (relay HTTP) ===

const originalFetch = globalThis.fetch;
let mockFetchHandler: (url: string, init?: RequestInit) => Promise<Response>;

// === Helpers ===

function createMockProvider(): StreamingProvider {
  const response: AIResponse = {
    text: "Here are the search results.",
    confidence: 0.8,
    memory_candidates: [],
    state_updates: {},
  };

  return {
    model: "mock-model",
    setModel: vi.fn(),
    generate: vi.fn<(ctx: ContextPack) => Promise<AIResponse>>().mockResolvedValue(response),
    estimateConfidence: vi.fn<() => Promise<number>>().mockResolvedValue(0.8),
    extractMemoryCandidates: vi.fn<(r: AIResponse) => Promise<never[]>>().mockResolvedValue([]),
    async *generateStream(_ctx: ContextPack) {
      yield { type: "text" as const, text: response.text };
      yield { type: "done" as const, response };
    },
  };
}

class InMemoryServiceListingStore implements ServiceListingStoreAdapter {
  private listings = new Map<string, AgentServiceListing>();
  async get(mid: string): Promise<AgentServiceListing | null> {
    return this.listings.get(mid) ?? null;
  }
  async set(l: AgentServiceListing): Promise<void> {
    this.listings.set(l.motebit_id, l);
  }
  async list(): Promise<AgentServiceListing[]> {
    return [...this.listings.values()];
  }
  async delete(lid: string): Promise<void> {
    for (const [k, v] of this.listings) {
      if (v.listing_id === lid) this.listings.delete(k);
    }
  }
}

function createAdapters(provider: StreamingProvider): PlatformAdapters {
  return {
    storage: createInMemoryStorage(),
    renderer: new NullRenderer(),
    ai: provider,
  };
}

function makeTurnResult(response = "Mock response"): TurnResult {
  return {
    response,
    memoriesFormed: [],
    memoriesRetrieved: [],
    stateAfter: {
      attention: 0.5,
      processing: 0.1,
      confidence: 0.7,
      affect_valence: 0,
      affect_arousal: 0,
      social_distance: 0.5,
      curiosity: 0.3,
      trust_mode: TrustMode.Guarded,
      battery_mode: BatteryMode.Normal,
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
  };
}

async function* yieldChunks(...chunks: AgenticChunk[]): AsyncGenerator<AgenticChunk> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

async function collectChunks(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

function fakeReceipt(overrides?: Partial<ExecutionReceipt>): ExecutionReceipt {
  return {
    task_id: "relay-task-001",
    motebit_id: "remote-agent-001",
    device_id: "remote-device-001",
    submitted_at: Date.now() - 5000,
    completed_at: Date.now(),
    status: "completed",
    result: "Search results: motebit is a sovereign AI agent framework.",
    tools_used: ["web_search"],
    memories_formed: 0,
    prompt_hash: "a".repeat(64),
    result_hash: "b".repeat(64),
    suite: "motebit-jcs-ed25519-b64-v1",
    signature: "fake-sig-for-test",
    ...overrides,
  };
}

// === Test Suite ===

describe("Interactive Delegation (delegate_to_agent tool)", () => {
  beforeEach(() => {
    mockRunTurnStreaming.mockReset();
    // Default: no-op fetch
    mockFetchHandler = async () => new Response("not found", { status: 404 });
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      // Only intercept relay calls
      if (url.includes("mock-relay.test")) {
        return mockFetchHandler(url, init);
      }
      return originalFetch(input, init);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("registers delegate_to_agent tool when enableInteractiveDelegation is called", () => {
    const runtime = new MotebitRuntime(
      { motebitId: "alice-001", tickRateHz: 0 },
      createAdapters(createMockProvider()),
    );

    runtime.enableInteractiveDelegation({
      syncUrl: "https://mock-relay.test",
      authToken: async () => "test-token",
    });

    const tools = runtime.getToolRegistry();
    expect(tools.has("delegate_to_agent")).toBe(true);
    const def = tools.get("delegate_to_agent");
    expect(def?.description).toContain("Delegate a task to a remote agent");
    expect(def?.inputSchema).toBeDefined();
  });

  it("does not double-register on repeated calls", () => {
    const runtime = new MotebitRuntime(
      { motebitId: "alice-001", tickRateHz: 0 },
      createAdapters(createMockProvider()),
    );

    runtime.enableInteractiveDelegation({
      syncUrl: "https://mock-relay.test",
      authToken: async () => "test-token",
    });
    runtime.enableInteractiveDelegation({
      syncUrl: "https://mock-relay.test",
      authToken: async () => "test-token",
    });

    // Would throw "already registered" if double-registered
    expect(runtime.getToolRegistry().has("delegate_to_agent")).toBe(true);
  });

  it("submits task to relay and returns result on successful delegation", async () => {
    const provider = createMockProvider();
    const runtime = new MotebitRuntime(
      { motebitId: "alice-001", tickRateHz: 0 },
      createAdapters(provider),
    );

    const receipt = fakeReceipt();
    let submitCalled = false;
    let pollCount = 0;

    mockFetchHandler = async (url: string, init?: RequestInit) => {
      // Task submission
      if (url.includes("/agent/alice-001/task") && init?.method === "POST") {
        submitCalled = true;
        const body = JSON.parse(init.body as string);
        expect(body.prompt).toBe("search the web for motebit");
        expect(body.submitted_by).toBe("alice-001");
        expect(body.required_capabilities).toEqual(["web_search"]);
        return new Response(JSON.stringify({ task_id: "relay-task-001", status: "pending" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Task polling
      if (
        url.includes("/agent/alice-001/task/relay-task-001") &&
        (!init?.method || init.method === "GET")
      ) {
        pollCount++;
        return new Response(JSON.stringify({ task: { status: "completed" }, receipt }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    };

    runtime.enableInteractiveDelegation({
      syncUrl: "https://mock-relay.test",
      authToken: async () => "test-token",
    });

    // Execute the tool directly
    const result = await runtime.getToolRegistry().execute("delegate_to_agent", {
      prompt: "search the web for motebit",
      required_capabilities: ["web_search"],
    });

    expect(submitCalled).toBe(true);
    expect(pollCount).toBeGreaterThanOrEqual(1);
    expect(result.ok).toBe(true);
    expect(result.data).toContain("motebit is a sovereign AI agent framework");
  });

  it("returns error on relay submission failure (402 insufficient budget)", async () => {
    const runtime = new MotebitRuntime(
      { motebitId: "alice-001", tickRateHz: 0 },
      createAdapters(createMockProvider()),
    );

    mockFetchHandler = async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response("Insufficient budget", { status: 402 });
      }
      return new Response("not found", { status: 404 });
    };

    runtime.enableInteractiveDelegation({
      syncUrl: "https://mock-relay.test",
      authToken: async () => "test-token",
    });

    const result = await runtime.getToolRegistry().execute("delegate_to_agent", {
      prompt: "search something",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("402");
  });

  it("returns error on timeout (no receipt within deadline)", async () => {
    const runtime = new MotebitRuntime(
      { motebitId: "alice-001", tickRateHz: 0 },
      createAdapters(createMockProvider()),
    );

    mockFetchHandler = async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ task_id: "task-timeout", status: "pending" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Always return pending (no receipt)
      return new Response(JSON.stringify({ task: { status: "running" }, receipt: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    runtime.enableInteractiveDelegation({
      syncUrl: "https://mock-relay.test",
      authToken: async () => "test-token",
      timeoutMs: 3000, // 3s timeout → ~1 poll
    });

    const result = await runtime.getToolRegistry().execute("delegate_to_agent", {
      prompt: "this will timeout",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("timed out");
  }, 10_000);

  it("returns error when auth token generation fails", async () => {
    const runtime = new MotebitRuntime(
      { motebitId: "alice-001", tickRateHz: 0 },
      createAdapters(createMockProvider()),
    );

    runtime.enableInteractiveDelegation({
      syncUrl: "https://mock-relay.test",
      authToken: async () => {
        throw new Error("keyring locked");
      },
    });

    const result = await runtime.getToolRegistry().execute("delegate_to_agent", {
      prompt: "auth will fail",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Auth failed");
    expect(result.error).toContain("keyring locked");
  });

  it("stashes receipt for handleAgentTask to drain into delegation_receipts", async () => {
    const runtime = new MotebitRuntime(
      { motebitId: "alice-001", tickRateHz: 0 },
      createAdapters(createMockProvider()),
    );

    const receipt = fakeReceipt();
    mockFetchHandler = async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ task_id: "relay-task-001", status: "pending" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ task: { status: "completed" }, receipt }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    runtime.enableInteractiveDelegation({
      syncUrl: "https://mock-relay.test",
      authToken: async () => "test-token",
    });

    // Execute the tool
    await runtime.getToolRegistry().execute("delegate_to_agent", {
      prompt: "delegated work",
    });

    // Drain receipts — should contain the receipt from the delegation
    const drained = runtime.getAndResetInteractiveDelegationReceipts();
    expect(drained).toHaveLength(1);
    expect(drained[0]!.task_id).toBe("relay-task-001");
    expect(drained[0]!.motebit_id).toBe("remote-agent-001");

    // Second drain should be empty (already consumed)
    const drained2 = runtime.getAndResetInteractiveDelegationReceipts();
    expect(drained2).toHaveLength(0);
  });

  it("emits delegation_start and delegation_complete chunks during streaming", async () => {
    const provider = createMockProvider();
    const runtime = new MotebitRuntime(
      { motebitId: "alice-001", tickRateHz: 0 },
      createAdapters(provider),
    );

    const receipt = fakeReceipt();
    mockFetchHandler = async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ task_id: "relay-task-001", status: "pending" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ task: { status: "completed" }, receipt }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    runtime.enableInteractiveDelegation({
      syncUrl: "https://mock-relay.test",
      authToken: async () => "test-token",
    });

    // Mock runTurnStreaming to simulate the AI calling delegate_to_agent
    mockRunTurnStreaming.mockImplementation(function (_deps: {
      tools?: {
        list: () => unknown[];
        execute: (name: string, args: Record<string, unknown>) => Promise<unknown>;
      };
    }) {
      return yieldChunks(
        { type: "tool_status", name: "delegate_to_agent", status: "calling" },
        // The real loop would execute the tool here — we simulate the result
        { type: "tool_status", name: "delegate_to_agent", status: "done", result: receipt },
        { type: "text", text: "Based on the delegation results..." },
        { type: "result", result: makeTurnResult("Based on the delegation results...") },
      );
    });

    const chunks = await collectChunks(runtime.sendMessageStreaming("search the web for motebit"));

    const delegationStart = chunks.find((c) => c.type === "delegation_start");
    const delegationComplete = chunks.find((c) => c.type === "delegation_complete");

    expect(delegationStart).toBeDefined();
    if (delegationStart && delegationStart.type === "delegation_start") {
      expect(delegationStart.server).toBe("relay");
      expect(delegationStart.tool).toBe("delegate_to_agent");
    }

    expect(delegationComplete).toBeDefined();
    if (delegationComplete && delegationComplete.type === "delegation_complete") {
      expect(delegationComplete.server).toBe("relay");
    }
  });

  it("passes required_capabilities to relay when specified", async () => {
    const runtime = new MotebitRuntime(
      { motebitId: "alice-001", tickRateHz: 0 },
      createAdapters(createMockProvider()),
    );

    let submittedBody: Record<string, unknown> | null = null;
    const receipt = fakeReceipt();

    mockFetchHandler = async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        submittedBody = JSON.parse(init.body as string) as Record<string, unknown>;
        return new Response(JSON.stringify({ task_id: "relay-task-001", status: "pending" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ task: { status: "completed" }, receipt }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    runtime.enableInteractiveDelegation({
      syncUrl: "https://mock-relay.test",
      authToken: async () => "test-token",
    });

    await runtime.getToolRegistry().execute("delegate_to_agent", {
      prompt: "read this URL",
      required_capabilities: ["read_url"],
    });

    expect(submittedBody).not.toBeNull();
    expect(submittedBody!.required_capabilities).toEqual(["read_url"]);
  });

  it("omits required_capabilities from relay body when not specified", async () => {
    const runtime = new MotebitRuntime(
      { motebitId: "alice-001", tickRateHz: 0 },
      createAdapters(createMockProvider()),
    );

    let submittedBody: Record<string, unknown> | null = null;
    const receipt = fakeReceipt();

    mockFetchHandler = async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        submittedBody = JSON.parse(init.body as string) as Record<string, unknown>;
        return new Response(JSON.stringify({ task_id: "relay-task-001", status: "pending" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ task: { status: "completed" }, receipt }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    runtime.enableInteractiveDelegation({
      syncUrl: "https://mock-relay.test",
      authToken: async () => "test-token",
    });

    await runtime.getToolRegistry().execute("delegate_to_agent", {
      prompt: "just do something",
    });

    expect(submittedBody).not.toBeNull();
    expect(submittedBody!.required_capabilities).toBeUndefined();
  });

  it("includes delegation receipt in handleAgentTask parent receipt", async () => {
    const provider = createMockProvider();
    const runtime = new MotebitRuntime(
      { motebitId: "alice-001", tickRateHz: 0 },
      createAdapters(provider),
    );

    const delegationReceipt = fakeReceipt();
    mockFetchHandler = async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ task_id: "relay-task-001", status: "pending" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ task: { status: "completed" }, receipt: delegationReceipt }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    runtime.enableInteractiveDelegation({
      syncUrl: "https://mock-relay.test",
      authToken: async () => "test-token",
    });

    // Execute delegate_to_agent tool (simulating what the AI would do)
    await runtime.getToolRegistry().execute("delegate_to_agent", {
      prompt: "search the web",
      required_capabilities: ["web_search"],
    });

    // Now handleAgentTask should drain these receipts into the parent receipt
    const keypair = await generateKeypair();
    const task: AgentTask = {
      task_id: "parent-task-001",
      motebit_id: "alice-001",
      prompt: "search the web for motebit",
      submitted_at: Date.now(),
      status: AgentTaskStatus.Claimed,
    };

    let parentReceipt: ExecutionReceipt | null = null;
    for await (const chunk of runtime.handleAgentTask(task, keypair.privateKey, "device-001")) {
      if (chunk.type === "task_result") {
        parentReceipt = chunk.receipt;
      }
    }

    expect(parentReceipt).not.toBeNull();
    expect(parentReceipt!.delegation_receipts).toHaveLength(1);
    expect(parentReceipt!.delegation_receipts![0]!.task_id).toBe("relay-task-001");
    expect(parentReceipt!.delegation_receipts![0]!.motebit_id).toBe("remote-agent-001");
  });

  it("handles network failure during polling gracefully", async () => {
    const runtime = new MotebitRuntime(
      { motebitId: "alice-001", tickRateHz: 0 },
      createAdapters(createMockProvider()),
    );

    let pollAttempts = 0;
    const receipt = fakeReceipt();

    mockFetchHandler = async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ task_id: "relay-task-001", status: "pending" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      // First poll: network error. Second poll: success.
      pollAttempts++;
      if (pollAttempts === 1) {
        throw new Error("network timeout");
      }
      return new Response(JSON.stringify({ task: { status: "completed" }, receipt }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    runtime.enableInteractiveDelegation({
      syncUrl: "https://mock-relay.test",
      authToken: async () => "test-token",
    });

    const result = await runtime.getToolRegistry().execute("delegate_to_agent", {
      prompt: "retry after network failure",
    });

    expect(result.ok).toBe(true);
    expect(pollAttempts).toBe(2); // retried after first failure
  });

  it("sends auth header on both submission and polling", async () => {
    const runtime = new MotebitRuntime(
      { motebitId: "alice-001", tickRateHz: 0 },
      createAdapters(createMockProvider()),
    );

    const capturedHeaders: string[] = [];
    const receipt = fakeReceipt();

    mockFetchHandler = async (_url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)?.Authorization;
      if (auth) capturedHeaders.push(auth);

      if (init?.method === "POST") {
        return new Response(JSON.stringify({ task_id: "relay-task-001", status: "pending" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ task: { status: "completed" }, receipt }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    runtime.enableInteractiveDelegation({
      syncUrl: "https://mock-relay.test",
      authToken: async () => "signed-jwt-token",
    });

    await runtime.getToolRegistry().execute("delegate_to_agent", {
      prompt: "check auth",
    });

    // Both submission and polling should have auth
    expect(capturedHeaders.length).toBeGreaterThanOrEqual(2);
    for (const h of capturedHeaders) {
      expect(h).toBe("Bearer signed-jwt-token");
    }
  });

  it("logs warning and continues polling when poll returns non-ok", async () => {
    const runtime = new MotebitRuntime(
      { motebitId: "alice-001", tickRateHz: 0 },
      createAdapters(createMockProvider()),
    );

    const receipt = fakeReceipt();
    let pollCount = 0;

    mockFetchHandler = async (url: string, init?: RequestInit) => {
      if (url.includes("/agent/alice-001/task") && init?.method === "POST") {
        return new Response(JSON.stringify({ task_id: "relay-task-001", status: "pending" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/agent/alice-001/task/relay-task-001")) {
        pollCount++;
        if (pollCount === 1) {
          return new Response("Forbidden", { status: 403 });
        }
        return new Response(JSON.stringify({ task: { status: "completed" }, receipt }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("ok", { status: 200 });
    };

    runtime.enableInteractiveDelegation({
      syncUrl: "https://mock-relay.test",
      authToken: async (aud) => `test-token-${aud ?? "default"}`,
    });

    const result = await runtime.getToolRegistry().execute("delegate_to_agent", {
      prompt: "test poll retry",
    });

    expect(pollCount).toBe(2);
    expect(result.ok).toBe(true);
  });

  it("succeeds even when trust bump throws", async () => {
    const provider = createMockProvider();
    const storage = createInMemoryStorage();
    const trustStore = new InMemoryAgentTrustStore();
    trustStore.setAgentTrust = async () => {
      throw new Error("trust store unavailable");
    };
    const adapters: PlatformAdapters = {
      storage: { ...storage, agentTrustStore: trustStore },
      renderer: new NullRenderer(),
      ai: provider,
    };

    const runtime = new MotebitRuntime({ motebitId: "alice-001", tickRateHz: 0 }, adapters);

    const receipt = fakeReceipt();
    mockFetchHandler = async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.includes("/task") && !url.includes("credentials")) {
        return new Response(JSON.stringify({ task_id: "relay-task-001", status: "pending" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/task/relay-task-001")) {
        return new Response(JSON.stringify({ task: { status: "completed" }, receipt }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("ok", { status: 200 });
    };

    runtime.enableInteractiveDelegation({
      syncUrl: "https://mock-relay.test",
      authToken: async () => "test-token",
    });

    const result = await runtime.getToolRegistry().execute("delegate_to_agent", {
      prompt: "trust bump will fail",
    });

    expect(result.ok).toBe(true);
    expect(result.data).toContain("motebit is a sovereign AI agent framework");
  });
});

describe("Agent capabilities in context", () => {
  beforeEach(() => {
    mockRunTurnStreaming.mockReset();
  });

  it("includes capabilities in knownAgents context when service listings exist", async () => {
    const provider = createMockProvider();
    const trustStore = new InMemoryAgentTrustStore();
    const listingStore = new InMemoryServiceListingStore();
    const storage = createInMemoryStorage();
    const runtime = new MotebitRuntime(
      { motebitId: "alice-001", tickRateHz: 0 },
      {
        storage: { ...storage, agentTrustStore: trustStore, serviceListingStore: listingStore },
        renderer: new NullRenderer(),
        ai: provider,
      },
    );

    // Set up agent trust store with a known agent
    await trustStore.setAgentTrust({
      motebit_id: "alice-001" as import("@motebit/sdk").MotebitId,
      remote_motebit_id: "bob-001" as import("@motebit/sdk").MotebitId,
      trust_level: AgentTrustLevel.Verified,
      first_seen_at: Date.now(),
      last_seen_at: Date.now(),
      interaction_count: 5,
      successful_tasks: 5,
      failed_tasks: 0,
    });

    // Set up service listing store with capabilities
    await listingStore.set({
      listing_id: "ls-001" as import("@motebit/sdk").ListingId,
      motebit_id: "bob-001" as import("@motebit/sdk").MotebitId,
      capabilities: ["web_search", "read_url"],
      pricing: [],
      sla: { max_latency_ms: 30000, availability_guarantee: 0.99 },
      description: "Web search service",
      updated_at: Date.now(),
    });

    // Capture what context pack is passed to runTurnStreaming
    let capturedOptions: Record<string, unknown> | null = null;
    mockRunTurnStreaming.mockImplementation(
      (_deps: unknown, _msg: string, opts: Record<string, unknown>) => {
        capturedOptions = opts;
        return yieldChunks(
          { type: "text", text: "delegated" },
          { type: "result", result: makeTurnResult("delegated") },
        );
      },
    );

    const chunks = await collectChunks(runtime.sendMessageStreaming("search the web"));
    expect(chunks.length).toBeGreaterThan(0);

    // Verify capabilities were passed through
    expect(capturedOptions).not.toBeNull();
    const caps = capturedOptions!.agentCapabilities as Record<string, string[]> | undefined;
    expect(caps).toBeDefined();
    expect(caps!["bob-001"]).toEqual(["web_search", "read_url"]);
  });
});
