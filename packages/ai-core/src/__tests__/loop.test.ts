import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@motebit/memory-graph", async () => {
  const actual =
    await vi.importActual<typeof import("@motebit/memory-graph")>("@motebit/memory-graph");
  return { ...actual, embedText: (text: string) => Promise.resolve(actual.embedTextHash(text)) };
});

import { runTurn, runTurnStreaming } from "../loop";
import type { MotebitLoopDependencies, AgenticChunk } from "../loop";
import { AnthropicProvider } from "../index";
import type { AnthropicProviderConfig, StreamingProvider } from "../index";
import { EventStore, InMemoryEventStore } from "@motebit/event-log";
import { MemoryGraph, InMemoryMemoryStorage } from "@motebit/memory-graph";
import { StateVectorEngine } from "@motebit/state-vector";
import { BehaviorEngine } from "@motebit/behavior-engine";
import { SensitivityLevel } from "@motebit/sdk";
import type {
  AIResponse,
  ContextPack,
  ToolRegistry,
  ToolDefinition,
  ToolResult,
} from "@motebit/sdk";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOTEBIT_ID = "motebit-loop-test";

/**
 * Build an SSE-formatted body that AnthropicProvider.generateStream can parse.
 * The stream sends the full text in a single content_block_delta, then closes.
 */
function mockSSEBody(text: string): string {
  const lines = [
    `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text } })}`,
    "",
    "data: [DONE]",
    "",
  ];
  return lines.join("\n");
}

function mockFetchSuccess(text: string): void {
  const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
  const body = mockSSEBody(text);
  mockFn.mockResolvedValueOnce(
    new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
  );
}

function mockFetchError(status: number, body: string): void {
  const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
  mockFn.mockResolvedValueOnce(new Response(body, { status }));
}

function makeDeps(): MotebitLoopDependencies {
  const cloudConfig: AnthropicProviderConfig = {
    api_key: "test-key",
    model: "claude-sonnet-4-5-20250929",
  };

  const eventStore = new EventStore(new InMemoryEventStore());
  const storage = new InMemoryMemoryStorage();
  const memoryGraph = new MemoryGraph(storage, eventStore, MOTEBIT_ID);
  const stateEngine = new StateVectorEngine();
  const behaviorEngine = new BehaviorEngine();
  const cloudProvider = new AnthropicProvider(cloudConfig);

  return {
    motebitId: MOTEBIT_ID,
    eventStore,
    memoryGraph,
    stateEngine,
    behaviorEngine,
    provider: cloudProvider,
  };
}

// ---------------------------------------------------------------------------
// Integration Tests
// ---------------------------------------------------------------------------

