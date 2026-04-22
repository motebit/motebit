/**
 * Tests for desktop's `registerComputerTool` — AI-boundary tool wiring
 * over the session manager.
 *
 * Exercised paths:
 *   - Successful session open + execute + dispose.
 *   - Explicit session_id supplied by the AI: honored, skips default.
 *   - Invalid / missing action: thrown via handler wrapper.
 *   - Failure path: session open fails (dispatcher not_supported) →
 *     no-active-session error surfaces as ok:false.
 *   - Failure path: session opens but execute returns a failure outcome
 *     → structured reason:message in the thrown error string.
 *   - Concurrent first calls share the in-flight openSession promise.
 */
import { describe, expect, it, vi } from "vitest";

import { SimpleToolRegistry } from "@motebit/runtime";
import { ComputerDispatcherError, type ComputerPlatformDispatcher } from "@motebit/runtime";

import { registerComputerTool } from "../computer-tool.js";
import type { InvokeFn } from "../tauri-storage.js";

function noopInvoke(): InvokeFn {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (async () => {
    throw new Error("invoke should not be called when dispatcher is overridden");
  }) as any;
}

function makeDispatcher(
  overrides?: Partial<ComputerPlatformDispatcher>,
): ComputerPlatformDispatcher {
  return {
    async queryDisplay() {
      return { width: 1920, height: 1080, scaling_factor: 1 };
    },
    async execute() {
      return undefined;
    },
    ...overrides,
  };
}

describe("registerComputerTool — happy path", () => {
  it("opens a default session on first call, executes, and routes through the session manager", async () => {
    const reg = new SimpleToolRegistry();
    const executeSpy = vi.fn(async () => ({ kind: "cursor_position", x: 1, y: 2 }));
    const dispatcher = makeDispatcher({ execute: executeSpy });
    const { sessionManager, dispose } = registerComputerTool(reg, {
      invoke: noopInvoke(),
      motebitId: "mot_test",
      dispatcher,
    });

    const result = await reg.execute("computer", {
      action: { kind: "cursor_position" },
    });
    expect(result.ok).toBe(true);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(sessionManager.activeSessionIds()).toHaveLength(1);
    await dispose();
    expect(sessionManager.activeSessionIds()).toEqual([]);
  });

  it("honors an explicit session_id when the AI supplies one", async () => {
    const reg = new SimpleToolRegistry();
    const dispatcher = makeDispatcher();
    const { sessionManager } = registerComputerTool(reg, {
      invoke: noopInvoke(),
      motebitId: "mot_test",
      dispatcher,
    });
    // Open a second session explicitly.
    const { handle } = await sessionManager.openSession("mot_test");
    const result = await reg.execute("computer", {
      session_id: handle.session_id,
      action: { kind: "screenshot" },
    });
    expect(result.ok).toBe(true);
  });
});

describe("registerComputerTool — failure paths", () => {
  it("throws structured error when args.action is missing", async () => {
    const reg = new SimpleToolRegistry();
    registerComputerTool(reg, {
      invoke: noopInvoke(),
      motebitId: "mot_test",
      dispatcher: makeDispatcher(),
    });
    const result = await reg.execute("computer", {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("missing");
  });

  it("throws structured error when args.action is not an object", async () => {
    const reg = new SimpleToolRegistry();
    registerComputerTool(reg, {
      invoke: noopInvoke(),
      motebitId: "mot_test",
      dispatcher: makeDispatcher(),
    });
    const result = await reg.execute("computer", { action: "not-an-object" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("missing");
  });

  it("surfaces 'no active session' when the dispatcher can't open one", async () => {
    const reg = new SimpleToolRegistry();
    const dispatcher = makeDispatcher({
      async queryDisplay() {
        throw new ComputerDispatcherError("not_supported", "Rust stub");
      },
    });
    registerComputerTool(reg, {
      invoke: noopInvoke(),
      motebitId: "mot_test",
      dispatcher,
    });
    const result = await reg.execute("computer", {
      action: { kind: "screenshot" },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no active session");
  });

  it("surfaces structured reason:message when the session executeAction fails", async () => {
    const reg = new SimpleToolRegistry();
    const dispatcher = makeDispatcher({
      async execute() {
        throw new ComputerDispatcherError("permission_denied", "Screen Recording");
      },
    });
    registerComputerTool(reg, {
      invoke: noopInvoke(),
      motebitId: "mot_test",
      dispatcher,
    });
    const result = await reg.execute("computer", {
      action: { kind: "screenshot" },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("permission_denied");
    expect(result.error).toContain("Screen Recording");
  });

  it("dispose is a no-op when no default session was ever opened", async () => {
    const reg = new SimpleToolRegistry();
    const { dispose } = registerComputerTool(reg, {
      invoke: noopInvoke(),
      motebitId: "mot_test",
      dispatcher: makeDispatcher(),
    });
    // No invocation happened; dispose still resolves.
    await expect(dispose()).resolves.toBeUndefined();
  });
});

describe("registerComputerTool — concurrent first calls", () => {
  it("shares the in-flight openSession promise across parallel tool calls", async () => {
    const reg = new SimpleToolRegistry();
    let queryDisplayCalls = 0;
    const dispatcher = makeDispatcher({
      async queryDisplay() {
        queryDisplayCalls++;
        // Force the second call to race against the first.
        await new Promise((r) => setTimeout(r, 5));
        return { width: 100, height: 100, scaling_factor: 1 };
      },
    });
    registerComputerTool(reg, {
      invoke: noopInvoke(),
      motebitId: "mot_test",
      dispatcher,
    });
    const [a, b] = await Promise.all([
      reg.execute("computer", { action: { kind: "screenshot" } }),
      reg.execute("computer", { action: { kind: "cursor_position" } }),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    // Both calls should have shared a single queryDisplay invocation.
    expect(queryDisplayCalls).toBe(1);
  });
});
