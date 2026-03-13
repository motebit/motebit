import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  McpServerAdapter,
  riskToAnnotations,
  formatResult,
  filterMemories,
  jsonSchemaToZodShape,
} from "../index.js";
import type { MotebitServerDeps, McpServerConfig } from "../index.js";
import { RiskLevel } from "@motebit/sdk";
import type { ToolResult, ToolDefinition } from "@motebit/sdk";

// === Mock MCP SDK ===

type ToolHandler = (...args: unknown[]) => Promise<unknown>;
type ResourceHandler = () => Promise<unknown>;
type PromptHandler = (args: Record<string, string>) => unknown;

interface MockRegistrations {
  tools: Map<string, { handler: ToolHandler; args: unknown[] }>;
  resources: Map<string, { handler: ResourceHandler }>;
  prompts: Map<string, { handler: PromptHandler }>;
}

let registrations: MockRegistrations;

const mockServerConnect = vi.fn();
const mockServerClose = vi.fn();

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: vi.fn().mockImplementation(() => {
    registrations = {
      tools: new Map(),
      resources: new Map(),
      prompts: new Map(),
    };
    return {
      connect: mockServerConnect,
      close: mockServerClose,
      tool: vi.fn((...args: unknown[]) => {
        // McpServer.tool() has multiple overloads:
        // tool(name, description, zodShape, annotations, handler)
        // tool(name, description, annotations, handler)
        const name = args[0] as string;
        const handler = args[args.length - 1] as ToolHandler;
        registrations.tools.set(name, { handler, args: args.slice(1, -1) });
      }),
      resource: vi.fn((...args: unknown[]) => {
        // resource(name, uri, handler)
        const name = args[0] as string;
        const handler = args[args.length - 1] as ResourceHandler;
        registrations.resources.set(name, { handler });
      }),
      prompt: vi.fn((...args: unknown[]) => {
        // prompt(name, description, schema?, handler)
        const name = args[0] as string;
        const handler = args[args.length - 1] as PromptHandler;
        registrations.prompts.set(name, { handler });
      }),
    };
  }),
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/server/streamableHttp.js", () => ({
  StreamableHTTPServerTransport: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/types.js", () => ({
  isInitializeRequest: vi.fn(() => false),
}));

// --- Helpers ---

function makeDeps(overrides?: Partial<MotebitServerDeps>): MotebitServerDeps {
  return {
    motebitId: "a1b2c3d4-e5f6-7890-abcd-ef0123456789",
    publicKeyHex: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    listTools: () => [],
    filterTools: (tools) => tools,
    validateTool: () => ({ allowed: true, requiresApproval: false }),
    executeTool: async () => ({ ok: true, data: "result" }),
    getState: () => ({ attention: 0.5, processing: 0.1 }),
    getMemories: async () => [],
    logToolCall: () => {},
    ...overrides,
  };
}

function makeConfig(overrides?: Partial<McpServerConfig>): McpServerConfig {
  return {
    transport: "stdio",
    ...overrides,
  };
}

function toolDef(name: string, overrides?: Partial<ToolDefinition>): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================
// Pure function tests (existing coverage preserved)
// ============================================================

describe("McpServerAdapter — constructor", () => {
  it("constructs with valid config and deps", () => {
    const adapter = new McpServerAdapter(makeConfig(), makeDeps());
    expect(adapter).toBeDefined();
  });
});

describe("riskToAnnotations", () => {
  it("maps R0_READ to readOnlyHint + idempotentHint", () => {
    const result = riskToAnnotations({ risk: RiskLevel.R0_READ });
    expect(result).toEqual({ readOnlyHint: true, idempotentHint: true });
  });

  it("maps R1_DRAFT to idempotentHint only", () => {
    const result = riskToAnnotations({ risk: RiskLevel.R1_DRAFT });
    expect(result).toEqual({ idempotentHint: true });
  });

  it("maps R2_WRITE to destructiveHint", () => {
    const result = riskToAnnotations({ risk: RiskLevel.R2_WRITE });
    expect(result).toEqual({ destructiveHint: true });
  });

  it("maps R3_EXECUTE to destructiveHint", () => {
    const result = riskToAnnotations({ risk: RiskLevel.R3_EXECUTE });
    expect(result).toEqual({ destructiveHint: true });
  });

  it("maps R4_MONEY to destructiveHint", () => {
    const result = riskToAnnotations({ risk: RiskLevel.R4_MONEY });
    expect(result).toEqual({ destructiveHint: true });
  });

  it("returns empty for undefined riskHint", () => {
    expect(riskToAnnotations(undefined)).toEqual({});
  });

  it("returns empty for riskHint without risk field", () => {
    expect(riskToAnnotations({})).toEqual({});
  });
});

describe("formatResult", () => {
  it("includes motebit ID and key fingerprint", () => {
    const result: ToolResult = { ok: true, data: "hello world" };
    const formatted = formatResult(
      result,
      "a1b2c3d4-e5f6-7890-abcd-ef0123456789",
      "0123456789abcdef0123456789abcdef",
    );
    expect(formatted).toContain("hello world");
    expect(formatted).toContain("[motebit:a1b2c3d4 key:0123456789abcdef]");
  });

  it("handles object data by JSON-stringifying", () => {
    const result: ToolResult = { ok: true, data: { count: 42 } };
    const formatted = formatResult(result, "abcdef01", "deadbeef");
    expect(formatted).toContain('{"count":42}');
  });

  it("shows error message when ok is false", () => {
    const result: ToolResult = { ok: false, error: "something failed" };
    const formatted = formatResult(result, "abcdef01", "deadbeef");
    expect(formatted).toContain("something failed");
  });

  it("shows 'none' when publicKeyHex is undefined", () => {
    const result: ToolResult = { ok: true, data: "test" };
    const formatted = formatResult(result, "abcdef01", undefined);
    expect(formatted).toContain("key:none");
  });

  it("shows 'no data' when ok is false and no error", () => {
    const result: ToolResult = { ok: false };
    const formatted = formatResult(result, "abcdef01");
    expect(formatted).toContain("no data");
  });

  it("uses string data directly without JSON.stringify", () => {
    const result: ToolResult = { ok: true, data: "raw string data" };
    const formatted = formatResult(result, "abcdef01");
    expect(formatted).toContain("raw string data");
    expect(formatted).not.toContain('"raw string data"'); // no extra quotes
  });
});

