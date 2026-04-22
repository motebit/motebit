import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MotebitRuntime, NullRenderer, SimpleToolRegistry, createInMemoryStorage } from "../index";
import type { PlatformAdapters, StreamChunk, ConversationStoreAdapter } from "../index";
import type { StreamingProvider, AgenticChunk, TurnResult } from "@motebit/ai-core";
import type { AIResponse, ContextPack, ToolHandler } from "@motebit/sdk";
import { TrustMode, BatteryMode, EventType } from "@motebit/sdk";

// === Mock ai-core: override runTurnStreaming and reflect, keep everything else real ===

const mockRunTurnStreaming = vi.fn();
const mockAiReflect = vi.fn();
const mockSummarize = vi.fn().mockResolvedValue("mock summary");
const mockShouldSummarize = vi.fn().mockReturnValue(false);

vi.mock("@motebit/ai-core", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@motebit/ai-core");
  return {
    ...actual,
    runTurnStreaming: (...args: unknown[]) =>
      mockRunTurnStreaming(...args) as AsyncGenerator<AgenticChunk>,
    reflect: (...args: unknown[]) => mockAiReflect(...args) as Promise<unknown>,
    summarizeConversation: (...args: unknown[]) => mockSummarize(...args) as Promise<string>,
    shouldSummarize: (...args: unknown[]) => mockShouldSummarize(...args) as boolean,
  };
});

// === Helpers ===

function createMockProvider(responseText = "Hello from mock"): StreamingProvider {
  const response: AIResponse = {
    text: responseText,
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
      yield { type: "text" as const, text: responseText };
      yield { type: "done" as const, response };
    },
  };
}

function createAdapters(
  provider?: StreamingProvider,
  overrides?: Partial<PlatformAdapters>,
): PlatformAdapters {
  return {
    storage: createInMemoryStorage(),
    renderer: new NullRenderer(),
    ai: provider,
    ...overrides,
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

function createMockConversationStore(): ConversationStoreAdapter {
  const conversations = new Map<
    string,
    {
      conversationId: string;
      motebitId: string;
      startedAt: number;
      lastActiveAt: number;
      summary: string | null;
      messages: Array<{
        messageId: string;
        conversationId: string;
        motebitId: string;
        role: string;
        content: string;
        toolCalls: string | null;
        toolCallId: string | null;
        createdAt: number;
        tokenEstimate: number;
      }>;
    }
  >();
  let nextId = 1;

  return {
    createConversation(motebitId: string): string {
      const id = `conv-${nextId++}`;
      conversations.set(id, {
        conversationId: id,
        motebitId,
        startedAt: Date.now(),
        lastActiveAt: Date.now(),
        summary: null,
        messages: [],
      });
      return id;
    },
    appendMessage(
      conversationId: string,
      motebitId: string,
      msg: {
        role: string;
        content: string;
        toolCalls?: string;
        toolCallId?: string;
      },
    ): void {
      const conv = conversations.get(conversationId);
      if (!conv) return;
      conv.lastActiveAt = Date.now();
      conv.messages.push({
        messageId: `msg-${conv.messages.length}`,
        conversationId,
        motebitId,
        role: msg.role,
        content: msg.content,
        toolCalls: msg.toolCalls ?? null,
        toolCallId: msg.toolCallId ?? null,
        createdAt: Date.now(),
        tokenEstimate: msg.content.length,
      });
    },
    loadMessages(conversationId: string, _limit?: number) {
      const conv = conversations.get(conversationId);
      return conv ? conv.messages : [];
    },
    getActiveConversation(motebitId: string) {
      for (const conv of conversations.values()) {
        if (conv.motebitId === motebitId) {
          return {
            conversationId: conv.conversationId,
            startedAt: conv.startedAt,
            lastActiveAt: conv.lastActiveAt,
            summary: conv.summary,
          };
        }
      }
      return null;
    },
    updateSummary(conversationId: string, summary: string): void {
      const conv = conversations.get(conversationId);
      if (conv) conv.summary = summary;
    },
    updateTitle(_conversationId: string, _title: string): void {
      // no-op for tests
    },
    listConversations(motebitId: string, limit?: number) {
      const results: Array<{
        conversationId: string;
        startedAt: number;
        lastActiveAt: number;
        title: string | null;
        messageCount: number;
      }> = [];
      for (const conv of conversations.values()) {
        if (conv.motebitId === motebitId) {
          results.push({
            conversationId: conv.conversationId,
            startedAt: conv.startedAt,
            lastActiveAt: conv.lastActiveAt,
            title: null,
            messageCount: conv.messages.length,
          });
        }
      }
      return limit != null ? results.slice(0, limit) : results;
    },
    deleteConversation(conversationId: string) {
      conversations.delete(conversationId);
    },
  };
}

// Shorthand for tool definitions (ToolDefinition uses inputSchema, not parameters)
function toolDef(name: string, description = name) {
  return { name, description, inputSchema: {} as Record<string, unknown> };
}

// === SimpleToolRegistry ===

describe("SimpleToolRegistry", () => {
  let registry: SimpleToolRegistry;

  beforeEach(() => {
    registry = new SimpleToolRegistry();
  });

  it("register and list tools", () => {
    registry.register(toolDef("test_tool", "A test tool"), async () => ({
      ok: true,
      data: "done",
    }));
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]!.name).toBe("test_tool");
  });

  it("has() returns true for registered tools", () => {
    registry.register(toolDef("foo", "foo tool"), async () => ({ ok: true }));
    expect(registry.has("foo")).toBe(true);
    expect(registry.has("bar")).toBe(false);
  });

  it("get() returns definition for registered tools", () => {
    const def = toolDef("bar", "bar tool");
    registry.register(def, async () => ({ ok: true }));
    expect(registry.get("bar")).toEqual(def);
    expect(registry.get("unknown")).toBeUndefined();
  });

  it("execute() calls handler and returns result", async () => {
    const handler = vi.fn<ToolHandler>().mockResolvedValue({ ok: true, data: "hello" });
    registry.register(toolDef("greet", "Greet"), handler);
    const result = await registry.execute("greet", { name: "world" });
    expect(result.ok).toBe(true);
    expect(result.data).toBe("hello");
    expect(handler).toHaveBeenCalledWith({ name: "world" });
  });

  it("execute() returns error for unknown tool", async () => {
    const result = await registry.execute("nonexistent", {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unknown tool");
  });

  it("execute() catches handler errors", async () => {
    registry.register(toolDef("broken", "Broken"), async () => {
      throw new Error("handler exploded");
    });
    const result = await registry.execute("broken", {});
    expect(result.ok).toBe(false);
    expect(result.error).toBe("handler exploded");
  });

  it("register() throws on duplicate name", () => {
    registry.register(toolDef("dup", "First"), async () => ({ ok: true }));
    expect(() => registry.register(toolDef("dup", "Second"), async () => ({ ok: true }))).toThrow(
      'Tool "dup" already registered',
    );
  });

  it("merge() imports tools from another registry", () => {
    const other = new SimpleToolRegistry();
    other.register(toolDef("external", "External"), async () => ({ ok: true, data: "from-other" }));
    registry.merge(other);
    expect(registry.has("external")).toBe(true);
    expect(registry.size).toBe(1);
  });

  it("merge() skips tools that already exist", () => {
    registry.register(toolDef("shared", "Local"), async () => ({ ok: true, data: "local" }));
    const other = new SimpleToolRegistry();
    other.register(toolDef("shared", "Remote"), async () => ({ ok: true, data: "remote" }));
    registry.merge(other);
    expect(registry.size).toBe(1);
  });

  it("merge() proxies execute to source registry", async () => {
    const other = new SimpleToolRegistry();
    other.register(toolDef("proxy", "Proxy"), async () => ({ ok: true, data: "proxied" }));
    registry.merge(other);
    const result = await registry.execute("proxy", {});
    expect(result.ok).toBe(true);
    expect(result.data).toBe("proxied");
  });

  it("unregister() removes a tool", () => {
    registry.register(toolDef("removable", "Removable"), async () => ({ ok: true }));
    expect(registry.has("removable")).toBe(true);
    const removed = registry.unregister("removable");
    expect(removed).toBe(true);
    expect(registry.has("removable")).toBe(false);
    expect(registry.size).toBe(0);
  });

  it("unregister() returns false for unknown tool", () => {
    expect(registry.unregister("ghost")).toBe(false);
  });

  it("size tracks tool count", () => {
    expect(registry.size).toBe(0);
    registry.register(toolDef("a", "A"), async () => ({ ok: true }));
    expect(registry.size).toBe(1);
    registry.register(toolDef("b", "B"), async () => ({ ok: true }));
    expect(registry.size).toBe(2);
    registry.unregister("a");
    expect(registry.size).toBe(1);
  });
});

// === sendMessageStreaming ===

describe("sendMessageStreaming", () => {
  let runtime: MotebitRuntime;
  let provider: StreamingProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = createMockProvider();
    runtime = new MotebitRuntime(
      { motebitId: "stream-test", tickRateHz: 0 },
      createAdapters(provider),
    );
  });

  it("yields text and result chunks", async () => {
    const result = makeTurnResult("Streamed response");
    mockRunTurnStreaming.mockReturnValue(
      yieldChunks(
        { type: "text", text: "Streamed " },
        { type: "text", text: "response" },
        { type: "result", result },
      ),
    );

    const chunks = await collectChunks(runtime.sendMessageStreaming("hello"));
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual({ type: "text", text: "Streamed " });
    expect(chunks[1]).toEqual({ type: "text", text: "response" });
    expect(chunks[2]).toEqual({ type: "result", result });
  });

  it("throws without AI provider", async () => {
    const headless = new MotebitRuntime({ motebitId: "no-ai" }, createAdapters());
    await expect(async () => {
      for await (const _chunk of headless.sendMessageStreaming("hello")) {
        /* consume */
      }
    }).rejects.toThrow("AI not initialized");
  });

  it("rejects concurrent streaming calls", async () => {
    const result = makeTurnResult();
    mockRunTurnStreaming.mockReturnValue(
      yieldChunks({ type: "text", text: "slow" }, { type: "result", result }),
    );

    const gen = runtime.sendMessageStreaming("first");
    await gen.next();

    await expect(async () => {
      for await (const _chunk of runtime.sendMessageStreaming("second")) {
        /* consume */
      }
    }).rejects.toThrow("Already processing");

    for await (const _chunk of gen) {
      /* drain */
    }
  });

  it("pushes user and assistant messages to conversation history", async () => {
    const result = makeTurnResult("Response text");
    mockRunTurnStreaming.mockReturnValue(
      yieldChunks({ type: "text", text: "Response text" }, { type: "result", result }),
    );

    await collectChunks(runtime.sendMessageStreaming("hello"));
    const history = runtime.getConversationHistory();
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual({ role: "user", content: "hello" });
    expect(history[1]).toEqual({ role: "assistant", content: "Response text" });
  });

  it("clears isProcessing after stream completes", async () => {
    const result = makeTurnResult();
    mockRunTurnStreaming.mockReturnValue(yieldChunks({ type: "result", result }));

    expect(runtime.isProcessing).toBe(false);
    await collectChunks(runtime.sendMessageStreaming("hello"));
    expect(runtime.isProcessing).toBe(false);
  });

  it("clears isProcessing even on error", async () => {
    mockRunTurnStreaming.mockReturnValue(
      (async function* () {
        yield { type: "text" as const, text: "" };
        throw new Error("stream failed");
      })(),
    );

    await expect(async () => {
      await collectChunks(runtime.sendMessageStreaming("hello"));
    }).rejects.toThrow("stream failed");
    expect(runtime.isProcessing).toBe(false);
  });

  it("clears pending approval at start of new stream", async () => {
    const result = makeTurnResult();
    mockRunTurnStreaming.mockReturnValue(yieldChunks({ type: "result", result }));

    await collectChunks(runtime.sendMessageStreaming("hello"));
    expect(runtime.hasPendingApproval).toBe(false);
  });
});

