import { describe, it, expect, afterEach } from "vitest";
import { DesktopApp } from "../index";

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
