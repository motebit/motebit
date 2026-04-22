/**
 * `computer` tool tests — definition surface + handler dispatch behavior.
 * The Rust-backed dispatcher lives on the desktop surface and is
 * out-of-scope here; the tests below validate the contract the runtime
 * sees regardless of which surface registered the tool.
 */
import { describe, it, expect, vi } from "vitest";

import {
  computerDefinition,
  createComputerHandler,
  type ComputerDispatcher,
} from "../builtins/computer.js";

describe("computerDefinition", () => {
  it("declares the computer tool name and a stable action enum", () => {
    expect(computerDefinition.name).toBe("computer");
    const props = computerDefinition.inputSchema.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    const actionField = props?.action;
    expect(actionField).toBeDefined();
    expect(actionField?.enum).toEqual([
      "screenshot",
      "cursor_position",
      "click",
      "double_click",
      "mouse_move",
      "drag",
      "type",
      "key",
      "scroll",
    ]);
    expect(computerDefinition.inputSchema.required).toEqual(["session_id", "action"]);
  });
});

describe("createComputerHandler — absent dispatcher", () => {
  it("returns not_supported when invoked on a surface without OS access", async () => {
    const handler = createComputerHandler();
    const result = await handler({ session_id: "cs_1", action: "screenshot" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not supported|requires a desktop/i);
  });
});

describe("createComputerHandler — with dispatcher", () => {
  it("routes execution to the dispatcher and passes through the data", async () => {
    const dispatcher: ComputerDispatcher = {
      execute: vi.fn(async () => ({
        session_id: "cs_1",
        kind: "screenshot",
        image_format: "png",
        image_base64: "iVBORw0KGg==",
        width: 100,
        height: 50,
        captured_at: 1_777_000_000_000,
        redaction_applied: false,
      })),
    };
    const handler = createComputerHandler({ dispatcher });
    const result = await handler({ session_id: "cs_1", action: "screenshot" });
    expect(result.ok).toBe(true);
    expect(dispatcher.execute).toHaveBeenCalledWith({
      session_id: "cs_1",
      action: "screenshot",
    });
    expect((result.data as { kind: string }).kind).toBe("screenshot");
  });

  it("wraps dispatcher throws as ok:false with the normalized error", async () => {
    const dispatcher: ComputerDispatcher = {
      execute: async () => {
        throw new Error("permission_denied");
      },
    };
    const handler = createComputerHandler({ dispatcher });
    const result = await handler({ session_id: "cs_1", action: "screenshot" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("permission_denied");
  });
});