describe("filterMemories", () => {
  it("excludes personal, medical, financial, and secret sensitivities", () => {
    const memories = [
      { content: "a", confidence: 0.9, sensitivity: "none", created_at: 1 },
      { content: "b", confidence: 0.8, sensitivity: "medical", created_at: 2 },
      { content: "c", confidence: 0.7, sensitivity: "financial", created_at: 3 },
      { content: "d", confidence: 0.6, sensitivity: "secret", created_at: 4 },
      { content: "e", confidence: 0.5, sensitivity: "personal", created_at: 5 },
    ];
    const result = filterMemories(memories, 50);
    expect(result).toHaveLength(1);
    expect(result.map((m) => m.content)).toEqual(["a"]);
  });

  it("caps at the specified limit", () => {
    const memories = Array.from({ length: 10 }, (_, i) => ({
      content: `mem-${i}`,
      confidence: 0.9,
      sensitivity: "none",
      created_at: i,
    }));
    const result = filterMemories(memories, 3);
    expect(result).toHaveLength(3);
  });

  it("strips sensitivity field from output", () => {
    const memories = [{ content: "a", confidence: 0.9, sensitivity: "none", created_at: 1 }];
    const result = filterMemories(memories, 50);
    expect(result[0]).toEqual({ content: "a", confidence: 0.9, created_at: 1 });
    expect("sensitivity" in result[0]!).toBe(false);
  });

  it("filters then limits (not limit then filter)", () => {
    // 3 "none" and 2 "secret" — limit 2 should give 2 "none" memories
    const memories = [
      { content: "n1", confidence: 0.9, sensitivity: "none", created_at: 1 },
      { content: "s1", confidence: 0.9, sensitivity: "secret", created_at: 2 },
      { content: "n2", confidence: 0.9, sensitivity: "none", created_at: 3 },
      { content: "s2", confidence: 0.9, sensitivity: "secret", created_at: 4 },
      { content: "n3", confidence: 0.9, sensitivity: "none", created_at: 5 },
    ];
    const result = filterMemories(memories, 2);
    expect(result).toHaveLength(2);
    expect(result.map((m) => m.content)).toEqual(["n1", "n2"]);
  });

  it("returns empty array when all memories are sensitive", () => {
    const memories = [
      { content: "a", confidence: 0.9, sensitivity: "medical", created_at: 1 },
      { content: "b", confidence: 0.9, sensitivity: "financial", created_at: 2 },
    ];
    const result = filterMemories(memories, 50);
    expect(result).toEqual([]);
  });
});

describe("jsonSchemaToZodShape", () => {
  it("converts string properties", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    });
    expect(shape).toHaveProperty("name");
    const parsed = shape["name"]!.safeParse("hello");
    expect(parsed.success).toBe(true);
  });

  it("converts number properties", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: { count: { type: "number" } },
      required: ["count"],
    });
    const parsed = shape["count"]!.safeParse(42);
    expect(parsed.success).toBe(true);
  });

  it("converts integer properties to number", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: { count: { type: "integer" } },
      required: ["count"],
    });
    const parsed = shape["count"]!.safeParse(42);
    expect(parsed.success).toBe(true);
  });

  it("converts boolean properties", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: { flag: { type: "boolean" } },
      required: ["flag"],
    });
    expect(shape["flag"]!.safeParse(true).success).toBe(true);
    expect(shape["flag"]!.safeParse("not-bool").success).toBe(false);
  });

  it("makes non-required properties optional", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: { opt: { type: "string" } },
    });
    const parsed = shape["opt"]!.safeParse(undefined);
    expect(parsed.success).toBe(true);
  });

  it("returns empty shape for schema with no properties", () => {
    const shape = jsonSchemaToZodShape({ type: "object" });
    expect(Object.keys(shape)).toHaveLength(0);
  });

  it("falls back to z.unknown() for unsupported types", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: { data: { type: "array" } },
      required: ["data"],
    });
    // z.unknown() accepts anything
    expect(shape["data"]!.safeParse([1, 2, 3]).success).toBe(true);
    expect(shape["data"]!.safeParse("anything").success).toBe(true);
  });

  it("preserves description from schema properties", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: { name: { type: "string", description: "The user name" } },
      required: ["name"],
    });
    expect(shape["name"]!.description).toBe("The user name");
  });

  it("handles multiple properties", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "integer" },
        active: { type: "boolean" },
      },
      required: ["name", "age"],
    });
    expect(Object.keys(shape)).toHaveLength(3);
    expect(shape["name"]!.safeParse("test").success).toBe(true);
    expect(shape["age"]!.safeParse(25).success).toBe(true);
    expect(shape["active"]!.safeParse(undefined).success).toBe(true); // optional
  });
});

// ============================================================
// McpServerAdapter — start/stop lifecycle
// ============================================================

describe("McpServerAdapter — lifecycle", () => {
  it("connects with stdio transport on start()", async () => {
    const adapter = new McpServerAdapter(makeConfig({ transport: "stdio" }), makeDeps());
    await adapter.start();
    expect(mockServerConnect).toHaveBeenCalledTimes(1);
  });

  it("calls server.close() on stop()", async () => {
    const adapter = new McpServerAdapter(makeConfig(), makeDeps());
    await adapter.start();
    await adapter.stop();
    expect(mockServerClose).toHaveBeenCalledTimes(1);
  });

  it("constructs without error using custom name and version", () => {
    const adapter = new McpServerAdapter(
      makeConfig({ name: "my-mote", version: "2.0.0" }),
      makeDeps(),
    );
    expect(adapter).toBeDefined();
  });
});

// ============================================================
// McpServerAdapter — tool registration
// ============================================================