// === processStream: state extraction and side effects ===

describe("processStream side effects", () => {
  let runtime: MotebitRuntime;

  beforeEach(() => {
    vi.clearAllMocks();
    runtime = new MotebitRuntime(
      { motebitId: "process-test", tickRateHz: 0 },
      createAdapters(createMockProvider()),
    );
  });

  it("updates state on tool_status calling", async () => {
    const result = makeTurnResult();
    mockRunTurnStreaming.mockReturnValue(
      yieldChunks(
        { type: "tool_status", name: "read_file", status: "calling" },
        { type: "tool_status", name: "read_file", status: "done", result: "file content" },
        { type: "text", text: "Here is the file." },
        { type: "result", result },
      ),
    );

    const chunks = await collectChunks(runtime.sendMessageStreaming("read a file"));
    expect(chunks).toHaveLength(4);
    expect(chunks[0]).toEqual({ type: "tool_status", name: "read_file", status: "calling" });
    expect(chunks[1]).toMatchObject({ type: "tool_status", name: "read_file", status: "done" });
  });

  it("captures pending approval on approval_request", async () => {
    const result = makeTurnResult();
    mockRunTurnStreaming.mockReturnValue(
      yieldChunks(
        {
          type: "approval_request",
          tool_call_id: "tc-1",
          name: "delete_file",
          args: { path: "/tmp/x" },
          risk_level: 0.9,
        },
        { type: "result", result },
      ),
    );

    expect(runtime.hasPendingApproval).toBe(false);
    await collectChunks(runtime.sendMessageStreaming("delete something"));

    expect(runtime.hasPendingApproval).toBe(true);
    expect(runtime.pendingApprovalInfo).toEqual({
      toolName: "delete_file",
      args: { path: "/tmp/x" },
    });
  });

  it("yields injection_warning chunks", async () => {
    const result = makeTurnResult();
    mockRunTurnStreaming.mockReturnValue(
      yieldChunks(
        { type: "injection_warning", tool_name: "web_fetch", patterns: ["ignore previous"] },
        { type: "text", text: "Warning detected." },
        { type: "result", result },
      ),
    );

    const chunks = await collectChunks(runtime.sendMessageStreaming("fetch url"));
    expect(chunks[0]).toEqual({
      type: "injection_warning",
      tool_name: "web_fetch",
      patterns: ["ignore previous"],
    });
  });

  it("extracts state tags from accumulated text", async () => {
    const result = makeTurnResult();
    mockRunTurnStreaming.mockReturnValue(
      yieldChunks(
        { type: "text", text: 'Thinking... <state field="curiosity" value="0.9" />' },
        { type: "result", result },
      ),
    );

    // Should extract state tag and push update without error
    await collectChunks(runtime.sendMessageStreaming("tell me about X"));
  });

  it("extracts actions from accumulated text", async () => {
    const result = makeTurnResult();
    mockRunTurnStreaming.mockReturnValue(
      yieldChunks(
        { type: "text", text: "I understand *smiles* let me help." },
        { type: "result", result },
      ),
    );

    // Should extract *smiles* action and convert to state delta without error
    await collectChunks(runtime.sendMessageStreaming("hello"));
  });
});

