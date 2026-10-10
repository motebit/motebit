import { describe, it, expect, vi } from "vitest";
import { ConversationManager } from "../conversation-manager";
import type { ConversationManagerDeps } from "../conversation-manager";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeStore(overrides: Record<string, unknown> = {}): any {
  return {
    listConversationsAsync: vi.fn(async () => []),
    loadMessagesAsync: vi.fn(async () => {}),
    updateSummary: vi.fn(),
    updateTitle: vi.fn(),
    getMessageCount: vi.fn(async () => 0),
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeRuntime(overrides: Record<string, unknown> = {}): any {
  return {
    getConversationId: vi.fn(() => "conv-1"),
    getConversationHistory: vi.fn(() => []),
    loadConversation: vi.fn(),
    resetConversation: vi.fn(),
    generateCompletion: vi.fn(async () => "summary text"),
    summarizeCurrentConversation: vi.fn(async () => "runtime summary"),
    sendMessage: vi.fn(async () => ({ response: "title text" })),
    ...overrides,
  };
}

function makeManager(deps: Partial<ConversationManagerDeps> = {}): {
  mgr: ConversationManager;
  runtime: ReturnType<typeof makeRuntime>;
  store: ReturnType<typeof makeStore>;
} {
  const runtime = makeRuntime();
  const store = makeStore();
  const mgr = new ConversationManager({
    getRuntime: () => runtime,
    getMotebitId: () => "motebit-1",
    getConversationStore: () => store,
    ...deps,
  });
  return { mgr, runtime, store };
}

describe("ConversationManager.listConversationsAsync", () => {
  it("returns [] when no store", async () => {
    const mgr = new ConversationManager({
      getRuntime: () => null,
      getMotebitId: () => "m",
      getConversationStore: () => null,
    });
    expect(await mgr.listConversationsAsync()).toEqual([]);
  });

  it("delegates to store with default limit 20", async () => {
    const { mgr, store } = makeManager();
    await mgr.listConversationsAsync();
    expect(store.listConversationsAsync).toHaveBeenCalledWith("motebit-1", 20);
  });

  it("passes custom limit", async () => {
    const { mgr, store } = makeManager();
    await mgr.listConversationsAsync(50);
    expect(store.listConversationsAsync).toHaveBeenCalledWith("motebit-1", 50);
  });
});

describe("ConversationManager.loadConversationById", () => {
  it("returns [] when runtime is null", async () => {
    const { mgr } = makeManager({ getRuntime: () => null });
    expect(await mgr.loadConversationById("c1")).toEqual([]);
  });

  it("returns [] when store is null", async () => {
    const { mgr } = makeManager({ getConversationStore: () => null });
    expect(await mgr.loadConversationById("c1")).toEqual([]);
  });

  it("prefetches, loads, returns history", async () => {
    const history = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const { mgr, runtime, store } = makeManager();
    runtime.getConversationHistory.mockReturnValue(history);
    const result = await mgr.loadConversationById("c42");
    expect(store.loadMessagesAsync).toHaveBeenCalledWith("c42");
    expect(runtime.loadConversation).toHaveBeenCalledWith("c42");
    expect(result).toEqual(history);
  });
});

describe("ConversationManager.startNewConversation", () => {
  it("calls runtime.resetConversation when runtime exists", () => {
    const { mgr, runtime } = makeManager();
    mgr.startNewConversation();
    expect(runtime.resetConversation).toHaveBeenCalled();
  });

  it("no-ops when runtime is null", () => {
    const mgr = new ConversationManager({
      getRuntime: () => null,
      getMotebitId: () => "m",
      getConversationStore: () => makeStore(),
    });
    expect(() => mgr.startNewConversation()).not.toThrow();
  });
});

describe("ConversationManager.getCurrentConversationId", () => {
  it("returns id from runtime", () => {
    const { mgr, runtime } = makeManager();
    runtime.getConversationId.mockReturnValue("active");
    expect(mgr.getCurrentConversationId()).toBe("active");
  });

  it("returns null when runtime is null", () => {
    const mgr = new ConversationManager({
      getRuntime: () => null,
      getMotebitId: () => "m",
      getConversationStore: () => makeStore(),
    });
    expect(mgr.getCurrentConversationId()).toBeNull();
  });
});

describe("ConversationManager.getConversationSummary", () => {
  it("returns null when no store", async () => {
    const mgr = new ConversationManager({
      getRuntime: () => null,
      getMotebitId: () => "m",
      getConversationStore: () => null,
    });
    expect(await mgr.getConversationSummary("c")).toBeNull();
  });

  it("returns summary for matching conversation", async () => {
    const { mgr, store } = makeManager();
    store.listConversationsAsync.mockResolvedValue([
      { conversationId: "c1", summary: "hello world" },
    ]);
    expect(await mgr.getConversationSummary("c1")).toBe("hello world");
  });

  it("displays a stamped summary without its sensitivity header", async () => {
    const { mgr, store } = makeManager();
    store.listConversationsAsync.mockResolvedValue([
      { conversationId: "c1", summary: "[motebit:sensitivity=personal]\nhello world" },
    ]);
    expect(await mgr.getConversationSummary("c1")).toBe("hello world");
  });

  it("returns null for unknown conversation", async () => {
    const { mgr } = makeManager();
    expect(await mgr.getConversationSummary("unknown")).toBeNull();
  });
});

describe("ConversationManager.summarizeConversation", () => {
  it("returns null when there is no runtime", async () => {
    const { mgr } = makeManager({ getRuntime: () => null });
    expect(await mgr.summarizeConversation()).toBeNull();
  });

  it("routes through the runtime's tier-filtered, stamp-persisting summarize — never a raw-history completion", async () => {
    const { mgr, runtime } = makeManager();
    runtime.getConversationHistory.mockReturnValue([
      { role: "user", content: "my code is SECRETDX", sensitivity: "secret" },
      { role: "assistant", content: "ok", sensitivity: "secret" },
    ]);
    const result = await mgr.summarizeConversation();
    expect(result).toBe("runtime summary");
    expect(runtime.summarizeCurrentConversation).toHaveBeenCalledTimes(1);
    expect(runtime.generateCompletion).not.toHaveBeenCalled();
  });
});