describe("McpServerAdapter — tool registration", () => {
  it("registers visible tools on start()", async () => {
    const tools: ToolDefinition[] = [
      toolDef("search", {
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      }),
      toolDef("status"),
    ];
    const deps = makeDeps({
      listTools: () => tools,
      filterTools: (t) => t,
    });

    const adapter = new McpServerAdapter(makeConfig(), deps);
    await adapter.start();

    expect(registrations.tools.has("search")).toBe(true);
    expect(registrations.tools.has("status")).toBe(true);
  });

  it("only registers tools that pass filterTools", async () => {
    const tools: ToolDefinition[] = [toolDef("allowed"), toolDef("denied")];
    const deps = makeDeps({
      listTools: () => tools,
      filterTools: (t) => t.filter((td) => td.name === "allowed"),
    });

    const adapter = new McpServerAdapter(makeConfig(), deps);
    await adapter.start();

    expect(registrations.tools.has("allowed")).toBe(true);
    expect(registrations.tools.has("denied")).toBe(false);
  });

  it("registers tools with args using zodShape", async () => {
    const tools: ToolDefinition[] = [
      toolDef("with-args", {
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      }),
    ];
    const deps = makeDeps({ listTools: () => tools });

    const adapter = new McpServerAdapter(makeConfig(), deps);
    await adapter.start();

    // Tool with args: description + zodShape (annotations omitted when empty)
    const entry = registrations.tools.get("with-args")!;
    expect(entry.args.length).toBeGreaterThanOrEqual(2);
  });

  it("registers tools without args (no zodShape)", async () => {
    const tools: ToolDefinition[] = [
      toolDef("no-args", { inputSchema: { type: "object", properties: {} } }),
    ];
    const deps = makeDeps({ listTools: () => tools });

    const adapter = new McpServerAdapter(makeConfig(), deps);
    await adapter.start();

    // Tool without args skips zodShape and empty annotations — just description + handler
    const entry = registrations.tools.get("no-args")!;
    expect(entry.args.length).toBe(1);
  });
});

// ============================================================
// McpServerAdapter — handleToolCall (via registered handler)
// ============================================================

describe("McpServerAdapter — tool execution", () => {
  async function startWithTool(tool: ToolDefinition, deps: Partial<MotebitServerDeps> = {}) {
    const fullDeps = makeDeps({
      listTools: () => [tool],
      ...deps,
    });
    const adapter = new McpServerAdapter(makeConfig(), fullDeps);
    await adapter.start();
    return registrations.tools.get(tool.name)!.handler;
  }

  it("executes tool and returns formatted result", async () => {
    const handler = await startWithTool(toolDef("run"), {
      executeTool: async () => ({ ok: true, data: "executed!" }),
    });

    const result = (await handler({})) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.text).toContain("executed!");
    expect(result.content[0]!.text).toContain("[motebit:");
  });

  it("includes identity tag in result", async () => {
    const handler = await startWithTool(toolDef("run"), {
      motebitId: "test-id-1234",
      publicKeyHex: "aabbccdd11223344",
      executeTool: async () => ({ ok: true, data: "ok" }),
    });

    const result = (await handler({})) as { content: Array<{ text: string }> };

    expect(result.content[0]!.text).toContain("[motebit:test-id- key:aabbccdd11223344]");
  });

  it("logs tool call to audit", async () => {
    const logToolCall = vi.fn();
    const handler = await startWithTool(toolDef("audited"), {
      executeTool: async () => ({ ok: true, data: "done" }),
      logToolCall,
    });

    await handler({});

    expect(logToolCall).toHaveBeenCalledTimes(1);
    expect(logToolCall).toHaveBeenCalledWith("audited", {}, { ok: true, data: "done" });
  });

  it("returns policy denial with reason", async () => {
    const handler = await startWithTool(toolDef("denied"), {
      validateTool: () => ({
        allowed: false,
        requiresApproval: false,
        reason: "too risky",
      }),
    });

    const result = (await handler({})) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Policy denied");
    expect(result.content[0]!.text).toContain("too risky");
  });

  it("returns default denial message when no reason", async () => {
    const handler = await startWithTool(toolDef("denied"), {
      validateTool: () => ({ allowed: false, requiresApproval: false }),
    });

    const result = (await handler({})) as { content: Array<{ text: string }> };
    expect(result.content[0]!.text).toContain("tool not allowed by governance policy");
  });

  it("returns approval-required message", async () => {
    const handler = await startWithTool(toolDef("needs-approval"), {
      validateTool: () => ({
        allowed: false,
        requiresApproval: true,
      }),
    });

    const result = (await handler({})) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("requires approval");
    expect(result.content[0]!.text).toContain("needs-approval");
  });

  it("does not audit denied tool calls", async () => {
    const logToolCall = vi.fn();
    const handler = await startWithTool(toolDef("denied"), {
      validateTool: () => ({ allowed: false, requiresApproval: false }),
      logToolCall,
    });

    await handler({});
    expect(logToolCall).not.toHaveBeenCalled();
  });

  it("does not audit approval-required tool calls", async () => {
    const logToolCall = vi.fn();
    const handler = await startWithTool(toolDef("needs-approval"), {
      validateTool: () => ({ allowed: false, requiresApproval: true }),
      logToolCall,
    });

    await handler({});
    expect(logToolCall).not.toHaveBeenCalled();
  });

  it("does not execute tool when denied", async () => {
    const executeTool = vi.fn();
    const handler = await startWithTool(toolDef("denied"), {
      validateTool: () => ({ allowed: false, requiresApproval: false }),
      executeTool,
    });

    await handler({});
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("passes isError=true when tool result is not ok", async () => {
    const handler = await startWithTool(toolDef("fail"), {
      executeTool: async () => ({ ok: false, error: "boom" }),
    });

    const result = (await handler({})) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });

  it("passes isError=false when tool result is ok", async () => {
    const handler = await startWithTool(toolDef("ok"), {
      executeTool: async () => ({ ok: true, data: "good" }),
    });

    const result = (await handler({})) as { isError?: boolean };
    expect(result.isError).toBe(false);
  });

  it("passes args through to executeTool and validateTool", async () => {
    const executeTool = vi.fn(async () => ({ ok: true, data: "ok" }));
    const validateTool = vi.fn(() => ({ allowed: true, requiresApproval: false }));
    const tool = toolDef("with-args", {
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    });

    const handler = await startWithTool(tool, { executeTool, validateTool });
    await handler({ city: "Paris" });

    expect(validateTool).toHaveBeenCalledWith(tool, { city: "Paris" }, undefined);
    expect(executeTool).toHaveBeenCalledWith("with-args", { city: "Paris" });
  });
});

// ============================================================
// McpServerAdapter — resource registration
// ============================================================

describe("McpServerAdapter — resources", () => {
  it("always registers identity resource", async () => {
    const adapter = new McpServerAdapter(makeConfig(), makeDeps());
    await adapter.start();
    expect(registrations.resources.has("identity")).toBe(true);
  });

  it("identity resource returns motebitId and publicKey", async () => {
    const deps = makeDeps({
      motebitId: "test-mote-1234",
      publicKeyHex: "deadbeef",
    });
    const adapter = new McpServerAdapter(makeConfig(), deps);
    await adapter.start();

    const handler = registrations.resources.get("identity")!.handler;
    const result = (await handler()) as {
      contents: Array<{ uri: string; mimeType: string; text: string }>;
    };

    expect(result.contents).toHaveLength(1);
    const parsed = JSON.parse(result.contents[0]!.text) as Record<string, unknown>;
    expect(parsed.motebit_id).toBe("test-mote-1234");
    expect(parsed.public_key).toBe("deadbeef");
  });

  it("identity resource returns null publicKey when not provided", async () => {
    const deps = makeDeps({ publicKeyHex: undefined });
    const adapter = new McpServerAdapter(makeConfig(), deps);
    await adapter.start();

    const handler = registrations.resources.get("identity")!.handler;
    const result = (await handler()) as {
      contents: Array<{ text: string }>;
    };

    const parsed = JSON.parse(result.contents[0]!.text) as Record<string, unknown>;
    expect(parsed.public_key).toBeNull();
  });

  it("registers state resource by default", async () => {
    const adapter = new McpServerAdapter(makeConfig(), makeDeps());
    await adapter.start();
    expect(registrations.resources.has("state")).toBe(true);
  });

  it("state resource returns current state", async () => {
    const deps = makeDeps({
      getState: () => ({ attention: 0.8, processing: 0.3, curiosity: 0.5 }),
    });
    const adapter = new McpServerAdapter(makeConfig(), deps);
    await adapter.start();

    const handler = registrations.resources.get("state")!.handler;
    const result = (await handler()) as { contents: Array<{ text: string }> };

    const parsed = JSON.parse(result.contents[0]!.text) as Record<string, unknown>;
    expect(parsed.attention).toBe(0.8);
    expect(parsed.processing).toBe(0.3);
    expect(parsed.curiosity).toBe(0.5);
  });

  it("does NOT register state resource when exposeState is false", async () => {
    const adapter = new McpServerAdapter(makeConfig({ exposeState: false }), makeDeps());
    await adapter.start();
    expect(registrations.resources.has("state")).toBe(false);
  });

  it("registers memories resource by default", async () => {
    const adapter = new McpServerAdapter(makeConfig(), makeDeps());
    await adapter.start();
    expect(registrations.resources.has("memories")).toBe(true);
  });

  it("memories resource returns privacy-filtered memories", async () => {
    const deps = makeDeps({
      getMemories: async () => [
        { content: "public", confidence: 0.9, sensitivity: "none", created_at: 1 },
        { content: "private", confidence: 0.8, sensitivity: "medical", created_at: 2 },
        { content: "also-private", confidence: 0.7, sensitivity: "personal", created_at: 3 },
      ],
    });
    const adapter = new McpServerAdapter(makeConfig(), deps);
    await adapter.start();

    const handler = registrations.resources.get("memories")!.handler;
    const result = (await handler()) as { contents: Array<{ text: string }> };

    const parsed = JSON.parse(result.contents[0]!.text) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.content).toBe("public");
    // sensitivity field should be stripped
    expect(parsed[0]).not.toHaveProperty("sensitivity");
  });

  it("does NOT register memories resource when exposeMemories is false", async () => {
    const adapter = new McpServerAdapter(makeConfig({ exposeMemories: false }), makeDeps());
    await adapter.start();
    expect(registrations.resources.has("memories")).toBe(false);
  });
});

