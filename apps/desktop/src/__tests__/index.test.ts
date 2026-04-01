import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { DesktopApp, isSlashCommand, parseSlashCommand, type InvokeFn } from "../index";

// ---------------------------------------------------------------------------
// DesktopApp
// ---------------------------------------------------------------------------
// The DesktopApp class integrates StateVectorEngine, BehaviorEngine, and
// ThreeJSAdapter. We test the parts that work without a real Tauri runtime
// or browser canvas.

describe("DesktopApp", () => {
  let app: DesktopApp;

  afterEach(() => {
    // Ensure timers and resources are cleaned up
    if (app != null) {
      app.stop();
    }
  });

  it("constructor creates an instance without throwing", () => {
    app = new DesktopApp();
    expect(app).toBeInstanceOf(DesktopApp);
  });

  it("can be initialized with a null canvas (stub adapter)", async () => {
    app = new DesktopApp();
    // ThreeJSAdapter.init accepts unknown, so null works in stub mode
    await expect(app.init(null)).resolves.toBeUndefined();
  });

  it("start and stop do not throw", async () => {
    app = new DesktopApp();
    await app.init(null);
    expect(() => app.start()).not.toThrow();
    expect(() => app.stop()).not.toThrow();
  });

  it("start is idempotent (calling twice does not throw)", async () => {
    app = new DesktopApp();
    await app.init(null);
    app.start();
    expect(() => app.start()).not.toThrow();
    app.stop();
  });

  it("stop can be called without start", () => {
    app = new DesktopApp();
    expect(() => app.stop()).not.toThrow();
  });

  it("stop can be called multiple times", async () => {
    app = new DesktopApp();
    await app.init(null);
    app.start();
    app.stop();
    expect(() => app.stop()).not.toThrow();
  });

  it("full lifecycle: construct -> init -> start -> stop", async () => {
    app = new DesktopApp();
    await app.init(null);
    app.start();
    // Let at least one tick potentially fire
    await new Promise((resolve) => setTimeout(resolve, 10));
    app.stop();
    // Should be cleanly stopped without errors
  });
});

// ---------------------------------------------------------------------------
// DesktopApp.initAI — provider selection
// ---------------------------------------------------------------------------

