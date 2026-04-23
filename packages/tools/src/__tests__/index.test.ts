import { describe, it, expect } from "vitest";
import { InMemoryToolRegistry } from "../index";
import type { ToolDefinition, ToolMode } from "@motebit/sdk";

function makeTool(name: string, requiresApproval = false, mode?: ToolMode): ToolDefinition {
  return {
    name,
    description: `Test tool ${name}`,
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
    requiresApproval,
    ...(mode !== undefined && { mode }),
  };
}

describe("InMemoryToolRegistry", () => {
  it("registers and lists tools", () => {
    const reg = new InMemoryToolRegistry();
    reg.register(makeTool("a"), async () => ({ ok: true }));
    reg.register(makeTool("b"), async () => ({ ok: true }));

    const tools = reg.list();
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name)).toEqual(["a", "b"]);
  });

  it("rejects duplicate registration", () => {
    const reg = new InMemoryToolRegistry();
    reg.register(makeTool("a"), async () => ({ ok: true }));
    expect(() => reg.register(makeTool("a"), async () => ({ ok: true }))).toThrow(
      'Tool "a" is already registered',
    );
  });

  it("executes a tool and returns result", async () => {
    const reg = new InMemoryToolRegistry();
    reg.register(makeTool("echo"), async (args) => ({
      ok: true,
      data: args.q,
    }));

    const result = await reg.execute("echo", { q: "hello" });
    expect(result.ok).toBe(true);
    expect(result.data).toBe("hello");
  });

  it("returns error for unknown tool", async () => {
    const reg = new InMemoryToolRegistry();
    const result = await reg.execute("nonexistent", {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unknown tool");
  });

  it("catches handler exceptions", async () => {
    const reg = new InMemoryToolRegistry();
    reg.register(makeTool("fail"), async () => {
      throw new Error("boom");
    });

    const result = await reg.execute("fail", {});
    expect(result.ok).toBe(false);
    expect(result.error).toBe("boom");
  });

  it("has() and get() work correctly", () => {
    const reg = new InMemoryToolRegistry();
    const tool = makeTool("search");
    reg.register(tool, async () => ({ ok: true }));

    expect(reg.has("search")).toBe(true);
    expect(reg.has("other")).toBe(false);
    expect(reg.get("search")?.name).toBe("search");
    expect(reg.get("other")).toBeUndefined();
  });

  it("merge() combines registries", async () => {
    const reg1 = new InMemoryToolRegistry();
    reg1.register(makeTool("a"), async () => ({ ok: true, data: "from-reg1" }));

    const reg2 = new InMemoryToolRegistry();
    reg2.register(makeTool("b"), async () => ({ ok: true, data: "from-reg2" }));

    reg1.merge(reg2);
    expect(reg1.size).toBe(2);

    const result = await reg1.execute("b", {});
    expect(result.ok).toBe(true);
    expect(result.data).toBe("from-reg2");
  });

  it("merge() does not overwrite existing tools", async () => {
    const reg1 = new InMemoryToolRegistry();
    reg1.register(makeTool("a"), async () => ({ ok: true, data: "original" }));

    const reg2 = new InMemoryToolRegistry();
    reg2.register(makeTool("a"), async () => ({ ok: true, data: "duplicate" }));

    reg1.merge(reg2);
    const result = await reg1.execute("a", {});
    expect(result.data).toBe("original");
  });

  it("tracks size correctly", () => {
    const reg = new InMemoryToolRegistry();
    expect(reg.size).toBe(0);
    reg.register(makeTool("a"), async () => ({ ok: true }));
    expect(reg.size).toBe(1);
  });

  it("preserves requiresApproval flag", () => {
    const reg = new InMemoryToolRegistry();
    reg.register(makeTool("safe", false), async () => ({ ok: true }));
    reg.register(makeTool("dangerous", true), async () => ({ ok: true }));

    expect(reg.get("safe")?.requiresApproval).toBe(false);
    expect(reg.get("dangerous")?.requiresApproval).toBe(true);
  });

  it("replace() overwrites existing handler", async () => {
    const reg = new InMemoryToolRegistry();
    reg.register(makeTool("a"), async () => ({ ok: true, data: "original" }));

    reg.replace(makeTool("a"), async () => ({ ok: true, data: "replaced" }));
    const result = await reg.execute("a", {});
    expect(result.data).toBe("replaced");
  });

  it("replace() registers new tool if not present", async () => {
    const reg = new InMemoryToolRegistry();
    reg.replace(makeTool("new"), async () => ({ ok: true, data: "fresh" }));

    expect(reg.has("new")).toBe(true);
    const result = await reg.execute("new", {});
    expect(result.data).toBe("fresh");
  });

  it("unregister() removes an existing tool", () => {
    const reg = new InMemoryToolRegistry();
    reg.register(makeTool("removable"), async () => ({ ok: true }));
    expect(reg.has("removable")).toBe(true);

    const removed = reg.unregister("removable");
    expect(removed).toBe(true);
    expect(reg.has("removable")).toBe(false);
    expect(reg.size).toBe(0);
  });

  it("unregister() returns false for non-existent tool", () => {
    const reg = new InMemoryToolRegistry();
    const removed = reg.unregister("nonexistent");
    expect(removed).toBe(false);
  });
});

describe("InMemoryToolRegistry — mode-tier sort", () => {
  it("sorts api → ax → pixels → undeclared", () => {
    const reg = new InMemoryToolRegistry();
    // Register intentionally out of tier order so the sort is load-bearing.
    reg.register(makeTool("p1", false, "pixels"), async () => ({ ok: true }));
    reg.register(makeTool("u1", false), async () => ({ ok: true }));
    reg.register(makeTool("a1", false, "ax"), async () => ({ ok: true }));
    reg.register(makeTool("api1", false, "api"), async () => ({ ok: true }));
    const names = reg.list().map((t) => t.name);
    expect(names).toEqual(["api1", "a1", "p1", "u1"]);
  });

  it("preserves registration order within a tier (stable sort)", () => {
    const reg = new InMemoryToolRegistry();
    reg.register(makeTool("api_z", false, "api"), async () => ({ ok: true }));
    reg.register(makeTool("api_a", false, "api"), async () => ({ ok: true }));
    reg.register(makeTool("api_m", false, "api"), async () => ({ ok: true }));
    expect(reg.list().map((t) => t.name)).toEqual(["api_z", "api_a", "api_m"]);
  });

  it("groups multiple tools per tier contiguously", () => {
    const reg = new InMemoryToolRegistry();
    reg.register(makeTool("pix_1", false, "pixels"), async () => ({ ok: true }));
    reg.register(makeTool("api_1", false, "api"), async () => ({ ok: true }));
    reg.register(makeTool("pix_2", false, "pixels"), async () => ({ ok: true }));
    reg.register(makeTool("api_2", false, "api"), async () => ({ ok: true }));
    expect(reg.list().map((t) => t.name)).toEqual(["api_1", "api_2", "pix_1", "pix_2"]);
  });

  it("places tools with no mode at the end", () => {
    const reg = new InMemoryToolRegistry();
    reg.register(makeTool("untagged"), async () => ({ ok: true }));
    reg.register(makeTool("api_tool", false, "api"), async () => ({ ok: true }));
    expect(reg.list().map((t) => t.name)).toEqual(["api_tool", "untagged"]);
  });
});