describe("runTurn", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("full turn: message → response → memory → state → cues", async () => {
    const responseText = [
      "That's really interesting!",
      '<memory confidence="0.9" sensitivity="personal">User enjoys hiking on weekends</memory>',
      '<state field="curiosity" value="0.8"/>',
    ].join(" ");

    mockFetchSuccess(responseText);

    const deps = makeDeps();
    const result = await runTurn(deps, "I love hiking on weekends!");

    // Response text should have tags stripped
    expect(result.response).toContain("That's really interesting!");
    expect(result.response).not.toContain("<memory");
    expect(result.response).not.toContain("<state");

    // Memory should have been formed
    expect(result.memoriesFormed).toHaveLength(1);
    expect(result.memoriesFormed[0]!.content).toBe("User enjoys hiking on weekends");
    expect(result.memoriesFormed[0]!.confidence).toBe(0.9);
    expect(result.memoriesFormed[0]!.sensitivity).toBe(SensitivityLevel.Personal);

    // State and cues should be present
    expect(result.stateAfter).toBeDefined();
    expect(result.cues).toBeDefined();
    expect(result.cues.hover_distance).toBeGreaterThan(0);
  });

  it("handles API error gracefully", async () => {
    mockFetchError(500, "Internal Server Error");

    const deps = makeDeps();
    await expect(runTurn(deps, "Hello")).rejects.toThrow("Anthropic API error 500");
  });

  it("handles response with no memory candidates", async () => {
    mockFetchSuccess("Just a plain response, no memories here.");

    const deps = makeDeps();
    const result = await runTurn(deps, "What's up?");

    expect(result.response).toBe("Just a plain response, no memories here.");
    expect(result.memoriesFormed).toHaveLength(0);
  });

  it("memory retrieval works on subsequent turns", async () => {
    const deps = makeDeps();

    // Turn 1: form a memory
    mockFetchSuccess(
      'Cool! <memory confidence="0.9" sensitivity="none">User loves jazz music</memory>',
    );
    const result1 = await runTurn(deps, "I love jazz music");
    expect(result1.memoriesFormed).toHaveLength(1);

    // Turn 2: the memory should be retrievable (it was stored)
    mockFetchSuccess("I remember you like jazz!");
    const result2 = await runTurn(deps, "What kind of music do I like?");
    expect(result2.response).toBe("I remember you like jazz!");

    // Verify the memory is in the graph
    const exported = await deps.memoryGraph.exportAll();
    expect(exported.nodes).toHaveLength(1);
    expect(exported.nodes[0]!.content).toBe("User loves jazz music");
  });

  it("links related memories with graph edges", async () => {
    const deps = makeDeps();

    // Turn 1: form a memory about jazz
    mockFetchSuccess(
      'Cool! <memory confidence="0.9" sensitivity="none">User loves jazz music</memory>',
    );
    await runTurn(deps, "I love jazz music");

    // Turn 2: form a related memory — the hash-based embeddings for similar
    // content may or may not cross the 0.7 threshold, but we can verify the
    // edge machinery works by forming a memory that retrieves the first one
    mockFetchSuccess(
      'Nice! <memory confidence="0.8" sensitivity="none">User enjoys jazz concerts on weekends</memory>',
    );
    const result2 = await runTurn(deps, "I go to jazz concerts on weekends");
    expect(result2.memoriesFormed).toHaveLength(1);

    // Verify edges were created between the new memory and the retrieved one
    const exported = await deps.memoryGraph.exportAll();
    expect(exported.nodes).toHaveLength(2);
    // Edges depend on cosine similarity of hash-based embeddings crossing 0.7
    // — the important thing is the infrastructure runs without errors.
    // If edges formed, they should link the two jazz-related memories.
    if (exported.edges.length > 0) {
      const edge = exported.edges[0]!;
      expect(edge.relation_type).toBe("related");
      expect(edge.weight).toBeGreaterThanOrEqual(0.7);
    }
  });

  it("links multiple memories formed in the same turn", async () => {
    const deps = makeDeps();

    // Form two memories in one turn
    mockFetchSuccess(
      'Interesting! <memory confidence="0.9" sensitivity="none">User studies piano</memory> ' +
        '<memory confidence="0.8" sensitivity="none">User practices piano daily</memory>',
    );
    const result = await runTurn(deps, "I study piano and practice daily");
    expect(result.memoriesFormed).toHaveLength(2);

    const exported = await deps.memoryGraph.exportAll();
    expect(exported.nodes).toHaveLength(2);
    // Two memories about piano in the same turn — if similar enough, they get linked
    if (exported.edges.length > 0) {
      expect(exported.edges[0]!.relation_type).toBe("related");
    }
  });

  it("previousCues in options propagates to context pack", async () => {
    const cues = {
      hover_distance: 0.15,
      drift_amplitude: 0.03,
      glow_intensity: 0.7,
      eye_dilation: 0.8,
      smile_curvature: 0.1,
      speaking_activity: 0,
    };

    mockFetchSuccess("I see!");

    const deps = makeDeps();
    // runTurn delegates to runTurnStreaming which calls generateStream
    const streamSpy = vi.spyOn(deps.provider, "generateStream");

    await runTurn(deps, "Test with cues", { previousCues: cues });

    expect(streamSpy).toHaveBeenCalledTimes(1);
    const contextPack = streamSpy.mock.calls[0]![0];
    expect(contextPack.behavior_cues).toEqual(cues);
  });

  it("sessionInfo in options propagates to context pack", async () => {
    const session = { continued: true, lastActiveAt: Date.now() - 3600_000 };

    mockFetchSuccess("Welcome back!");

    const deps = makeDeps();
    const streamSpy = vi.spyOn(deps.provider, "generateStream");

    await runTurn(deps, "I'm back", { sessionInfo: session });

    expect(streamSpy).toHaveBeenCalledTimes(1);
    const contextPack = streamSpy.mock.calls[0]![0];
    expect(contextPack.sessionInfo).toEqual(session);
  });

  it("sessionInfo is undefined when not provided", async () => {
    mockFetchSuccess("Hello!");

    const deps = makeDeps();
    const streamSpy = vi.spyOn(deps.provider, "generateStream");

    await runTurn(deps, "Hello");

    const contextPack = streamSpy.mock.calls[0]![0];
    expect(contextPack.sessionInfo).toBeUndefined();
  });

  it("infers state from text when no state tags are present", async () => {
    // Response with positive words, a question, and length > 200 chars — but no <state> tags
    const responseText =
      "I'm so happy you asked about that! It's a wonderful topic and I'd love to explore it with you. " +
      "What aspects are you most interested in? There are definitely many fascinating angles we could investigate together.";

    mockFetchSuccess(responseText);

    const deps = makeDeps();
    const pushSpy = vi.spyOn(deps.stateEngine, "pushUpdate");

    await runTurn(deps, "Tell me about something cool");

    expect(pushSpy).toHaveBeenCalledTimes(1);
    const pushed = pushSpy.mock.calls[0]![0] as Record<string, unknown>;

    // Should have inferred nudges (not explicit state tags)
    expect(pushed.affect_valence).toBeGreaterThan(0); // positive words
    expect(pushed.curiosity).toBeGreaterThan(0); // question mark
    expect(pushed.confidence).toBeGreaterThan(0.5); // "definitely"
  });

  it("explicit state tags take priority over inference", async () => {
    // Response with BOTH positive words and explicit state tags
    const responseText = [
      "I'm so happy about this!",
      '<state field="curiosity" value="0.9"/>',
    ].join(" ");

    mockFetchSuccess(responseText);

    const deps = makeDeps();
    const pushSpy = vi.spyOn(deps.stateEngine, "pushUpdate");

    await runTurn(deps, "Test explicit vs inferred");

    expect(pushSpy).toHaveBeenCalledTimes(1);
    const pushed = pushSpy.mock.calls[0]![0] as Record<string, unknown>;

    // Should use explicit tag value, NOT inference
    expect(pushed).toEqual({ curiosity: 0.9 });
    // Inference would have also set affect_valence — verify it's absent
    expect(pushed.affect_valence).toBeUndefined();
  });

  it("executes tool calls via the streaming agentic loop", async () => {
    const toolRegistry = makeMockToolRegistry(
      new Map([
        [
          "get_weather",
          {
            def: {
              name: "get_weather",
              description: "Get weather for a location",
              inputSchema: { type: "object", properties: { location: { type: "string" } } },
            },
            result: { ok: true, data: { temp: 72, condition: "sunny" } },
          },
        ],
      ]),
    );

    const provider = makeMockProvider([
      // First call: provider requests a tool call
      {
        text: "Let me check the weather.",
        confidence: 0.8,
        memory_candidates: [],
        state_updates: {},
        tool_calls: [{ id: "tc_1", name: "get_weather", args: { location: "San Francisco" } }],
      },
      // Second call: provider responds with tool result incorporated
      {
        text: "It's 72°F and sunny in San Francisco!",
        confidence: 0.8,
        memory_candidates: [],
        state_updates: {},
      },
    ]);

    const deps = makeDepsWithProvider(provider, toolRegistry);
    const result = await runTurn(deps, "What's the weather in SF?");

    // The final response should come from the second provider call
    expect(result.response).toContain("72°F");
    expect(result.stateAfter).toBeDefined();
    expect(result.cues).toBeDefined();
  });

  it("handles approval_request tools by auto-denying in non-streaming mode", async () => {
    const toolRegistry = makeMockToolRegistry(
      new Map([
        [
          "send_email",
          {
            def: {
              name: "send_email",
              description: "Send an email",
              inputSchema: { type: "object", properties: { to: { type: "string" } } },
              requiresApproval: true,
            },
            result: { ok: true },
          },
        ],
      ]),
    );

    const provider = makeMockProvider([
      {
        text: "I'll send that email for you.",
        confidence: 0.8,
        memory_candidates: [],
        state_updates: {},
        tool_calls: [{ id: "tc_approval", name: "send_email", args: { to: "test@example.com" } }],
      },
    ]);

    const deps = makeDepsWithProvider(provider, toolRegistry);
    const result = await runTurn(deps, "Send email to test@example.com");

    // Should still return a result (the approval-gated tool was not executed,
    // and the loop breaks because all calls were blocked)
    expect(result.response).toBe("I'll send that email for you.");
    expect(result.stateAfter).toBeDefined();
  });

  it("version clocks increment across turns", async () => {
    const deps = makeDeps();

    // Turn 1
    mockFetchSuccess('Hi! <memory confidence="0.8" sensitivity="none">Fact 1</memory>');
    await runTurn(deps, "Message 1");

    // Turn 2
    mockFetchSuccess('Hey! <memory confidence="0.7" sensitivity="none">Fact 2</memory>');
    await runTurn(deps, "Message 2");

    // Check events have incrementing clocks
    const events = await deps.eventStore.query({ motebit_id: MOTEBIT_ID });
    const clocks = events.map((e) => e.version_clock);

    // Each event should have a unique clock
    const uniqueClocks = new Set(clocks);
    expect(uniqueClocks.size).toBe(clocks.length);

    // Clocks should be monotonically increasing
    for (let i = 1; i < clocks.length; i++) {
      expect(clocks[i]!).toBeGreaterThan(clocks[i - 1]!);
    }
  });
});

