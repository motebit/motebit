import { describe, it, expect, afterEach } from "vitest";
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
    if (app) {
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
    if (app) {
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
    expect(parseSlashCommand("/model  spaced  arg ")).toEqual({ command: "model", args: "spaced  arg" });
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
    if (app) app.stop();
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
    expect(app.currentModel).toBe("claude-sonnet-4-20250514");
  });
});

describe("DesktopApp.setModel", () => {
  let app: DesktopApp;

  afterEach(() => {
    if (app) app.stop();
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
    if (app) app.stop();
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
    if (app) app.stop();
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
    if (app) app.stop();
  });

  it("registers browser-safe builtin tools in dev mode", async () => {
    app = new DesktopApp();
    await app.initAI({ provider: "ollama", isTauri: false });

    // The runtime should have the 4 browser-safe tools registered
    const toolNames = (app as unknown as { runtime: { getToolRegistry(): { list(): { name: string }[] } } })
      .runtime.getToolRegistry().list().map((t) => t.name);

    expect(toolNames).toContain("web_search");
    expect(toolNames).toContain("read_url");
    expect(toolNames).toContain("recall_memories");
    expect(toolNames).toContain("list_events");
  });

  it("does NOT register tools in Tauri mode without governance (fail-closed)", async () => {
    app = new DesktopApp();
    // Mock invoke returns empty config — no _identity_file
    const mockInvoke: InvokeFn = (cmd: string) => {
      if (cmd === "read_config") return Promise.resolve("{}" as never);
      return Promise.resolve([] as never);
    };
    await app.initAI({ provider: "ollama", isTauri: true, invoke: mockInvoke });

    const toolNames = (app as unknown as { runtime: { getToolRegistry(): { list(): { name: string }[] } } })
      .runtime.getToolRegistry().list().map((t) => t.name);

    expect(toolNames).not.toContain("web_search");
    expect(toolNames).not.toContain("recall_memories");
    expect(toolNames).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// DesktopApp.governanceStatus
// ---------------------------------------------------------------------------

describe("DesktopApp.governanceStatus", () => {
  let app: DesktopApp;

  afterEach(() => {
    if (app) app.stop();
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
    expect((app.governanceStatus as { reason: string }).reason).toContain("missing or invalid governance");
  });
});

// ---------------------------------------------------------------------------
// DesktopApp.exportAllData — includes runtime data
// ---------------------------------------------------------------------------

describe("DesktopApp.exportAllData", () => {
  let app: DesktopApp;

  afterEach(() => {
    if (app) app.stop();
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
