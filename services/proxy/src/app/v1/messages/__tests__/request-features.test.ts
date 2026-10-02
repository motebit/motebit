import { describe, it, expect } from "vitest";
import { findUnsupportedFeature } from "../request-features";

const MSG = [{ role: "user", content: "hi" }];
const base = (extra: Record<string, unknown> = {}) => ({
  model: "claude-sonnet-4-6",
  messages: MSG,
  ...extra,
});
const withBlock = (block: unknown) => base({ messages: [{ role: "user", content: [block] }] });

describe("findUnsupportedFeature — admitted (metered) features", () => {
  const admitted: Array<[string, Record<string, unknown>]> = [
    ["minimal", base()],
    [
      "every allowed top-level key",
      base({
        system: "s",
        max_tokens: 100,
        stream: true,
        temperature: 0.5,
        top_p: 0.9,
        top_k: 5,
        stop_sequences: ["x"],
        metadata: { user_id: "u" },
        thinking: { type: "enabled", budget_tokens: 2048 },
        tools: [],
      }),
    ],
    ["adaptive thinking", base({ thinking: { type: "adaptive" } })],
    ["null temperature", base({ temperature: null })],
    [
      "system blocks with 1h cache_control",
      base({
        system: [{ type: "text", text: "s", cache_control: { type: "ephemeral", ttl: "1h" } }],
      }),
    ],
    [
      "anthropic custom tools",
      base({
        tools: [
          { name: "a", description: "d", input_schema: { type: "object" } },
          { type: "custom", name: "b", input_schema: {}, cache_control: { type: "ephemeral" } },
        ],
      }),
    ],
    [
      "openai function tool",
      base({
        tools: [{ type: "function", function: { name: "f", description: "d", parameters: {} } }],
      }),
    ],
    [
      "image base64",
      withBlock({ type: "image", source: { type: "base64", media_type: "image/png", data: "x" } }),
    ],
    [
      "document text",
      withBlock({ type: "document", source: { type: "text", data: "x" }, title: "t" }),
    ],
    [
      "replay blocks",
      base({
        messages: [
          { role: "user", content: "q" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "t", signature: "s" },
              { type: "redacted_thinking", data: "d" },
              { type: "text", text: "a" },
              { type: "tool_use", id: "1", name: "a", input: {} },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "1", content: "ok", is_error: false },
              {
                type: "tool_result",
                tool_use_id: "1",
                content: [
                  { type: "text", text: "x" },
                  { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } },
                ],
                cache_control: { type: "ephemeral" },
              },
            ],
          },
        ],
      }),
    ],
  ];
  it.each(admitted)("%s", (_n, body) => {
    expect(findUnsupportedFeature(body)).toBeNull();
  });
});

