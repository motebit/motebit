/**
 * buildProviderRequest — the cost-critical request shaping, esp. Anthropic
 * prompt caching. The headline contract: `cache_control` must ride a system
 * content BLOCK, never a top-level body field (Anthropic silently ignores the
 * latter — the prior bug that cached nothing). OpenAI-shaped upstreams get the
 * system flattened to a plain string.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  buildProviderRequest,
  proxyExtendedThinkingBudget,
  systemToText,
  systemToAnthropicBlocks,
  type SystemBlock,
} from "../provider-request";

const CACHED: SystemBlock[] = [
  { type: "text", text: "STATIC identity + doctrine", cache_control: { type: "ephemeral" } },
  { type: "text", text: "dynamic suffix" },
];

function anthropicBody(system: unknown, tools?: unknown): Record<string, unknown> {
  return {
    model: "claude-sonnet-4-5",
    messages: [{ role: "user", content: "hi" }],
    system,
    max_tokens: 2048,
    ...(tools != null ? { tools } : {}),
  };
}

describe("systemToAnthropicBlocks", () => {
  it("wraps a plain string into one cached block (caching for legacy clients)", () => {
    const blocks = systemToAnthropicBlocks("you are motebit");
    expect(blocks).toEqual([
      { type: "text", text: "you are motebit", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("passes client-supplied blocks through untouched (their own breakpoints)", () => {
    expect(systemToAnthropicBlocks(CACHED)).toBe(CACHED);
  });

  it("returns undefined for an absent system", () => {
    expect(systemToAnthropicBlocks(undefined)).toBeUndefined();
  });

  it("returns undefined for an unexpected non-string/non-array shape (never '[object Object]')", () => {
    expect(systemToAnthropicBlocks({ rogue: true })).toBeUndefined();
    expect(systemToAnthropicBlocks(42)).toBeUndefined();
  });
});

describe("systemToText", () => {
  it("returns a string system as-is", () => {
    expect(systemToText("plain")).toBe("plain");
  });

  it("joins block texts (for OpenAI-shaped upstreams)", () => {
    expect(systemToText(CACHED)).toBe("STATIC identity + doctrine\n\ndynamic suffix");
  });

  it("returns undefined for absent / unexpected shapes", () => {
    expect(systemToText(undefined)).toBeUndefined();
    expect(systemToText({ rogue: true })).toBeUndefined();
    expect(systemToText([])).toBeUndefined();
  });
});

describe("buildProviderRequest — Anthropic prompt caching", () => {
  it("sends system as cache_control blocks, NOT a top-level cache_control field", () => {
    const req = buildProviderRequest(
      "anthropic",
      "sk-x",
      "claude-sonnet-4-5",
      anthropicBody(CACHED),
      4096,
    );
    const body = JSON.parse(req.body) as Record<string, unknown>;
    // Blocks passed through with their cache breakpoint intact.
    expect(body.system).toEqual(CACHED);
    // The no-op top-level field must be gone (the bug this fix closes).
    expect(body.cache_control).toBeUndefined();
    expect(req.url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("wraps a legacy string system into a cached block so the cloud path caches too", () => {
    const req = buildProviderRequest(
      "anthropic",
      "sk-x",
      "claude-sonnet-4-5",
      anthropicBody("you are motebit"),
      4096,
    );
    const body = JSON.parse(req.body) as { system: SystemBlock[]; cache_control?: unknown };
    expect(Array.isArray(body.system)).toBe(true);
    expect(body.system[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(body.cache_control).toBeUndefined();
  });

  it("passes tools through (client marks the last tool cacheable)", () => {
    const tools = [{ name: "a" }, { name: "b", cache_control: { type: "ephemeral" } }];
    const req = buildProviderRequest("anthropic", "sk-x", "m", anthropicBody(CACHED, tools), 4096);
    const body = JSON.parse(req.body) as { tools: unknown };
    expect(body.tools).toEqual(tools);
  });

  it("caps max_tokens at the provided ceiling", () => {
    const req = buildProviderRequest(
      "anthropic",
      "sk-x",
      "m",
      { ...anthropicBody(CACHED), max_tokens: 100_000 },
      8192,
    );
    const body = JSON.parse(req.body) as { max_tokens: number };
    expect(body.max_tokens).toBe(8192);
  });
});

describe("buildProviderRequest — OpenAI-shaped upstreams flatten system to a string", () => {
  it("openai: reorders for auto-cache — static system leads, dynamic before the user turn", () => {
    const req = buildProviderRequest("openai", "sk-x", "gpt-4o", anthropicBody(CACHED), 4096);
    const msgs = (JSON.parse(req.body) as { messages: Array<{ role: string; content: string }> })
      .messages;
    // Static doctrine leads (the cacheable prefix) — dynamic is split OUT, not
    // joined into the leading message.
    expect(msgs[0]).toEqual({ role: "system", content: "STATIC identity + doctrine" });
    // Dynamic context is a separate system message anchored before the user turn.
    const lastUserIdx = msgs.map((m) => m.role).lastIndexOf("user");
    expect(msgs[lastUserIdx - 1]).toEqual({ role: "system", content: "dynamic suffix" });
    expect(msgs[lastUserIdx]!.content).toBe("hi");
    expect(req.body).not.toContain("cache_control");
    expect(req.url).toContain("openai.com");
  });

  it("openai: prior-turn history sits BEFORE the dynamic block (so it caches cross-turn)", () => {
    const body = {
      ...anthropicBody(CACHED),
      messages: [
        { role: "user", content: "earlier" },
        { role: "assistant", content: "earlier reply" },
        { role: "user", content: "now" },
      ],
    };
    const req = buildProviderRequest("openai", "sk-x", "gpt-4o", body, 4096);
    const msgs = (JSON.parse(req.body) as { messages: Array<{ role: string; content: string }> })
      .messages;
    const earlierIdx = msgs.findIndex((m) => m.content === "earlier");
    const lastUserIdx = msgs.map((m) => m.role).lastIndexOf("user");
    expect(earlierIdx).toBeGreaterThan(0); // after the static system lead
    expect(earlierIdx).toBeLessThan(lastUserIdx - 1); // before the dynamic block
    expect(msgs[lastUserIdx - 1]!.content).toBe("dynamic suffix");
    expect(msgs[lastUserIdx]!.content).toBe("now");
  });

  it("groq: NOT reordered (no caching) — stays front-loaded, flattened to string", () => {
    const req = buildProviderRequest("groq", "sk-x", "llama-3.3-70b", anthropicBody(CACHED), 4096);
    const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: unknown }> };
    expect(typeof body.messages[0]!.content).toBe("string");
    // Front-loaded: static+dynamic joined into the single leading system message.
    expect(body.messages[0]!.content).toBe("STATIC identity + doctrine\n\ndynamic suffix");
  });

  it("groq: blocks flattened too; no array leaks into the OpenAI shape", () => {
    const req = buildProviderRequest("groq", "sk-x", "llama-3.3-70b", anthropicBody(CACHED), 4096);
    const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: unknown }> };
    expect(typeof body.messages[0]!.content).toBe("string");
  });

  it("google: flattens system to a leading system message; routes to the OpenAI-compat endpoint", () => {
    const req = buildProviderRequest(
      "google",
      "sk-x",
      "gemini-2.0-flash",
      anthropicBody(CACHED),
      4096,
    );
    const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: string }> };
    expect(body.messages[0]).toEqual({
      role: "system",
      content: "STATIC identity + doctrine\n\ndynamic suffix",
    });
    expect(req.url).toContain("generativelanguage.googleapis.com");
  });
});

describe("buildProviderRequest — message handling across upstreams", () => {
  // The ai-core client marks the last message's content as a cache_control block
  // (incremental caching). Anthropic upstream must see it verbatim; OpenAI-shaped
  // upstreams must NOT (they'd choke on the block shape + unknown field).
  const blockMessages = [
    { role: "user", content: "earlier" },
    {
      role: "user",
      content: [{ type: "text", text: "latest", cache_control: { type: "ephemeral" } }],
    },
  ];

  it("anthropic: passes block-content messages through verbatim (cache_control preserved)", () => {
    const body = { ...anthropicBody(CACHED), messages: blockMessages };
    const req = buildProviderRequest("anthropic", "sk-x", "m", body, 4096);
    const out = JSON.parse(req.body) as { messages: unknown };
    expect(out.messages).toEqual(blockMessages);
  });

  it("openai: flattens block content to a string and strips cache_control", () => {
    const body = { ...anthropicBody(CACHED), messages: blockMessages };
    const req = buildProviderRequest("openai", "sk-x", "gpt-4o", body, 4096);
    const out = JSON.parse(req.body) as { messages: Array<{ role: string; content: unknown }> };
    // messages[0] is the system message (flattened); the conversation follows.
    const convo = out.messages.filter((m) => m.role === "user");
    expect(convo.every((m) => typeof m.content === "string")).toBe(true);
    expect(convo.map((m) => m.content)).toEqual(["earlier", "latest"]);
    // No cache_control survives into the OpenAI shape.
    expect(req.body).not.toContain("cache_control");
  });
});

describe("buildProviderRequest — local-server is not routable", () => {
  it("throws fail-closed for an on-device host", () => {
    expect(() => buildProviderRequest("local-server", "", "m", anthropicBody("x"), 4096)).toThrow(
      /not routable through the proxy/,
    );
  });
});

const THINK_ENV = "MOTEBIT_EXTENDED_THINKING_BUDGET_TOKENS";

describe("extended-thinking switch (cloud path, off by default)", () => {
  afterEach(() => {
    delete process.env[THINK_ENV];
  });

  function anthropicBodyFor(model: string): Record<string, unknown> {
    return { model, messages: [{ role: "user", content: "hi" }], system: "s", max_tokens: 2048 };
  }

  it("proxyExtendedThinkingBudget: null when unset / invalid / unsupported model; floors at 1024", () => {
    expect(proxyExtendedThinkingBudget("claude-sonnet-4-5")).toBeNull(); // unset
    process.env[THINK_ENV] = "0";
    expect(proxyExtendedThinkingBudget("claude-sonnet-4-5")).toBeNull(); // non-positive
    process.env[THINK_ENV] = "nope";
    expect(proxyExtendedThinkingBudget("claude-sonnet-4-5")).toBeNull(); // non-numeric
    process.env[THINK_ENV] = "3000";
    expect(proxyExtendedThinkingBudget("claude-sonnet-4-5")).toBe(3000);
    expect(proxyExtendedThinkingBudget("claude-haiku-4-5")).toBeNull(); // unsupported model
    process.env[THINK_ENV] = "10";
    expect(proxyExtendedThinkingBudget("claude-sonnet-4-5")).toBe(1024); // floored
  });

  it("is INERT by default — no thinking param, temperature preserved", () => {
    const body = { ...anthropicBodyFor("claude-sonnet-4-5"), temperature: 0.5 };
    const req = buildProviderRequest("anthropic", "sk", "claude-sonnet-4-5", body, 8192);
    const out = JSON.parse(req.body) as Record<string, unknown>;
    expect(out.thinking).toBeUndefined();
    expect(out.temperature).toBe(0.5);
  });

  it("when enabled on a supporting model: adds thinking, omits temperature, bumps max_tokens", () => {
    process.env[THINK_ENV] = "4000";
    const body = { ...anthropicBodyFor("claude-sonnet-4-5"), temperature: 0.5 };
    const req = buildProviderRequest("anthropic", "sk", "claude-sonnet-4-5", body, 8192);
    const out = JSON.parse(req.body) as Record<string, unknown>;
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 4000 });
    expect(out.temperature).toBeUndefined();
    expect(out.max_tokens as number).toBeGreaterThan(4000);
  });

  it("safety net: does NOT enable on an unsupported model even when the env is set", () => {
    process.env[THINK_ENV] = "4000";
    const req = buildProviderRequest(
      "anthropic",
      "sk",
      "claude-haiku-4-5",
      { ...anthropicBodyFor("claude-haiku-4-5"), temperature: 0.5 },
      8192,
    );
    const out = JSON.parse(req.body) as Record<string, unknown>;
    expect(out.thinking).toBeUndefined();
    expect(out.temperature).toBe(0.5);
  });
});