describe("DesktopApp.initAI", () => {
  let app: DesktopApp;

  afterEach(() => {
    if (app != null) {
      app.stop();
    }
  });

  it("ollama provider initializes without an API key", async () => {
    app = new DesktopApp();
    const result = await app.initAI({
      provider: "ollama",
      isTauri: false,
    });
    expect(result).toBe(true);
    expect(app.isAIReady).toBe(true);
  });

  it("anthropic provider initializes with an API key", async () => {
    app = new DesktopApp();
    const result = await app.initAI({
      provider: "anthropic",
      apiKey: "sk-ant-test-key",
      isTauri: false,
    });
    expect(result).toBe(true);
    expect(app.isAIReady).toBe(true);
  });

  it("anthropic provider fails without an API key", async () => {
    app = new DesktopApp();
    const result = await app.initAI({
      provider: "anthropic",
      isTauri: false,
    });
    expect(result).toBe(false);
    expect(app.isAIReady).toBe(false);
  });

  it("personalityConfig temperature is passed through", async () => {
    app = new DesktopApp();
    // This should not throw — the resolved config propagates to the provider
    const result = await app.initAI({
      provider: "ollama",
      personalityConfig: { temperature: 0.2 },
      isTauri: false,
    });
    expect(result).toBe(true);
    expect(app.isAIReady).toBe(true);
  });

  it("ollama uses custom model when specified", async () => {
    app = new DesktopApp();
    const result = await app.initAI({
      provider: "ollama",
      model: "mistral",
      isTauri: false,
    });
    expect(result).toBe(true);
    expect(app.isAIReady).toBe(true);
  });

  it("anthropic uses custom model when specified", async () => {
    app = new DesktopApp();
    const result = await app.initAI({
      provider: "anthropic",
      apiKey: "sk-ant-test-key",
      model: "claude-haiku-4-5-20251001",
      isTauri: false,
    });
    expect(result).toBe(true);
    expect(app.isAIReady).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Slash command utilities
// ---------------------------------------------------------------------------

describe("isSlashCommand", () => {
  it("returns true for strings starting with /", () => {
    expect(isSlashCommand("/model")).toBe(true);
    expect(isSlashCommand("/help")).toBe(true);
    expect(isSlashCommand("/model mistral")).toBe(true);
  });

  it("returns false for regular text", () => {
    expect(isSlashCommand("hello")).toBe(false);
    expect(isSlashCommand("")).toBe(false);
    expect(isSlashCommand(" /model")).toBe(false);
  });
});

describe("parseSlashCommand", () => {
  it("parses command without args", () => {
    expect(parseSlashCommand("/model")).toEqual({ command: "model", args: "" });
    expect(parseSlashCommand("/help")).toEqual({ command: "help", args: "" });
  });

  it("parses command with args", () => {
    expect(parseSlashCommand("/model mistral")).toEqual({ command: "model", args: "mistral" });
    expect(parseSlashCommand("/model  spaced  arg ")).toEqual({
      command: "model",
      args: "spaced  arg",
    });
  });

  it("handles single slash", () => {
    expect(parseSlashCommand("/")).toEqual({ command: "", args: "" });
  });
});

// ---------------------------------------------------------------------------
// DesktopApp.currentModel / setModel
// ---------------------------------------------------------------------------

describe("DesktopApp.currentModel", () => {
  let app: DesktopApp;

  afterEach(() => {
    if (app != null) app.stop();
  });

  it("returns null before initAI", () => {
    app = new DesktopApp();
    expect(app.currentModel).toBeNull();
  });

  it("returns the model after ollama initAI", async () => {
    app = new DesktopApp();
    await app.initAI({ provider: "ollama", isTauri: false });
    expect(app.currentModel).toBe("llama3.2");
  });

  it("returns custom model when specified", async () => {
    app = new DesktopApp();
    await app.initAI({ provider: "ollama", model: "mistral", isTauri: false });
    expect(app.currentModel).toBe("mistral");
  });

  it("returns the model after anthropic initAI", async () => {
    app = new DesktopApp();
    await app.initAI({ provider: "anthropic", apiKey: "sk-test", isTauri: false });
    expect(app.currentModel).toBe("claude-sonnet-4-6");
  });
});

describe("DesktopApp.setModel", () => {
  let app: DesktopApp;

  afterEach(() => {
    if (app != null) app.stop();
  });

  it("throws before initAI", () => {
    app = new DesktopApp();
    expect(() => app.setModel("mistral")).toThrow("AI not initialized");
  });

  it("switches model in-place for ollama", async () => {
    app = new DesktopApp();
    await app.initAI({ provider: "ollama", isTauri: false });
    expect(app.currentModel).toBe("llama3.2");
    app.setModel("mistral");
    expect(app.currentModel).toBe("mistral");
  });

  it("switches model in-place for anthropic", async () => {
    app = new DesktopApp();
    await app.initAI({ provider: "anthropic", apiKey: "sk-test", isTauri: false });
    app.setModel("claude-haiku-4-5-20251001");
    expect(app.currentModel).toBe("claude-haiku-4-5-20251001");
  });
});

// ---------------------------------------------------------------------------
// DesktopApp.sendMessageStreaming — guards and contract
// ---------------------------------------------------------------------------

describe("DesktopApp.sendMessageStreaming", () => {
  let app: DesktopApp;

  afterEach(() => {
    if (app != null) app.stop();
  });

  it("throws before initAI", async () => {
    app = new DesktopApp();
    const gen = app.sendMessageStreaming("hello");
    await expect(gen.next()).rejects.toThrow("AI not initialized");
  });

  it("throws when already processing", async () => {
    app = new DesktopApp();
    await app.initAI({ provider: "ollama", isTauri: false });

    // Start a blocking sendMessage that we never await to completion
    // to set _isProcessing = true. We use sendMessage since it also sets the flag.
    const pending = app.sendMessage("first").catch(() => {});

    const gen = app.sendMessageStreaming("second");
    await expect(gen.next()).rejects.toThrow("Already processing");

    // Clean up — let the pending call reject (no real provider)
    await pending;
  });

  it("returns an async generator", async () => {
    app = new DesktopApp();
    await app.initAI({ provider: "ollama", isTauri: false });
    const gen = app.sendMessageStreaming("hello");
    expect(typeof gen[Symbol.asyncIterator]).toBe("function");
    // Return without consuming to avoid hitting the real provider
    void gen.return(undefined);
  });
});

// ---------------------------------------------------------------------------
// DesktopApp.initAI — storage selection
// ---------------------------------------------------------------------------

describe("DesktopApp.initAI storage selection", () => {
  let app: DesktopApp;

  afterEach(() => {
    if (app != null) app.stop();
  });

  it("uses in-memory storage when isTauri is false", async () => {
    app = new DesktopApp();
    const result = await app.initAI({ provider: "ollama", isTauri: false });
    expect(result).toBe(true);
    expect(app.isAIReady).toBe(true);
  });

  it("uses Tauri storage when isTauri is true and invoke is provided", async () => {
    app = new DesktopApp();
    // Provide a mock invoke that returns empty results for preload queries
    const mockInvoke: InvokeFn = () => Promise.resolve([] as never);
    const result = await app.initAI({
      provider: "ollama",
      isTauri: true,
      invoke: mockInvoke,
    });
    expect(result).toBe(true);
    expect(app.isAIReady).toBe(true);
  });

  it("falls back to in-memory when isTauri is true but invoke is missing", async () => {
    app = new DesktopApp();
    const result = await app.initAI({
      provider: "ollama",
      isTauri: true,
      // invoke intentionally omitted
    });
    expect(result).toBe(true);
    expect(app.isAIReady).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DesktopApp.initAI — desktop tools are registered
// ---------------------------------------------------------------------------

describe("DesktopApp.initAI tools", () => {
  let app: DesktopApp;

  afterEach(() => {
    if (app != null) app.stop();
  });

  it("registers browser-safe builtin tools in dev mode", async () => {
    app = new DesktopApp();
    await app.initAI({ provider: "ollama", isTauri: false });

    // The runtime should have the 4 browser-safe tools registered
    const toolNames = (
      app as unknown as { runtime: { getToolRegistry(): { list(): { name: string }[] } } }
    ).runtime
      .getToolRegistry()
      .list()
      .map((t) => t.name);

    expect(toolNames).toContain("web_search");
    expect(toolNames).toContain("read_url");
    expect(toolNames).toContain("recall_memories");
    expect(toolNames).toContain("list_events");
  });

  it("does NOT register desktop tools in Tauri mode without governance (fail-closed)", async () => {
    app = new DesktopApp();
    // Mock invoke returns empty config — no _identity_file
    const mockInvoke: InvokeFn = (cmd: string) => {
      if (cmd === "read_config") return Promise.resolve("{}" as never);
      return Promise.resolve([] as never);
    };
    await app.initAI({ provider: "ollama", isTauri: true, invoke: mockInvoke });

    const toolNames = (
      app as unknown as { runtime: { getToolRegistry(): { list(): { name: string }[] } } }
    ).runtime
      .getToolRegistry()
      .list()
      .map((t) => t.name);

    // Desktop tools (web_search, recall_memories, etc.) require governance
    expect(toolNames).not.toContain("web_search");
    expect(toolNames).not.toContain("recall_memories");
    // Goal tools are always registered in Tauri mode (low-risk internal tools)
    expect(toolNames).toContain("create_sub_goal");
    expect(toolNames).toContain("complete_goal");
    expect(toolNames).toContain("report_progress");
  });
});

// ---------------------------------------------------------------------------
// DesktopApp.initAI — memoryGovernance config passthrough
// ---------------------------------------------------------------------------

describe("DesktopApp.initAI memoryGovernance", () => {
  let app: DesktopApp;

  afterEach(() => {
    if (app != null) app.stop();
  });

  it("passes memoryGovernance through to runtime (not defaults)", async () => {
    app = new DesktopApp();
    await app.initAI({
      provider: "ollama",
      isTauri: false,
      memoryGovernance: { persistenceThreshold: 0.9, rejectSecrets: false },
    });

    const gov = app.getMemoryGovernance();
    expect(gov).not.toBeNull();
    expect(gov!.persistenceThreshold).toBe(0.9);
    expect(gov!.rejectSecrets).toBe(false);
  });

  it("uses defaults when memoryGovernance is omitted", async () => {
    app = new DesktopApp();
    await app.initAI({
      provider: "ollama",
      isTauri: false,
    });

    const gov = app.getMemoryGovernance();
    expect(gov).not.toBeNull();
    expect(gov!.persistenceThreshold).toBe(0.5);
    expect(gov!.rejectSecrets).toBe(true);
  });

  it("partial config merges with defaults (only persistenceThreshold)", async () => {
    app = new DesktopApp();
    await app.initAI({
      provider: "ollama",
      isTauri: false,
      memoryGovernance: { persistenceThreshold: 0.8 },
    });

    const gov = app.getMemoryGovernance();
    expect(gov!.persistenceThreshold).toBe(0.8);
    expect(gov!.rejectSecrets).toBe(true); // default preserved
  });

  it("partial config merges with defaults (only rejectSecrets)", async () => {
    app = new DesktopApp();
    await app.initAI({
      provider: "ollama",
      isTauri: false,
      memoryGovernance: { rejectSecrets: false },
    });

    const gov = app.getMemoryGovernance();
    expect(gov!.persistenceThreshold).toBe(0.5); // default preserved
    expect(gov!.rejectSecrets).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DesktopApp.governanceStatus
// ---------------------------------------------------------------------------

describe("DesktopApp.governanceStatus", () => {
  let app: DesktopApp;

  afterEach(() => {
    if (app != null) app.stop();
  });

  it("reports dev mode when isTauri is false", async () => {
    app = new DesktopApp();
    await app.initAI({ provider: "ollama", isTauri: false });
    expect(app.governanceStatus.governed).toBe(false);
    expect((app.governanceStatus as { reason: string }).reason).toBe("dev mode");
  });

  it("reports missing governance when Tauri mode has no identity file", async () => {
    app = new DesktopApp();
    const mockInvoke: InvokeFn = (cmd: string) => {
      if (cmd === "read_config") return Promise.resolve("{}" as never);
      return Promise.resolve([] as never);
    };
    await app.initAI({ provider: "ollama", isTauri: true, invoke: mockInvoke });
    expect(app.governanceStatus.governed).toBe(false);
    expect((app.governanceStatus as { reason: string }).reason).toContain(
      "missing or invalid governance",
    );
  });
});

// ---------------------------------------------------------------------------
// DesktopApp — Goal tools registration
// ---------------------------------------------------------------------------

describe("DesktopApp goal tools", () => {
  let app: DesktopApp;

  afterEach(() => {
    if (app != null) app.stop();
  });

  it("goal tools are NOT registered in dev mode (non-Tauri)", async () => {
    app = new DesktopApp();
    await app.initAI({ provider: "ollama", isTauri: false });

    const toolNames = (
      app as unknown as { runtime: { getToolRegistry(): { list(): { name: string }[] } } }
    ).runtime
      .getToolRegistry()
      .list()
      .map((t) => t.name);
    expect(toolNames).not.toContain("create_sub_goal");
    expect(toolNames).not.toContain("complete_goal");
    expect(toolNames).not.toContain("report_progress");
  });

  it("goal tools appear in registry in Tauri mode", async () => {
    app = new DesktopApp();
    const db = emptyDb();
    const invoke = createMockInvoke(db);
    await app.initAI({ provider: "ollama", isTauri: true, invoke });

    const toolNames = (
      app as unknown as { runtime: { getToolRegistry(): { list(): { name: string }[] } } }
    ).runtime
      .getToolRegistry()
      .list()
      .map((t) => t.name);

    expect(toolNames).toContain("create_sub_goal");
    expect(toolNames).toContain("complete_goal");
    expect(toolNames).toContain("report_progress");
  });

  it("create_sub_goal returns error when called outside goal context", async () => {
    app = new DesktopApp();
    const db = emptyDb();
    const invoke = createMockInvoke(db);
    await app.initAI({ provider: "ollama", isTauri: true, invoke });

    const registry = (
      app as unknown as {
        runtime: {
          getToolRegistry(): {
            execute(
              name: string,
              args: Record<string, unknown>,
            ): Promise<{ ok: boolean; error?: string }>;
          };
        };
      }
    ).runtime.getToolRegistry();

    const result = await registry.execute("create_sub_goal", { prompt: "test sub-goal" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("No active goal context");
  });

  it("complete_goal returns error when called outside goal context", async () => {
    app = new DesktopApp();
    const db = emptyDb();
    const invoke = createMockInvoke(db);
    await app.initAI({ provider: "ollama", isTauri: true, invoke });

    const registry = (
      app as unknown as {
        runtime: {
          getToolRegistry(): {
            execute(
              name: string,
              args: Record<string, unknown>,
            ): Promise<{ ok: boolean; error?: string }>;
          };
        };
      }
    ).runtime.getToolRegistry();

    const result = await registry.execute("complete_goal", { reason: "done" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("No active goal context");
  });

  it("report_progress returns error when called outside goal context", async () => {
    app = new DesktopApp();
    const db = emptyDb();
    const invoke = createMockInvoke(db);
    await app.initAI({ provider: "ollama", isTauri: true, invoke });

    const registry = (
      app as unknown as {
        runtime: {
          getToolRegistry(): {
            execute(
              name: string,
              args: Record<string, unknown>,
            ): Promise<{ ok: boolean; error?: string }>;
          };
        };
      }
    ).runtime.getToolRegistry();

    const result = await registry.execute("report_progress", { note: "halfway done" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("No active goal context");
  });
});

// ---------------------------------------------------------------------------
// DesktopApp.exportAllData — includes runtime data
// ---------------------------------------------------------------------------

describe("DesktopApp.exportAllData", () => {
  let app: DesktopApp;

  afterEach(() => {
    if (app != null) app.stop();
  });

  it("includes identity fields even without runtime", async () => {
    app = new DesktopApp();
    const json = await app.exportAllData();
    const data = JSON.parse(json) as Record<string, unknown>;
    expect(data.motebit_id).toBe("desktop-local");
    expect(data.exported_at).toBeDefined();
  });

  it("includes state and memories when runtime is initialized", async () => {
    app = new DesktopApp();
    await app.initAI({ provider: "ollama", isTauri: false });
    const json = await app.exportAllData();
    const data = JSON.parse(json) as Record<string, unknown>;
    expect(data.state).toBeDefined();
    expect(data.memories).toBeDefined();
    expect(data.events).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Mock invoke helpers
// ---------------------------------------------------------------------------

interface MockDbState {
  conversations: Array<{
    conversation_id: string;
    motebit_id: string;
    started_at: number;
    last_active_at: number;
    title: string | null;
    summary: string | null;
    message_count: number;
  }>;
  messages: Array<{
    message_id: string;
    conversation_id: string;
    motebit_id: string;
    role: string;
    content: string;
    tool_calls: string | null;
    tool_call_id: string | null;
    created_at: number;
    token_estimate: number;
  }>;
  goals: Array<{
    goal_id: string;
    motebit_id: string;
    prompt: string;
    interval_ms: number;
    last_run_at: number | null;
    enabled: number;
    status: string;
    mode: string;
    parent_goal_id: string | null;
    max_retries: number;
    consecutive_failures: number;
  }>;
  goalOutcomes: Array<{
    ran_at: number;
    status: string;
    summary: string | null;
    error_message: string | null;
  }>;
  plans: Array<{
    plan_id: string;
    goal_id: string;
    motebit_id: string;
    title: string;
    status: string;
    created_at: number;
    updated_at: number;
    current_step_index: number;
    total_steps: number;
  }>;
  planSteps: Array<{
    step_id: string;
    plan_id: string;
    ordinal: number;
    description: string;
    prompt: string;
    depends_on: string;
    optional: number;
    status: string;
    result_summary: string | null;
    error_message: string | null;
    tool_calls_made: number;
    started_at: number | null;
    completed_at: number | null;
    retry_count: number;
  }>;
  executions: Array<{ sql: string; params: unknown[] }>;
}

function createMockInvoke(db: MockDbState): InvokeFn {
  return ((cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "db_query") {
      const sql = (args?.sql as string) ?? "";
      if (
        sql.includes("FROM conversations") &&
        sql.includes("ORDER BY last_active_at DESC LIMIT 1")
      ) {
        return Promise.resolve(db.conversations.slice(0, 1));
      }
      if (sql.includes("FROM conversations")) {
        return Promise.resolve(db.conversations);
      }
      if (sql.includes("FROM conversation_messages")) {
        const convId = (args?.params as unknown[])?.[0] as string;
        return Promise.resolve(db.messages.filter((m) => m.conversation_id === convId));
      }
      if (sql.includes("FROM goals")) {
        return Promise.resolve(db.goals.filter((g) => g.enabled === 1 && g.status === "active"));
      }
      if (sql.includes("FROM goal_outcomes")) {
        return Promise.resolve(db.goalOutcomes);
      }
      if (sql.includes("message_count FROM conversations")) {
        const convId = (args?.params as unknown[])?.[0] as string;
        const conv = db.conversations.find((c) => c.conversation_id === convId);
        return Promise.resolve(conv ? [{ message_count: conv.message_count }] : []);
      }
      if (sql.includes("FROM plans")) {
        const goalId = (args?.params as unknown[])?.[0] as string;
        return Promise.resolve(db.plans.filter((p) => p.goal_id === goalId));
      }
      if (sql.includes("FROM plan_steps")) {
        const planId = (args?.params as unknown[])?.[0] as string;
        return Promise.resolve(db.planSteps.filter((s) => s.plan_id === planId));
      }
      if (sql.includes("MAX(version_clock)")) {
        return Promise.resolve([{ max_clock: 0 }]);
      }
      return Promise.resolve([]);
    }
    if (cmd === "db_execute") {
      db.executions.push({ sql: args?.sql as string, params: args?.params as unknown[] });
      return Promise.resolve(1);
    }
    if (cmd === "goals_create") {
      return Promise.resolve(undefined);
    }
    return Promise.resolve([] as never);
  }) as InvokeFn;
}

function emptyDb(): MockDbState {
  return {
    conversations: [],
    messages: [],
    goals: [],
    goalOutcomes: [],
    plans: [],
    planSteps: [],
    executions: [],
  };
}

// ---------------------------------------------------------------------------
// DesktopApp — Conversation Browsing
// ---------------------------------------------------------------------------

describe("DesktopApp.listConversationsAsync", () => {
  let app: DesktopApp;

  afterEach(() => {
    if (app != null) app.stop();
  });

  it("returns empty array without Tauri store", async () => {
    app = new DesktopApp();
    await app.initAI({ provider: "ollama", isTauri: false });
    const result = await app.listConversationsAsync();
    expect(result).toEqual([]);
  });

  it("returns conversations from Tauri store", async () => {
    const db = emptyDb();
    db.conversations.push({
      conversation_id: "conv-1",
      motebit_id: "desktop-local",
      started_at: 1000,
      last_active_at: 2000,
      title: "Test Chat",
      summary: null,
      message_count: 5,
    });
    app = new DesktopApp();
    await app.initAI({ provider: "ollama", isTauri: true, invoke: createMockInvoke(db) });

    const result = await app.listConversationsAsync();
    expect(result).toHaveLength(1);
    expect(result[0]!.conversationId).toBe("conv-1");
    expect(result[0]!.title).toBe("Test Chat");
    expect(result[0]!.messageCount).toBe(5);
  });
});

describe("DesktopApp.loadConversationById", () => {
  let app: DesktopApp;

  afterEach(() => {
    if (app != null) app.stop();
  });

  it("returns empty array without runtime", async () => {
    app = new DesktopApp();
    const result = await app.loadConversationById("conv-1");
    expect(result).toEqual([]);
  });

  it("returns empty array without Tauri store", async () => {
    app = new DesktopApp();
    await app.initAI({ provider: "ollama", isTauri: false });
    const result = await app.loadConversationById("conv-1");
    expect(result).toEqual([]);
  });

  it("loads messages and switches conversation", async () => {
    const db = emptyDb();
    db.conversations.push({
      conversation_id: "conv-1",
      motebit_id: "desktop-local",
      started_at: 1000,
      last_active_at: 2000,
      title: null,
      summary: null,
      message_count: 2,
    });
    db.messages.push(
      {
        message_id: "msg-1",
        conversation_id: "conv-1",
        motebit_id: "desktop-local",
        role: "user",
        content: "Hello",
        tool_calls: null,
        tool_call_id: null,
        created_at: 1000,
        token_estimate: 2,
      },
      {
        message_id: "msg-2",
        conversation_id: "conv-1",
        motebit_id: "desktop-local",
        role: "assistant",
        content: "Hi there",
        tool_calls: null,
        tool_call_id: null,
        created_at: 1001,
        token_estimate: 3,
      },
    );

    app = new DesktopApp();
    await app.initAI({ provider: "ollama", isTauri: true, invoke: createMockInvoke(db) });

    const messages = await app.loadConversationById("conv-1");
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.content).toBe("Hello");
    expect(messages[1]!.role).toBe("assistant");
    expect(messages[1]!.content).toBe("Hi there");
  });
});

describe("DesktopApp.startNewConversation", () => {
  let app: DesktopApp;

  afterEach(() => {
    if (app != null) app.stop();
  });

  it("does not throw without runtime", () => {
    app = new DesktopApp();
    expect(() => app.startNewConversation()).not.toThrow();
  });

  it("resets conversation (sets conversationId to null)", async () => {
    app = new DesktopApp();
    await app.initAI({ provider: "ollama", isTauri: false });
    // Before any messages, conversationId is null
    app.startNewConversation();
    // After reset, conversationId is null (no conversation until first message)
    expect(app.currentConversationId).toBeNull();
  });
});

describe("DesktopApp.currentConversationId", () => {
  let app: DesktopApp;

  afterEach(() => {
    if (app != null) app.stop();
  });

  it("returns null before initAI", () => {
    app = new DesktopApp();
    expect(app.currentConversationId).toBeNull();
  });

  it("returns null after initAI (no conversation until first message)", async () => {
    app = new DesktopApp();
    await app.initAI({ provider: "ollama", isTauri: false });
    // Conversation is lazily created on first message
    expect(app.currentConversationId).toBeNull();
  });
});

describe("DesktopApp.syncConversations", () => {
  let app: DesktopApp;

  afterEach(() => {
    if (app != null) app.stop();
  });

  it("returns zeros when no conversation store", async () => {
    app = new DesktopApp();
    await app.initAI({ provider: "ollama", isTauri: false });
    const result = await app.syncConversations("http://localhost:3000");
    expect(result).toEqual({
      conversations_pushed: 0,
      conversations_pulled: 0,
      messages_pushed: 0,
      messages_pulled: 0,
    });
  });
});

describe("DesktopApp.stopSync", () => {
  let app: DesktopApp;

  afterEach(() => {
    if (app != null) app.stop();
  });

  it("does not throw without runtime", () => {
    app = new DesktopApp();
    expect(() => app.stopSync()).not.toThrow();
  });

  it("does not throw after initAI", async () => {
    app = new DesktopApp();
    await app.initAI({ provider: "ollama", isTauri: false });
    expect(() => app.stopSync()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// DesktopApp — Goal Scheduler
// ---------------------------------------------------------------------------

describe("DesktopApp.startGoalScheduler / stopGoalScheduler", () => {
  let app: DesktopApp;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    if (app != null) app.stop();
    vi.useRealTimers();
  });

  it("startGoalScheduler is idempotent", async () => {
    app = new DesktopApp();
    const db = emptyDb();
    const invoke = createMockInvoke(db);
    await app.initAI({ provider: "ollama", isTauri: true, invoke });

    app.startGoalScheduler(invoke);
    app.startGoalScheduler(invoke); // Second call should be a no-op
    app.stopGoalScheduler();
  });

  it("stopGoalScheduler without start is safe", async () => {
    app = new DesktopApp();
    expect(() => app.stopGoalScheduler()).not.toThrow();
  });

  it("stopGoalScheduler prevents interval ticks (initial setTimeout still fires)", async () => {
    app = new DesktopApp();
    const db = emptyDb();
    const invoke = vi.fn(createMockInvoke(db)) as unknown as InvokeFn & ReturnType<typeof vi.fn>;
    await app.initAI({ provider: "ollama", isTauri: true, invoke });

    app.startGoalScheduler(invoke);
    app.stopGoalScheduler();

    // Advance past the initial 5s delay — this one still fires (setTimeout not cleared)
    await vi.advanceTimersByTimeAsync(6_000);
    const afterInitial = invoke.mock.calls.filter(
      (call: unknown[]) =>
        call[0] === "db_query" &&
        ((call[1] as Record<string, unknown>)?.sql as string)?.includes("FROM goals"),
    ).length;

    // Advance past multiple 60s intervals — none should fire (setInterval was cleared)
    await vi.advanceTimersByTimeAsync(180_000);
    const afterIntervals = invoke.mock.calls.filter(
      (call: unknown[]) =>
        call[0] === "db_query" &&
        ((call[1] as Record<string, unknown>)?.sql as string)?.includes("FROM goals"),
    ).length;

    // No additional goal queries after the initial timeout
    expect(afterIntervals).toBe(afterInitial);
  });
});

describe("DesktopApp.isGoalExecuting", () => {
  let app: DesktopApp;

  afterEach(() => {
    if (app != null) app.stop();
  });

  it("is false initially", () => {
    app = new DesktopApp();
    expect(app.isGoalExecuting).toBe(false);
  });
});

describe("DesktopApp goal callbacks", () => {
  let app: DesktopApp;

  afterEach(() => {
    if (app != null) app.stop();
  });

  it("onGoalStatus and onGoalComplete accept callbacks", async () => {
    app = new DesktopApp();
    await app.initAI({ provider: "ollama", isTauri: false });

    const statusCalls: boolean[] = [];
    const completeCalls: Array<{ status: string }> = [];

    app.onGoalStatus((executing) => statusCalls.push(executing));
    app.onGoalComplete((event) => completeCalls.push({ status: event.status }));

    // Callbacks are registered but won't fire until a goal tick runs
    expect(statusCalls).toHaveLength(0);
    expect(completeCalls).toHaveLength(0);
  });
});

describe("DesktopApp.goalTick (via startGoalScheduler)", () => {
  let app: DesktopApp;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    // Mock fetch to reject immediately so AI calls fail fast (no Ollama)
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Connection refused"));
  });

  afterEach(() => {
    if (app != null) app.stop();
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it("no-op when no active goals", async () => {
    app = new DesktopApp();
    const db = emptyDb();
    const invoke = vi.fn(createMockInvoke(db)) as unknown as InvokeFn & ReturnType<typeof vi.fn>;
    await app.initAI({ provider: "ollama", isTauri: true, invoke });

    app.startGoalScheduler(invoke);

    // Advance past the 5s initial delay
    await vi.advanceTimersByTimeAsync(6_000);

    // Should have queried goals and found none — no executions recorded
    expect(db.executions).toHaveLength(0);
    app.stopGoalScheduler();
  });

  it("records failed outcome when AI call fails", async () => {
    app = new DesktopApp();
    const db = emptyDb();
    db.goals.push({
      goal_id: "goal-1",
      motebit_id: "desktop-local",
      prompt: "Check the weather",
      interval_ms: 60_000,
      last_run_at: null,
      enabled: 1,
      status: "active",
      mode: "recurring",
      parent_goal_id: null,
      max_retries: 3,
      consecutive_failures: 0,
    });

    const invoke = vi.fn(createMockInvoke(db)) as unknown as InvokeFn & ReturnType<typeof vi.fn>;
    await app.initAI({ provider: "ollama", isTauri: true, invoke });

    const completeCalls: Array<{ goalId: string; status: string; error: string | null }> = [];
    app.onGoalComplete((event) =>
      completeCalls.push({
        goalId: event.goalId,
        status: event.status,
        error: event.error,
      }),
    );

    const statusCalls: boolean[] = [];
    app.onGoalStatus((executing) => statusCalls.push(executing));

    app.startGoalScheduler(invoke);

    // Advance past the 5s initial delay to trigger goalTick
    await vi.advanceTimersByTimeAsync(6_000);

    // Should have attempted the goal, failed, and recorded the failure
    const failInserts = db.executions.filter(
      (e) => e.sql.includes("INSERT INTO goal_outcomes") && e.sql.includes("failed"),
    );
    expect(failInserts.length).toBeGreaterThanOrEqual(1);

    // Should have incremented consecutive_failures
    const failUpdates = db.executions.filter((e) =>
      e.sql.includes("consecutive_failures = consecutive_failures + 1"),
    );
    expect(failUpdates.length).toBeGreaterThanOrEqual(1);

    // onGoalComplete should have fired with failed status
    expect(completeCalls).toHaveLength(1);
    expect(completeCalls[0]!.goalId).toBe("goal-1");
    expect(completeCalls[0]!.status).toBe("failed");
    expect(completeCalls[0]!.error).toBeTruthy();

    // onGoalStatus should have been called with true (start) then false (end)
    expect(statusCalls).toContain(true);
    expect(statusCalls).toContain(false);

    app.stopGoalScheduler();
  });

  it("auto-pauses goal when consecutive_failures reaches max_retries", async () => {
    app = new DesktopApp();
    const db = emptyDb();
    db.goals.push({
      goal_id: "goal-2",
      motebit_id: "desktop-local",
      prompt: "Failing goal",
      interval_ms: 60_000,
      last_run_at: null,
      enabled: 1,
      status: "active",
      mode: "recurring",
      parent_goal_id: null,
      max_retries: 1,
      consecutive_failures: 0, // Will reach 1 after this failure → pauses
    });

    const invoke = vi.fn(createMockInvoke(db)) as unknown as InvokeFn & ReturnType<typeof vi.fn>;
    await app.initAI({ provider: "ollama", isTauri: true, invoke });

    app.startGoalScheduler(invoke);
    await vi.advanceTimersByTimeAsync(6_000);

    // Should have paused the goal (consecutive_failures 0 + 1 >= max_retries 1)
    const pauseUpdates = db.executions.filter((e) =>
      e.sql.includes("UPDATE goals SET status = 'paused'"),
    );
    expect(pauseUpdates.length).toBeGreaterThanOrEqual(1);
    expect(pauseUpdates[0]!.params).toContain("goal-2");

    app.stopGoalScheduler();
  });

  it("skips goal that has not elapsed its interval", async () => {
    app = new DesktopApp();
    const db = emptyDb();
    db.goals.push({
      goal_id: "goal-3",
      motebit_id: "desktop-local",
      prompt: "Recent goal",
      interval_ms: 300_000, // 5 minutes
      last_run_at: Date.now() - 60_000, // Ran 1 minute ago
      enabled: 1,
      status: "active",
      mode: "recurring",
      parent_goal_id: null,
      max_retries: 3,
      consecutive_failures: 0,
    });

    const invoke = vi.fn(createMockInvoke(db)) as unknown as InvokeFn & ReturnType<typeof vi.fn>;
    await app.initAI({ provider: "ollama", isTauri: true, invoke });

    const statusCalls: boolean[] = [];
    app.onGoalStatus((executing) => statusCalls.push(executing));

    app.startGoalScheduler(invoke);
    await vi.advanceTimersByTimeAsync(6_000);

    // Goal should not have been executed (not enough time elapsed)
    expect(statusCalls).not.toContain(true);
    expect(db.executions).toHaveLength(0);

    app.stopGoalScheduler();
  });
});

describe("DesktopApp.resumeGoalAfterApproval", () => {
  let app: DesktopApp;

  afterEach(() => {
    if (app != null) app.stop();
  });

  it("throws without runtime", async () => {
    app = new DesktopApp();
    const gen = app.resumeGoalAfterApproval(true);
    await expect(gen.next()).rejects.toThrow("AI not initialized");
  });

  it("throws without pending approval", async () => {
    app = new DesktopApp();
    await app.initAI({ provider: "ollama", isTauri: false });
    const gen = app.resumeGoalAfterApproval(true);
    await expect(gen.next()).rejects.toThrow("No pending goal approval");
  });
});

// ---------------------------------------------------------------------------
// Helper: access private fields on DesktopApp for auto-title testing
// ---------------------------------------------------------------------------

type RuntimeInternals = {
  conversationId: string | null;
  conversationHistory: Array<{ role: string; content: string }>;
};

/** Cast to access DesktopApp private fields */
function appInternals(app: DesktopApp) {
  return app as unknown as {
    runtime: RuntimeInternals | null;
    conversationStoreRef: unknown;
    _autoTitlePending: boolean;
  };
}

/** Set up a DesktopApp with Tauri store, runtime initialized, and an active conversation with N messages. */
async function setupAppWithConversation(opts: {
  messageCount: number;
  title?: string | null;
  firstUserContent?: string;
}): Promise<{ app: DesktopApp; db: MockDbState }> {
  const db = emptyDb();
  const convId = "conv-auto-title";

  db.conversations.push({
    conversation_id: convId,
    motebit_id: "desktop-local",
    started_at: 1000,
    last_active_at: 2000,
    title: opts.title ?? null,
    summary: null,
    message_count: opts.messageCount,
  });

  // Build messages for the mock DB
  const firstContent =
    opts.firstUserContent ?? "Tell me about the history of computing and how it evolved over time";
  for (let i = 0; i < opts.messageCount; i++) {
    const isUser = i % 2 === 0;
    db.messages.push({
      message_id: `msg-${i}`,
      conversation_id: convId,
      motebit_id: "desktop-local",
      role: isUser ? "user" : "assistant",
      content: i === 0 ? firstContent : isUser ? `Follow-up question ${i}` : `Response ${i}`,
      tool_calls: null,
      tool_call_id: null,
      created_at: 1000 + i,
      token_estimate: 10,
    });
  }

  const app = new DesktopApp();
  await app.initAI({ provider: "ollama", isTauri: true, invoke: createMockInvoke(db) });

  // Set up the runtime's internal conversation state to match
  const internals = appInternals(app);
  const rt = internals.runtime!;
  rt.conversationId = convId;
  rt.conversationHistory = db.messages.map((m) => ({ role: m.role, content: m.content }));

  return { app, db };
}

// ---------------------------------------------------------------------------
// DesktopApp.maybeAutoTitle
// ---------------------------------------------------------------------------

describe("DesktopApp.maybeAutoTitle", () => {
  let app: DesktopApp;

  afterEach(() => {
    if (app != null) app.stop();
  });

  it("returns null without runtime", async () => {
    app = new DesktopApp();
    const result = await app.maybeAutoTitle();
    expect(result).toBeNull();
  });

  it("returns null without conversation store (in-memory mode)", async () => {
    app = new DesktopApp();
    await app.initAI({ provider: "ollama", isTauri: false });
    const result = await app.maybeAutoTitle();
    expect(result).toBeNull();
  });

  it("returns null when _autoTitlePending is true", async () => {
    const setup = await setupAppWithConversation({ messageCount: 6 });
    app = setup.app;
    appInternals(app)._autoTitlePending = true;
    const result = await app.maybeAutoTitle();
    expect(result).toBeNull();
  });

  it("returns null when runtime has no conversation ID", async () => {
    app = new DesktopApp();
    const db = emptyDb();
    await app.initAI({ provider: "ollama", isTauri: true, invoke: createMockInvoke(db) });
    // runtime exists but conversationId is null (no conversation started)
    const result = await app.maybeAutoTitle();
    expect(result).toBeNull();
  });

  it("returns null with fewer than 4 messages", async () => {
    const setup = await setupAppWithConversation({ messageCount: 2 });
    app = setup.app;
    const result = await app.maybeAutoTitle();
    expect(result).toBeNull();
  });

  it("returns existing title when conversation is already titled", async () => {
    const setup = await setupAppWithConversation({
      messageCount: 6,
      title: "Existing Title",
    });
    app = setup.app;
    const result = await app.maybeAutoTitle();
    expect(result).toBe("Existing Title");
  });

  it("returns null when AI call fails (no real provider)", async () => {
    // With 4+ messages and no title, maybeAutoTitle will try to call
    // runtime.sendMessage for AI-based titling. Without a real provider,
    // the call will fail and the method returns null gracefully.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Connection refused"));
    try {
      const setup = await setupAppWithConversation({ messageCount: 6 });
      app = setup.app;
      const result = await app.maybeAutoTitle();
      expect(result).toBeNull();
      // Verify that _autoTitlePending was reset in the finally block
      expect(appInternals(app)._autoTitlePending).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// DesktopApp.generateTitleInBackground
// ---------------------------------------------------------------------------

describe("DesktopApp.generateTitleInBackground", () => {
  let app: DesktopApp;

  afterEach(() => {
    if (app != null) app.stop();
  });

  it("returns null without runtime", async () => {
    app = new DesktopApp();
    const result = await app.generateTitleInBackground();
    expect(result).toBeNull();
  });

  it("returns null without conversation store (in-memory mode)", async () => {
    app = new DesktopApp();
    await app.initAI({ provider: "ollama", isTauri: false });
    const result = await app.generateTitleInBackground();
    expect(result).toBeNull();
  });

  it("returns null when runtime has no conversation ID", async () => {
    app = new DesktopApp();
    const db = emptyDb();
    await app.initAI({ provider: "ollama", isTauri: true, invoke: createMockInvoke(db) });
    const result = await app.generateTitleInBackground();
    expect(result).toBeNull();
  });

  it("returns null with fewer than 4 messages (message count check)", async () => {
    const setup = await setupAppWithConversation({ messageCount: 2 });
    app = setup.app;
    const result = await app.generateTitleInBackground();
    expect(result).toBeNull();
  });

  it("returns null when conversation already has a title", async () => {
    const setup = await setupAppWithConversation({
      messageCount: 6,
      title: "Already Titled",
    });
    app = setup.app;
    const result = await app.generateTitleInBackground();
    expect(result).toBeNull();
  });

  it("returns null when _autoTitlePending is true (concurrent guard)", async () => {
    const setup = await setupAppWithConversation({ messageCount: 6 });
    app = setup.app;
    appInternals(app)._autoTitlePending = true;
    const result = await app.generateTitleInBackground();
    expect(result).toBeNull();
  });

  /** Force AI path to fail so heuristic fallback is tested. */
  function forceHeuristicPath(desktopApp: DesktopApp): void {
    const rt = appInternals(desktopApp).runtime as unknown as {
      generateCompletion: (p: string) => Promise<string>;
    };
    rt.generateCompletion = vi.fn().mockRejectedValue(new Error("No provider"));
  }

  it("generates title from first 7 words of first user message with ellipsis", async () => {
    const setup = await setupAppWithConversation({
      messageCount: 6,
      firstUserContent: "Tell me about the history of computing and how it evolved over time",
    });
    app = setup.app;
    forceHeuristicPath(app);
    const result = await app.generateTitleInBackground();
    expect(result).toBe("Tell me about the history of computing...");
    // Verify the pending flag was reset
    expect(appInternals(app)._autoTitlePending).toBe(false);
  });

  it("uses full text when first user message has 7 or fewer words", async () => {
    const setup = await setupAppWithConversation({
      messageCount: 6,
      firstUserContent: "Hello how are you",
    });
    app = setup.app;
    forceHeuristicPath(app);
    const result = await app.generateTitleInBackground();
    expect(result).toBe("Hello how are you");
    expect(appInternals(app)._autoTitlePending).toBe(false);
  });

  it("uses full text for exactly 7 words without ellipsis", async () => {
    const setup = await setupAppWithConversation({
      messageCount: 6,
      firstUserContent: "one two three four five six seven",
    });
    app = setup.app;
    forceHeuristicPath(app);
    const result = await app.generateTitleInBackground();
    expect(result).toBe("one two three four five six seven");
  });

  it("appends ellipsis when first user message exceeds 7 words", async () => {
    const setup = await setupAppWithConversation({
      messageCount: 6,
      firstUserContent: "one two three four five six seven eight nine",
    });
    app = setup.app;
    forceHeuristicPath(app);
    const result = await app.generateTitleInBackground();
    expect(result).toBe("one two three four five six seven...");
  });

  it("persists the title via updateTitle (db_execute)", async () => {
    const setup = await setupAppWithConversation({
      messageCount: 6,
      firstUserContent: "What is machine learning",
    });
    app = setup.app;
    forceHeuristicPath(app);
    await app.generateTitleInBackground();

    // Check that the mock DB recorded the UPDATE for the title
    const titleUpdates = setup.db.executions.filter((e) =>
      e.sql.includes("UPDATE conversations SET title"),
    );
    expect(titleUpdates).toHaveLength(1);
    expect(titleUpdates[0]!.params).toContain("What is machine learning");
    expect(titleUpdates[0]!.params).toContain("conv-auto-title");
  });

  it("uses AI-generated title when runtime.generateCompletion succeeds", async () => {
    const setup = await setupAppWithConversation({
      messageCount: 6,
      firstUserContent: "Tell me about quantum computing and its implications for cryptography",
    });
    app = setup.app;

    // Mock generateCompletion on the runtime to simulate successful AI response
    const rt = appInternals(app).runtime as unknown as {
      generateCompletion: (p: string) => Promise<string>;
    };
    rt.generateCompletion = vi.fn().mockResolvedValue("Quantum Computing and Cryptography");

    const result = await app.generateTitleInBackground();
    expect(result).toBe("Quantum Computing and Cryptography");

    // Verify it used AI, not the heuristic
    expect(rt.generateCompletion).toHaveBeenCalledOnce();
    const prompt = (rt.generateCompletion as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(prompt).toContain("Generate a very short title");
  });

  it("falls back to heuristic when runtime.generateCompletion fails", async () => {
    const setup = await setupAppWithConversation({
      messageCount: 6,
      firstUserContent: "Tell me about quantum computing and its implications for cryptography",
    });
    app = setup.app;

    // Mock generateCompletion to throw (simulating provider failure)
    const rt = appInternals(app).runtime as unknown as {
      generateCompletion: (p: string) => Promise<string>;
    };
    rt.generateCompletion = vi.fn().mockRejectedValue(new Error("Connection refused"));

    const result = await app.generateTitleInBackground();
    // Falls back to heuristic: first 7 words + ellipsis
    expect(result).toBe("Tell me about quantum computing and its...");
  });

  it("strips quotes from AI-generated titles", async () => {
    const setup = await setupAppWithConversation({
      messageCount: 6,
      firstUserContent: "What is the weather today",
    });
    app = setup.app;

    const rt = appInternals(app).runtime as unknown as {
      generateCompletion: (p: string) => Promise<string>;
    };
    rt.generateCompletion = vi.fn().mockResolvedValue('"Today\'s Weather Forecast"');

    const result = await app.generateTitleInBackground();
    expect(result).toBe("Today's Weather Forecast");
  });
});

// ---------------------------------------------------------------------------
// DesktopApp.getConversationSummary
// ---------------------------------------------------------------------------

describe("DesktopApp.getConversationSummary", () => {
  let app: DesktopApp;

  afterEach(() => {
    if (app != null) app.stop();
  });

  it("returns null without conversation store", async () => {
    app = new DesktopApp();
    await app.initAI({ provider: "ollama", isTauri: false });
    const result = await app.getConversationSummary("conv-1");
    expect(result).toBeNull();
  });

  it("returns null for conversation without summary", async () => {
    const db = emptyDb();
    db.conversations.push({
      conversation_id: "conv-1",
      motebit_id: "desktop-local",
      started_at: 1000,
      last_active_at: 2000,
      title: "Test Chat",
      summary: null,
      message_count: 5,
    });
    app = new DesktopApp();
    await app.initAI({ provider: "ollama", isTauri: true, invoke: createMockInvoke(db) });

    const result = await app.getConversationSummary("conv-1");
    expect(result).toBeNull();
  });

  it("returns summary for conversation with one", async () => {
    const db = emptyDb();
    db.conversations.push({
      conversation_id: "conv-1",
      motebit_id: "desktop-local",
      started_at: 1000,
      last_active_at: 2000,
      title: "Test Chat",
      summary: "Discussed testing strategies for TypeScript apps.",
      message_count: 10,
    });
    app = new DesktopApp();
    await app.initAI({ provider: "ollama", isTauri: true, invoke: createMockInvoke(db) });

    const result = await app.getConversationSummary("conv-1");
    expect(result).toBe("Discussed testing strategies for TypeScript apps.");
  });

  it("returns null for non-existent conversation", async () => {
    const db = emptyDb();
    app = new DesktopApp();
    await app.initAI({ provider: "ollama", isTauri: true, invoke: createMockInvoke(db) });

    const result = await app.getConversationSummary("non-existent");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DesktopApp.summarizeConversation
// ---------------------------------------------------------------------------

describe("DesktopApp.summarizeConversation", () => {
  let app: DesktopApp;

  afterEach(() => {
    if (app != null) app.stop();
  });

  it("returns null without runtime", async () => {
    app = new DesktopApp();
    const result = await app.summarizeConversation();
    expect(result).toBeNull();
  });

  it("returns null without conversation store (in-memory mode)", async () => {
    app = new DesktopApp();
    await app.initAI({ provider: "ollama", isTauri: false });
    const result = await app.summarizeConversation();
    expect(result).toBeNull();
  });

  it("returns null when no active conversation", async () => {
    const db = emptyDb();
    app = new DesktopApp();
    await app.initAI({ provider: "ollama", isTauri: true, invoke: createMockInvoke(db) });
    const result = await app.summarizeConversation();
    expect(result).toBeNull();
  });

  it("returns null when conversation has fewer than 2 messages", async () => {
    const setup = await setupAppWithConversation({ messageCount: 1 });
    app = setup.app;
    const result = await app.summarizeConversation();
    expect(result).toBeNull();
  });

  it("returns summary when generateCompletion succeeds", async () => {
    const setup = await setupAppWithConversation({ messageCount: 6 });
    app = setup.app;

    // Mock generateCompletion
    const rt = appInternals(app).runtime as unknown as {
      generateCompletion: (p: string) => Promise<string>;
    };
    rt.generateCompletion = vi
      .fn()
      .mockResolvedValue("A conversation about computing history and evolution.");

    const result = await app.summarizeConversation();
    expect(result).toBe("A conversation about computing history and evolution.");

    // Verify it called generateCompletion with a summarization prompt
    expect(rt.generateCompletion).toHaveBeenCalledOnce();
    const prompt = (rt.generateCompletion as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(prompt).toContain("Summarize this conversation");
  });

  it("persists summary via updateSummary (db_execute)", async () => {
    const setup = await setupAppWithConversation({ messageCount: 6 });
    app = setup.app;

    const rt = appInternals(app).runtime as unknown as {
      generateCompletion: (p: string) => Promise<string>;
    };
    rt.generateCompletion = vi.fn().mockResolvedValue("Summary of the conversation.");

    await app.summarizeConversation();

    const summaryUpdates = setup.db.executions.filter((e) =>
      e.sql.includes("UPDATE conversations SET summary"),
    );
    expect(summaryUpdates).toHaveLength(1);
    expect(summaryUpdates[0]!.params).toContain("Summary of the conversation.");
    expect(summaryUpdates[0]!.params).toContain("conv-auto-title");
  });

  it("includes existing summary in the prompt for updates", async () => {
    const db = emptyDb();
    db.conversations.push({
      conversation_id: "conv-summ",
      motebit_id: "desktop-local",
      started_at: 1000,
      last_active_at: 2000,
      title: null,
      summary: "Previous summary content.",
      message_count: 6,
    });
    for (let i = 0; i < 6; i++) {
      db.messages.push({
        message_id: `msg-${i}`,
        conversation_id: "conv-summ",
        motebit_id: "desktop-local",
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}`,
        tool_calls: null,
        tool_call_id: null,
        created_at: 1000 + i,
        token_estimate: 10,
      });
    }

    app = new DesktopApp();
    await app.initAI({ provider: "ollama", isTauri: true, invoke: createMockInvoke(db) });

    const internals = appInternals(app);
    const rt = internals.runtime!;
    rt.conversationId = "conv-summ";
    rt.conversationHistory = db.messages.map((m) => ({ role: m.role, content: m.content }));

    const rtTyped = rt as unknown as { generateCompletion: (p: string) => Promise<string> };
    rtTyped.generateCompletion = vi.fn().mockResolvedValue("Updated summary.");

    const result = await app.summarizeConversation();
    expect(result).toBe("Updated summary.");

    const prompt = (rtTyped.generateCompletion as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as string;
    expect(prompt).toContain("Update this conversation summary");
    expect(prompt).toContain("Previous summary content.");
  });
});