describe("findUnsupportedFeature — refused (unmeterable) features", () => {
  const refused: Array<[string, Record<string, unknown>, string]> = [
    ["unknown top-level key", base({ mcp_servers: [] }), "mcp_servers"],
    ["container", base({ container: "c" }), "container"],
    ["tool_choice", base({ tool_choice: { type: "auto" } }), "tool_choice"],
    ["stream not boolean", base({ stream: "yes" }), "stream"],
    ["temperature not number", base({ temperature: "hot" }), "temperature"],
    ["stop_sequences not strings", base({ stop_sequences: [1] }), "stop_sequences"],
    ["metadata not object", base({ metadata: "x" }), "metadata"],
    ["metadata unknown key", base({ metadata: { user_id: "u", x: 1 } }), "metadata.x"],
    ["thinking unknown type", base({ thinking: { type: "turbo" } }), "thinking.type=turbo"],
    ["thinking not object", base({ thinking: true }), "thinking.type=boolean"],
    ["thinking unknown key", base({ thinking: { type: "enabled", x: 1 } }), "thinking.x"],
    ["system not string/array", base({ system: { text: "s" } }), "system"],
    [
      "system non-text block",
      base({ system: [{ type: "image", source: {} }] }),
      "content.type=image",
    ],
    // A url source is fetched by the PROVIDER: its input size is unknown to
    // the proxy, so the byte-based input upper bound would not bound it.
    [
      "image url source",
      withBlock({ type: "image", source: { type: "url", url: "https://x/y.png" } }),
      "image.source.type=url",
    ],
    [
      "document url source",
      withBlock({ type: "document", source: { type: "url", url: "https://x/y.pdf" } }),
      "document.source.type=url",
    ],
    [
      "url source nested in a tool_result",
      withBlock({
        type: "tool_result",
        tool_use_id: "1",
        content: [{ type: "image", source: { type: "url", url: "https://x/y.png" } }],
      }),
      "image.source.type=url",
    ],
    ["tools not array", base({ tools: {} }), "tools"],
    ["tool not object", base({ tools: ["x"] }), "tool"],
    [
      "web_search server tool",
      base({ tools: [{ type: "web_search_20250305", name: "web_search" }] }),
      "tools.type=web_search_20250305",
    ],
    [
      "web_fetch server tool",
      base({ tools: [{ type: "web_fetch_20250910", name: "web_fetch" }] }),
      "tools.type=web_fetch_20250910",
    ],
    [
      "code_execution server tool",
      base({ tools: [{ type: "code_execution_20250825", name: "c" }] }),
      "tools.type=code_execution_20250825",
    ],
    [
      "custom tool unknown key",
      base({ tools: [{ name: "a", input_schema: {}, defer_loading: true }] }),
      "tool.defer_loading",
    ],
    ["custom tool no name", base({ tools: [{ input_schema: {} }] }), "tool.name"],
    ["function tool without function", base({ tools: [{ type: "function" }] }), "tool.function"],
    [
      "function tool unknown key",
      base({ tools: [{ type: "function", function: { name: "f", x: 1 } }] }),
      "tool.function.x",
    ],
    [
      "function tool extra key",
      base({ tools: [{ type: "function", function: { name: "f" }, x: 1 }] }),
      "tool.x",
    ],
    [
      "bad cache_control type",
      base({ system: [{ type: "text", text: "s", cache_control: { type: "persistent" } }] }),
      "cache_control",
    ],
    [
      "bad cache_control ttl",
      base({
        system: [{ type: "text", text: "s", cache_control: { type: "ephemeral", ttl: "1d" } }],
      }),
      "cache_control.ttl=1d",
    ],
    [
      "cache_control unknown key",
      base({ system: [{ type: "text", text: "s", cache_control: { type: "ephemeral", x: 1 } }] }),
      "cache_control.x",
    ],
    [
      "message unknown key",
      base({ messages: [{ role: "user", content: "x", name: "bob" }] }),
      "message.name",
    ],
    ["block not object", withBlock("text"), "content_block"],
    [
      "server_tool_use block",
      withBlock({ type: "server_tool_use", id: "s", name: "web_search", input: {} }),
      "content.type=server_tool_use",
    ],
    [
      "web_search_tool_result block",
      withBlock({ type: "web_search_tool_result", tool_use_id: "s", content: [] }),
      "content.type=web_search_tool_result",
    ],
    [
      "container_upload block",
      withBlock({ type: "container_upload", file_id: "f" }),
      "content.type=container_upload",
    ],
    [
      "text block unknown key",
      withBlock({ type: "text", text: "x", citations: [] }),
      "content[text].citations",
    ],
    [
      "image file source",
      withBlock({ type: "image", source: { type: "file", file_id: "f" } }),
      "image.source.type=file",
    ],
    [
      "document file source",
      withBlock({ type: "document", source: { type: "file", file_id: "f" } }),
      "document.source.type=file",
    ],
    ["image no source", withBlock({ type: "image" }), "image.source.type=undefined"],
    [
      "tool_result nests a tool_use",
      withBlock({
        type: "tool_result",
        tool_use_id: "1",
        content: [{ type: "tool_use", id: "x", name: "a", input: {} }],
      }),
      "content.type=tool_use",
    ],
    [
      "tool_result content object",
      withBlock({ type: "tool_result", tool_use_id: "1", content: { text: "x" } }),
      "tool_result.content",
    ],
  ];
  it.each(refused)("%s", (_n, body, feature) => {
    expect(findUnsupportedFeature(body)?.feature).toBe(feature);
  });

  it("a block type naming an Object.prototype member is unknown, never a crash", () => {
    for (const t of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(findUnsupportedFeature(withBlock({ type: t }))?.feature).toBe(`content.type=${t}`);
    }
  });

  it("names the path of the refused feature", () => {
    expect(
      findUnsupportedFeature(base({ tools: [{ name: "a" }, { type: "web_search_20250305" }] })),
    ).toEqual({ feature: "tools.type=web_search_20250305", path: "tools[1].type" });
  });
});
