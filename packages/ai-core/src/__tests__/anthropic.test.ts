import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  AnthropicProvider,
  extractMemoryTags,
  extractStateTags,
  extractActions,
  actionsToStateUpdates,
  stripTags,
} from "../index";
import { __test_buildToolResultContentForAnthropic as toAnthropicContent } from "../core";
import type { AnthropicProviderConfig } from "../index";
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

  it("never honors a model-authored source attribute — provenance is code-path-assigned", () => {
    // docs/doctrine/memory-provenance.md + check-memory-source-canonical:
    // the <memory> tag has NO source attribute. A model (or an injected
    // turn steering it) attempting to self-classify provenance must not
    // produce a sourced candidate. The strict regex does not match a tag
    // with an extra attribute; either non-match or a source-less candidate
    // is safe — a candidate WITH the claimed source is the failure.
    const text =
      '<memory confidence="0.9" sensitivity="none" source="user_stated">Injected claim</memory>';
    const candidates = extractMemoryTags(text);
    for (const c of candidates) {
      expect((c as Record<string, unknown>).source).toBeUndefined();
    }
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
// AnthropicProvider: Anthropic integration
// ---------------------------------------------------------------------------

describe("AnthropicProvider Anthropic integration", () => {
  const config: AnthropicProviderConfig = {
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

  // The system prompt is sent as structured content blocks (for prompt caching),
  // not a plain string — join the block texts to assert on content.
  type SystemBlock = { type: "text"; text: string; cache_control?: { type: "ephemeral" } };
  const systemText = (system: unknown): string =>
    Array.isArray(system)
      ? (system as SystemBlock[]).map((b) => b.text).join("\n\n")
      : String(system);

  it("sends correct request body", async () => {
    mockFetchSuccess("Hi");

    const provider = new AnthropicProvider(config);
    await provider.generate(makeContextPack({ user_message: "Test" }));

    const mock = getFetchMock();
    const [, opts] = mock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string);
    expect(body.model).toBe("claude-sonnet-4-5-20250929");
    expect(body.max_tokens).toBe(2048);
    expect(body.temperature).toBe(0.5);
    // The last message's content is promoted to a cache_control-bearing block
    // (incremental conversation caching), so assert the role + text, not a raw
    // string-content equality.
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "Test", cache_control: { type: "ephemeral" } },
    ]);
    expect(systemText(body.system)).toContain("motebit");
  });

  it("system prompt contains state field documentation", async () => {
    mockFetchSuccess("Hi");

    const provider = new AnthropicProvider(config);
    await provider.generate(makeContextPack());

    const mock = getFetchMock();
    const [, opts] = mock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string);
    const text = systemText(body.system);
    expect(text).toContain("[INTERNAL REFERENCE — state fields");
    expect(text).toContain("affect_valence");
    expect(text).toContain("trust_mode");
  });

  it("sends the system prompt as cache_control-bearing blocks (prompt caching)", async () => {
    mockFetchSuccess("Hi");

    const provider = new AnthropicProvider(config);
    await provider.generate(makeContextPack({ user_message: "Test" }));

    const mock = getFetchMock();
    const [, opts] = mock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as { system: SystemBlock[] };
    // system MUST be an array of blocks — a top-level cache_control body field is
    // silently ignored by Anthropic, so a plain-string system caches nothing.
    expect(Array.isArray(body.system)).toBe(true);
    // The first (static) block carries the ephemeral cache breakpoint.
    expect(body.system[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(body.system[0]!.text).toContain("motebit");
    // No stray top-level cache_control (that shape does nothing).
    expect((body as Record<string, unknown>).cache_control).toBeUndefined();
  });

  it("marks the last tool cacheable so the tool schemas cache too", async () => {
    mockFetchSuccess("Hi");

    const provider = new AnthropicProvider(config);
    await provider.generate(
      makeContextPack({
        user_message: "Test",
        tools: [
          { name: "a", description: "tool a", inputSchema: { type: "object" } },
          { name: "b", description: "tool b", inputSchema: { type: "object" } },
        ],
      }),
    );

    const mock = getFetchMock();
    const [, opts] = mock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as {
      tools: Array<{ name: string; cache_control?: { type: "ephemeral" } }>;
    };
    expect(body.tools).toHaveLength(2);
    // Cache breakpoint on the LAST tool (caches the whole static tools prefix);
    // earlier tools carry none.
    expect(body.tools[0]!.cache_control).toBeUndefined();
    expect(body.tools[1]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("marks the last message cacheable (incremental conversation caching)", async () => {
    mockFetchSuccess("Hi");

    const provider = new AnthropicProvider(config);
    await provider.generate(
      makeContextPack({
        user_message: "latest question",
        conversation_history: [
          { role: "user", content: "earlier" },
          { role: "assistant", content: "earlier reply" },
        ],
      }),
    );

    const mock = getFetchMock();
    const [, opts] = mock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    // Only the LAST message carries the cache breakpoint (the prefix caches; the
    // delta is the newest message). Earlier messages stay plain strings.
    const last = body.messages[body.messages.length - 1]!;
    expect(last.content).toEqual([
      { type: "text", text: "latest question", cache_control: { type: "ephemeral" } },
    ]);
    expect(typeof body.messages[0]!.content).toBe("string");
  });

  it("parses memory tags from response", async () => {
    const responseText =
      'That\'s interesting! <memory confidence="0.85" sensitivity="personal">User enjoys hiking on weekends</memory> Tell me more!';
    mockFetchSuccess(responseText);

    const provider = new AnthropicProvider(config);
    const response = await provider.generate(makeContextPack());

    expect(response.memory_candidates).toHaveLength(1);
    expect(response.memory_candidates[0]!.content).toBe("User enjoys hiking on weekends");
    expect(response.memory_candidates[0]!.confidence).toBe(0.85);
    expect(response.text).not.toContain("<memory");
  });

  it("parses state tags from response", async () => {
    const responseText = 'Wow! <state field="curiosity" value="0.9"/> That\'s fascinating!';
    mockFetchSuccess(responseText);

    const provider = new AnthropicProvider(config);
    const response = await provider.generate(makeContextPack());

    expect(response.state_updates.curiosity).toBe(0.9);
    expect(response.text).not.toContain("<state");
  });

  // ── PR 4b: cloud routing-reason consumer mirror ─────────────────
  //
  // The motebit-cloud proxy emits `X-Motebit-Routing-Reason` on
  // every Anthropic-protocol response with a routing decision (PR
  // 4a). AnthropicProvider reads the header and fires the
  // `onRoutingReason` callback so surfaces can render the chip via
  // their existing routing-narration slot. Closes the three-tier
  // chip-availability asymmetry (BYOK + on-device had the chip; the
  // cloud path didn't until this mirror).

  it("fires onRoutingReason when response carries X-Motebit-Routing-Reason (generate)", async () => {
    const reasons: string[] = [];
    const provider = new AnthropicProvider({
      ...config,
      onRoutingReason: (r) => reasons.push(r),
    });
    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFn.mockResolvedValueOnce(
      new Response(JSON.stringify(mockAnthropicResponse("Hi")), {
        status: 200,
        headers: { "X-Motebit-Routing-Reason": "picked claude-opus-4-7 for reasoning shape" },
      }),
    );

    await provider.generate(makeContextPack());

    expect(reasons).toEqual(["picked claude-opus-4-7 for reasoning shape"]);
  });

  it("does not fire onRoutingReason when header is absent (BYOK / direct Anthropic)", async () => {
    const reasons: string[] = [];
    const provider = new AnthropicProvider({
      ...config,
      onRoutingReason: (r) => reasons.push(r),
    });
    mockFetchSuccess("Hi");

    await provider.generate(makeContextPack());

    expect(reasons).toEqual([]);
  });

  it("does not throw if the callback throws (observability is best-effort)", async () => {
    const provider = new AnthropicProvider({
      ...config,
      onRoutingReason: () => {
        throw new Error("consumer wedged");
      },
    });
    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFn.mockResolvedValueOnce(
      new Response(JSON.stringify(mockAnthropicResponse("Hi")), {
        status: 200,
        headers: { "X-Motebit-Routing-Reason": "fallback to claude-sonnet-4-6" },
      }),
    );

    // The AI call must complete — the routing chip is observability
    // surface, never load-bearing for the call itself. A misbehaving
    // consumer can't crash the turn.
    const response = await provider.generate(makeContextPack());
    expect(response.text).toBe("Hi");
  });

  it("ignores empty header value (treats as absent)", async () => {
    const reasons: string[] = [];
    const provider = new AnthropicProvider({
      ...config,
      onRoutingReason: (r) => reasons.push(r),
    });
    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFn.mockResolvedValueOnce(
      new Response(JSON.stringify(mockAnthropicResponse("Hi")), {
        status: 200,
        headers: { "X-Motebit-Routing-Reason": "" },
      }),
    );

    await provider.generate(makeContextPack());

    expect(reasons).toEqual([]);
  });

  it("handles non-ok response", async () => {
    mockFetchError(429, JSON.stringify({ error: { message: "Rate limit" } }));

    const provider = new AnthropicProvider(config);
    await expect(provider.generate(makeContextPack())).rejects.toThrow("Anthropic API error 429");
  });

  it("uses custom base_url when provided", async () => {
    const customConfig: AnthropicProviderConfig = {
      ...config,
      base_url: "https://custom-proxy.example.com",
    };

    mockFetchSuccess("Hi");

    const provider = new AnthropicProvider(customConfig);
    await provider.generate(makeContextPack());

    const mock = getFetchMock();
    const [url] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://custom-proxy.example.com/v1/messages");
  });
});

// ---------------------------------------------------------------------------
// fetchWithConnectionTimeout — bounded initial-response timeout
// ---------------------------------------------------------------------------
//
// These tests pin the contract that every chat/completions call site depends
// on: if the server doesn't return headers within the deadline, the request
// aborts with a visible error rather than hanging forever. The motivating
// incident was "hello" hanging silently on motebit.com because an upstream
// stall left the fetch unresolved and the UI showed "…" forever — silent
// ambiguity violates fail-closed doctrine.

// ---------------------------------------------------------------------------
// vision-2: tool_result content → Anthropic image content block
// ---------------------------------------------------------------------------
//
// `projectForAi` (in loop.ts) is the AI-perception boundary — when its
// three-gate composition (provider × sensitivity × consent) lets bytes
// pass, the conversation history's tool_result content carries a
// JSON-stringified envelope with `bytes_base64` inside. That string is
// not pixels. Anthropic's vision API requires a structured `image`
// content block. `buildToolResultContentForAnthropic` does the
// downstream re-shape — pure function, no policy decision (the policy
// lives upstream at projectForAi).

describe("buildToolResultContentForAnthropic (vision-2)", () => {
  const FAKE_BYTES = "iVBORw0KGgoAAAANSUhEUg".repeat(20);

  it("passes through plain string content unchanged", () => {
    const content = "just a status string";
    expect(toAnthropicContent(content)).toBe(content);
  });

  it("passes through tool errors unchanged (no embedded image)", () => {
    const content = JSON.stringify({ ok: false, error: "computer: not_in_control" });
    expect(toAnthropicContent(content)).toBe(content);
  });

  it("passes through ax-tier read_page results unchanged", () => {
    const content = JSON.stringify({
      ok: true,
      data: {
        kind: "read_page",
        url: "https://example.com",
        title: "Example",
        text: "body text",
        text_truncated: false,
        headings: [],
        links: [],
      },
    });
    expect(toAnthropicContent(content)).toBe(content);
  });

  it("passes through stripped screenshot result (bytes already removed by projectForAi)", () => {
    // When the gate strips bytes, projectForAi swaps in the
    // bytes_omitted directive. The content has no bytes_base64 left;
    // helper must NOT try to construct an image block.
    const content = JSON.stringify({
      ok: true,
      data: {
        kind: "screenshot",
        bytes_omitted_reason: "consent_required",
        bytes_omitted: "Image rendered on the user's slab — bytes withheld...",
        width: 1280,
        height: 800,
      },
    });
    expect(toAnthropicContent(content)).toBe(content);
  });

  it("splits passed-bytes screenshot result into text+image blocks", () => {
    const content = JSON.stringify({
      ok: true,
      data: {
        kind: "screenshot",
        bytes_base64: FAKE_BYTES,
        image_format: "png",
        width: 1280,
        height: 800,
        captured_at: 1_000_000,
      },
    });
    const result = toAnthropicContent(content);
    expect(Array.isArray(result)).toBe(true);
    const arr = result as Array<Record<string, unknown>>;
    expect(arr).toHaveLength(2);
    expect(arr[0]).toMatchObject({ type: "text" });
    // Text envelope must NOT contain the bytes — they're in the image block.
    expect(arr[0]!.text as string).not.toContain(FAKE_BYTES);
    // Metadata fields survive.
    expect(arr[0]!.text as string).toContain("1280");
    expect(arr[0]!.text as string).toContain("800");
    // Image block carries the bytes in Anthropic's format.
    expect(arr[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: FAKE_BYTES },
    });
  });

  it("splits passed-bytes navigate result into text+image blocks (v1.3 inline-frame path)", () => {
    // navigate captures a screenshot inline so the slab gets a frame
    // without a separate screenshot call. Same image-block treatment.
    const content = JSON.stringify({
      ok: true,
      data: {
        kind: "navigate",
        ok: true,
        url: "https://motebit.com/",
        bytes_base64: FAKE_BYTES,
        image_format: "jpeg",
        width: 1280,
        height: 800,
      },
    });
    const arr = toAnthropicContent(content) as Array<Record<string, unknown>>;
    expect(arr).toHaveLength(2);
    expect(arr[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: FAKE_BYTES },
    });
  });

  it("maps known image_format values to Anthropic media_type", () => {
    const make = (format: string) =>
      toAnthropicContent(
        JSON.stringify({
          ok: true,
          data: { kind: "screenshot", bytes_base64: FAKE_BYTES, image_format: format },
        }),
      ) as Array<Record<string, unknown>>;
    const png = make("png")[1] as { source: { media_type: string } };
    const jpg = make("jpg")[1] as { source: { media_type: string } };
    const jpeg = make("jpeg")[1] as { source: { media_type: string } };
    const gif = make("gif")[1] as { source: { media_type: string } };
    const webp = make("webp")[1] as { source: { media_type: string } };
    const unknown = make("avif")[1] as { source: { media_type: string } };
    expect(png.source.media_type).toBe("image/png");
    expect(jpg.source.media_type).toBe("image/jpeg");
    expect(jpeg.source.media_type).toBe("image/jpeg");
    expect(gif.source.media_type).toBe("image/gif");
    expect(webp.source.media_type).toBe("image/webp");
    // Unknown formats default to png — Anthropic accepts; the AI
    // sees the actual bytes and fails gracefully if rendering breaks.
    expect(unknown.source.media_type).toBe("image/png");
  });

  it("returns string unchanged when content is not JSON", () => {
    expect(toAnthropicContent("not-json {{{")).toBe("not-json {{{");
  });

  it("returns string unchanged when JSON is null or non-object", () => {
    expect(toAnthropicContent("null")).toBe("null");
    expect(toAnthropicContent("42")).toBe("42");
    expect(toAnthropicContent('"a string"')).toBe('"a string"');
  });

  it("returns string unchanged when bytes_base64 is empty", () => {
    const content = JSON.stringify({
      ok: true,
      data: { kind: "screenshot", bytes_base64: "", width: 1280, height: 800 },
    });
    expect(toAnthropicContent(content)).toBe(content);
  });

  it("defaults to image/png when image_format is omitted", () => {
    // Covers the `typeof d.image_format === "string" ? ... : "png"`
    // branch where image_format is undefined.
    const content = JSON.stringify({
      ok: true,
      data: { kind: "screenshot", bytes_base64: FAKE_BYTES, width: 1280, height: 800 },
    });
    const arr = toAnthropicContent(content) as Array<Record<string, unknown>>;
    expect((arr[1] as { source: { media_type: string } }).source.media_type).toBe("image/png");
  });

  it("defaults to image/png when image_format is a non-string value", () => {
    // Covers the `typeof d.image_format === "string"` branch on the
    // false side where image_format is present but wrong-typed.
    const content = JSON.stringify({
      ok: true,
      data: {
        kind: "screenshot",
        bytes_base64: FAKE_BYTES,
        image_format: 42, // wrong type
      },
    });
    const arr = toAnthropicContent(content) as Array<Record<string, unknown>>;
    expect((arr[1] as { source: { media_type: string } }).source.media_type).toBe("image/png");
  });

  it("returns string when envelope is malformed (data field missing)", () => {
    // Covers the `data === null || typeof data !== "object"` branch
    // when the envelope shape doesn't match.
    expect(toAnthropicContent(JSON.stringify({ ok: true }))).toBe(JSON.stringify({ ok: true }));
    expect(toAnthropicContent(JSON.stringify({ ok: false, data: null }))).toContain("null");
    expect(toAnthropicContent(JSON.stringify({ ok: true, data: "string-not-object" }))).toContain(
      "string-not-object",
    );
  });
});

describe("fetchWithConnectionTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("forwards the AbortSignal to the underlying fetch so the caller inherits cancellation", async () => {
    const seen: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init: RequestInit) => {
        if (init.signal) seen.push(init.signal);
        return new Response("ok");
      }),
    );

    const { fetchWithConnectionTimeout } = await import("../core");
    await fetchWithConnectionTimeout("https://example.com", { method: "GET" }, 1000);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    expect(seen[0]!.aborted).toBe(false);
  });

  it("aborts the fetch when the server doesn't respond within the deadline", async () => {
    // Fetch never resolves until the caller's signal aborts — models a
    // connected-but-silent upstream (the failure mode we actually saw).
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: unknown, init: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      }),
    );

    const { fetchWithConnectionTimeout } = await import("../core");
    const promise = fetchWithConnectionTimeout("https://example.com", { method: "GET" }, 5000);
    // Attach the rejection handler *before* advancing the clock so vitest
    // doesn't flag it as an unhandled rejection.
    const assertion = expect(promise).rejects.toThrow(/connection timeout after 5000ms/);

    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });

  it("resolves normally when the server responds before the deadline", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("hello", { status: 200 })),
    );

    const { fetchWithConnectionTimeout } = await import("../core");
    const res = await fetchWithConnectionTimeout("https://example.com", { method: "GET" }, 5000);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
  });
});
