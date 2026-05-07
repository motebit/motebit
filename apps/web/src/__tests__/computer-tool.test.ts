/**
 * Tests for `registerWebComputerTool` — the web-side wiring that
 * registers the `computer` tool with a `CloudBrowserDispatcher`
 * pointing at `services/browser-sandbox`.
 *
 * The wiring is symmetric to `apps/desktop/src/computer-tool.ts`
 * (Tauri dispatcher); the contract differences are:
 *
 *   - Returns `null` when `baseUrl` is empty — explicit-not-configured.
 *   - Uses `CloudBrowserDispatcher` by default; tests override with a
 *     captured mock to avoid hitting the network.
 *
 * Real Playwright integration is exercised inside `services/browser-
 * sandbox`. Here we just prove the wiring contract:
 *
 *   - Registry receives the `computer` tool when configured.
 *   - Registry stays empty when `baseUrl` is empty.
 *   - Tool handler routes through the session manager + the supplied
 *     dispatcher mock.
 *   - Dispose closes the default session and stops the manager.
 */

import { describe, it, expect } from "vitest";
import { InMemoryToolRegistry } from "@motebit/tools/web-safe";
import type { ComputerPlatformDispatcher } from "@motebit/runtime";

import { registerWebComputerTool } from "../computer-tool.js";

interface MockDispatcherCalls {
  queryDisplay: number;
  execute: Array<{ kind: string }>;
  dispose: number;
}

function makeMockDispatcher(): {
  dispatcher: ComputerPlatformDispatcher;
  calls: MockDispatcherCalls;
} {
  const calls: MockDispatcherCalls = { queryDisplay: 0, execute: [], dispose: 0 };
  const dispatcher: ComputerPlatformDispatcher = {
    async queryDisplay() {
      calls.queryDisplay++;
      return { width: 1280, height: 800, scaling_factor: 1 };
    },
    async execute(action) {
      calls.execute.push({ kind: action.kind });
      return { kind: action.kind, ok: true };
    },
    async dispose() {
      calls.dispose++;
    },
  };
  return { dispatcher, calls };
}

describe("registerWebComputerTool", () => {
  it("returns null when baseUrl is empty (tool absent from registry)", () => {
    const registry = new InMemoryToolRegistry();
    const reg = registerWebComputerTool(registry, {
      baseUrl: "",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
    });
    expect(reg).toBeNull();
    expect(registry.list().find((t) => t.name === "computer")).toBeUndefined();
  });

  it("registers the `computer` tool when configured", () => {
    const registry = new InMemoryToolRegistry();
    const { dispatcher } = makeMockDispatcher();
    const reg = registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
    });
    expect(reg).not.toBeNull();
    expect(registry.has("computer")).toBe(true);
  });

  it("routes the AI-visible action through the session manager + dispatcher", async () => {
    const registry = new InMemoryToolRegistry();
    const { dispatcher, calls } = makeMockDispatcher();
    const reg = registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
    });

    const result = await registry.execute("computer", { action: { kind: "screenshot" } });
    expect(result.ok).toBe(true);
    // queryDisplay fires on the first execute (lazy session open),
    // then the action is dispatched.
    expect(calls.queryDisplay).toBe(1);
    expect(calls.execute).toEqual([{ kind: "screenshot" }]);

    // Subsequent action reuses the open session — no second queryDisplay.
    await registry.execute("computer", { action: { kind: "cursor_position" } });
    expect(calls.queryDisplay).toBe(1);
    expect(calls.execute).toEqual([{ kind: "screenshot" }, { kind: "cursor_position" }]);

    await reg!.dispose();
    expect(calls.dispose).toBe(1);
  });

  it("rejects with structured failure when no `action` argument supplied", async () => {
    const registry = new InMemoryToolRegistry();
    const { dispatcher } = makeMockDispatcher();
    registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
    });

    const result = await registry.execute("computer", {});
    expect(result.ok).toBe(false);
    expect(typeof (result as { error: unknown }).error).toBe("string");
  });

  it("dispose is idempotent (subsequent calls are no-ops)", async () => {
    const registry = new InMemoryToolRegistry();
    const { dispatcher, calls } = makeMockDispatcher();
    const reg = registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
    });
    // Open the default session
    await registry.execute("computer", { action: { kind: "screenshot" } });
    await reg!.dispose();
    await reg!.dispose();
    expect(calls.dispose).toBe(1);
  });
});