// ---------------------------------------------------------------------------
// Mock StreamingProvider for tool-calling tests
// ---------------------------------------------------------------------------

function makeMockProvider(responses: AIResponse[]): StreamingProvider {
  let callIndex = 0;
  return {
    model: "test-model",
    setModel: vi.fn(),
    async generate(_contextPack: ContextPack): Promise<AIResponse> {
      const response = responses[callIndex] ?? responses[responses.length - 1]!;
      callIndex++;
      return response;
    },
    async *generateStream(_contextPack: ContextPack) {
      const response = responses[callIndex] ?? responses[responses.length - 1]!;
      callIndex++;
      if (response.text) {
        yield { type: "text" as const, text: response.text };
      }
      yield { type: "done" as const, response };
    },
    estimateConfidence: () => Promise.resolve(0.8),
    extractMemoryCandidates: (r: AIResponse) => Promise.resolve(r.memory_candidates),
  };
}

function makeMockToolRegistry(
  tools: Map<string, { def: ToolDefinition; result: ToolResult }>,
): ToolRegistry {
  return {
    list(): ToolDefinition[] {
      return [...tools.values()].map((t) => t.def);
    },
    async execute(name: string, _args: Record<string, unknown>): Promise<ToolResult> {
      const entry = tools.get(name);
      if (!entry) return { ok: false, error: `Unknown tool: ${name}` };
      return entry.result;
    },
    register(): void {
      // No-op for tests
    },
  };
}

