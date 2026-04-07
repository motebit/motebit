import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CloudProvider,
  extractMemoryTags,
  extractStateTags,
  extractActions,
  actionsToStateUpdates,
  stripTags,
} from "../index";
import type { CloudProviderConfig } from "../index";
import { TrustMode, BatteryMode, SensitivityLevel } from "@motebit/sdk";
import type { ContextPack, MotebitState } from "@motebit/sdk";

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

function mockAnthropicResponse(text: string) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    model: "claude-sonnet-4-5-20250929",
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

function getFetchMock(): ReturnType<typeof vi.fn> {
  return globalThis.fetch as ReturnType<typeof vi.fn>;
}

// ---------------------------------------------------------------------------
// extractMemoryTags
// ---------------------------------------------------------------------------

describe("extractMemoryTags", () => {
  it("extracts a single memory tag", () => {
    const text =
      'Hello! <memory confidence="0.9" sensitivity="personal">User likes jazz</memory> Goodbye.';
    const candidates = extractMemoryTags(text);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.content).toBe("User likes jazz");
    expect(candidates[0]!.confidence).toBe(0.9);
    expect(candidates[0]!.sensitivity).toBe(SensitivityLevel.Personal);
  });

  it("extracts multiple memory tags", () => {
    const text = [
      'Some text <memory confidence="0.8" sensitivity="none">Fact A</memory>',
      'more text <memory confidence="0.7" sensitivity="medical">Fact B</memory>',
    ].join(" ");
    const candidates = extractMemoryTags(text);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.content).toBe("Fact A");
    expect(candidates[1]!.content).toBe("Fact B");
    expect(candidates[1]!.sensitivity).toBe(SensitivityLevel.Medical);
  });

  it("returns empty array when no tags present", () => {
    expect(extractMemoryTags("Just plain text")).toEqual([]);
  });

  it("handles unknown sensitivity as none", () => {
    const text = '<memory confidence="0.5" sensitivity="unknown">Something</memory>';
    const candidates = extractMemoryTags(text);
    expect(candidates[0]!.sensitivity).toBe(SensitivityLevel.None);
  });
});

// ---------------------------------------------------------------------------
// extractStateTags
// ---------------------------------------------------------------------------

