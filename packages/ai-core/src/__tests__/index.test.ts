import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { packContext, CloudProvider, HybridProvider } from "../index";
import type { CloudProviderConfig, HybridProviderConfig } from "../index";
import { TrustMode, BatteryMode, SensitivityLevel, EventType } from "@motebit/sdk";
import type { AIResponse, ContextPack, MemoryCandidate, MotebitState, EventLogEntry, MemoryNode } from "@motebit/sdk";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDefaultState(overrides: Partial<MotebitState> = {}): MotebitState {
  return {
    attention: 0.5,
    processing: 0.3,
    confidence: 0.7,
    affect_valence: -0.2,
    affect_arousal: 0.1,
    social_distance: 0.4,
    curiosity: 0.6,
    trust_mode: TrustMode.Guarded,
    battery_mode: BatteryMode.Normal,
    ...overrides,
  };
}

function makeContextPack(overrides: Partial<ContextPack> = {}): ContextPack {
  return {
    recent_events: [],
    relevant_memories: [],
    current_state: makeDefaultState(),
    user_message: "Hello, Motebit!",
    ...overrides,
  };
}

function makeEvent(overrides: Partial<EventLogEntry> = {}): EventLogEntry {
  return {
    event_id: "e1",
    motebit_id: "m1",
    timestamp: 1000,
    event_type: EventType.StateUpdated,
    payload: { key: "value" },
    version_clock: 1,
    tombstoned: false,
    ...overrides,
  };
}

function makeMemory(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    node_id: "n1",
    motebit_id: "m1",
    content: "User likes jazz",
    embedding: [0.1, 0.2],
    confidence: 0.85,
    sensitivity: SensitivityLevel.Personal,
    created_at: 1000,
    last_accessed: 2000,
    half_life: 604800000,
    tombstoned: false,
    pinned: false,
    ...overrides,
  };
}

function mockAnthropicResponse(text: string) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    model: "claude-sonnet-4-5-20250514",
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

function mockFetchSuccess(text: string): void {
  const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
  mockFn.mockResolvedValueOnce(
    new Response(JSON.stringify(mockAnthropicResponse(text)), { status: 200 }),
  );
}

function mockFetchError(status: number, body: string): void {
  const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
  mockFn.mockResolvedValueOnce(new Response(body, { status }));
}

function mockFetchReject(error: Error): void {
  const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
  mockFn.mockRejectedValueOnce(error);
}

function getFetchMock(): ReturnType<typeof vi.fn> {
  return globalThis.fetch as ReturnType<typeof vi.fn>;
}

// ---------------------------------------------------------------------------
// packContext()
// ---------------------------------------------------------------------------

describe("packContext", () => {
  it("formats state line correctly", () => {
    const result = packContext(makeContextPack());
    expect(result).toContain("[State]");
    expect(result).toContain("attention=0.50");
    expect(result).toContain("confidence=0.70");
    expect(result).toContain("valence=-0.20");
  });

  it("includes user message", () => {
    const result = packContext(makeContextPack({ user_message: "Test msg" }));
    expect(result).toContain("[User] Test msg");
  });

  it("includes recent events", () => {
    const result = packContext(
      makeContextPack({
        recent_events: [makeEvent({ event_type: EventType.MemoryFormed })],
      }),
    );
    expect(result).toContain("[Recent Events]");
    expect(result).toContain("memory_formed");
  });

  it("includes relevant memories", () => {
    const result = packContext(
      makeContextPack({
        relevant_memories: [makeMemory({ content: "User likes jazz" })],
      }),
    );
    expect(result).toContain("[Relevant Memories]");
    expect(result).toContain("User likes jazz");
    expect(result).toContain("confidence=0.85");
  });

  it("omits events section when empty", () => {
    const result = packContext(makeContextPack({ recent_events: [] }));
    expect(result).not.toContain("[Recent Events]");
  });

  it("omits memories section when empty", () => {
    const result = packContext(makeContextPack({ relevant_memories: [] }));
    expect(result).not.toContain("[Relevant Memories]");
  });

  it("limits to last 10 events", () => {
    const events = Array.from({ length: 15 }, (_, i) =>
      makeEvent({ event_id: `e${i}` }),
    );
    const result = packContext(makeContextPack({ recent_events: events }));
    const eventLines = result
      .split("\n")
      .filter((line) => line.startsWith("  ") && line.includes("state_updated"));
    expect(eventLines).toHaveLength(10);
  });
});

