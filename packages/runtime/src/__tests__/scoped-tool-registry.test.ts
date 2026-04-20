/**
 * ScopedToolRegistry — predicate-driven filtering of a ToolRegistry.
 */
import { describe, it, expect, vi } from "vitest";
import type { ToolDefinition, ToolRegistry, ToolResult } from "@motebit/sdk";
import { SimpleToolRegistry } from "../index";
import { ScopedToolRegistry } from "../scoped-tool-registry";

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    inputSchema: { type: "object", properties: {} },
  };
}

function makeInner(): ToolRegistry & { size: number } {
  const inner = new SimpleToolRegistry();
  inner.register(makeTool("read_memory"), async () => ({ ok: true, data: "read" }));
  inner.register(makeTool("send_notification"), async () => ({ ok: true, data: "sent" }));
  inner.register(makeTool("delete_file"), async () => ({ ok: true, data: "deleted" }));
  return inner;
}

describe("ScopedToolRegistry", () => {
  it("transparent passthrough when allows always returns true", async () => {
    const inner = makeInner();
    const scoped = new ScopedToolRegistry(inner, { allows: () => true });
    expect(
      scoped
        .list()
        .map((t) => t.name)
        .sort(),
    ).toEqual(["delete_file", "read_memory", "send_notification"]);
    expect(scoped.size).toBe(3);
    const result = await scoped.execute("read_memory", {});
    expect(result.ok).toBe(true);
  });

  it("hides every tool when allows returns false", () => {
    const inner = makeInner();
    const scoped = new ScopedToolRegistry(inner, { allows: () => false });
    expect(scoped.list()).toEqual([]);
    expect(scoped.size).toBe(0);
  });

  it("execute returns scoped error result for disallowed tool, never invokes inner handler", async () => {
    const inner = new SimpleToolRegistry();
    const handler = vi.fn().mockResolvedValue({ ok: true, data: "should not run" } as ToolResult);
    inner.register(makeTool("dangerous"), handler);
    const scoped = new ScopedToolRegistry(inner, { allows: () => false });
    const result = await scoped.execute("dangerous", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("dangerous");
      expect(result.error).toContain("not available");
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("selective allow — only listed tools are visible and executable", async () => {
    const inner = makeInner();
    const allowed = new Set(["read_memory"]);
    const scoped = new ScopedToolRegistry(inner, { allows: (n) => allowed.has(n) });
    expect(scoped.list().map((t) => t.name)).toEqual(["read_memory"]);
    expect(scoped.size).toBe(1);
    const ok = await scoped.execute("read_memory", {});
    expect(ok.ok).toBe(true);
    const denied = await scoped.execute("send_notification", {});
    expect(denied.ok).toBe(false);
  });

  it("predicate is evaluated on every call (live presence state)", () => {
    const inner = makeInner();
    let mode: "responsive" | "tending" = "responsive";
    const scoped = new ScopedToolRegistry(inner, {
      allows: (name) => mode === "responsive" || name === "read_memory",
    });
    expect(scoped.size).toBe(3);
    mode = "tending";
    expect(scoped.size).toBe(1);
    expect(scoped.list().map((t) => t.name)).toEqual(["read_memory"]);
  });

  it("register proxies through to the inner registry, regardless of scope", () => {
    const inner = new SimpleToolRegistry();
    const scoped = new ScopedToolRegistry(inner, { allows: () => false });
    scoped.register(makeTool("freshly_added"), async () => ({ ok: true, data: "new" }));
    // Inner has it, scoped filter still hides it from list().
    expect(inner.list().map((t) => t.name)).toEqual(["freshly_added"]);
    expect(scoped.list()).toEqual([]);
  });

  it("unregister proxies through and returns the inner result", () => {
    const inner = makeInner();
    const scoped = new ScopedToolRegistry(inner, { allows: () => true });
    expect(scoped.unregister("read_memory")).toBe(true);
    expect(scoped.unregister("nonexistent")).toBe(false);
    expect(
      scoped
        .list()
        .map((t) => t.name)
        .sort(),
    ).toEqual(["delete_file", "send_notification"]);
  });

  it("replace proxies through when inner supports it; falls back to register otherwise", async () => {
    const inner = makeInner();
    const scoped = new ScopedToolRegistry(inner, { allows: () => true });
    scoped.replace(makeTool("read_memory"), async () => ({ ok: true, data: "new-handler" }));
    const result = await scoped.execute("read_memory", {});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe("new-handler");
  });
});