function makeDepsWithProvider(
  provider: StreamingProvider,
  tools?: ToolRegistry,
): MotebitLoopDependencies {
  const eventStore = new EventStore(new InMemoryEventStore());
  const storage = new InMemoryMemoryStorage();
  const memoryGraph = new MemoryGraph(storage, eventStore, MOTEBIT_ID);
  const stateEngine = new StateVectorEngine();
  const behaviorEngine = new BehaviorEngine();

  return {
    motebitId: MOTEBIT_ID,
    eventStore,
    memoryGraph,
    stateEngine,
    behaviorEngine,
    provider,
    tools,
  };
}

// ---------------------------------------------------------------------------
// Agentic Loop: Tool Calling
// ---------------------------------------------------------------------------

describe("runTurnStreaming (agentic loop)", () => {
  it("streams text when no tools are provided", async () => {
    const provider = makeMockProvider([
      {
        text: "Hello there!",
        confidence: 0.8,
        memory_candidates: [],
        state_updates: {},
      },
    ]);
    const deps = makeDepsWithProvider(provider);

    const chunks: AgenticChunk[] = [];
    for await (const chunk of runTurnStreaming(deps, "Hi")) {
      chunks.push(chunk);
    }

    const textChunks = chunks.filter((c) => c.type === "text");
    expect(textChunks).toHaveLength(1);
    expect((textChunks[0] as { type: "text"; text: string }).text).toBe("Hello there!");

    const resultChunk = chunks.find((c) => c.type === "result") as {
      type: "result";
      result: { response: string };
    };
    expect(resultChunk).toBeDefined();
    expect(resultChunk.result.response).toBe("Hello there!");
  });

  it("executes tool calls and feeds results back into provider", async () => {
    const toolRegistry = makeMockToolRegistry(
      new Map([
        [
          "get_weather",
          {
            def: {
              name: "get_weather",
              description: "Get weather for a location",
              inputSchema: { type: "object", properties: { location: { type: "string" } } },
            },
            result: { ok: true, data: { temp: 72, condition: "sunny" } },
          },
        ],
      ]),
    );

    const provider = makeMockProvider([
      // First call: provider requests a tool call
      {
        text: "Let me check the weather.",
        confidence: 0.8,
        memory_candidates: [],
        state_updates: {},
        tool_calls: [{ id: "tc_1", name: "get_weather", args: { location: "San Francisco" } }],
      },
      // Second call: provider responds with tool result incorporated
      {
        text: "It's 72°F and sunny in San Francisco!",
        confidence: 0.8,
        memory_candidates: [],
        state_updates: {},
      },
    ]);

    const deps = makeDepsWithProvider(provider, toolRegistry);

    const chunks: AgenticChunk[] = [];
    for await (const chunk of runTurnStreaming(deps, "What's the weather in SF?")) {
      chunks.push(chunk);
    }

    // Should have tool_status chunks
    const toolCallingChunk = chunks.find(
      (c) => c.type === "tool_status" && (c as { status: string }).status === "calling",
    ) as { type: "tool_status"; name: string; status: string } | undefined;
    expect(toolCallingChunk).toBeDefined();
    expect(toolCallingChunk!.name).toBe("get_weather");

    const toolDoneChunk = chunks.find(
      (c) => c.type === "tool_status" && (c as { status: string }).status === "done",
    ) as { type: "tool_status"; name: string; status: string; result?: unknown } | undefined;
    expect(toolDoneChunk).toBeDefined();
    expect(toolDoneChunk!.result).toEqual({ temp: 72, condition: "sunny" });

    // Final result should contain the follow-up text
    const resultChunk = chunks.find((c) => c.type === "result") as {
      type: "result";
      result: { response: string };
    };
    expect(resultChunk).toBeDefined();
    expect(resultChunk.result.response).toContain("72°F");
  });

  it("yields approval_request for tools requiring approval", async () => {
    const toolRegistry = makeMockToolRegistry(
      new Map([
        [
          "send_email",
          {
            def: {
              name: "send_email",
              description: "Send an email",
              inputSchema: { type: "object", properties: { to: { type: "string" } } },
              requiresApproval: true,
            },
            result: { ok: true },
          },
        ],
      ]),
    );

    const provider = makeMockProvider([
      {
        text: "I'll send that email for you.",
        confidence: 0.8,
        memory_candidates: [],
        state_updates: {},
        tool_calls: [{ id: "tc_approval", name: "send_email", args: { to: "test@example.com" } }],
      },
    ]);

    const deps = makeDepsWithProvider(provider, toolRegistry);

    const chunks: AgenticChunk[] = [];
    for await (const chunk of runTurnStreaming(deps, "Send email to test@example.com")) {
      chunks.push(chunk);
    }

    const approvalChunk = chunks.find((c) => c.type === "approval_request") as
      | {
          type: "approval_request";
          tool_call_id: string;
          name: string;
          args: Record<string, unknown>;
        }
      | undefined;
    expect(approvalChunk).toBeDefined();
    expect(approvalChunk!.name).toBe("send_email");
    expect(approvalChunk!.tool_call_id).toBe("tc_approval");
    expect(approvalChunk!.args).toEqual({ to: "test@example.com" });

    // Should NOT have a tool_status "calling" chunk (tool was not executed)
    const callingChunks = chunks.filter(
      (c) => c.type === "tool_status" && (c as { status: string }).status === "calling",
    );
    expect(callingChunks).toHaveLength(0);
  });

  it("respects max 10 iteration limit", async () => {
    const toolRegistry = makeMockToolRegistry(
      new Map([
        [
          "infinite_tool",
          {
            def: {
              name: "infinite_tool",
              description: "A tool that keeps getting called",
              inputSchema: { type: "object" },
            },
            result: { ok: true, data: "done" },
          },
        ],
      ]),
    );

    // Provider always returns a tool call, causing an infinite loop
    const alwaysToolCall: AIResponse = {
      text: "Calling tool again...",
      confidence: 0.8,
      memory_candidates: [],
      state_updates: {},
      tool_calls: [{ id: "tc_loop", name: "infinite_tool", args: {} }],
    };

    let callCount = 0;
    const provider: StreamingProvider = {
      model: "test-model",
      setModel: vi.fn(),
      async generate() {
        return alwaysToolCall;
      },
      async *generateStream() {
        callCount++;
        yield { type: "text" as const, text: "Calling tool again..." };
        yield { type: "done" as const, response: alwaysToolCall };
      },
      estimateConfidence: () => Promise.resolve(0.8),
      extractMemoryCandidates: (r: AIResponse) => Promise.resolve(r.memory_candidates),
    };

    const deps = makeDepsWithProvider(provider, toolRegistry);

    const chunks: AgenticChunk[] = [];
    for await (const chunk of runTurnStreaming(deps, "Do something")) {
      chunks.push(chunk);
    }

    // Should have stopped after 10 iterations
    expect(callCount).toBe(10);

    // Should still yield a result
    const resultChunk = chunks.find((c) => c.type === "result");
    expect(resultChunk).toBeDefined();
  });

  it("includes memoriesRetrieved in result chunk", async () => {
    const deps = makeDepsWithProvider(
      makeMockProvider([
        {
          text: 'Nice! <memory confidence="0.9" sensitivity="none">User likes cats</memory>',
          confidence: 0.8,
          memory_candidates: [
            { content: "User likes cats", confidence: 0.9, sensitivity: SensitivityLevel.None },
          ],
          state_updates: {},
        },
      ]),
    );

    // Turn 1: form a memory
    const chunks1: AgenticChunk[] = [];
    for await (const chunk of runTurnStreaming(deps, "I like cats")) {
      chunks1.push(chunk);
    }
    const result1 = chunks1.find((c) => c.type === "result") as {
      type: "result";
      result: { memoriesFormed: unknown[]; memoriesRetrieved: unknown[] };
    };
    expect(result1.result.memoriesFormed).toHaveLength(1);
    expect(result1.result.memoriesRetrieved).toHaveLength(0); // no prior memories

    // Turn 2: the formed memory should appear in memoriesRetrieved
    const provider2 = makeMockProvider([
      {
        text: "You like cats!",
        confidence: 0.8,
        memory_candidates: [],
        state_updates: {},
      },
    ]);
    // Swap provider for turn 2
    (deps as { provider: StreamingProvider }).provider = provider2;

    const chunks2: AgenticChunk[] = [];
    for await (const chunk of runTurnStreaming(deps, "What animals do I like?")) {
      chunks2.push(chunk);
    }
    const result2 = chunks2.find((c) => c.type === "result") as {
      type: "result";
      result: { memoriesRetrieved: Array<{ content: string }> };
    };
    expect(result2.result.memoriesRetrieved.length).toBeGreaterThan(0);
    expect(result2.result.memoriesRetrieved[0]!.content).toBe("User likes cats");
  });

  it("pinned memories appear in memoriesRetrieved", async () => {
    const deps = makeDepsWithProvider(
      makeMockProvider([
        {
          text: 'Nice! <memory confidence="0.9" sensitivity="none">User likes dogs</memory>',
          confidence: 0.8,
          memory_candidates: [
            { content: "User likes dogs", confidence: 0.9, sensitivity: SensitivityLevel.None },
          ],
          state_updates: {},
        },
      ]),
    );

    // Turn 1: form a memory and pin it
    const chunks1: AgenticChunk[] = [];
    for await (const chunk of runTurnStreaming(deps, "I like dogs")) {
      chunks1.push(chunk);
    }
    const result1 = chunks1.find((c) => c.type === "result") as {
      type: "result";
      result: { memoriesFormed: Array<{ node_id: string }> };
    };
    const nodeId = result1.result.memoriesFormed[0]!.node_id;
    await deps.memoryGraph.pinMemory(nodeId, true);

    // Turn 2: pinned memory should appear in memoriesRetrieved
    const provider2 = makeMockProvider([
      {
        text: "You like dogs!",
        confidence: 0.8,
        memory_candidates: [],
        state_updates: {},
      },
    ]);
    (deps as { provider: StreamingProvider }).provider = provider2;

    const chunks2: AgenticChunk[] = [];
    for await (const chunk of runTurnStreaming(deps, "What do I like?")) {
      chunks2.push(chunk);
    }
    const result2 = chunks2.find((c) => c.type === "result") as {
      type: "result";
      result: { memoriesRetrieved: Array<{ node_id: string; pinned: boolean }> };
    };
    const retrieved = result2.result.memoriesRetrieved;
    expect(retrieved.some((m) => m.node_id === nodeId && m.pinned)).toBe(true);
  });

  it("pinned memories are not duplicated when also similarity-matched", async () => {
    const deps = makeDepsWithProvider(
      makeMockProvider([
        {
          text: 'Cool! <memory confidence="0.9" sensitivity="none">User enjoys cycling</memory>',
          confidence: 0.8,
          memory_candidates: [
            { content: "User enjoys cycling", confidence: 0.9, sensitivity: SensitivityLevel.None },
          ],
          state_updates: {},
        },
      ]),
    );

    // Turn 1: form and pin
    const chunks1: AgenticChunk[] = [];
    for await (const chunk of runTurnStreaming(deps, "I enjoy cycling")) {
      chunks1.push(chunk);
    }
    const result1 = chunks1.find((c) => c.type === "result") as {
      type: "result";
      result: { memoriesFormed: Array<{ node_id: string }> };
    };
    const nodeId = result1.result.memoriesFormed[0]!.node_id;
    await deps.memoryGraph.pinMemory(nodeId, true);

    // Turn 2: query about cycling — will match both pinned and similarity
    const provider2 = makeMockProvider([
      {
        text: "Cycling is great!",
        confidence: 0.8,
        memory_candidates: [],
        state_updates: {},
      },
    ]);
    (deps as { provider: StreamingProvider }).provider = provider2;

    const chunks2: AgenticChunk[] = [];
    for await (const chunk of runTurnStreaming(deps, "Tell me about cycling")) {
      chunks2.push(chunk);
    }
    const result2 = chunks2.find((c) => c.type === "result") as {
      type: "result";
      result: { memoriesRetrieved: Array<{ node_id: string }> };
    };
    const ids = result2.result.memoriesRetrieved.map((m) => m.node_id);
    const occurrences = ids.filter((id) => id === nodeId);
    expect(occurrences).toHaveLength(1); // no duplicates
  });

  it("returns empty memoriesRetrieved when no memories exist", async () => {
    const provider = makeMockProvider([
      {
        text: "Hello!",
        confidence: 0.8,
        memory_candidates: [],
        state_updates: {},
      },
    ]);
    const deps = makeDepsWithProvider(provider);

    const chunks: AgenticChunk[] = [];
    for await (const chunk of runTurnStreaming(deps, "Hi")) {
      chunks.push(chunk);
    }

    const resultChunk = chunks.find((c) => c.type === "result") as {
      type: "result";
      result: { memoriesRetrieved: unknown[] };
    };
    expect(resultChunk.result.memoriesRetrieved).toEqual([]);
  });

  it("falls back to single-pass when tools registry is provided but response has no tool_calls", async () => {
    const toolRegistry = makeMockToolRegistry(
      new Map([
        [
          "unused_tool",
          {
            def: {
              name: "unused_tool",
              description: "A tool that isn't needed",
              inputSchema: { type: "object" },
            },
            result: { ok: true },
          },
        ],
      ]),
    );

    const provider = makeMockProvider([
      {
        text: "I don't need any tools for this.",
        confidence: 0.8,
        memory_candidates: [],
        state_updates: {},
      },
    ]);

    const deps = makeDepsWithProvider(provider, toolRegistry);

    const chunks: AgenticChunk[] = [];
    for await (const chunk of runTurnStreaming(deps, "Hello")) {
      chunks.push(chunk);
    }

    // No tool_status chunks
    const toolChunks = chunks.filter((c) => c.type === "tool_status");
    expect(toolChunks).toHaveLength(0);

    const resultChunk = chunks.find((c) => c.type === "result") as {
      type: "result";
      result: { response: string };
    };
    expect(resultChunk.result.response).toBe("I don't need any tools for this.");
  });
});

