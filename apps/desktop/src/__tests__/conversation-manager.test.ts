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

  it("returns null for unknown conversation", async () => {
    const { mgr } = makeManager();
    expect(await mgr.getConversationSummary("unknown")).toBeNull();
  });
});

describe("ConversationManager.summarizeConversation", () => {
  it("returns null when runtime or store missing", async () => {
    const { mgr: m1 } = makeManager({ getRuntime: () => null });
    expect(await m1.summarizeConversation()).toBeNull();

    const { mgr: m2 } = makeManager({ getConversationStore: () => null });
    expect(await m2.summarizeConversation()).toBeNull();
  });

  it("returns null when conversationId is empty", async () => {
    const { mgr, runtime } = makeManager();
    runtime.getConversationId.mockReturnValue("");
    expect(await mgr.summarizeConversation()).toBeNull();
  });

  it("returns null when history has <2 messages", async () => {
    const { mgr, runtime } = makeManager();
    runtime.getConversationHistory.mockReturnValue([{ role: "user", content: "hi" }]);
    expect(await mgr.summarizeConversation()).toBeNull();
  });

  it("generates + persists summary for fresh conversation", async () => {
    const { mgr, runtime, store } = makeManager();
    runtime.getConversationHistory.mockReturnValue([
      { role: "user", content: "question" },
      { role: "assistant", content: "answer" },
    ]);
    runtime.generateCompletion.mockResolvedValue("a concise summary");
    const result = await mgr.summarizeConversation();
    expect(result).toBe("a concise summary");
    expect(store.updateSummary).toHaveBeenCalledWith("conv-1", "a concise summary");
  });

  it("uses 'update' prompt when existing summary is present", async () => {
    const { mgr, runtime, store } = makeManager();
    runtime.getConversationHistory.mockReturnValue([
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ]);
    store.listConversationsAsync.mockResolvedValue([
      { conversationId: "conv-1", summary: "prior summary" },
    ]);
    await mgr.summarizeConversation();
    const prompt = runtime.generateCompletion.mock.calls[0][0] as string;
    expect(prompt).toContain("Existing summary:");
    expect(prompt).toContain("prior summary");
  });

  it("returns null when AI returns empty string", async () => {
    const { mgr, runtime, store } = makeManager();
    runtime.getConversationHistory.mockReturnValue([
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ]);
    runtime.generateCompletion.mockResolvedValue("   ");
    const result = await mgr.summarizeConversation();
    expect(result).toBeNull();
    expect(store.updateSummary).not.toHaveBeenCalled();
  });
});

describe("ConversationManager.maybeAutoTitle", () => {
  it("returns null when runtime or store missing", async () => {
    const { mgr: m1 } = makeManager({ getRuntime: () => null });
    expect(await m1.maybeAutoTitle()).toBeNull();
  });

  it("returns null when history.length < 4", async () => {
    const { mgr, runtime } = makeManager();
    runtime.getConversationHistory.mockReturnValue([
      { role: "user", content: "1" },
      { role: "user", content: "2" },
    ]);
    expect(await mgr.maybeAutoTitle()).toBeNull();
  });

  it("returns existing title when already titled", async () => {
    const { mgr, runtime, store } = makeManager();
    runtime.getConversationHistory.mockReturnValue([
      { role: "user", content: "1" },
      { role: "assistant", content: "2" },
      { role: "user", content: "3" },
      { role: "assistant", content: "4" },
    ]);
    store.listConversationsAsync.mockResolvedValue([
      { conversationId: "conv-1", title: "Existing Title" },
    ]);
    const result = await mgr.maybeAutoTitle();
    expect(result).toBe("Existing Title");
  });

  it("generates + persists title when none exists", async () => {
    const { mgr, runtime, store } = makeManager();
    runtime.getConversationHistory.mockReturnValue([
      { role: "user", content: "1" },
      { role: "assistant", content: "2" },
      { role: "user", content: "3" },
      { role: "assistant", content: "4" },
    ]);
    runtime.sendMessage.mockResolvedValue({ response: "A Short Title" });
    const result = await mgr.maybeAutoTitle();
    expect(result).toBe("A Short Title");
    expect(store.updateTitle).toHaveBeenCalledWith("conv-1", "A Short Title");
  });

  it("trims quotes from generated title", async () => {
    const { mgr, runtime, store } = makeManager();
    runtime.getConversationHistory.mockReturnValue([
      { role: "user", content: "1" },
      { role: "assistant", content: "2" },
      { role: "user", content: "3" },
      { role: "assistant", content: "4" },
    ]);
    runtime.sendMessage.mockResolvedValue({ response: '"Quoted Title"' });
    await mgr.maybeAutoTitle();
    expect(store.updateTitle).toHaveBeenCalledWith("conv-1", "Quoted Title");
  });

  it("swallows AI errors and returns null", async () => {
    const { mgr, runtime } = makeManager();
    runtime.getConversationHistory.mockReturnValue([
      { role: "user", content: "1" },
      { role: "assistant", content: "2" },
      { role: "user", content: "3" },
      { role: "assistant", content: "4" },
    ]);
    runtime.sendMessage.mockRejectedValue(new Error("ai down"));
    await expect(mgr.maybeAutoTitle()).resolves.toBeNull();
  });
});

