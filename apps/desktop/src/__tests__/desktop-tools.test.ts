import { describe, it, expect, vi } from "vitest";
import { SimpleToolRegistry } from "@motebit/runtime";

// Stub embedText so tests don't hit ONNX
vi.mock("@motebit/memory-graph", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    embedText: vi.fn(async (_text: string) => new Float32Array([0.1, 0.2, 0.3])),
  };
});

import { registerDesktopTools } from "../desktop-tools";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeRuntime(overrides: Record<string, unknown> = {}): any {
  return {
    motebitId: "motebit-1",
    memory: {
      retrieve: vi.fn(async () => [
        { content: "memory 1", confidence: 0.8 },
        { content: "memory 2", confidence: 0.6 },
      ]),
    },
    events: {
      query: vi.fn(async () => [
        { event_type: "message", timestamp: 100, payload: { text: "hi" } },
      ]),
    },
    reflect: vi.fn(async () => ({
      selfAssessment: "doing fine",
      insights: [],
      planAdjustments: [],
      patterns: [],
    })),
    ...overrides,
  };
}

describe("registerDesktopTools", () => {
  it("registers browser-safe tools without invoke", () => {
    const registry = new SimpleToolRegistry();
    const runtime = makeRuntime();
    registerDesktopTools(registry, runtime);
    const names = registry.list().map((t) => t.name);
    expect(names).toContain("web_search");
    expect(names).toContain("read_url");
    expect(names).toContain("recall_memories");
    expect(names).toContain("list_events");
    expect(names).toContain("self_reflect");
    expect(names).not.toContain("read_file");
  });

  it("registers Tauri-privileged tools when invoke is provided", () => {
    const registry = new SimpleToolRegistry();
    const runtime = makeRuntime();
    const invoke = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerDesktopTools(registry, runtime, invoke as any);
    const names = registry.list().map((t) => t.name);
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
    expect(names).toContain("shell_exec");
  });

  it("recall_memories handler calls runtime.memory.retrieve", async () => {
    const registry = new SimpleToolRegistry();
    const runtime = makeRuntime();
    registerDesktopTools(registry, runtime);
    const result = await registry.execute("recall_memories", { query: "q", limit: 5 });
    expect(runtime.memory.retrieve).toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it("list_events handler filters by event_type", async () => {
    const registry = new SimpleToolRegistry();
    const runtime = makeRuntime();
    registerDesktopTools(registry, runtime);
    const result = await registry.execute("list_events", { limit: 10, event_type: "message" });
    expect(runtime.events.query).toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it("list_events handler without event_type", async () => {
    const registry = new SimpleToolRegistry();
    const runtime = makeRuntime();
    registerDesktopTools(registry, runtime);
    const result = await registry.execute("list_events", { limit: 10 });
    expect(runtime.events.query).toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it("self_reflect handler calls runtime.reflect", async () => {
    const registry = new SimpleToolRegistry();
    const runtime = makeRuntime();
    registerDesktopTools(registry, runtime);
    const result = await registry.execute("self_reflect", {});
    expect(runtime.reflect).toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });
});