// === resumeAfterApproval ===

describe("resumeAfterApproval", () => {
  let runtime: MotebitRuntime;

  beforeEach(() => {
    vi.clearAllMocks();
    runtime = new MotebitRuntime(
      { motebitId: "approval-test", tickRateHz: 0 },
      createAdapters(createMockProvider()),
    );
  });

  it("returns silently without pending approval (timeout may have fired)", async () => {
    // When no pending approval exists (e.g. timeout already fired and cleared it),
    // resumeAfterApproval returns silently instead of throwing — prevents the race
    // where a user approves at the same moment the timeout fires.
    const chunks: unknown[] = [];
    for await (const chunk of runtime.resumeAfterApproval(true)) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(0);
  });

  it("throws without AI provider", async () => {
    const headless = new MotebitRuntime({ motebitId: "no-ai" }, createAdapters());
    // Set pending approval directly via the streaming manager for this edge case test
    const streaming = (headless as unknown as { streaming: { _pendingApproval: unknown } })
      .streaming;
    streaming._pendingApproval = {
      toolCallId: "tc-1",
      toolName: "test",
      args: {},
      userMessage: "test",
    };
    await expect(async () => {
      for await (const _chunk of headless.resumeAfterApproval(true)) {
        /* consume */
      }
    }).rejects.toThrow("AI not initialized");
  });

  it("approved: executes tool and yields tool_status chunks", async () => {
    // Register a tool in the registry
    runtime.getToolRegistry().register(toolDef("safe_tool", "A safe tool"), async (args) => ({
      ok: true,
      data: `executed with ${JSON.stringify(args)}`,
    }));

    // Simulate getting into pending approval state
    mockRunTurnStreaming.mockReturnValueOnce(
      yieldChunks(
        { type: "approval_request", tool_call_id: "tc-1", name: "safe_tool", args: { x: 1 } },
        { type: "result", result: makeTurnResult() },
      ),
    );
    await collectChunks(runtime.sendMessageStreaming("use tool"));
    expect(runtime.hasPendingApproval).toBe(true);

    // Resume with approval — continuation stream
    const continuationResult = makeTurnResult("Tool executed successfully");
    mockRunTurnStreaming.mockReturnValueOnce(
      yieldChunks(
        { type: "text", text: "Tool executed successfully" },
        { type: "result", result: continuationResult },
      ),
    );

    const chunks = await collectChunks(runtime.resumeAfterApproval(true));

    // Should yield: tool_status calling, tool_status done, then continuation chunks
    expect(chunks[0]).toEqual({ type: "tool_status", name: "safe_tool", status: "calling" });
    expect(chunks[1]).toMatchObject({ type: "tool_status", name: "safe_tool", status: "done" });

    expect(runtime.hasPendingApproval).toBe(false);
  });

  it("denied: pushes denial into history and continues", async () => {
    // Simulate pending approval state
    mockRunTurnStreaming.mockReturnValueOnce(
      yieldChunks(
        { type: "approval_request", tool_call_id: "tc-2", name: "risky_tool", args: { y: 2 } },
        { type: "result", result: makeTurnResult() },
      ),
    );
    await collectChunks(runtime.sendMessageStreaming("use risky tool"));
    expect(runtime.hasPendingApproval).toBe(true);

    // Resume with denial
    const continuationResult = makeTurnResult("I understand, the tool was denied.");
    mockRunTurnStreaming.mockReturnValueOnce(
      yieldChunks(
        { type: "text", text: "I understand, the tool was denied." },
        { type: "result", result: continuationResult },
      ),
    );

    const chunks = await collectChunks(runtime.resumeAfterApproval(false));

    // Should NOT yield tool_status (tool not executed)
    const toolStatusChunks = chunks.filter((c) => c.type === "tool_status");
    expect(toolStatusChunks).toHaveLength(0);

    // Should yield text and result from continuation
    expect(chunks.some((c) => c.type === "text")).toBe(true);
    expect(runtime.hasPendingApproval).toBe(false);
  });

  it("clears pending approval after resume", async () => {
    mockRunTurnStreaming.mockReturnValueOnce(
      yieldChunks({ type: "approval_request", tool_call_id: "tc-3", name: "tool", args: {} }),
    );
    await collectChunks(runtime.sendMessageStreaming("test"));

    const continuationResult = makeTurnResult("ok");
    mockRunTurnStreaming.mockReturnValueOnce(
      yieldChunks({ type: "result", result: continuationResult }),
    );

    await collectChunks(runtime.resumeAfterApproval(false));
    expect(runtime.hasPendingApproval).toBe(false);
    expect(runtime.pendingApprovalInfo).toBeNull();
  });
});

// === External tool registration ===

describe("External tool registration", () => {
  let runtime: MotebitRuntime;

  beforeEach(() => {
    runtime = new MotebitRuntime(
      { motebitId: "tools-test", tickRateHz: 0 },
      createAdapters(createMockProvider()),
    );
  });

  it("registerExternalTools adds tools from another registry", () => {
    const external = new SimpleToolRegistry();
    external.register(toolDef("ext_tool", "External"), async () => ({ ok: true }));

    runtime.registerExternalTools("mcp:test", external);
    expect(runtime.getToolRegistry().has("ext_tool")).toBe(true);
  });

  it("registerExternalTools skips already-registered tools", () => {
    runtime
      .getToolRegistry()
      .register(toolDef("overlap", "Local"), async () => ({ ok: true, data: "local" }));

    const external = new SimpleToolRegistry();
    external.register(toolDef("overlap", "External"), async () => ({ ok: true, data: "external" }));

    runtime.registerExternalTools("mcp:test", external);
    expect(runtime.getToolRegistry().get("overlap")!.description).toBe("Local");
  });

  it("unregisterExternalTools removes tools by source", () => {
    const external = new SimpleToolRegistry();
    external.register(toolDef("tool_a", "A"), async () => ({ ok: true }));
    external.register(toolDef("tool_b", "B"), async () => ({ ok: true }));

    runtime.registerExternalTools("mcp:fs", external);
    expect(runtime.getToolRegistry().has("tool_a")).toBe(true);
    expect(runtime.getToolRegistry().has("tool_b")).toBe(true);

    runtime.unregisterExternalTools("mcp:fs");
    expect(runtime.getToolRegistry().has("tool_a")).toBe(false);
    expect(runtime.getToolRegistry().has("tool_b")).toBe(false);
  });

  it("unregisterExternalTools is no-op for unknown source", () => {
    expect(() => runtime.unregisterExternalTools("mcp:unknown")).not.toThrow();
  });

  it("multiple sources can be registered independently", () => {
    const ext1 = new SimpleToolRegistry();
    ext1.register(toolDef("source1_tool", "S1"), async () => ({ ok: true }));

    const ext2 = new SimpleToolRegistry();
    ext2.register(toolDef("source2_tool", "S2"), async () => ({ ok: true }));

    runtime.registerExternalTools("mcp:a", ext1);
    runtime.registerExternalTools("mcp:b", ext2);

    runtime.unregisterExternalTools("mcp:a");
    expect(runtime.getToolRegistry().has("source1_tool")).toBe(false);
    expect(runtime.getToolRegistry().has("source2_tool")).toBe(true);
  });
});