describe("ConversationManager.generateTitleInBackground", () => {
  it("returns null when runtime or store missing", async () => {
    const { mgr: m1 } = makeManager({ getRuntime: () => null });
    expect(await m1.generateTitleInBackground()).toBeNull();
  });

  it("returns null when message count < 4", async () => {
    const { mgr, store } = makeManager();
    store.getMessageCount.mockResolvedValue(2);
    expect(await mgr.generateTitleInBackground()).toBeNull();
  });

  it("returns null when already titled", async () => {
    const { mgr, store } = makeManager();
    store.getMessageCount.mockResolvedValue(5);
    store.listConversationsAsync.mockResolvedValue([
      { conversationId: "conv-1", title: "Existing" },
    ]);
    expect(await mgr.generateTitleInBackground()).toBeNull();
  });

  it("uses AI-generated title via side-channel", async () => {
    const { mgr, runtime, store } = makeManager();
    store.getMessageCount.mockResolvedValue(5);
    runtime.getConversationHistory.mockReturnValue([
      { role: "user", content: "first user msg" },
      { role: "assistant", content: "r" },
    ]);
    runtime.generateCompletion.mockResolvedValue("AI Title");
    const result = await mgr.generateTitleInBackground();
    expect(result).toBe("AI Title");
    expect(store.updateTitle).toHaveBeenCalledWith("conv-1", "AI Title");
    // generateCompletion, NOT sendMessage (side-channel)
    expect(runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("falls back to heuristic on AI error", async () => {
    const { mgr, runtime, store } = makeManager();
    store.getMessageCount.mockResolvedValue(5);
    runtime.getConversationHistory.mockReturnValue([
      { role: "user", content: "hello world this is my message body" },
      { role: "assistant", content: "r" },
    ]);
    runtime.generateCompletion.mockRejectedValue(new Error("ai down"));
    const result = await mgr.generateTitleInBackground();
    // First 7 words of first user message
    expect(result).toBe("hello world this is my message body");
    expect(store.updateTitle).toHaveBeenCalled();
  });

  it("heuristic truncates with ellipsis for long first message", async () => {
    const { mgr, runtime, store } = makeManager();
    store.getMessageCount.mockResolvedValue(5);
    runtime.getConversationHistory.mockReturnValue([
      {
        role: "user",
        content: "one two three four five six seven eight nine ten eleven twelve",
      },
      { role: "assistant", content: "r" },
    ]);
    runtime.generateCompletion.mockRejectedValue(new Error());
    const result = await mgr.generateTitleInBackground();
    expect(result).toBe("one two three four five six seven...");
  });

  it("returns null when conversationId is empty", async () => {
    const { mgr, runtime } = makeManager();
    runtime.getConversationId.mockReturnValue("");
    expect(await mgr.generateTitleInBackground()).toBeNull();
  });
});
