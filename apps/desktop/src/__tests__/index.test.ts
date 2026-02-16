import { describe, it, expect, afterEach } from "vitest";
import { DesktopApp, isSlashCommand, parseSlashCommand } from "../index";

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

  it("ollama provider initializes without an API key", () => {
    app = new DesktopApp();
    const result = app.initAI({
      provider: "ollama",
      isTauri: false,
    });
    expect(result).toBe(true);
    expect(app.isAIReady).toBe(true);
  });

  it("anthropic provider initializes with an API key", () => {
    app = new DesktopApp();
    const result = app.initAI({
      provider: "anthropic",
      apiKey: "sk-ant-test-key",
      isTauri: false,
    });
    expect(result).toBe(true);
    expect(app.isAIReady).toBe(true);
  });

  it("anthropic provider fails without an API key", () => {
    app = new DesktopApp();
    const result = app.initAI({
      provider: "anthropic",
      isTauri: false,
    });
    expect(result).toBe(false);
    expect(app.isAIReady).toBe(false);
  });

  it("personalityConfig temperature is passed through", () => {
    app = new DesktopApp();
    // This should not throw — the resolved config propagates to the provider
    const result = app.initAI({
      provider: "ollama",
      personalityConfig: { temperature: 0.2 },
      isTauri: false,
    });
    expect(result).toBe(true);
    expect(app.isAIReady).toBe(true);
  });

  it("ollama uses custom model when specified", () => {
    app = new DesktopApp();
    const result = app.initAI({
      provider: "ollama",
      model: "mistral",
      isTauri: false,
    });
    expect(result).toBe(true);
    expect(app.isAIReady).toBe(true);
  });

  it("anthropic uses custom model when specified", () => {
    app = new DesktopApp();
    const result = app.initAI({
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

  it("returns the model after ollama initAI", () => {
    app = new DesktopApp();
    app.initAI({ provider: "ollama", isTauri: false });
    expect(app.currentModel).toBe("llama3.2");
  });

  it("returns custom model when specified", () => {
    app = new DesktopApp();
    app.initAI({ provider: "ollama", model: "mistral", isTauri: false });
    expect(app.currentModel).toBe("mistral");
  });

  it("returns the model after anthropic initAI", () => {
    app = new DesktopApp();
    app.initAI({ provider: "anthropic", apiKey: "sk-test", isTauri: false });
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

  it("switches model in-place for ollama", () => {
    app = new DesktopApp();
    app.initAI({ provider: "ollama", isTauri: false });
    expect(app.currentModel).toBe("llama3.2");
    app.setModel("mistral");
    expect(app.currentModel).toBe("mistral");
  });

  it("switches model in-place for anthropic", () => {
    app = new DesktopApp();
    app.initAI({ provider: "anthropic", apiKey: "sk-test", isTauri: false });
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
    app.initAI({ provider: "ollama", isTauri: false });

    // Start a blocking sendMessage that we never await to completion
    // to set _isProcessing = true. We use sendMessage since it also sets the flag.
    const pending = app.sendMessage("first").catch(() => {});

    const gen = app.sendMessageStreaming("second");
    await expect(gen.next()).rejects.toThrow("Already processing");

    // Clean up — let the pending call reject (no real provider)
    await pending;
  });

  it("returns an async generator", () => {
    app = new DesktopApp();
    app.initAI({ provider: "ollama", isTauri: false });
    const gen = app.sendMessageStreaming("hello");
    expect(typeof gen[Symbol.asyncIterator]).toBe("function");
    // Return without consuming to avoid hitting the real provider
    void gen.return(undefined);
  });
});