// === Policy / governance updates ===

describe("Policy and governance updates", () => {
  it("updatePolicyConfig replaces the policy gate", () => {
    const runtime = new MotebitRuntime(
      { motebitId: "policy-test", tickRateHz: 0 },
      createAdapters(createMockProvider()),
    );

    const oldGate = runtime.policy;
    runtime.updatePolicyConfig({ operatorMode: true });
    expect(runtime.policy).not.toBe(oldGate);
  });

  it("updateMemoryGovernance replaces the governor", () => {
    const runtime = new MotebitRuntime(
      { motebitId: "gov-test", tickRateHz: 0 },
      createAdapters(createMockProvider()),
    );

    const oldGov = runtime.memoryGovernor;
    runtime.updateMemoryGovernance({ persistenceThreshold: 0.5 });
    expect(runtime.memoryGovernor).not.toBe(oldGov);
  });
});

// === Conversation persistence ===

describe("Conversation persistence", () => {
  let runtime: MotebitRuntime;
  let store: ConversationStoreAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    store = createMockConversationStore();
    const storage = { ...createInMemoryStorage(), conversationStore: store };
    runtime = new MotebitRuntime(
      { motebitId: "persist-test", tickRateHz: 0 },
      {
        storage,
        renderer: new NullRenderer(),
        ai: createMockProvider(),
      },
    );
  });

  it("creates conversation on first message", async () => {
    const result = makeTurnResult("reply");
    mockRunTurnStreaming.mockReturnValue(
      yieldChunks({ type: "text", text: "reply" }, { type: "result", result }),
    );

    expect(runtime.getConversationId()).toBeNull();
    await collectChunks(runtime.sendMessageStreaming("hello"));
    expect(runtime.getConversationId()).not.toBeNull();
  });

  it("persists user and assistant messages", async () => {
    const result = makeTurnResult("reply");
    mockRunTurnStreaming.mockReturnValue(
      yieldChunks({ type: "text", text: "reply" }, { type: "result", result }),
    );

    await collectChunks(runtime.sendMessageStreaming("hello"));
    const convId = runtime.getConversationId()!;
    const msgs = store.loadMessages(convId);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.role).toBe("user");
    expect(msgs[0]!.content).toBe("hello");
    expect(msgs[1]!.role).toBe("assistant");
    expect(msgs[1]!.content).toBe("reply");
  });

  it("listConversations delegates to store", async () => {
    const result = makeTurnResult("reply");
    mockRunTurnStreaming.mockReturnValue(
      yieldChunks({ type: "text", text: "reply" }, { type: "result", result }),
    );

    await collectChunks(runtime.sendMessageStreaming("hello"));
    const convs = runtime.listConversations();
    expect(convs).toHaveLength(1);
    expect(convs[0]!.conversationId).toBe(runtime.getConversationId());
  });

  it("listConversations returns empty without store", () => {
    const noStore = new MotebitRuntime(
      { motebitId: "no-store", tickRateHz: 0 },
      createAdapters(createMockProvider()),
    );
    expect(noStore.listConversations()).toEqual([]);
  });

  it("loadConversation replaces history", async () => {
    const result = makeTurnResult("reply");
    mockRunTurnStreaming.mockReturnValue(
      yieldChunks({ type: "text", text: "reply" }, { type: "result", result }),
    );

    await collectChunks(runtime.sendMessageStreaming("hello"));
    const convId = runtime.getConversationId()!;

    runtime.resetConversation();
    expect(runtime.getConversationHistory()).toHaveLength(0);

    runtime.loadConversation(convId);
    const history = runtime.getConversationHistory();
    expect(history).toHaveLength(2);
    expect(history[0]!.content).toBe("hello");
    expect(history[1]!.content).toBe("reply");
    expect(runtime.getConversationId()).toBe(convId);
  });

  it("loadConversation is no-op without store", () => {
    const noStore = new MotebitRuntime(
      { motebitId: "no-store", tickRateHz: 0 },
      createAdapters(createMockProvider()),
    );
    noStore.loadConversation("conv-123");
    expect(noStore.getConversationHistory()).toHaveLength(0);
  });

  it("resetConversation clears conversationId", async () => {
    const result = makeTurnResult("reply");
    mockRunTurnStreaming.mockReturnValue(
      yieldChunks({ type: "text", text: "reply" }, { type: "result", result }),
    );

    await collectChunks(runtime.sendMessageStreaming("hello"));
    expect(runtime.getConversationId()).not.toBeNull();

    runtime.resetConversation();
    expect(runtime.getConversationId()).toBeNull();
  });
});

// === Summarization ===

describe("Conversation summarization", () => {
  it("triggers summarization when shouldSummarize returns true", async () => {
    vi.clearAllMocks();
    mockShouldSummarize.mockReturnValue(true);
    mockSummarize.mockResolvedValue("conversation summary");

    const store = createMockConversationStore();
    const storage = { ...createInMemoryStorage(), conversationStore: store };
    const runtime = new MotebitRuntime(
      { motebitId: "sum-test", tickRateHz: 0 },
      {
        storage,
        renderer: new NullRenderer(),
        ai: createMockProvider(),
      },
    );

    const result = makeTurnResult("reply");
    mockRunTurnStreaming.mockReturnValue(
      yieldChunks({ type: "text", text: "reply" }, { type: "result", result }),
    );

    await collectChunks(runtime.sendMessageStreaming("hello"));

    // Allow async summarization to complete
    await vi.waitFor(() => {
      expect(mockSummarize).toHaveBeenCalled();
    });
  });
});

// === setModel ===

describe("setModel", () => {
  it("throws without provider", () => {
    const headless = new MotebitRuntime({ motebitId: "no-ai" }, createAdapters());
    expect(() => headless.setModel("new-model")).toThrow("No AI provider configured");
  });
});

// === reflect ===

describe("reflect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws without provider", async () => {
    const headless = new MotebitRuntime({ motebitId: "no-ai" }, createAdapters());
    await expect(headless.reflect()).rejects.toThrow("No AI provider configured");
  });

  it("calls aiReflect and returns result", { timeout: 15_000 }, async () => {
    const runtime = new MotebitRuntime(
      { motebitId: "reflect-test", tickRateHz: 0 },
      createAdapters(createMockProvider()),
    );

    const mockResult = {
      insights: ["Users prefer short answers"],
      planAdjustments: ["Be more concise"],
      patterns: [],
      selfAssessment: "Good overall",
    };
    mockAiReflect.mockResolvedValue(mockResult);

    const result = await runtime.reflect();
    expect(result).toEqual(mockResult);
    expect(mockAiReflect).toHaveBeenCalled();
  });

  it("does not store insights as memories (event log is canonical)", async () => {
    const runtime = new MotebitRuntime(
      { motebitId: "reflect-mem", tickRateHz: 0 },
      createAdapters(createMockProvider()),
    );

    mockAiReflect.mockResolvedValue({
      insights: ["Insight one", "Insight two"],
      planAdjustments: [],
      patterns: [],
      selfAssessment: "Good",
    });

    await runtime.reflect();

    const memories = await runtime.memory.exportAll();
    const reflectionMems = memories.nodes.filter((n) => n.content.startsWith("[reflection]"));
    expect(reflectionMems).toHaveLength(0);
  });
});

