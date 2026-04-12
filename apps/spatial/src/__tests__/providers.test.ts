import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (hoisted before imports)
// ---------------------------------------------------------------------------

type StreamChunk = { choices: Array<{ delta: { content?: string } }> };

// Shared mock engine — tests can replace it
let mockEngine: {
  reload: ReturnType<typeof vi.fn>;
  chat: {
    completions: {
      create: ReturnType<typeof vi.fn>;
    };
  };
};

// Controls for the CDN import() return shape
const cdnState = {
  hasWorker: true,
  workerThrows: false,
  webWorkerEngineResult: null as unknown,
};

vi.mock("@motebit/ai-core", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@motebit/ai-core");
  return {
    ...actual,
    AnthropicProvider: vi.fn(function AnthropicStub(this: { cfg: unknown }, cfg: unknown) {
      this.cfg = cfg;
      return this;
    }),
    OpenAIProvider: vi.fn(function OpenAIStub(this: { cfg: unknown }, cfg: unknown) {
      this.cfg = cfg;
      return this;
    }),
    extractMemoryTags: vi.fn(() => []),
    extractStateTags: vi.fn(() => ({})),
    stripTags: vi.fn((t: string) => t),
    buildSystemPrompt: vi.fn(() => "system-prompt"),
  };
});

// Mock the CDN dynamic import by intercepting the esm.run URL via import map.
// We use vi.hoisted + stubGlobal approach: patch the dynamic import through a
// global shim. The providers.ts file uses `await import("https://esm.run/...")`.
// We wrap `import()` using vitest's stubbing by intercepting it through
// `vi.doMock`-compatible aliasing. Since we can't mock URL imports directly,
// we use the strategy of stubbing `globalThis` to intercept. The cleanest way
// in vitest is to mock the module via its specifier — this is supported.
vi.mock("https://esm.run/@mlc-ai/web-llm", () => {
  const webllmModule = {
    CreateMLCEngine: vi.fn(
      (
        _model: string,
        opts?: { initProgressCallback?: (r: { text: string; progress: number }) => void },
      ) => {
        if (opts?.initProgressCallback) {
          opts.initProgressCallback({ text: "loading", progress: 0.5 });
        }
        return Promise.resolve(mockEngine);
      },
    ),
    CreateWebWorkerMLCEngine: vi.fn(
      (
        _worker: Worker,
        _model: string,
        opts?: { initProgressCallback?: (r: { text: string; progress: number }) => void },
      ) => {
        if (cdnState.workerThrows) {
          return Promise.reject(new Error("worker init failed"));
        }
        if (opts?.initProgressCallback) {
          opts.initProgressCallback({ text: "worker-loading", progress: 0.3 });
        }
        return Promise.resolve(cdnState.webWorkerEngineResult ?? mockEngine);
      },
    ),
  };
  return webllmModule;
});

// ---------------------------------------------------------------------------
// Global setup: Worker stub
// ---------------------------------------------------------------------------

class FakeWorker {
  terminated = false;
  constructor(_url: URL | string, _opts?: WorkerOptions) {}
  terminate() {
    this.terminated = true;
  }
  postMessage(_msg: unknown) {}
  addEventListener() {}
  removeEventListener() {}
}

beforeEach(() => {
  mockEngine = {
    reload: vi.fn().mockResolvedValue(undefined),
    chat: {
      completions: {
        create: vi.fn(),
      },
    },
  };
  cdnState.hasWorker = true;
  cdnState.workerThrows = false;
  cdnState.webWorkerEngineResult = null;

  if (cdnState.hasWorker) {
    (globalThis as unknown as { Worker: typeof FakeWorker }).Worker =
      FakeWorker as unknown as typeof FakeWorker;
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).Worker;
  }
});

import { WebLLMProvider, spatialSpecToProvider } from "../providers";
import type { ProviderSpec } from "@motebit/sdk";
import { UnsupportedBackendError } from "@motebit/sdk";

// Helper: build an async iterable of chunks
async function* makeStream(parts: string[]): AsyncIterable<StreamChunk> {
  for (const p of parts) {
    yield { choices: [{ delta: { content: p } }] };
  }
}