describe("extractStateTags", () => {
  it("extracts a single state tag", () => {
    const text = 'Hello <state field="curiosity" value="0.8"/> there';
    const updates = extractStateTags(text);
    expect(updates.curiosity).toBe(0.8);
  });

  it("extracts multiple state tags", () => {
    const text = '<state field="curiosity" value="0.9"/><state field="attention" value="0.6"/>';
    const updates = extractStateTags(text);
    expect(updates.curiosity).toBe(0.9);
    expect(updates.attention).toBe(0.6);
  });

  it("returns empty object when no tags", () => {
    expect(extractStateTags("no tags here")).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// stripTags
// ---------------------------------------------------------------------------

describe("stripTags", () => {
  it("removes memory tags from text", () => {
    const text =
      'Hello! <memory confidence="0.9" sensitivity="personal">User likes jazz</memory> How are you?';
    expect(stripTags(text)).toBe("Hello! How are you?");
  });

  it("removes state tags from text", () => {
    const text = 'Hello! <state field="curiosity" value="0.8"/> How are you?';
    expect(stripTags(text)).toBe("Hello! How are you?");
  });

  it("removes action text from asterisks", () => {
    const text = "Hello! *drifts slightly closer* How are you?";
    expect(stripTags(text)).toBe("Hello! How are you?");
  });

  it("removes both memory and state tags", () => {
    const text =
      'Hi <memory confidence="0.9" sensitivity="none">fact</memory> there <state field="attention" value="0.5"/>';
    const result = stripTags(text);
    expect(result).not.toContain("<memory");
    expect(result).not.toContain("<state");
  });

  it("removes all tag types together", () => {
    const text =
      'Hi *smiles* <state field="curiosity" value="0.8"/> How are you? <memory confidence="0.9" sensitivity="none">fact</memory>';
    const result = stripTags(text);
    expect(result).not.toContain("*");
    expect(result).not.toContain("<state");
    expect(result).not.toContain("<memory");
    expect(result).toBe("Hi How are you?");
  });

  it("collapses excessive newlines", () => {
    const text =
      'Hello\n\n\n\n<memory confidence="0.9" sensitivity="none">fact</memory>\n\n\nWorld';
    const result = stripTags(text);
    expect(result).not.toContain("\n\n\n");
  });
});

// ---------------------------------------------------------------------------
// extractActions
// ---------------------------------------------------------------------------

describe("extractActions", () => {
  it("extracts single action", () => {
    const actions = extractActions("Hello! *drifts closer* How are you?");
    expect(actions).toEqual(["drifts closer"]);
  });

  it("extracts multiple actions", () => {
    const actions = extractActions("*smiles* Hello! *glows softly*");
    expect(actions).toEqual(["smiles", "glows softly"]);
  });

  it("returns empty array when no actions", () => {
    expect(extractActions("no actions here")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// actionsToStateUpdates
// ---------------------------------------------------------------------------

describe("actionsToStateUpdates", () => {
  it("maps drift closer to reduced social_distance", () => {
    const updates = actionsToStateUpdates(["drifts slightly closer"]);
    expect(updates.social_distance).toBeLessThan(0);
  });

  it("maps smile to positive affect_valence", () => {
    const updates = actionsToStateUpdates(["smiles warmly"]);
    expect(updates.affect_valence).toBeGreaterThan(0);
  });

  it("maps glowing to increased processing", () => {
    const updates = actionsToStateUpdates(["glows softly"]);
    expect(updates.processing).toBeGreaterThan(0);
  });

  it("maps eyes widen to increased attention and curiosity", () => {
    const updates = actionsToStateUpdates(["eyes widen"]);
    expect(updates.attention).toBeGreaterThan(0);
    expect(updates.curiosity).toBeGreaterThan(0);
  });

  it("maps bounce to increased arousal", () => {
    const updates = actionsToStateUpdates(["bounces excitedly"]);
    expect(updates.affect_arousal).toBeGreaterThan(0);
  });

  it("returns empty object for unrecognized actions", () => {
    const updates = actionsToStateUpdates(["does something unknown"]);
    expect(Object.keys(updates)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// CloudProvider: Anthropic integration
// ---------------------------------------------------------------------------

describe("CloudProvider Anthropic integration", () => {
  const config: CloudProviderConfig = {
    api_key: "test-api-key",
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 2048,
    temperature: 0.5,
  };

  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends correct request body", async () => {
    mockFetchSuccess("Hi");

    const provider = new CloudProvider(config);
    await provider.generate(makeContextPack({ user_message: "Test" }));

    const mock = getFetchMock();
    const [, opts] = mock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string);
    expect(body.model).toBe("claude-sonnet-4-5-20250929");
    expect(body.max_tokens).toBe(2048);
    expect(body.temperature).toBe(0.5);
    expect(body.messages).toEqual([{ role: "user", content: "Test" }]);
    expect(body.system).toContain("motebit");
  });

  it("system prompt contains state field documentation", async () => {
    mockFetchSuccess("Hi");

    const provider = new CloudProvider(config);
    await provider.generate(makeContextPack());

    const mock = getFetchMock();
    const [, opts] = mock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string);
    expect(body.system).toContain("[INTERNAL REFERENCE — state fields");
    expect(body.system).toContain("affect_valence");
    expect(body.system).toContain("trust_mode");
  });

  it("parses memory tags from response", async () => {
    const responseText =
      'That\'s interesting! <memory confidence="0.85" sensitivity="personal">User enjoys hiking on weekends</memory> Tell me more!';
    mockFetchSuccess(responseText);

    const provider = new CloudProvider(config);
    const response = await provider.generate(makeContextPack());

    expect(response.memory_candidates).toHaveLength(1);
    expect(response.memory_candidates[0]!.content).toBe("User enjoys hiking on weekends");
    expect(response.memory_candidates[0]!.confidence).toBe(0.85);
    expect(response.text).not.toContain("<memory");
  });

  it("parses state tags from response", async () => {
    const responseText = 'Wow! <state field="curiosity" value="0.9"/> That\'s fascinating!';
    mockFetchSuccess(responseText);

    const provider = new CloudProvider(config);
    const response = await provider.generate(makeContextPack());

    expect(response.state_updates.curiosity).toBe(0.9);
    expect(response.text).not.toContain("<state");
  });

  it("handles non-ok response", async () => {
    mockFetchError(429, JSON.stringify({ error: { message: "Rate limit" } }));

    const provider = new CloudProvider(config);
    await expect(provider.generate(makeContextPack())).rejects.toThrow("Anthropic API error 429");
  });

  it("uses custom base_url when provided", async () => {
    const customConfig: CloudProviderConfig = {
      ...config,
      base_url: "https://custom-proxy.example.com",
    };

    mockFetchSuccess("Hi");

    const provider = new CloudProvider(customConfig);
    await provider.generate(makeContextPack());

    const mock = getFetchMock();
    const [url] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://custom-proxy.example.com/v1/messages");
  });
});