// === logToolUsed ===

describe("logToolUsed (via tool_status done)", () => {
  it("appends ToolUsed event to event store", async () => {
    vi.clearAllMocks();
    const storage = createInMemoryStorage();
    const runtime = new MotebitRuntime(
      { motebitId: "audit-test", tickRateHz: 0 },
      { storage, renderer: new NullRenderer(), ai: createMockProvider() },
    );

    const result = makeTurnResult();
    mockRunTurnStreaming.mockReturnValue(
      yieldChunks(
        { type: "tool_status", name: "test_tool", status: "calling" },
        { type: "tool_status", name: "test_tool", status: "done", result: "tool output" },
        { type: "result", result },
      ),
    );

    await collectChunks(runtime.sendMessageStreaming("use test_tool"));

    // Give logToolUsed a tick to complete (it's async/void)
    await new Promise((r) => setTimeout(r, 50));

    const events = await runtime.events.query({
      motebit_id: "audit-test",
      event_types: [EventType.ToolUsed],
    });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.payload.tool).toBe("test_tool");
  });
});

// === ToolInvocationReceipt emission ===

describe("onToolInvocation — signed per-tool-call receipts", () => {
  async function makeKeyedRuntime(
    onToolInvocation?: (receipt: unknown) => void,
  ): Promise<MotebitRuntime> {
    const { generateKeypair } = await import("@motebit/crypto");
    const kp = await generateKeypair();
    return new MotebitRuntime(
      {
        motebitId: "tir-test",
        tickRateHz: 0,
        deviceId: "device-abc",
        signingKeys: { privateKey: kp.privateKey, publicKey: kp.publicKey },
        ...(onToolInvocation ? { onToolInvocation } : {}),
      },
      createAdapters(createMockProvider()),
    );
  }

  it("fires the sink with a signed receipt for each matched calling→done pair", async () => {
    vi.clearAllMocks();
    const received: unknown[] = [];
    const runtime = await makeKeyedRuntime((r) => received.push(r));

    const result = makeTurnResult();
    mockRunTurnStreaming.mockReturnValue(
      yieldChunks(
        {
          type: "tool_status",
          name: "read_url",
          status: "calling",
          tool_call_id: "tc_1",
          args: { url: "https://motebit.com" },
          started_at: 1700000000000,
        },
        {
          type: "tool_status",
          name: "read_url",
          status: "done",
          result: "ok",
          tool_call_id: "tc_1",
        },
        { type: "result", result },
      ),
    );

    await collectChunks(runtime.sendMessageStreaming("read motebit.com"));
    await new Promise((r) => setTimeout(r, 10));

    expect(received.length).toBe(1);
    const r = received[0] as {
      invocation_id: string;
      tool_name: string;
      motebit_id: string;
      device_id: string;
      args_hash: string;
      result_hash: string;
      signature: string;
      suite: string;
      public_key?: string;
      invocation_origin?: string;
    };
    expect(r.invocation_id).toBe("tc_1");
    expect(r.tool_name).toBe("read_url");
    expect(r.motebit_id).toBe("tir-test");
    expect(r.device_id).toBe("device-abc");
    expect(r.suite).toBe("motebit-jcs-ed25519-b64-v1");
    expect(r.signature).toBeTruthy();
    expect(r.args_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.result_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.public_key).toMatch(/^[0-9a-f]{64}$/);
    expect(r.invocation_origin).toBe("ai-loop");
  });

  it("produces a receipt that verifies end-to-end against the runtime's public key", async () => {
    const { generateKeypair, verifyToolInvocationReceipt, hexToBytes } =
      await import("@motebit/crypto");
    const kp = await generateKeypair();
    let captured: unknown = null;
    const runtime = new MotebitRuntime(
      {
        motebitId: "tir-verify",
        tickRateHz: 0,
        deviceId: "device-verify",
        signingKeys: { privateKey: kp.privateKey, publicKey: kp.publicKey },
        onToolInvocation: (r) => {
          captured = r;
        },
      },
      createAdapters(createMockProvider()),
    );

    mockRunTurnStreaming.mockReturnValue(
      yieldChunks(
        {
          type: "tool_status",
          name: "web_search",
          status: "calling",
          tool_call_id: "tc_9",
          args: { q: "motebit" },
          started_at: Date.now(),
        },
        {
          type: "tool_status",
          name: "web_search",
          status: "done",
          result: { hits: 3 },
          tool_call_id: "tc_9",
        },
        { type: "result", result: makeTurnResult() },
      ),
    );

    await collectChunks(runtime.sendMessageStreaming("search motebit"));
    await new Promise((r) => setTimeout(r, 10));

    expect(captured).not.toBeNull();
    const valid = await verifyToolInvocationReceipt(
      captured as Parameters<typeof verifyToolInvocationReceipt>[0],
      kp.publicKey,
    );
    expect(valid).toBe(true);
    // The embedded public_key hex on the receipt should match the
    // runtime's signing public key byte-for-byte.
    const r = captured as { public_key: string };
    expect(hexToBytes(r.public_key)).toEqual(kp.publicKey);
  });

  it("drops silently (fail-closed) when signing keys aren't configured", async () => {
    vi.clearAllMocks();
    const received: unknown[] = [];
    const runtime = new MotebitRuntime(
      {
        motebitId: "tir-nokey",
        tickRateHz: 0,
        onToolInvocation: (r) => received.push(r),
        // Intentionally no signingKeys.
      },
      createAdapters(createMockProvider()),
    );

    mockRunTurnStreaming.mockReturnValue(
      yieldChunks(
        {
          type: "tool_status",
          name: "read_url",
          status: "calling",
          tool_call_id: "tc_2",
          args: { url: "https://example.com" },
          started_at: Date.now(),
        },
        {
          type: "tool_status",
          name: "read_url",
          status: "done",
          result: "ok",
          tool_call_id: "tc_2",
        },
        { type: "result", result: makeTurnResult() },
      ),
    );

    await collectChunks(runtime.sendMessageStreaming("read example.com"));
    await new Promise((r) => setTimeout(r, 10));

    expect(received.length).toBe(0);
  });

  it("does not sign when onToolInvocation is not wired", async () => {
    vi.clearAllMocks();
    // No sink passed — every branch short-circuits before hashing.
    const runtime = await makeKeyedRuntime(undefined);

    mockRunTurnStreaming.mockReturnValue(
      yieldChunks(
        {
          type: "tool_status",
          name: "read_url",
          status: "calling",
          tool_call_id: "tc_3",
          args: { url: "https://motebit.com" },
          started_at: Date.now(),
        },
        {
          type: "tool_status",
          name: "read_url",
          status: "done",
          result: "ok",
          tool_call_id: "tc_3",
        },
        { type: "result", result: makeTurnResult() },
      ),
    );

    // Just exercise the path — nothing to assert beyond "no throw."
    await collectChunks(runtime.sendMessageStreaming("read motebit"));
  });

  it("skips emission when tool_status chunks omit the new fields (legacy stream)", async () => {
    vi.clearAllMocks();
    const received: unknown[] = [];
    const runtime = await makeKeyedRuntime((r) => received.push(r));

    mockRunTurnStreaming.mockReturnValue(
      yieldChunks(
        { type: "tool_status", name: "legacy_tool", status: "calling" },
        { type: "tool_status", name: "legacy_tool", status: "done", result: "ok" },
        { type: "result", result: makeTurnResult() },
      ),
    );

    await collectChunks(runtime.sendMessageStreaming("legacy call"));
    await new Promise((r) => setTimeout(r, 10));

    expect(received.length).toBe(0);
  });

  it("emits one receipt per tool call when a turn has multiple tool calls", async () => {
    vi.clearAllMocks();
    const received: Array<{ invocation_id: string; tool_name: string }> = [];
    const runtime = await makeKeyedRuntime((r) =>
      received.push(r as { invocation_id: string; tool_name: string }),
    );

    mockRunTurnStreaming.mockReturnValue(
      yieldChunks(
        {
          type: "tool_status",
          name: "read_url",
          status: "calling",
          tool_call_id: "tc_a",
          args: { url: "a" },
          started_at: 1,
        },
        {
          type: "tool_status",
          name: "read_url",
          status: "done",
          result: "ok_a",
          tool_call_id: "tc_a",
        },
        {
          type: "tool_status",
          name: "web_search",
          status: "calling",
          tool_call_id: "tc_b",
          args: { q: "x" },
          started_at: 2,
        },
        {
          type: "tool_status",
          name: "web_search",
          status: "done",
          result: "ok_b",
          tool_call_id: "tc_b",
        },
        { type: "result", result: makeTurnResult() },
      ),
    );

    await collectChunks(runtime.sendMessageStreaming("multi"));
    await new Promise((r) => setTimeout(r, 10));

    expect(received.length).toBe(2);
    expect(received[0]!.invocation_id).toBe("tc_a");
    expect(received[0]!.tool_name).toBe("read_url");
    expect(received[1]!.invocation_id).toBe("tc_b");
    expect(received[1]!.tool_name).toBe("web_search");
  });

  it("swallows sink exceptions without breaking the stream", async () => {
    vi.clearAllMocks();
    const runtime = await makeKeyedRuntime(() => {
      throw new Error("sink on fire");
    });

    mockRunTurnStreaming.mockReturnValue(
      yieldChunks(
        {
          type: "tool_status",
          name: "read_url",
          status: "calling",
          tool_call_id: "tc_err",
          args: { url: "x" },
          started_at: 1,
        },
        {
          type: "tool_status",
          name: "read_url",
          status: "done",
          result: "ok",
          tool_call_id: "tc_err",
        },
        { type: "result", result: makeTurnResult() },
      ),
    );

    // Must not throw — sink fault is isolated.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(collectChunks(runtime.sendMessageStreaming("test"))).resolves.toBeDefined();
    warnSpy.mockRestore();
  });
});

