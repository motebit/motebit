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
  it("declares the computer tool name; only `action` is required at the AI boundary", () => {
    expect(computerDefinition.name).toBe("computer");
    // session_id is optional at the AI surface — the handler fills it
    // from the runtime's default session. Wire-format
    // ComputerActionRequest still requires session_id on the signed
    // receipt.
    expect(computerDefinition.inputSchema.required).toEqual(["action"]);
  });

  it("exposes action as a discriminated oneOf, one branch per kind", () => {
    const props = computerDefinition.inputSchema.properties as Record<string, unknown>;
    const action = props.action as { oneOf: Array<{ properties: { kind: { enum: string[] } } }> };
    expect(action.oneOf).toBeDefined();
    expect(action.oneOf.length).toBe(9);
    const kinds = action.oneOf.map((v) => v.properties.kind.enum[0]);
    expect(kinds).toEqual([
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
  });

  it("click variant requires target, drag variant requires from+to, type variant requires text", () => {
    const props = computerDefinition.inputSchema.properties as Record<string, unknown>;
    const oneOf = (
      props.action as {
        oneOf: Array<{ properties: { kind: { enum: string[] } }; required: string[] }>;
      }
    ).oneOf;
    const click = oneOf.find((v) => v.properties.kind.enum[0] === "click")!;
    expect(click.required).toEqual(["kind", "target"]);
    const drag = oneOf.find((v) => v.properties.kind.enum[0] === "drag")!;
    expect(drag.required).toEqual(["kind", "from", "to"]);
    const typeAction = oneOf.find((v) => v.properties.kind.enum[0] === "type")!;
    expect(typeAction.required).toEqual(["kind", "text"]);
  });
});

describe("createComputerHandler — absent dispatcher", () => {
  it("returns not_supported when invoked on a surface without OS access", async () => {
    const handler = createComputerHandler();
    const result = await handler({
      session_id: "cs_1",
      action: { kind: "screenshot" },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not supported|requires a desktop/i);
  });
});

describe("createComputerHandler — with dispatcher", () => {
  it("routes execution to the dispatcher and passes through the data", async () => {
    const dispatcher: ComputerDispatcher = {
      execute: vi.fn(async () => ({
        kind: "screenshot",
        session_id: "cs_1",
        artifact_id: "art_1",
        artifact_sha256: "a".repeat(64),
        image_format: "png",
        width: 100,
        height: 50,
        captured_at: 1_777_000_000_000,
        redaction: {
          applied: false,
          projection_kind: "raw",
        },
      })),
    };
    const handler = createComputerHandler({ dispatcher });
    const result = await handler({
      session_id: "cs_1",
      action: { kind: "screenshot" },
    });
    expect(result.ok).toBe(true);
    expect(dispatcher.execute).toHaveBeenCalledWith({
      session_id: "cs_1",
      action: { kind: "screenshot" },
    });
    expect((result.data as { kind: string }).kind).toBe("screenshot");
    expect((result.data as { artifact_id: string }).artifact_id).toBe("art_1");
  });

  it("wraps dispatcher throws as ok:false with the normalized error", async () => {
    const dispatcher: ComputerDispatcher = {
      execute: async () => {
        throw new Error("permission_denied");
      },
    };
    const handler = createComputerHandler({ dispatcher });
    const result = await handler({
      session_id: "cs_1",
      action: { kind: "screenshot" },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("permission_denied");
  });
});