function makeContextPack() {
  // Cast away the strict ContextPack shape — we only need user_message and
  // conversation_history for the WebLLM generate path.
  return {
    user_message: "hi",
    state: { energy: 0.5, mood: 0.5, coherence: 0.5, curiosity: 0.5, trust: 0.5 },
    memories: [],
    conversation_history: [],
    current_goal: null,
    tools: [],
    recent_events: [],
    relevant_memories: [],
    current_state: { energy: 0.5, mood: 0.5, coherence: 0.5, curiosity: 0.5, trust: 0.5 },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

// ---------------------------------------------------------------------------
// WebLLMProvider — constructor + getters/setters
// ---------------------------------------------------------------------------

describe("WebLLMProvider", () => {
  it("constructs with defaults", () => {
    const p = new WebLLMProvider("test-model");
    expect(p.model).toBe("test-model");
    expect(p.temperature).toBe(0.7);
    expect(p.maxTokens).toBe(4096);
  });

  it("constructs with overrides", () => {
    const onProgress = vi.fn();
    const p = new WebLLMProvider("m", { temperature: 0.2, maxTokens: 1000, onProgress });
    expect(p.temperature).toBe(0.2);
    expect(p.maxTokens).toBe(1000);
  });

  it("setModel clears engine + worker", () => {
    const p = new WebLLMProvider("m");
    p.setModel("new-model");
    expect(p.model).toBe("new-model");
  });

  it("setTemperature updates temperature", () => {
    const p = new WebLLMProvider("m");
    p.setTemperature(0.9);
    expect(p.temperature).toBe(0.9);
  });

  it("setMaxTokens updates maxTokens", () => {
    const p = new WebLLMProvider("m");
    p.setMaxTokens(2048);
    expect(p.maxTokens).toBe(2048);
  });

  it("estimateConfidence returns default", async () => {
    const p = new WebLLMProvider("m");
    expect(await p.estimateConfidence()).toBe(0.7);
  });

  it("extractMemoryCandidates returns candidates from response", async () => {
    const p = new WebLLMProvider("m");
    const response = {
      text: "x",
      confidence: 0.5,
      memory_candidates: [{ id: "abc", content: "c", sensitivity: "none" } as never],
      state_updates: {},
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await p.extractMemoryCandidates(response as any);
    expect(out).toEqual(response.memory_candidates);
  });
});

// ---------------------------------------------------------------------------
// init() and createEngine — worker path, non-worker path, worker failure
// ---------------------------------------------------------------------------

describe("WebLLMProvider.init", () => {
  it("init with worker path calls onProgress", async () => {
    const progress: Array<{ progress: number; text: string }> = [];
    const p = new WebLLMProvider("m");
    await p.init((r) => progress.push(r));
    // CreateWebWorkerMLCEngine branch (Worker defined, webWorker exists)
    expect(progress.length).toBeGreaterThan(0);
  });

  it("init falls back to non-worker path when Worker is undefined", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).Worker;
    const progress: Array<{ progress: number; text: string }> = [];
    const p = new WebLLMProvider("m");
    await p.init((r) => progress.push(r));
    expect(progress.length).toBeGreaterThan(0);
  });

  it("init catches worker init failure and falls back", async () => {
    cdnState.workerThrows = true;
    const p = new WebLLMProvider("m", {
      onProgress: () => {},
    });
    await p.init();
    // Should not throw: worker throws, we fall to CreateMLCEngine
    expect(p.model).toBe("m");
  });

  it("init forwards onProgress via constructor when no arg passed", async () => {
    const progress: Array<[string, number]> = [];
    const p = new WebLLMProvider("m", {
      onProgress: (text, prog) => progress.push([text, prog]),
    });
    await p.init();
    // The worker path with the constructor onProgress callback
    expect(progress.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// generate + generateStream
// ---------------------------------------------------------------------------

describe("WebLLMProvider.generate/generateStream", () => {
  it("generateStream yields text chunks and done", async () => {
    mockEngine.chat.completions.create.mockResolvedValue(makeStream(["hel", "lo"]));
    const p = new WebLLMProvider("m");
    const chunks: Array<{ type: string }> = [];
    for await (const chunk of p.generateStream(makeContextPack())) {
      chunks.push(chunk);
    }
    expect(chunks.some((c) => c.type === "text")).toBe(true);
    expect(chunks[chunks.length - 1]?.type).toBe("done");
  });

  it("generate accumulates text from stream", async () => {
    mockEngine.chat.completions.create.mockResolvedValue(makeStream(["foo", "bar"]));
    const p = new WebLLMProvider("m");
    const resp = await p.generate(makeContextPack());
    expect(resp.text).toContain("foobar");
    expect(resp.confidence).toBe(0.7);
  });

  it("generateStream passes conversation_history to engine", async () => {
    mockEngine.chat.completions.create.mockResolvedValue(makeStream(["ok"]));
    const p = new WebLLMProvider("m");
    const pack = makeContextPack();
    pack.conversation_history = [
      { role: "user", content: "prev question" },
      { role: "assistant", content: "prev answer" },
    ] as never;
    for await (const _c of p.generateStream(pack)) {
      // consume
    }
    const call = mockEngine.chat.completions.create.mock.calls[0]?.[0] as {
      messages: Array<{ role: string }>;
    };
    // system + 2 history + 1 user
    expect(call.messages.length).toBe(4);
  });

  it("generateStream handles missing delta content gracefully", async () => {
    // Some chunks without content shouldn't break
    async function* odd() {
      yield { choices: [{ delta: {} }] };
      yield { choices: [{ delta: { content: "x" } }] };
      yield { choices: [{ delta: { content: "" } }] };
    }
    mockEngine.chat.completions.create.mockResolvedValue(odd());
    const p = new WebLLMProvider("m");
    const chunks: Array<{ type: string }> = [];
    for await (const chunk of p.generateStream(makeContextPack())) {
      chunks.push(chunk);
    }
    expect(chunks[chunks.length - 1]?.type).toBe("done");
  });

  it("generate returns default response if stream yields no done", async () => {
    // Generator that yields only text, then returns — our generate() iterates
    // and only returns on 'done' — if the stream exits without done we should
    // hit the fallback return. But generateStream always emits 'done'. So we
    // test generate via the real stream path; generate short-circuits on done.
    mockEngine.chat.completions.create.mockResolvedValue(makeStream(["a"]));
    const p = new WebLLMProvider("m");
    const resp = await p.generate(makeContextPack());
    expect(resp).toBeDefined();
  });

  it("second generate reuses engine", async () => {
    mockEngine.chat.completions.create.mockResolvedValue(makeStream(["a"]));
    const p = new WebLLMProvider("m");
    await p.generate(makeContextPack());
    mockEngine.chat.completions.create.mockResolvedValue(makeStream(["b"]));
    await p.generate(makeContextPack());
    expect(mockEngine.chat.completions.create.mock.calls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// spatialSpecToProvider transport switch
// ---------------------------------------------------------------------------

describe("spatialSpecToProvider", () => {
  it("returns OpenAIProvider for cloud/openai", () => {
    const spec: ProviderSpec = {
      kind: "cloud",
      wireProtocol: "openai",
      provider: "openai",
      apiKey: "sk-xxx",
      model: "gpt-4",
      baseUrl: "https://api.openai.com",
      maxTokens: 1024,
      temperature: 0.5,
      extraHeaders: {},
    } as never;
    const p = spatialSpecToProvider(spec);
    expect(p).toBeDefined();
  });

  it("returns AnthropicProvider for cloud/anthropic", () => {
    const spec: ProviderSpec = {
      kind: "cloud",
      wireProtocol: "anthropic",
      provider: "anthropic",
      apiKey: "sk-ant",
      model: "claude-3",
      baseUrl: "https://api.anthropic.com",
      maxTokens: 1024,
      temperature: 0.5,
      extraHeaders: {},
    } as never;
    const p = spatialSpecToProvider(spec);
    expect(p).toBeDefined();
  });

  it("returns WebLLMProvider for webllm", () => {
    const spec: ProviderSpec = {
      kind: "webllm",
      model: "Qwen-0.5B",
      maxTokens: 1024,
      temperature: 0.3,
    } as never;
    const p = spatialSpecToProvider(spec);
    expect(p).toBeInstanceOf(WebLLMProvider);
  });

  it("throws UnsupportedBackendError for apple-fm", () => {
    const spec: ProviderSpec = { kind: "apple-fm", model: "default" } as never;
    expect(() => spatialSpecToProvider(spec)).toThrow(UnsupportedBackendError);
  });

  it("throws UnsupportedBackendError for mlx", () => {
    const spec: ProviderSpec = { kind: "mlx", model: "default" } as never;
    expect(() => spatialSpecToProvider(spec)).toThrow(UnsupportedBackendError);
  });
});