// === ToolActivityEvent (live browser-pane stream) ===

describe("onToolActivity — ephemeral tool-activity stream", () => {
  it("fires alongside the signed receipt, carrying raw args + result", async () => {
    vi.clearAllMocks();
    const receipts: unknown[] = [];
    const activities: Array<{
      invocation_id: string;
      tool_name: string;
      args: Record<string, unknown>;
      result: unknown;
      started_at: number;
      completed_at: number;
    }> = [];
    const runtime = new MotebitRuntime(
      {
        motebitId: "activity-test",
        tickRateHz: 0,
        onToolInvocation: (r) => receipts.push(r),
        onToolActivity: (e) => activities.push(e as (typeof activities)[number]),
      },
      createAdapters(createMockProvider()),
    );

    mockRunTurnStreaming.mockReturnValue(
      yieldChunks(
        {
          type: "tool_status",
          name: "read_url",
          status: "calling",
          tool_call_id: "tc_a",
          args: { url: "https://example.com" },
          started_at: 1_700_000_000_000,
        },
        {
          type: "tool_status",
          name: "read_url",
          status: "done",
          result: "page content",
          tool_call_id: "tc_a",
        },
        { type: "result", result: makeTurnResult() },
      ),
    );

    await collectChunks(runtime.sendMessageStreaming("read example"));
    await new Promise((r) => setTimeout(r, 10));

    // Activity channel carries raw args + result bytes.
    expect(activities.length).toBe(1);
    const e = activities[0]!;
    expect(e.invocation_id).toBe("tc_a");
    expect(e.tool_name).toBe("read_url");
    expect(e.args).toEqual({ url: "https://example.com" });
    expect(e.result).toBe("page content");
    expect(e.started_at).toBe(1_700_000_000_000);
    expect(typeof e.completed_at).toBe("number");

    // Receipt channel also fires — they're correlated by invocation_id.
    // (Receipt only lands when signing keys are wired; this runtime has
    // none, so the receipts bucket stays empty here. The correlation is
    // verified in the dedicated onToolInvocation suite.)
    expect(receipts.length).toBe(0);
  });

  it("does not fire onToolActivity when not configured", async () => {
    vi.clearAllMocks();
    // Key-only runtime — no activity sink.
    const { generateKeypair } = await import("@motebit/crypto");
    const kp = await generateKeypair();
    const receipts: unknown[] = [];
    const runtime = new MotebitRuntime(
      {
        motebitId: "activity-off",
        tickRateHz: 0,
        deviceId: "device-off",
        signingKeys: { privateKey: kp.privateKey, publicKey: kp.publicKey },
        onToolInvocation: (r) => receipts.push(r),
      },
      createAdapters(createMockProvider()),
    );

    mockRunTurnStreaming.mockReturnValue(
      yieldChunks(
        {
          type: "tool_status",
          name: "read_url",
          status: "calling",
          tool_call_id: "tc_b",
          args: { url: "https://x" },
          started_at: Date.now(),
        },
        {
          type: "tool_status",
          name: "read_url",
          status: "done",
          result: "ok",
          tool_call_id: "tc_b",
        },
        { type: "result", result: makeTurnResult() },
      ),
    );

    await collectChunks(runtime.sendMessageStreaming("x"));
    await new Promise((r) => setTimeout(r, 10));

    // Receipt still produced (keys are configured); activity silent.
    expect(receipts.length).toBe(1);
  });

  it("isolates activity-sink exceptions from the streaming generator", async () => {
    vi.clearAllMocks();
    const runtime = new MotebitRuntime(
      {
        motebitId: "activity-throw",
        tickRateHz: 0,
        onToolActivity: () => {
          throw new Error("activity on fire");
        },
      },
      createAdapters(createMockProvider()),
    );

    mockRunTurnStreaming.mockReturnValue(
      yieldChunks(
        {
          type: "tool_status",
          name: "read_url",
          status: "calling",
          tool_call_id: "tc_c",
          args: { url: "https://x" },
          started_at: 1,
        },
        {
          type: "tool_status",
          name: "read_url",
          status: "done",
          result: "ok",
          tool_call_id: "tc_c",
        },
        { type: "result", result: makeTurnResult() },
      ),
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(collectChunks(runtime.sendMessageStreaming("x"))).resolves.toBeDefined();
    warnSpy.mockRestore();
  });

  it("skips activity emission for legacy tool_status chunks lacking the new fields", async () => {
    vi.clearAllMocks();
    const activities: unknown[] = [];
    const runtime = new MotebitRuntime(
      {
        motebitId: "activity-legacy",
        tickRateHz: 0,
        onToolActivity: (e) => activities.push(e),
      },
      createAdapters(createMockProvider()),
    );

    mockRunTurnStreaming.mockReturnValue(
      yieldChunks(
        { type: "tool_status", name: "legacy_tool", status: "calling" },
        { type: "tool_status", name: "legacy_tool", status: "done", result: "ok" },
        { type: "result", result: makeTurnResult() },
      ),
    );

    await collectChunks(runtime.sendMessageStreaming("legacy"));
    await new Promise((r) => setTimeout(r, 10));

    expect(activities.length).toBe(0);
  });
});

// === pendingApprovalInfo ===

describe("pendingApprovalInfo", () => {
  it("returns null when no pending approval", () => {
    const runtime = new MotebitRuntime(
      { motebitId: "info-test", tickRateHz: 0 },
      createAdapters(createMockProvider()),
    );
    expect(runtime.pendingApprovalInfo).toBeNull();
    expect(runtime.hasPendingApproval).toBe(false);
  });
});

// === Constructor with platform tools ===

describe("Constructor with platform tools", () => {
  it("merges platform-provided tools into registry", () => {
    const platformTools = new SimpleToolRegistry();
    platformTools.register(toolDef("platform_builtin", "Builtin"), async () => ({ ok: true }));

    const runtime = new MotebitRuntime(
      { motebitId: "plat-test", tickRateHz: 0 },
      {
        storage: createInMemoryStorage(),
        renderer: new NullRenderer(),
        ai: createMockProvider(),
        tools: platformTools,
      },
    );

    expect(runtime.getToolRegistry().has("platform_builtin")).toBe(true);
  });
});

// === Conversation resume from store ===

describe("Conversation resume from store", () => {
  it("resumes active conversation on construction", () => {
    const store = createMockConversationStore();
    const convId = store.createConversation("resume-test");
    store.appendMessage(convId, "resume-test", { role: "user", content: "previous message" });
    store.appendMessage(convId, "resume-test", { role: "assistant", content: "previous reply" });

    const storage = { ...createInMemoryStorage(), conversationStore: store };
    const runtime = new MotebitRuntime(
      { motebitId: "resume-test", tickRateHz: 0 },
      {
        storage,
        renderer: new NullRenderer(),
        ai: createMockProvider(),
      },
    );

    const history = runtime.getConversationHistory();
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual({ role: "user", content: "previous message" });
    expect(history[1]).toEqual({ role: "assistant", content: "previous reply" });
    expect(runtime.getConversationId()).toBe(convId);
  });
});

// === Approval Timeout ===

describe("Approval timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockRunTurnStreaming.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("auto-denies pending approval after timeout", async () => {
    // Set up a stream that yields an approval request then stops
    mockRunTurnStreaming.mockReturnValueOnce(
      yieldChunks({
        type: "approval_request",
        tool_call_id: "tc-timeout",
        name: "risky_tool",
        args: { x: 1 },
      }),
    );

    const runtime = new MotebitRuntime(
      { motebitId: "timeout-test", tickRateHz: 0, approvalTimeoutMs: 5000 },
      createAdapters(createMockProvider()),
    );
    // AI initialized via constructor

    // Consume stream to trigger approval capture
    await collectChunks(runtime.sendMessageStreaming("do something risky"));

    expect(runtime.hasPendingApproval).toBe(true);

    // Advance past timeout
    vi.advanceTimersByTime(5001);

    expect(runtime.hasPendingApproval).toBe(false);
  });

  it("fires onApprovalExpired callback", async () => {
    mockRunTurnStreaming.mockReturnValueOnce(
      yieldChunks({
        type: "approval_request",
        tool_call_id: "tc-cb",
        name: "risky_tool",
        args: {},
      }),
    );

    const runtime = new MotebitRuntime(
      { motebitId: "cb-test", tickRateHz: 0, approvalTimeoutMs: 3000 },
      createAdapters(createMockProvider()),
    );
    // AI initialized via constructor

    const cb = vi.fn();
    runtime.onApprovalExpired(cb);

    await collectChunks(runtime.sendMessageStreaming("test"));
    expect(cb).not.toHaveBeenCalled();

    vi.advanceTimersByTime(3001);

    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("does not fire timeout if approval resolved before expiry", async () => {
    mockRunTurnStreaming.mockReturnValueOnce(
      yieldChunks({ type: "approval_request", tool_call_id: "tc-fast", name: "tool", args: {} }),
    );
    // Continuation stream after denial
    mockRunTurnStreaming.mockReturnValueOnce(
      yieldChunks(
        { type: "text", text: "denied" },
        { type: "result", result: makeTurnResult("denied") },
      ),
    );

    const runtime = new MotebitRuntime(
      { motebitId: "fast-test", tickRateHz: 0, approvalTimeoutMs: 5000 },
      createAdapters(createMockProvider()),
    );
    // AI initialized via constructor

    const cb = vi.fn();
    runtime.onApprovalExpired(cb);

    await collectChunks(runtime.sendMessageStreaming("test"));
    expect(runtime.hasPendingApproval).toBe(true);

    // Deny before timeout
    await collectChunks(runtime.resumeAfterApproval(false));

    // Advance past would-be timeout
    vi.advanceTimersByTime(6000);

    expect(cb).not.toHaveBeenCalled();
    expect(runtime.hasPendingApproval).toBe(false);
  });

  it("disabled when approvalTimeoutMs is 0", async () => {
    mockRunTurnStreaming.mockReturnValueOnce(
      yieldChunks({ type: "approval_request", tool_call_id: "tc-no", name: "tool", args: {} }),
    );

    const runtime = new MotebitRuntime(
      { motebitId: "no-timeout-test", tickRateHz: 0, approvalTimeoutMs: 0 },
      createAdapters(createMockProvider()),
    );
    // AI initialized via constructor

    await collectChunks(runtime.sendMessageStreaming("test"));
    expect(runtime.hasPendingApproval).toBe(true);

    // Advance a long time — should still be pending
    vi.advanceTimersByTime(999_999);
    expect(runtime.hasPendingApproval).toBe(true);
  });
});

