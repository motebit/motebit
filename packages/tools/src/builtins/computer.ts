/**
 * `computer` — the motebit's primitive for observing and acting on the
 * user's operating system. Screen capture, cursor read, mouse/keyboard
 * injection, scroll. One tool with a discriminated `action` field per the
 * `spec/computer-use-v1.md` wire format.
 *
 * Today this handler is a structured stub: every call returns a typed
 * "not_supported" error until the desktop Tauri bridge (Rust screen-capture
 * + input injection + OS accessibility APIs) lands. The tool definition
 * and wire-format parity are finalized so the Rust backend can drop in
 * behind a stable contract without touching any of the signed-receipt,
 * governance, or UI wiring.
 *
 * Surface support (per `docs/doctrine/workstation-viewport.md` §Per-surface
 * map): only the desktop surface registers this tool. Web / mobile /
 * spatial sandboxes cannot reach the OS and omit `computer` from their
 * tool registry entirely — the AI model's advertised tool list on those
 * surfaces does not include it.
 */

import type { ToolDefinition, ToolHandler } from "@motebit/sdk";

/**
 * Structured error reason returned when the tool is invoked on a surface
 * that cannot fulfill it, or when a specific action precondition fails.
 * String union for wire stability; extend via v2 spec revision.
 */
export type ComputerUnsupportedReason =
  | "not_supported"
  | "permission_denied"
  | "session_closed"
  | "policy_denied"
  | "not_implemented";

export const computerDefinition: ToolDefinition = {
  name: "computer",
  description:
    "Observe or act on the user's computer — screenshot, click, type, scroll. Only available on the desktop surface; other surfaces do not expose this tool. Every observation and action emits a signed receipt and flows through the governance gate. See spec/computer-use-v1.md.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "Open computer-use session identifier.",
      },
      action: {
        type: "string",
        enum: [
          "screenshot",
          "cursor_position",
          "click",
          "double_click",
          "mouse_move",
          "drag",
          "type",
          "key",
          "scroll",
        ],
        description:
          "Discriminator. Observation: screenshot, cursor_position. Input: click, double_click, mouse_move, drag, type, key, scroll.",
      },
      x: { type: "number", description: "Target X pixel (primary display coords)." },
      y: { type: "number", description: "Target Y pixel." },
      x1: { type: "number", description: "Drag-end X. Required when action === 'drag'." },
      y1: { type: "number", description: "Drag-end Y." },
      button: {
        type: "string",
        enum: ["left", "right", "middle"],
        description: "Mouse button. Defaults to 'left'.",
      },
      modifiers: {
        type: "array",
        items: { type: "string", enum: ["cmd", "ctrl", "alt", "shift"] },
        description: "Modifier keys held during the action.",
      },
      text: { type: "string", description: "Keyboard text. Required when action === 'type'." },
      key: {
        type: "string",
        description: "Key combination. Example: 'cmd+c', 'escape'. Required when action === 'key'.",
      },
      dx: { type: "number", description: "Scroll wheel delta X." },
      dy: { type: "number", description: "Scroll wheel delta Y." },
    },
    required: ["session_id", "action"],
  },
};

/**
 * Dispatcher invoked by the tool runtime to actually execute an action on
 * the OS. Implemented by the desktop surface's Tauri bridge; absent on
 * sandboxed surfaces. The return value parallels the `data` field of a
 * successful `ToolResult` — observation actions return
 * `ComputerObservationResult`-shaped payloads, input actions return
 * `{ ok: true }` on success. The handler produced by
 * `createComputerHandler` wraps the dispatcher with argument parsing and
 * error normalization.
 */
export interface ComputerDispatcher {
  execute(request: unknown): Promise<unknown>;
}

export interface ComputerHandlerOptions {
  /**
   * When omitted, the handler returns `{ ok: false, error: "not_supported" }`
   * on every call — the correct behavior on surfaces that do not implement
   * computer use. The desktop surface supplies a dispatcher backed by the
   * Tauri Rust bridge.
   */
  dispatcher?: ComputerDispatcher;
}

/**
 * Build the `computer` tool handler. Surfaces that cannot reach the OS
 * should NOT register this tool at all (per the doctrine — AI model's
 * advertised tool list reflects capability). Surfaces that CAN reach the
 * OS pass a `dispatcher` backed by their platform bridge.
 *
 * When `dispatcher` is absent, the handler responds with a structured
 * `not_supported` error so an accidentally-registered call on the wrong
 * surface fails loud instead of producing garbage — useful for
 * development-time assertions.
 */
export function createComputerHandler(opts?: ComputerHandlerOptions): ToolHandler {
  const dispatcher = opts?.dispatcher;

  return async (args) => {
    if (!dispatcher) {
      return {
        ok: false,
        error:
          "computer use is not supported on this surface — requires a desktop build with OS screen + input access",
      };
    }
    try {
      const data = await dispatcher.execute(args);
      return { ok: true, data };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `computer: ${msg}` };
    }
  };
}
