/**
 * `disableInteractiveDelegation` — the OFF half of `enableInteractiveDelegation`.
 *
 * A surface whose user turns the relay off must drop every live relay
 * handle: with delegation still enabled, a chat `delegate_to_agent` /
 * `discover_agents` call (or the result-retrieval read) would keep
 * contacting the relay the user just disconnected. Disable unregisters the
 * relay tools and clears the stored relay coordinates; a later enable (a new
 * relay URL) registers them again against the new relay.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";
import type { PlatformAdapters } from "../index";
import type { StreamingProvider } from "@motebit/ai-core";

const RELAY_TOOLS = ["delegate_to_agent", "discover_agents", "retrieve_task_result"];

function makeRuntime(): MotebitRuntime {
  const provider = {
    model: "mock-model",
    setModel: vi.fn(),
    generate: vi.fn(),
    estimateConfidence: vi.fn(),
    extractMemoryCandidates: vi.fn(),
    // eslint-disable-next-line require-yield
    async *generateStream() {
      return;
    },
  } as unknown as StreamingProvider;
  const adapters: PlatformAdapters = {
    storage: createInMemoryStorage(),
    renderer: new NullRenderer(),
    ai: provider,
  };
  return new MotebitRuntime({ motebitId: "alice-001", tickRateHz: 0 }, adapters);
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("MotebitRuntime.disableInteractiveDelegation", () => {
  it("unregisters the relay tools and clears the relay coordinates", async () => {
    const runtime = makeRuntime();
    runtime.enableInteractiveDelegation({
      syncUrl: "https://relay-a.test",
      authToken: async () => "tok",
    });
    for (const name of RELAY_TOOLS) expect(runtime.getToolRegistry().has(name)).toBe(true);

    runtime.disableInteractiveDelegation();

    for (const name of RELAY_TOOLS) expect(runtime.getToolRegistry().has(name)).toBe(false);
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await runtime.getToolRegistry().execute("delegate_to_agent", { prompt: "hi" });
    await runtime.getToolRegistry().execute("discover_agents", {});
    expect(await runtime.retrieveDelegationResult("task-1")).toEqual({
      status: "not_connected",
      taskId: "task-1",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is a no-op before enable, and a later enable binds the NEW relay", async () => {
    const runtime = makeRuntime();
    expect(() => runtime.disableInteractiveDelegation()).not.toThrow();

    runtime.enableInteractiveDelegation({
      syncUrl: "https://relay-a.test",
      authToken: async () => "tok",
    });
    runtime.disableInteractiveDelegation();
    runtime.enableInteractiveDelegation({
      syncUrl: "https://relay-b.test",
      authToken: async () => "tok",
    });

    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return new Response(JSON.stringify({ agents: [] }), { status: 200 });
    }) as typeof fetch;
    await runtime.getToolRegistry().execute("discover_agents", {});
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.startsWith("https://relay-b.test"))).toBe(true);
  });
});