// === Delegation Streaming Events ===

describe("Delegation streaming events", () => {
  let runtime: MotebitRuntime;

  beforeEach(() => {
    vi.clearAllMocks();
    runtime = new MotebitRuntime(
      { motebitId: "delegation-test", tickRateHz: 0 },
      createAdapters(createMockProvider()),
    );
  });

  function setMotebitToolServer(rt: MotebitRuntime, toolName: string, serverName: string): void {
    const map = (rt as unknown as { motebitToolServers: Map<string, string> }).motebitToolServers;
    map.set(toolName, serverName);
  }

  it("emits delegation_start and delegation_complete for motebit tools", async () => {
    setMotebitToolServer(runtime, "motebit_query", "agent-alpha");

    const result = makeTurnResult();
    mockRunTurnStreaming.mockReturnValue(
      yieldChunks(
        { type: "tool_status", name: "motebit_query", status: "calling" },
        { type: "tool_status", name: "motebit_query", status: "done", result: "response" },
        { type: "text", text: "Got it." },
        { type: "result", result },
      ),
    );

    const chunks = await collectChunks(runtime.sendMessageStreaming("ask agent"));

    const delegationStart = chunks.find((c) => c.type === "delegation_start");
    const delegationComplete = chunks.find((c) => c.type === "delegation_complete");

    expect(delegationStart).toEqual({
      type: "delegation_start",
      server: "agent-alpha",
      tool: "motebit_query",
    });
    expect(delegationComplete).toMatchObject({
      type: "delegation_complete",
      server: "agent-alpha",
      tool: "motebit_query",
    });
  });

  it("does not emit delegation events for non-motebit tools", async () => {
    const result = makeTurnResult();
    mockRunTurnStreaming.mockReturnValue(
      yieldChunks(
        { type: "tool_status", name: "read_file", status: "calling" },
        { type: "tool_status", name: "read_file", status: "done", result: "content" },
        { type: "result", result },
      ),
    );

    const chunks = await collectChunks(runtime.sendMessageStreaming("read file"));

    const delegationChunks = chunks.filter(
      (c) => c.type === "delegation_start" || c.type === "delegation_complete",
    );
    expect(delegationChunks).toHaveLength(0);
  });

  it("extracts receipt summary from motebit_task results", async () => {
    setMotebitToolServer(runtime, "motebit_task", "agent-beta");

    const taskReceipt = {
      task_id: "task-123",
      status: "completed",
      tools_used: ["web_search", "summarize"],
      result: "Task done",
    };

    const result = makeTurnResult();
    mockRunTurnStreaming.mockReturnValue(
      yieldChunks(
        { type: "tool_status", name: "motebit_task", status: "calling" },
        { type: "tool_status", name: "motebit_task", status: "done", result: taskReceipt },
        { type: "result", result },
      ),
    );

    const chunks = await collectChunks(runtime.sendMessageStreaming("run task"));

    const delegationComplete = chunks.find((c) => c.type === "delegation_complete") as Extract<
      StreamChunk,
      { type: "delegation_complete" }
    >;

    expect(delegationComplete).toBeDefined();
    expect(delegationComplete.receipt).toEqual({
      task_id: "task-123",
      status: "completed",
      tools_used: ["web_search", "summarize"],
    });
  });

  it("delegation_complete has no receipt for non-task tools", async () => {
    setMotebitToolServer(runtime, "motebit_recall", "agent-gamma");

    const result = makeTurnResult();
    mockRunTurnStreaming.mockReturnValue(
      yieldChunks(
        { type: "tool_status", name: "motebit_recall", status: "calling" },
        { type: "tool_status", name: "motebit_recall", status: "done", result: "memories" },
        { type: "result", result },
      ),
    );

    const chunks = await collectChunks(runtime.sendMessageStreaming("recall"));

    const delegationComplete = chunks.find((c) => c.type === "delegation_complete") as Extract<
      StreamChunk,
      { type: "delegation_complete" }
    >;

    expect(delegationComplete).toBeDefined();
    expect(delegationComplete.receipt).toBeUndefined();
  });

  it("delegation events are interleaved correctly with tool_status", async () => {
    setMotebitToolServer(runtime, "motebit_query", "agent-alpha");

    const result = makeTurnResult();
    mockRunTurnStreaming.mockReturnValue(
      yieldChunks(
        { type: "tool_status", name: "motebit_query", status: "calling" },
        { type: "tool_status", name: "motebit_query", status: "done", result: "ok" },
        { type: "result", result },
      ),
    );

    const chunks = await collectChunks(runtime.sendMessageStreaming("ask"));

    // Delegation events are emitted before the corresponding tool_status chunk
    // Order: delegation_start, tool_status calling, delegation_complete, tool_status done, result
    const types = chunks.map((c) => c.type);
    expect(types).toContain("delegation_start");
    expect(types).toContain("delegation_complete");

    const startIdx = types.indexOf("delegation_start");
    const completeIdx = types.indexOf("delegation_complete");

    // delegation_start comes before delegation_complete
    expect(startIdx).toBeLessThan(completeIdx);
  });
});

