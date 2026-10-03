/**
 * The motebit-cloud proxy refuses request features it cannot meter (deny by
 * default — services/proxy/src/app/v1/messages/request-features.ts). This
 * test runs the REAL client request builder — `@motebit/ai-core`'s
 * `AnthropicProvider`, the one cloud wire every surface (web, desktop,
 * mobile, spatial, cli) instantiates through `resolveProviderSpec`
 * (`wireProtocol: "anthropic"` for motebit-cloud) — and asserts that every
 * request body it produces passes the allowlist: a real client is never
 * refused. Lives here (beside the other cross-service conformance tests) so
 * the proxy takes no workspace dependency on ai-core.
 *
 * Shapes exercised: plain turn; tools (cache_control on the last); temperature;
 * a tool-use history with extended-thinking blocks; tool results (plain,
 * merged, a screenshot as an image block, a synthesized missing result);
 * the activation prompt; adaptive thinking (Claude-5 family); both
 * `generate` and `generateStream`.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { AnthropicProvider } from "../../packages/ai-core/src/index.js";
import type { ContextPack, ConversationMessage } from "../../packages/sdk/src/index.js";
import { TrustMode, BatteryMode } from "../../packages/sdk/src/index.js";
import { findUnsupportedFeature } from "../../services/proxy/src/app/v1/messages/request-features.js";

function pack(overrides: Partial<ContextPack> = {}): ContextPack {
  return {
    recent_events: [],
    relevant_memories: [],
    current_state: {
      attention: 0.5,
      processing: 0.3,
      confidence: 0.7,
      affect_valence: 0,
      affect_arousal: 0.1,
      social_distance: 0.4,
      curiosity: 0.6,
      trust_mode: TrustMode.Guarded,
      battery_mode: BatteryMode.Normal,
    },
    user_message: "Hello",
    ...overrides,
  };
}

const TOOLS: ContextPack["tools"] = [
  {
    name: "web_search",
    description: "Search the web (a CLIENT tool — runs on the motebit, not the provider)",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
  },
  {
    name: "read_memory",
    description: "Read a memory",
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
  },
];

const SCREENSHOT = JSON.stringify({
  ok: true,
  data: { kind: "screenshot", bytes_base64: "iVBORw0KGgo=", image_format: "png" },
});

const HISTORY: ConversationMessage[] = [
  { role: "user", content: "find the weather" },
  {
    role: "assistant",
    content: "Let me look.",
    tool_calls: [
      { id: "t1", name: "web_search", args: { query: "weather" } },
      { id: "t2", name: "read_memory", args: { id: "m1" } },
      { id: "t3", name: "read_memory", args: { id: "m2" } },
    ],
    thinking_blocks: [{ thinking: "I should search", signature: "sig-1" }],
  } as ConversationMessage,
  { role: "tool", content: "sunny", tool_call_id: "t1" } as ConversationMessage,
  { role: "tool", content: SCREENSHOT, tool_call_id: "t2" } as ConversationMessage,
  // t3 has no result: the builder synthesizes one.
  { role: "assistant", content: "It is sunny." },
];

const CASES: Array<{
  name: string;
  config: Record<string, unknown>;
  pack: ContextPack;
}> = [
  { name: "plain turn", config: {}, pack: pack() },
  { name: "tools + temperature", config: { temperature: 0.7 }, pack: pack({ tools: TOOLS }) },
  {
    name: "tool-use history with thinking blocks + screenshot result",
    config: { extendedThinking: { budgetTokens: 2000 } },
    pack: pack({ tools: TOOLS, conversation_history: HISTORY, user_message: "" }),
  },
  {
    name: "activation prompt",
    config: {},
    pack: pack({ activationPrompt: "You just woke up.", conversation_history: HISTORY }),
  },
  {
    name: "adaptive thinking (Claude-5 family)",
    config: { model: "claude-opus-5", extendedThinking: { budgetTokens: 4000 } },
    pack: pack({ tools: TOOLS, conversation_history: HISTORY }),
  },
];

function captureBodies(): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
      // Answer as a 200 error so the provider stops right after sending.
      return new Response("nope", { status: 400 });
    }),
  );
  return bodies;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the proxy's metered-feature allowlist admits every real cloud client request", () => {
  for (const c of CASES) {
    it(`AnthropicProvider (${c.name}) — generate and generateStream`, async () => {
      const bodies = captureBodies();
      const provider = new AnthropicProvider({
        api_key: "",
        model: "claude-sonnet-4-6",
        base_url: "https://proxy.example",
        max_tokens: 4096,
        extra_headers: { "x-proxy-token": "tok" },
        ...c.config,
      } as ConstructorParameters<typeof AnthropicProvider>[0]);

      await provider.generate(c.pack).catch(() => {});
      const stream = provider.generateStream(c.pack);
      await stream.next().catch(() => {});

      expect(bodies).toHaveLength(2);
      for (const body of bodies) {
        expect(findUnsupportedFeature(body)).toBeNull();
      }
    });
  }

  it("the history case actually exercises the replay blocks (the allowlist sees them)", async () => {
    const bodies = captureBodies();
    const provider = new AnthropicProvider({
      api_key: "",
      model: "claude-sonnet-4-6",
      base_url: "https://proxy.example",
      extendedThinking: { budgetTokens: 2000 },
    } as ConstructorParameters<typeof AnthropicProvider>[0]);
    await provider.generate(CASES[2]!.pack).catch(() => {});
    const types = new Set<string>();
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        if (typeof o.type === "string") types.add(o.type);
        Object.values(o).forEach(walk);
      }
    };
    walk(bodies[0]!.messages);
    for (const t of ["thinking", "text", "tool_use", "tool_result", "image"]) {
      expect(types.has(t), `history body carries a ${t} block`).toBe(true);
    }
    expect(bodies[0]!.thinking).toBeDefined();
    expect(findUnsupportedFeature(bodies[0]!)).toBeNull();
  });

  it("a server tool in the same body IS refused (the allowlist is not vacuous)", async () => {
    const bodies = captureBodies();
    await new AnthropicProvider({
      api_key: "",
      model: "claude-sonnet-4-6",
      base_url: "https://proxy.example",
    } as ConstructorParameters<typeof AnthropicProvider>[0])
      .generate(pack({ tools: TOOLS }))
      .catch(() => {});
    const body = bodies[0]!;
    (body.tools as unknown[]).push({ type: "web_search_20250305", name: "web_search" });
    expect(findUnsupportedFeature(body)?.feature).toBe("tools.type=web_search_20250305");
  });
});