// ============================================================
// McpServerAdapter — prompt registration
// ============================================================

describe("McpServerAdapter — prompts", () => {
  it("registers chat, recall, and reflect prompts", async () => {
    const adapter = new McpServerAdapter(makeConfig(), makeDeps());
    await adapter.start();

    expect(registrations.prompts.has("chat")).toBe(true);
    expect(registrations.prompts.has("recall")).toBe(true);
    expect(registrations.prompts.has("reflect")).toBe(true);
  });

  it("chat prompt returns user message", async () => {
    const adapter = new McpServerAdapter(makeConfig(), makeDeps());
    await adapter.start();

    const handler = registrations.prompts.get("chat")!.handler;
    const result = handler({ message: "Hello motebit!" }) as {
      messages: Array<{ role: string; content: { type: string; text: string } }>;
    };

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.role).toBe("user");
    expect(result.messages[0]!.content.text).toBe("Hello motebit!");
  });

  it("recall prompt includes query text", async () => {
    const adapter = new McpServerAdapter(makeConfig(), makeDeps());
    await adapter.start();

    const handler = registrations.prompts.get("recall")!.handler;
    const result = handler({ query: "previous conversations" }) as {
      messages: Array<{ content: { text: string } }>;
    };

    expect(result.messages[0]!.content.text).toContain("previous conversations");
  });

  it("recall prompt includes limit when provided", async () => {
    const adapter = new McpServerAdapter(makeConfig(), makeDeps());
    await adapter.start();

    const handler = registrations.prompts.get("recall")!.handler;
    const result = handler({ query: "test", limit: "5" }) as {
      messages: Array<{ content: { text: string } }>;
    };

    expect(result.messages[0]!.content.text).toContain("(limit: 5)");
  });

  it("recall prompt omits limit text when not provided", async () => {
    const adapter = new McpServerAdapter(makeConfig(), makeDeps());
    await adapter.start();

    const handler = registrations.prompts.get("recall")!.handler;
    const result = handler({ query: "test" }) as {
      messages: Array<{ content: { text: string } }>;
    };

    expect(result.messages[0]!.content.text).not.toContain("limit");
  });

  it("reflect prompt returns reflection instruction", async () => {
    const adapter = new McpServerAdapter(makeConfig(), makeDeps());
    await adapter.start();

    const handler = registrations.prompts.get("reflect")!.handler;
    const result = handler({}) as {
      messages: Array<{ content: { text: string } }>;
    };

    expect(result.messages[0]!.content.text).toContain("reflect");
  });
});