// === Streaming boundary sanitization (defense-in-depth) ===

describe("streaming boundary sanitization", () => {
  let runtime: MotebitRuntime;
  let provider: StreamingProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = createMockProvider();
    runtime = new MotebitRuntime(
      { motebitId: "sanitize-stream-test", tickRateHz: 0 },
      createAdapters(provider),
    );
  });

  it("redacts secrets from tool results before they reach the stream", async () => {
    const apiKey = "sk_abcdefghijklmnopqrstuvwxyz";
    const result = makeTurnResult();
    mockRunTurnStreaming.mockReturnValue(
      yieldChunks(
        { type: "tool_status", name: "fetch_config", status: "calling" },
        {
          type: "tool_status",
          name: "fetch_config",
          status: "done",
          result: `Config loaded. API key: ${apiKey}`,
        },
        { type: "result", result },
      ),
    );

    const chunks = await collectChunks(runtime.sendMessageStreaming("get config"));
    const toolDone = chunks.find(
      (c) => c.type === "tool_status" && "status" in c && c.status === "done",
    ) as Extract<StreamChunk, { type: "tool_status" }>;

    expect(toolDone).toBeDefined();
    // The raw API key must not appear in the streamed result
    expect(String(toolDone.result)).not.toContain(apiKey);
    expect(String(toolDone.result)).toContain("[REDACTED:");
  });

  it("redacts password patterns from tool results before streaming", async () => {
    const result = makeTurnResult();
    mockRunTurnStreaming.mockReturnValue(
      yieldChunks(
        { type: "tool_status", name: "read_env", status: "calling" },
        {
          type: "tool_status",
          name: "read_env",
          status: "done",
          result: "password: hunter2_secret_value",
        },
        { type: "result", result },
      ),
    );

    const chunks = await collectChunks(runtime.sendMessageStreaming("read env"));
    const toolDone = chunks.find(
      (c) => c.type === "tool_status" && "status" in c && c.status === "done",
    ) as Extract<StreamChunk, { type: "tool_status" }>;

    expect(toolDone).toBeDefined();
    expect(String(toolDone.result)).not.toContain("hunter2_secret_value");
    expect(String(toolDone.result)).toContain("[REDACTED:");
  });

  it("redacts secrets from AI text chunks before streaming", async () => {
    const apiKey = "sk_abcdefghijklmnopqrstuvwxyz";
    const result = makeTurnResult(`Here is the key: ${apiKey}`);
    mockRunTurnStreaming.mockReturnValue(
      yieldChunks({ type: "text", text: `Here is the key: ${apiKey}` }, { type: "result", result }),
    );

    const chunks = await collectChunks(runtime.sendMessageStreaming("show key"));
    const textChunks = chunks.filter((c) => c.type === "text") as Array<
      Extract<StreamChunk, { type: "text" }>
    >;
    const allText = textChunks.map((c) => c.text).join("");

    // The raw API key must not appear in the streamed text
    expect(allText).not.toContain(apiKey);
    expect(allText).toContain("[REDACTED:");
  });

  it("passes clean content through without modification", async () => {
    const cleanResult = "Search returned 42 results for weather in LA";
    const result = makeTurnResult();
    mockRunTurnStreaming.mockReturnValue(
      yieldChunks(
        { type: "tool_status", name: "web_search", status: "calling" },
        {
          type: "tool_status",
          name: "web_search",
          status: "done",
          result: cleanResult,
        },
        { type: "result", result },
      ),
    );

    const chunks = await collectChunks(runtime.sendMessageStreaming("search weather"));
    const toolDone = chunks.find(
      (c) => c.type === "tool_status" && "status" in c && c.status === "done",
    ) as Extract<StreamChunk, { type: "tool_status" }>;

    expect(toolDone).toBeDefined();
    // Clean content passes through unchanged
    expect(toolDone.result).toBe(cleanResult);
  });
});
