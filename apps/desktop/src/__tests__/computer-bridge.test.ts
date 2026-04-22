/**
 * Tests for the Tauri → ComputerPlatformDispatcher bridge.
 *
 * Exercises every path in `createTauriComputerDispatcher`:
 *   - queryDisplay: success (raw invoke result forwarded).
 *   - queryDisplay: invoke reject with FailureEnvelope → typed error.
 *   - execute: success (data forwarded).
 *   - execute: FailureEnvelope with known reason → preserved.
 *   - execute: FailureEnvelope with unknown reason → defaults to platform_blocked.
 *   - execute: generic Error throw → platform_blocked with message.
 *   - execute: non-Error non-envelope throw → platform_blocked with stringified.
 */
import { describe, expect, it } from "vitest";

import { ComputerDispatcherError } from "@motebit/runtime";

import { createTauriComputerDispatcher } from "../computer-bridge.js";
import type { InvokeFn } from "../tauri-storage.js";

function makeInvoke(
  impl: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
): InvokeFn {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return impl as any;
}

describe("createTauriComputerDispatcher — queryDisplay", () => {
  it("forwards the Rust DisplayInfo on success", async () => {
    const invoke = makeInvoke(async (cmd) => {
      expect(cmd).toBe("computer_query_display");
      return { width: 2560, height: 1440, scaling_factor: 2 };
    });
    const d = createTauriComputerDispatcher(invoke);
    const display = await d.queryDisplay();
    expect(display).toEqual({ width: 2560, height: 1440, scaling_factor: 2 });
  });

  it("unwraps FailureEnvelope rejections into ComputerDispatcherError", async () => {
    const invoke = makeInvoke(async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- mimic Tauri reject shape
      throw { reason: "permission_denied", message: "No Screen Recording" };
    });
    const d = createTauriComputerDispatcher(invoke);
    try {
      await d.queryDisplay();
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ComputerDispatcherError);
      if (err instanceof ComputerDispatcherError) {
        expect(err.reason).toBe("permission_denied");
        expect(err.message).toContain("No Screen Recording");
      }
    }
  });
});

describe("createTauriComputerDispatcher — execute", () => {
  it("forwards the action to Rust and returns the result", async () => {
    const invoke = makeInvoke(async (cmd, args) => {
      expect(cmd).toBe("computer_execute");
      expect(args?.action).toEqual({ kind: "cursor_position" });
      return { kind: "cursor_position", x: 100, y: 200 };
    });
    const d = createTauriComputerDispatcher(invoke);
    const result = await d.execute({ kind: "cursor_position" });
    expect(result).toEqual({ kind: "cursor_position", x: 100, y: 200 });
  });

  it("preserves a known failure reason from the envelope", async () => {
    const invoke = makeInvoke(async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- mimic Tauri reject shape
      throw { reason: "target_not_found", message: "no element at (512, 384)" };
    });
    const d = createTauriComputerDispatcher(invoke);
    try {
      await d.execute({ kind: "click", target: { x: 512, y: 384 } });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ComputerDispatcherError);
      if (err instanceof ComputerDispatcherError) {
        expect(err.reason).toBe("target_not_found");
      }
    }
  });

  it("defaults unknown envelope reasons to platform_blocked", async () => {
    const invoke = makeInvoke(async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- mimic Tauri reject shape with invalid reason
      throw { reason: "garbage_not_in_enum", message: "whatever" };
    });
    const d = createTauriComputerDispatcher(invoke);
    try {
      await d.execute({ kind: "screenshot" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ComputerDispatcherError);
      if (err instanceof ComputerDispatcherError) {
        expect(err.reason).toBe("platform_blocked");
        expect(err.message).toBe("whatever");
      }
    }
  });

  it("generic Error reject maps to platform_blocked with message", async () => {
    const invoke = makeInvoke(async () => {
      throw new Error("ipc channel died");
    });
    const d = createTauriComputerDispatcher(invoke);
    try {
      await d.execute({ kind: "screenshot" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ComputerDispatcherError);
      if (err instanceof ComputerDispatcherError) {
        expect(err.reason).toBe("platform_blocked");
        expect(err.message).toContain("ipc channel died");
      }
    }
  });

  it("non-Error, non-envelope reject maps to platform_blocked with stringified", async () => {
    const invoke = makeInvoke(async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- testing non-Error reject path
      throw 42;
    });
    const d = createTauriComputerDispatcher(invoke);
    try {
      await d.execute({ kind: "screenshot" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ComputerDispatcherError);
      if (err instanceof ComputerDispatcherError) {
        expect(err.reason).toBe("platform_blocked");
        expect(err.message).toBe("42");
      }
    }
  });
});
