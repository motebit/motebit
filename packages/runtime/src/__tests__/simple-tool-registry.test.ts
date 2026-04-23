/**
 * Tests for `SimpleToolRegistry` — the inlined minimal registry runtime
 * ships so it doesn't take a value dep on `@motebit/tools`. Parity with
 * that package's `InMemoryToolRegistry` on the mode-tier sort is
 * load-bearing: both registries feed `ContextPack.tools`, and the
 * ordering survives unmutated to the AI. If one sorts and the other
 * doesn't, the structural preference is inconsistent across the
 * surfaces that consume each.
 */
import { describe, it, expect } from "vitest";

import type { ToolDefinition, ToolMode } from "@motebit/sdk";

import { SimpleToolRegistry } from "../simple-tool-registry.js";

function makeTool(name: string, mode?: ToolMode): ToolDefinition {
  return {
    name,
    description: `Test tool ${name}`,
    inputSchema: { type: "object", properties: {} },
    ...(mode !== undefined && { mode }),
  };
}

describe("SimpleToolRegistry — mode-tier sort", () => {
  it("sorts api → ax → pixels → undeclared", () => {
    const reg = new SimpleToolRegistry();
    reg.register(makeTool("p1", "pixels"), async () => ({ ok: true }));
    reg.register(makeTool("u1"), async () => ({ ok: true }));
    reg.register(makeTool("a1", "ax"), async () => ({ ok: true }));
    reg.register(makeTool("api1", "api"), async () => ({ ok: true }));
    expect(reg.list().map((t) => t.name)).toEqual(["api1", "a1", "p1", "u1"]);
  });

  it("preserves registration order within a tier (stable)", () => {
    const reg = new SimpleToolRegistry();
    reg.register(makeTool("api_z", "api"), async () => ({ ok: true }));
    reg.register(makeTool("api_a", "api"), async () => ({ ok: true }));
    reg.register(makeTool("api_m", "api"), async () => ({ ok: true }));
    expect(reg.list().map((t) => t.name)).toEqual(["api_z", "api_a", "api_m"]);
  });

  it("interleaves multiple tiers into contiguous groups", () => {
    const reg = new SimpleToolRegistry();
    reg.register(makeTool("pix_1", "pixels"), async () => ({ ok: true }));
    reg.register(makeTool("api_1", "api"), async () => ({ ok: true }));
    reg.register(makeTool("pix_2", "pixels"), async () => ({ ok: true }));
    reg.register(makeTool("api_2", "api"), async () => ({ ok: true }));
    expect(reg.list().map((t) => t.name)).toEqual(["api_1", "api_2", "pix_1", "pix_2"]);
  });

  it("places tools with no mode at the end", () => {
    const reg = new SimpleToolRegistry();
    reg.register(makeTool("untagged"), async () => ({ ok: true }));
    reg.register(makeTool("api_tool", "api"), async () => ({ ok: true }));
    expect(reg.list().map((t) => t.name)).toEqual(["api_tool", "untagged"]);
  });

  it("empty registry returns empty list", () => {
    const reg = new SimpleToolRegistry();
    expect(reg.list()).toEqual([]);
  });
});