// ---------------------------------------------------------------------------
// CloudProvider
// ---------------------------------------------------------------------------

describe("CloudProvider", () => {
  const config: CloudProviderConfig = {
    provider: "anthropic",
    api_key: "test-key",
    model: "claude-sonnet-4-5-20250514",
  };

  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("generate() calls Anthropic API and returns parsed response", async () => {
    mockFetchSuccess("Hello! I'm Motebit.");

    const provider = new CloudProvider(config);
    const response: AIResponse = await provider.generate(makeContextPack());

    expect(response.text).toBe("Hello! I'm Motebit.");
    expect(response.confidence).toBe(0.8);
    expect(response.memory_candidates).toEqual([]);
    expect(response.state_updates).toEqual({});
  });

  it("sends correct headers", async () => {
    mockFetchSuccess("Hi");

    const provider = new CloudProvider(config);
    await provider.generate(makeContextPack());

    const mock = getFetchMock();
    expect(mock).toHaveBeenCalledOnce();
    const [url, opts] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = opts.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("throws on API error", async () => {
    mockFetchError(401, "Unauthorized");

    const provider = new CloudProvider(config);
    await expect(provider.generate(makeContextPack())).rejects.toThrow(
      "Anthropic API error 401",
    );
  });

  it("estimateConfidence() returns 0.8", async () => {
    const provider = new CloudProvider(config);
    const confidence: number = await provider.estimateConfidence();
    expect(confidence).toBe(0.8);
  });

  it("extractMemoryCandidates() returns response candidates", async () => {
    const provider = new CloudProvider(config);
    const candidates: MemoryCandidate[] = await provider.extractMemoryCandidates({
      text: "test",
      confidence: 0.8,
      memory_candidates: [
        {
          content: "User birthday is Jan 1",
          confidence: 0.9,
          sensitivity: SensitivityLevel.Personal,
        },
      ],
      state_updates: {},
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.content).toBe("User birthday is Jan 1");
  });
});

// ---------------------------------------------------------------------------
// HybridProvider
// ---------------------------------------------------------------------------

describe("HybridProvider", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("uses cloud provider by default", async () => {
    mockFetchSuccess("Cloud response");

    const config: HybridProviderConfig = {
      cloud: {
        provider: "anthropic",
        api_key: "test-key",
        model: "claude-sonnet-4-5-20250514",
      },
      fallback_to_local: false,
    };
    const provider = new HybridProvider(config);
    const response: AIResponse = await provider.generate(makeContextPack());
    expect(response.text).toBe("Cloud response");
  });

  it("falls back to local on cloud failure when configured", async () => {
    mockFetchReject(new Error("Network error"));

    const config: HybridProviderConfig = {
      cloud: {
        provider: "anthropic",
        api_key: "test-key",
        model: "claude-sonnet-4-5-20250514",
      },
      local: {
        model_path: "/path/to/model",
      },
      fallback_to_local: true,
    };
    const provider = new HybridProvider(config);
    const response: AIResponse = await provider.generate(makeContextPack());
    expect(response.text).toContain("LocalProvider");
  });

  it("throws when cloud fails and no local fallback", async () => {
    mockFetchReject(new Error("Network error"));

    const config: HybridProviderConfig = {
      cloud: {
        provider: "anthropic",
        api_key: "test-key",
        model: "claude-sonnet-4-5-20250514",
      },
      fallback_to_local: false,
    };
    const provider = new HybridProvider(config);

    await expect(provider.generate(makeContextPack())).rejects.toThrow(
      "Cloud provider failed and no local fallback available",
    );
  });

  it("throws when cloud fails and fallback_to_local is true but no local config", async () => {
    mockFetchReject(new Error("Network error"));

    const config: HybridProviderConfig = {
      cloud: {
        provider: "anthropic",
        api_key: "test-key",
        model: "claude-sonnet-4-5-20250514",
      },
      fallback_to_local: true,
    };
    const provider = new HybridProvider(config);

    await expect(provider.generate(makeContextPack())).rejects.toThrow(
      "Cloud provider failed and no local fallback available",
    );
  });

  it("estimateConfidence() delegates to cloud", async () => {
    const config: HybridProviderConfig = {
      cloud: {
        provider: "anthropic",
        api_key: "key",
        model: "claude-sonnet-4-5-20250514",
      },
      fallback_to_local: false,
    };
    const provider = new HybridProvider(config);
    const confidence: number = await provider.estimateConfidence();
    expect(confidence).toBe(0.8);
  });
});