// ============================================================
// McpServerAdapter — HTTP transport
// ============================================================

describe("McpServerAdapter — HTTP transport", () => {
  it("stop() handles absence of httpServer gracefully", async () => {
    // Start with stdio — no httpServer created
    const adapter = new McpServerAdapter(makeConfig(), makeDeps());
    await adapter.start();
    await adapter.stop();
    // No error means httpServer?.close() path was safely skipped
  });
});

// ============================================================
// Integration: full tool execution pipeline
// ============================================================

describe("McpServerAdapter — integration", () => {
  it("end-to-end: register tool → policy check → execute → audit → format", async () => {
    const logToolCall = vi.fn();
    const executeTool = vi.fn(async () => ({ ok: true, data: "42" }));
    const validateTool = vi.fn(() => ({ allowed: true, requiresApproval: false }));

    const tool = toolDef("calculator", {
      inputSchema: {
        type: "object",
        properties: { expression: { type: "string" } },
        required: ["expression"],
      },
    });

    const deps = makeDeps({
      motebitId: "calc-mote-id",
      publicKeyHex: "aabbccddeeff0011",
      listTools: () => [tool],
      filterTools: (t) => t,
      validateTool,
      executeTool,
      logToolCall,
    });

    const adapter = new McpServerAdapter(makeConfig(), deps);
    await adapter.start();

    // Invoke the registered handler
    const handler = registrations.tools.get("calculator")!.handler;
    const result = (await handler({ expression: "6*7" })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };

    // 1. Policy was checked (caller is undefined when no motebit auth)
    expect(validateTool).toHaveBeenCalledWith(tool, { expression: "6*7" }, undefined);

    // 2. Tool was executed
    expect(executeTool).toHaveBeenCalledWith("calculator", { expression: "6*7" });

    // 3. Audit was logged
    expect(logToolCall).toHaveBeenCalledWith(
      "calculator",
      { expression: "6*7" },
      { ok: true, data: "42" },
    );

    // 4. Result is formatted with identity
    expect(result.isError).toBe(false);
    expect(result.content[0]!.text).toContain("42");
    expect(result.content[0]!.text).toContain("[motebit:calc-mot key:aabbccddeeff0011]");
  });

  it("all three resources registered with correct URIs", async () => {
    const adapter = new McpServerAdapter(makeConfig(), makeDeps());
    await adapter.start();

    expect(registrations.resources.size).toBe(3);
    expect(registrations.resources.has("identity")).toBe(true);
    expect(registrations.resources.has("state")).toBe(true);
    expect(registrations.resources.has("memories")).toBe(true);
  });

  it("only identity resource when both state and memories disabled", async () => {
    const adapter = new McpServerAdapter(
      makeConfig({ exposeState: false, exposeMemories: false }),
      makeDeps(),
    );
    await adapter.start();

    expect(registrations.resources.size).toBe(1);
    expect(registrations.resources.has("identity")).toBe(true);
  });
});

// ============================================================
// McpServerAdapter — synthetic tool registration
// ============================================================

describe("McpServerAdapter — synthetic tools", () => {
  it("always registers motebit_identity and motebit_tools", async () => {
    const adapter = new McpServerAdapter(makeConfig(), makeDeps());
    await adapter.start();

    expect(registrations.tools.has("motebit_identity")).toBe(true);
    expect(registrations.tools.has("motebit_tools")).toBe(true);
  });

  it("does NOT register motebit_query when sendMessage is absent", async () => {
    const adapter = new McpServerAdapter(makeConfig(), makeDeps());
    await adapter.start();

    expect(registrations.tools.has("motebit_query")).toBe(false);
  });

  it("registers motebit_query when sendMessage is provided", async () => {
    const deps = makeDeps({
      sendMessage: async () => ({ response: "hello", memoriesFormed: 0 }),
    });
    const adapter = new McpServerAdapter(makeConfig(), deps);
    await adapter.start();

    expect(registrations.tools.has("motebit_query")).toBe(true);
  });

  it("does NOT register motebit_remember when storeMemory is absent", async () => {
    const adapter = new McpServerAdapter(makeConfig(), makeDeps());
    await adapter.start();

    expect(registrations.tools.has("motebit_remember")).toBe(false);
  });

  it("registers motebit_remember when storeMemory is provided", async () => {
    const deps = makeDeps({
      storeMemory: async () => ({ node_id: "n1" }),
    });
    const adapter = new McpServerAdapter(makeConfig(), deps);
    await adapter.start();

    expect(registrations.tools.has("motebit_remember")).toBe(true);
  });

  it("does NOT register motebit_recall when queryMemories is absent", async () => {
    const adapter = new McpServerAdapter(makeConfig(), makeDeps());
    await adapter.start();

    expect(registrations.tools.has("motebit_recall")).toBe(false);
  });

  it("registers motebit_recall when queryMemories is provided", async () => {
    const deps = makeDeps({
      queryMemories: async () => [],
    });
    const adapter = new McpServerAdapter(makeConfig(), deps);
    await adapter.start();

    expect(registrations.tools.has("motebit_recall")).toBe(true);
  });

  it("does NOT register motebit_task when handleAgentTask is absent", async () => {
    const adapter = new McpServerAdapter(makeConfig(), makeDeps());
    await adapter.start();

    expect(registrations.tools.has("motebit_task")).toBe(false);
  });

  it("registers motebit_task when handleAgentTask is provided", async () => {
    const deps = makeDeps({
      handleAgentTask: async function* () {
        /* empty */
      },
    });
    const adapter = new McpServerAdapter(makeConfig(), deps);
    await adapter.start();

    expect(registrations.tools.has("motebit_task")).toBe(true);
  });
});

// ============================================================
// McpServerAdapter — synthetic tool execution
// ============================================================

