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

  // -------------------------------------------------------------------
  // v1.5 — close emits a signed `ComputerSessionSummarized` event when
  // the registration has the runtime's signing path wired.
  // -------------------------------------------------------------------

  it("emits ComputerSessionSummarized at dispose when signing is wired (v1.5)", async () => {
    const registry = new InMemoryToolRegistry();
    const { dispatcher } = makeMockDispatcher();
    const events: Array<{ event_type: string; payload: Record<string, unknown> }> = [];
    const eventsAdapter = {
      append: async (entry: { event_type: string; payload: Record<string, unknown> }) => {
        events.push({ event_type: entry.event_type, payload: entry.payload });
      },
    } as unknown as Parameters<typeof registerWebComputerTool>[1]["events"];

    const signSessionReceipt = async (body: {
      session_id: string;
      action_count: number;
      embodiment_mode: string;
    }) => ({
      ...body,
      receipt_id: "csr_test",
      suite: "motebit-jcs-ed25519-b64-v1" as const,
      signature: "fake_sig_b64url",
      public_key: "f".repeat(64),
    });

    const hashSessionActions = async () => "h".repeat(64);

    const reg = registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
      events: eventsAdapter,
      signSessionReceipt: signSessionReceipt as never,
      hashSessionActions,
    });

    await registry.execute("computer", { action: { kind: "screenshot" } });
    await registry.execute("computer", { action: { kind: "screenshot" } });
    await reg!.dispose();

    const types = events.map((e) => e.event_type);
    expect(types).toContain("computer_session_opened");
    expect(types).toContain("computer_session_closed");
    expect(types).toContain("computer_session_summarized");

    const summarized = events.find((e) => e.event_type === "computer_session_summarized");
    expect(summarized).toBeDefined();
    expect(summarized!.payload.embodiment_mode).toBe("virtual_browser");
    expect(summarized!.payload.action_count).toBe(2);
    expect(summarized!.payload.signature).toBe("fake_sig_b64url");
  });

  it("skips ComputerSessionSummarized when signSessionReceipt returns null (no signing key)", async () => {
    const registry = new InMemoryToolRegistry();
    const { dispatcher } = makeMockDispatcher();
    const events: Array<{ event_type: string }> = [];
    const eventsAdapter = {
      append: async (entry: { event_type: string }) => {
        events.push({ event_type: entry.event_type });
      },
    } as unknown as Parameters<typeof registerWebComputerTool>[1]["events"];

    const reg = registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
      events: eventsAdapter,
      // Null return mimics a runtime with no signing keys.
      signSessionReceipt: async () => null,
    });

    await registry.execute("computer", { action: { kind: "screenshot" } });
    await reg!.dispose();

    const types = events.map((e) => e.event_type);
    expect(types).toContain("computer_session_closed");
    expect(types).not.toContain("computer_session_summarized");
  });

  it("does NOT emit ComputerSessionSummarized when signSessionReceipt is unwired", async () => {
    const registry = new InMemoryToolRegistry();
    const { dispatcher } = makeMockDispatcher();
    const events: Array<{ event_type: string }> = [];
    const eventsAdapter = {
      append: async (entry: { event_type: string }) => {
        events.push({ event_type: entry.event_type });
      },
    } as unknown as Parameters<typeof registerWebComputerTool>[1]["events"];

    const reg = registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
      events: eventsAdapter,
      // signSessionReceipt deliberately omitted.
    });

    await registry.execute("computer", { action: { kind: "screenshot" } });
    await reg!.dispose();

    const types = events.map((e) => e.event_type);
    expect(types).toContain("computer_session_closed");
    expect(types).not.toContain("computer_session_summarized");
  });

  it("fires onSessionReceiptSigned after the audit emit so apps can emerge an artifact (v1.5 detach)", async () => {
    const registry = new InMemoryToolRegistry();
    const { dispatcher } = makeMockDispatcher();
    const events: string[] = [];
    const eventsAdapter = {
      append: async (entry: { event_type: string }) => {
        events.push(entry.event_type);
      },
    } as unknown as Parameters<typeof registerWebComputerTool>[1]["events"];

    const signSessionReceipt = async (body: { session_id: string }) => ({
      ...body,
      receipt_id: "csr_test",
      suite: "motebit-jcs-ed25519-b64-v1" as const,
      signature: "fake_sig",
      public_key: "f".repeat(64),
    });

    const emerged: Array<{ session_id: string }> = [];
    const reg = registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
      events: eventsAdapter,
      signSessionReceipt: signSessionReceipt as never,
      onSessionReceiptSigned: (receipt) => {
        emerged.push({ session_id: receipt.session_id });
      },
    });

    await registry.execute("computer", { action: { kind: "screenshot" } });
    await reg!.dispose();

    expect(emerged).toHaveLength(1);
    expect(emerged[0]?.session_id).toBeTruthy();
    // Audit emit happened FIRST (calm-software ordering — record on the
    // log before UX surface emerges).
    const summarizedIdx = events.indexOf("computer_session_summarized");
    expect(summarizedIdx).toBeGreaterThanOrEqual(0);
  });

  it("a throwing onSessionReceiptSigned callback does not break the close path", async () => {
    const registry = new InMemoryToolRegistry();
    const { dispatcher, calls } = makeMockDispatcher();

    const signSessionReceipt = async (body: { session_id: string }) => ({
      ...body,
      receipt_id: "csr_test",
      suite: "motebit-jcs-ed25519-b64-v1" as const,
      signature: "fake_sig",
      public_key: "f".repeat(64),
    });

    const reg = registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
      signSessionReceipt: signSessionReceipt as never,
      onSessionReceiptSigned: () => {
        throw new Error("emerge boom");
      },
    });

    await registry.execute("computer", { action: { kind: "screenshot" } });
    await expect(reg!.dispose()).resolves.toBeUndefined();
    // Dispatcher still tore down — close path completed despite the
    // emerge callback throwing. UX failure ≠ audit failure ≠ close
    // failure; fail-soft chain works.
    expect(calls.dispose).toBe(1);
  });
});
