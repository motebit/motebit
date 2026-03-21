import { describe, it, expect } from "vitest";
import { InMemoryToolRegistry } from "../index";
import type { ToolDefinition } from "@motebit/sdk";

function makeTool(name: string, requiresApproval = false): ToolDefinition {
  return {
    name,
    description: `Test tool ${name}`,
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
    requiresApproval,
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
});