describe("McpServerAdapter — synthetic tool execution", () => {
  it("motebit_query calls sendMessage and returns response", async () => {
    const sendMessage = vi.fn(async () => ({ response: "42 is the answer", memoriesFormed: 1 }));
    const deps = makeDeps({ sendMessage });
    const adapter = new McpServerAdapter(makeConfig(), deps);
    await adapter.start();

    const handler = registrations.tools.get("motebit_query")!.handler;
    const result = (await handler({ message: "what is 42?" })) as {
      content: Array<{ text: string }>;
    };

    expect(sendMessage).toHaveBeenCalledWith("what is 42?");
    expect(result.content[0]!.text).toContain("42 is the answer");
    expect(result.content[0]!.text).toContain("memories_formed");
    expect(result.content[0]!.text).toContain("[motebit:");
  });

  it("motebit_remember stores memory and returns node_id", async () => {
    const storeMemory = vi.fn(async () => ({ node_id: "mem-123" }));
    const deps = makeDeps({ storeMemory });
    const adapter = new McpServerAdapter(makeConfig(), deps);
    await adapter.start();

    const handler = registrations.tools.get("motebit_remember")!.handler;
    const result = (await handler({ content: "remember this" })) as {
      content: Array<{ text: string }>;
    };

    expect(storeMemory).toHaveBeenCalledWith("remember this", undefined);
    expect(result.content[0]!.text).toContain("mem-123");
  });

  it("motebit_remember rejects medical sensitivity", async () => {
    const storeMemory = vi.fn(async () => ({ node_id: "x" }));
    const deps = makeDeps({ storeMemory });
    const adapter = new McpServerAdapter(makeConfig(), deps);
    await adapter.start();

    const handler = registrations.tools.get("motebit_remember")!.handler;
    const result = (await handler({ content: "test", sensitivity: "medical" })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Denied");
    expect(storeMemory).not.toHaveBeenCalled();
  });

  it("motebit_remember rejects financial sensitivity", async () => {
    const storeMemory = vi.fn(async () => ({ node_id: "x" }));
    const deps = makeDeps({ storeMemory });
    const adapter = new McpServerAdapter(makeConfig(), deps);
    await adapter.start();

    const handler = registrations.tools.get("motebit_remember")!.handler;
    const result = (await handler({ content: "test", sensitivity: "financial" })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(storeMemory).not.toHaveBeenCalled();
  });

  it("motebit_remember rejects secret sensitivity", async () => {
    const storeMemory = vi.fn(async () => ({ node_id: "x" }));
    const deps = makeDeps({ storeMemory });
    const adapter = new McpServerAdapter(makeConfig(), deps);
    await adapter.start();

    const handler = registrations.tools.get("motebit_remember")!.handler;
    const result = (await handler({ content: "test", sensitivity: "secret" })) as {
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(storeMemory).not.toHaveBeenCalled();
  });

  it("motebit_remember rejects personal sensitivity from external callers", async () => {
    const storeMemory = vi.fn(async () => ({ node_id: "ok-1" }));
    const deps = makeDeps({ storeMemory });
    const adapter = new McpServerAdapter(makeConfig(), deps);
    await adapter.start();

    const handler = registrations.tools.get("motebit_remember")!.handler;
    const result = (await handler({ content: "test", sensitivity: "personal" })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(storeMemory).not.toHaveBeenCalled();
  });

  it("motebit_recall returns query results", async () => {
    const queryMemories = vi.fn(async () => [
      { content: "memory 1", confidence: 0.9, similarity: 0.85 },
      { content: "memory 2", confidence: 0.7, similarity: 0.6 },
    ]);
    const deps = makeDeps({ queryMemories });
    const adapter = new McpServerAdapter(makeConfig(), deps);
    await adapter.start();

    const handler = registrations.tools.get("motebit_recall")!.handler;
    const result = (await handler({ query: "what happened?" })) as {
      content: Array<{ text: string }>;
    };

    expect(queryMemories).toHaveBeenCalledWith("what happened?", undefined);
    expect(result.content[0]!.text).toContain("memory 1");
    expect(result.content[0]!.text).toContain("memory 2");
  });

  it("motebit_recall passes limit", async () => {
    const queryMemories = vi.fn(async () => []);
    const deps = makeDeps({ queryMemories });
    const adapter = new McpServerAdapter(makeConfig(), deps);
    await adapter.start();

    const handler = registrations.tools.get("motebit_recall")!.handler;
    await handler({ query: "test", limit: 5 });

    expect(queryMemories).toHaveBeenCalledWith("test", 5);
  });

  it("motebit_task iterates generator and returns receipt", async () => {
    const mockReceipt = { task_id: "t1", status: "completed", result: "done" };
    const handleAgentTask = async function* () {
      yield { type: "text" as const, text: "working..." };
      yield { type: "task_result" as const, receipt: mockReceipt };
    };
    const deps = makeDeps({ handleAgentTask });
    const adapter = new McpServerAdapter(makeConfig(), deps);
    await adapter.start();

    const handler = registrations.tools.get("motebit_task")!.handler;
    const result = (await handler({ prompt: "do something" })) as {
      content: Array<{ text: string }>;
    };

    expect(result.content[0]!.text).toContain("t1");
    expect(result.content[0]!.text).toContain("completed");
  });

  it("motebit_task returns fallback when no receipt emitted", async () => {
    const handleAgentTask = async function* () {
      yield { type: "text" as const, text: "just text" };
    };
    const deps = makeDeps({ handleAgentTask });
    const adapter = new McpServerAdapter(makeConfig(), deps);
    await adapter.start();

    const handler = registrations.tools.get("motebit_task")!.handler;
    const result = (await handler({ prompt: "do it" })) as {
      content: Array<{ text: string }>;
    };

    expect(result.content[0]!.text).toContain("just text");
    expect(result.content[0]!.text).toContain("completed");
  });

  it("motebit_identity returns identityFileContent when provided", async () => {
    const deps = makeDeps({ identityFileContent: "# motebit.md\n---\nidentity..." });
    const adapter = new McpServerAdapter(makeConfig(), deps);
    await adapter.start();

    const handler = registrations.tools.get("motebit_identity")!.handler;
    const result = (await handler()) as { content: Array<{ text: string }> };

    expect(result.content[0]!.text).toContain("# motebit.md");
  });

  it("motebit_identity returns JSON fallback when no file content", async () => {
    const deps = makeDeps({
      motebitId: "test-id-abc",
      publicKeyHex: "deadbeef1234",
    });
    const adapter = new McpServerAdapter(makeConfig(), deps);
    await adapter.start();

    const handler = registrations.tools.get("motebit_identity")!.handler;
    const result = (await handler()) as { content: Array<{ text: string }> };

    expect(result.content[0]!.text).toContain("test-id-abc");
    expect(result.content[0]!.text).toContain("deadbeef1234");
  });

  it("motebit_tools returns tool list", async () => {
    const tools: ToolDefinition[] = [
      toolDef("search", { riskHint: { risk: RiskLevel.R0_READ } }),
      toolDef("execute", { riskHint: { risk: RiskLevel.R3_EXECUTE } }),
    ];
    const deps = makeDeps({ listTools: () => tools });
    const adapter = new McpServerAdapter(makeConfig(), deps);
    await adapter.start();

    const handler = registrations.tools.get("motebit_tools")!.handler;
    const result = (await handler()) as { content: Array<{ text: string }> };

    const text = result.content[0]!.text;
    expect(text).toContain("search");
    expect(text).toContain("execute");
  });

  it("synthetic tools log via logToolCall", async () => {
    const logToolCall = vi.fn();
    const deps = makeDeps({
      logToolCall,
      sendMessage: async () => ({ response: "ok", memoriesFormed: 0 }),
    });
    const adapter = new McpServerAdapter(makeConfig(), deps);
    await adapter.start();

    const handler = registrations.tools.get("motebit_query")!.handler;
    await handler({ message: "test" });

    expect(logToolCall).toHaveBeenCalledWith(
      "motebit_query",
      { message: "test" },
      { ok: true, data: "ok" },
    );
  });
});

// ============================================================
// McpServerAdapter — HTTP auth
// ============================================================

describe("McpServerAdapter — HTTP auth", () => {
  it("rejects requests with wrong token", async () => {
    const adapter = new McpServerAdapter(
      makeConfig({ transport: "http", port: 0, authToken: "secret-token" }),
      makeDeps(),
    );
    await adapter.start();

    // The HTTP server is created internally. We test by making a real request.
    // Since port 0 picks a random port, we need to extract the actual port.
    const server = (adapter as unknown as { httpServer: import("node:http").Server }).httpServer;
    const addr = server.address() as import("node:net").AddressInfo;

    const res = await fetch(`http://localhost:${addr.port}/mcp`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);

    await adapter.stop();
  });

  it("allows /health without auth", async () => {
    const adapter = new McpServerAdapter(
      makeConfig({ transport: "http", port: 0, authToken: "secret-token" }),
      makeDeps(),
    );
    await adapter.start();

    const server = (adapter as unknown as { httpServer: import("node:http").Server }).httpServer;
    const addr = server.address() as import("node:net").AddressInfo;

    const res = await fetch(`http://localhost:${addr.port}/health`);
    expect(res.status).toBe(200);

    await adapter.stop();
  });

  it("allows requests with correct token", async () => {
    const adapter = new McpServerAdapter(
      makeConfig({ transport: "http", port: 0, authToken: "correct-token" }),
      makeDeps(),
    );
    await adapter.start();

    const server = (adapter as unknown as { httpServer: import("node:http").Server }).httpServer;
    const addr = server.address() as import("node:net").AddressInfo;

    const res = await fetch(`http://localhost:${addr.port}/health`);
    expect(res.status).toBe(200);

    // /mcp POST without body returns 400 (parse error), not 401 (auth passed)
    const msgRes = await fetch(`http://localhost:${addr.port}/mcp`, {
      method: "POST",
      headers: { Authorization: "Bearer correct-token" },
    });
    expect(msgRes.status).toBe(400);

    await adapter.stop();
  });

  it("skips auth when authToken is not configured", async () => {
    const adapter = new McpServerAdapter(makeConfig({ transport: "http", port: 0 }), makeDeps());
    await adapter.start();

    const server = (adapter as unknown as { httpServer: import("node:http").Server }).httpServer;
    const addr = server.address() as import("node:net").AddressInfo;

    // No Authorization header, should still get through
    const res = await fetch(`http://localhost:${addr.port}/mcp`, {
      method: "POST",
    });
    expect(res.status).toBe(400); // invalid session, not 401

    await adapter.stop();
  });
});

// ============================================================
// McpServerAdapter — mutual authentication (motebit tokens)
// ============================================================

describe("McpServerAdapter — mutual authentication", () => {
  // Helper: create a fake base64url-encoded claims payload
  function fakeClaimsB64(claims: Record<string, unknown>): string {
    const json = JSON.stringify(claims);
    // btoa then make URL-safe
    return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  it("rejects motebit: token when caller is not in knownCallers and no resolveCallerKey", async () => {
    const claims = {
      mid: "unknown-caller-id",
      did: "d1",
      iat: Date.now(),
      exp: Date.now() + 60000,
    };
    const token = `${fakeClaimsB64(claims)}.fakesig`;

    const adapter = new McpServerAdapter(
      makeConfig({
        transport: "http",
        port: 0,
        knownCallers: new Map(), // empty — no known callers
      }),
      makeDeps({
        verifySignedToken: vi.fn(async () => null),
      }),
    );
    await adapter.start();

    const server = (adapter as unknown as { httpServer: import("node:http").Server }).httpServer;
    const addr = server.address() as import("node:net").AddressInfo;

    const res = await fetch(`http://localhost:${addr.port}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer motebit:${token}` },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid motebit token");

    await adapter.stop();
  });

  it("rejects motebit: token when caller is blocked in knownCallers", async () => {
    const callerId = "blocked-caller-id";
    const claims = { mid: callerId, did: "d1", iat: Date.now(), exp: Date.now() + 60000 };
    const token = `${fakeClaimsB64(claims)}.fakesig`;

    const knownCallers = new Map<
      string,
      { publicKey: string; trustLevel: import("../index.js").AgentTrustLevel }
    >();
    const { AgentTrustLevel: ATL } = await import("../index.js");
    knownCallers.set(callerId, {
      publicKey: "aabbccdd".repeat(8),
      trustLevel: ATL.Blocked,
    });

    const adapter = new McpServerAdapter(
      makeConfig({ transport: "http", port: 0, knownCallers }),
      makeDeps({
        verifySignedToken: vi.fn(async () => null), // won't be reached (blocked before verification)
      }),
    );
    await adapter.start();

    const server = (adapter as unknown as { httpServer: import("node:http").Server }).httpServer;
    const addr = server.address() as import("node:net").AddressInfo;

    const res = await fetch(`http://localhost:${addr.port}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer motebit:${token}` },
    });
    expect(res.status).toBe(401);

    await adapter.stop();
  });

  it("rejects motebit: token with malformed payload (no dot)", async () => {
    const adapter = new McpServerAdapter(makeConfig({ transport: "http", port: 0 }), makeDeps());
    await adapter.start();

    const server = (adapter as unknown as { httpServer: import("node:http").Server }).httpServer;
    const addr = server.address() as import("node:net").AddressInfo;

    const res = await fetch(`http://localhost:${addr.port}/mcp`, {
      method: "POST",
      headers: { Authorization: "Bearer motebit:nodothere" },
    });
    expect(res.status).toBe(401);

    await adapter.stop();
  });

  it("rejects motebit: token with invalid base64 in claims", async () => {
    const adapter = new McpServerAdapter(makeConfig({ transport: "http", port: 0 }), makeDeps());
    await adapter.start();

    const server = (adapter as unknown as { httpServer: import("node:http").Server }).httpServer;
    const addr = server.address() as import("node:net").AddressInfo;

    const res = await fetch(`http://localhost:${addr.port}/mcp`, {
      method: "POST",
      headers: { Authorization: "Bearer motebit:!!!invalid!!!.sig" },
    });
    expect(res.status).toBe(401);

    await adapter.stop();
  });

  it("rejects motebit: token when resolveCallerKey returns blocked", async () => {
    const { AgentTrustLevel: ATL } = await import("../index.js");
    const callerId = "resolve-blocked-id";
    const claims = { mid: callerId, did: "d1", iat: Date.now(), exp: Date.now() + 60000 };
    const token = `${fakeClaimsB64(claims)}.fakesig`;

    const resolveCallerKey = vi.fn(async () => ({
      publicKey: "aabbccdd".repeat(8),
      trustLevel: ATL.Blocked,
    }));

    const adapter = new McpServerAdapter(
      makeConfig({ transport: "http", port: 0 }),
      makeDeps({
        resolveCallerKey,
        verifySignedToken: vi.fn(async () => null), // won't be reached (blocked before verification)
      }),
    );
    await adapter.start();

    const server = (adapter as unknown as { httpServer: import("node:http").Server }).httpServer;
    const addr = server.address() as import("node:net").AddressInfo;

    const res = await fetch(`http://localhost:${addr.port}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer motebit:${token}` },
    });
    expect(res.status).toBe(401);
    expect(resolveCallerKey).toHaveBeenCalledWith(callerId);

    await adapter.stop();
  });

  it("static auth still works (backward compat)", async () => {
    const adapter = new McpServerAdapter(
      makeConfig({ transport: "http", port: 0, authToken: "my-secret" }),
      makeDeps(),
    );
    await adapter.start();

    const server = (adapter as unknown as { httpServer: import("node:http").Server }).httpServer;
    const addr = server.address() as import("node:net").AddressInfo;

    // Wrong token
    const res1 = await fetch(`http://localhost:${addr.port}/mcp`, {
      method: "POST",
      headers: { Authorization: "Bearer wrong" },
    });
    expect(res1.status).toBe(401);

    // Correct token (400 = auth passed, invalid session)
    const res2 = await fetch(`http://localhost:${addr.port}/mcp`, {
      method: "POST",
      headers: { Authorization: "Bearer my-secret" },
    });
    expect(res2.status).toBe(400);

    await adapter.stop();
  });

  it("open access when no authToken and no motebit: prefix", async () => {
    const adapter = new McpServerAdapter(makeConfig({ transport: "http", port: 0 }), makeDeps());
    await adapter.start();

    const server = (adapter as unknown as { httpServer: import("node:http").Server }).httpServer;
    const addr = server.address() as import("node:net").AddressInfo;

    // No auth header at all
    const res = await fetch(`http://localhost:${addr.port}/mcp`, {
      method: "POST",
    });
    expect(res.status).toBe(400); // invalid session, not 401

    await adapter.stop();
  });

  it("caller identity is passed to validateTool when verified", async () => {
    // This tests the integration: once a motebit caller is verified,
    // subsequent tool calls receive the caller context.
    // We test indirectly via the handleToolCall path using a registered tool.
    const { AgentTrustLevel: ATL } = await import("../index.js");

    const validateTool = vi.fn(() => ({ allowed: true, requiresApproval: false }));
    const tool = toolDef("test_tool", {
      inputSchema: {
        type: "object",
        properties: { x: { type: "string" } },
        required: ["x"],
      },
    });

    const deps = makeDeps({
      listTools: () => [tool],
      filterTools: (t) => t,
      validateTool,
    });

    const adapter = new McpServerAdapter(makeConfig(), deps);
    await adapter.start();

    // Simulate setting lastVerifiedCaller (as would happen during HTTP auth)
    const adapterAny = adapter as unknown as {
      lastVerifiedCaller: { motebitId: string; trustLevel: string } | null;
    };
    adapterAny.lastVerifiedCaller = {
      motebitId: "caller-mote-id",
      trustLevel: ATL.Verified,
    };

    // Invoke the tool handler
    const handler = registrations.tools.get("test_tool")!.handler;
    await handler({ x: "hello" });

    // validateTool should receive the caller identity
    expect(validateTool).toHaveBeenCalledWith(
      tool,
      { x: "hello" },
      { motebitId: "caller-mote-id", trustLevel: ATL.Verified },
    );
  });

  it("validateTool receives undefined caller when no motebit auth", async () => {
    const validateTool = vi.fn(() => ({ allowed: true, requiresApproval: false }));
    const tool = toolDef("plain_tool", {
      inputSchema: {
        type: "object",
        properties: { y: { type: "number" } },
        required: ["y"],
      },
    });

    const deps = makeDeps({
      listTools: () => [tool],
      filterTools: (t) => t,
      validateTool,
    });

    const adapter = new McpServerAdapter(makeConfig(), deps);
    await adapter.start();

    const handler = registrations.tools.get("plain_tool")!.handler;
    await handler({ y: 42 });

    // No motebit auth, so caller is undefined
    expect(validateTool).toHaveBeenCalledWith(tool, { y: 42 }, undefined);
  });
});