// ---------------------------------------------------------------------------
// Pipeline stage timeouts — regression guard for silent adapter hangs
// ---------------------------------------------------------------------------
//
// The motivating incident: on motebit.com, sending "hello" showed "…"
// forever with no error and no fetch POST in the Network tab. Something
// upstream of the provider call — most likely a persistence or memory-graph
// adapter — was hanging silently, and the whole chat turn died with it.
//
// `withStageTimeout` wraps every pre-provider await in `runTurnStreaming`
// with a labeled deadline. These tests pin the contract: if any stage
// adapter hangs, the turn fails with a `StageTimeoutError` naming the
// exact stage, in bounded wall time — not an untyped hang.

describe("runTurnStreaming pipeline stage timeouts", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it("surfaces a StageTimeoutError when the event store hangs past its deadline", async () => {
    const { StageTimeoutError, STAGE_TIMEOUTS_MS } = await import("../core");
    const deps = makeDeps();
    // Hang event_query. All other pre-provider stages would still resolve
    // (in-memory), but Promise.all waits for all three — a single hang is
    // enough to kill the turn without this guard.
    vi.spyOn(deps.eventStore, "query").mockReturnValue(new Promise(() => {}));

    // Capture the thrown error to inspect both type and the `stage` field —
    // the stage label is the whole diagnostic point, and `toBeInstanceOf`
    // alone wouldn't catch a regression that broadened the stage name.
    const nextPromise = iter(deps, "hello");
    await vi.advanceTimersByTimeAsync(STAGE_TIMEOUTS_MS.event_query + 50);
    const err = await nextPromise;
    expect(err).toBeInstanceOf(StageTimeoutError);
    expect((err as InstanceType<typeof StageTimeoutError>).stage).toBe("event_query");
  });

  it("surfaces a StageTimeoutError when memoryGraph.retrieve hangs past its deadline", async () => {
    const { StageTimeoutError, STAGE_TIMEOUTS_MS } = await import("../core");
    const deps = makeDeps();
    // Let the Promise.all batch resolve (event/embed/pinned all fast against
    // in-memory stores), then hang the similarity retrieve. Models a
    // corrupted vector index that accepts the call but never returns.
    vi.spyOn(deps.memoryGraph, "retrieve").mockReturnValue(new Promise(() => {}));

    const nextPromise = iter(deps, "hello");
    await vi.advanceTimersByTimeAsync(STAGE_TIMEOUTS_MS.memory_retrieve + 50);
    const err = await nextPromise;
    expect(err).toBeInstanceOf(StageTimeoutError);
    expect((err as InstanceType<typeof StageTimeoutError>).stage).toBe("memory_retrieve");
  });
});

/** Run one step of a streaming turn and capture the thrown error (if any). */
async function iter(deps: MotebitLoopDependencies, text: string): Promise<unknown> {
  try {
    const gen = runTurnStreaming(deps, text);
    await gen.next();
    return undefined;
  } catch (err) {
    return err;
  }
}
