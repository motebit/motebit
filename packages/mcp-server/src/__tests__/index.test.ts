import { describe, it, expect } from "vitest";
import {
  McpServerAdapter,
  riskToAnnotations,
  formatResult,
  filterMemories,
  jsonSchemaToZodShape,
} from "../index.js";
import type { MotebitServerDeps, McpServerConfig } from "../index.js";
import { RiskLevel } from "@motebit/sdk";
import type { ToolResult } from "@motebit/sdk";

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

// --- Tests ---

describe("McpServerAdapter", () => {
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
});

describe("filterMemories", () => {
  it("excludes medical, financial, and secret sensitivities", () => {
    const memories = [
      { content: "a", confidence: 0.9, sensitivity: "none", created_at: 1 },
      { content: "b", confidence: 0.8, sensitivity: "medical", created_at: 2 },
      { content: "c", confidence: 0.7, sensitivity: "financial", created_at: 3 },
      { content: "d", confidence: 0.6, sensitivity: "secret", created_at: 4 },
      { content: "e", confidence: 0.5, sensitivity: "personal", created_at: 5 },
    ];
    const result = filterMemories(memories, 50);
    expect(result).toHaveLength(2);
    expect(result.map((m) => m.content)).toEqual(["a", "e"]);
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
    const memories = [
      { content: "a", confidence: 0.9, sensitivity: "none", created_at: 1 },
    ];
    const result = filterMemories(memories, 50);
    expect(result[0]).toEqual({ content: "a", confidence: 0.9, created_at: 1 });
    expect("sensitivity" in result[0]!).toBe(false);
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
    // Verify it parses a string
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

  it("makes non-required properties optional", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: { opt: { type: "string" } },
    });
    // Should accept undefined
    const parsed = shape["opt"]!.safeParse(undefined);
    expect(parsed.success).toBe(true);
  });

  it("returns empty shape for schema with no properties", () => {
    const shape = jsonSchemaToZodShape({ type: "object" });
    expect(Object.keys(shape)).toHaveLength(0);
  });
});
