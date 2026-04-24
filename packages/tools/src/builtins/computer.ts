/**
 * `computer` — the motebit's primitive for observing and acting on the
 * user's operating system. Screen capture, cursor read, mouse/keyboard
 * injection, scroll. One tool; the `action` argument is a nested
 * discriminated variant per the `spec/computer-use-v1.md` wire format.
 *
 * Today this handler is a structured stub: every call returns a typed
 * failure reason until the desktop Tauri bridge (Rust screen-capture +
 * input injection + OS accessibility APIs) lands. The tool definition and
 * wire-format parity are finalized so the Rust backend can drop in behind
 * a stable contract without touching any of the signed-receipt,
 * governance, or UI wiring.
 *
 * Surface support (`docs/doctrine/motebit-computer.md` § "Embodiment
 * modes"): the `desktop_drive` mode registers this tool on desktop with a
 * real dispatcher. Web / mobile / spatial sandboxes cannot reach the OS;
 * those surfaces reach the user's world via `virtual_browser` / `shared_gaze`
 * (cloud-hosted) when those modes ship. They MUST NOT include `computer` in
 * the AI model's advertised tool list at all, and the handler here is a
 * defense-in-depth fallback.
 */

import type { ToolDefinition, ToolHandler } from "@motebit/sdk";

/**
 * Structured failure reasons returned when the tool cannot execute an
 * action. Every implementation MUST emit one of these values so the
 * motebit's reasoning loop and the governance audit can discriminate cases
 * deterministically. Mirrors `ComputerFailureReason` in @motebit/protocol.
 */
export type ComputerFailureReason =
  | "policy_denied"
  | "approval_required"
  | "approval_expired"
  | "permission_denied"
  | "session_closed"
  | "target_not_found"
  | "target_obscured"
  | "user_preempted"
  | "platform_blocked"
  | "not_supported";

// ── JSON Schema for the tool args ────────────────────────────────────
//
// Nested discriminated union via oneOf. Modern AI models (Claude 4.x,
// GPT-5.x) generate structured tool calls against oneOf schemas reliably.
// Exhaustive per-variant fields mean the model can't produce impossible
// combinations (e.g. `drag` without `to`, `type` without `text`).

const POINT_SCHEMA = {
  type: "object",
  properties: {
    x: { type: "integer", description: "Logical pixel X." },
    y: { type: "integer", description: "Logical pixel Y." },
  },
  required: ["x", "y"],
  additionalProperties: false,
};

const TARGET_HINT_SCHEMA = {
  type: "object",
  properties: {
    role: { type: "string", description: "Accessibility role. Examples: 'button', 'link'." },
    label: { type: "string", description: "Accessible label or visible text." },
    source: {
      type: "string",
      description: "Source: 'accessibility', 'dom', 'vision', 'user_annotation'.",
    },
  },
  required: ["source"],
  additionalProperties: true,
};

const MODIFIERS_SCHEMA = {
  type: "array",
  items: { type: "string", enum: ["cmd", "ctrl", "alt", "shift"] },
  description: "Modifier keys held during the action.",
};

export const computerDefinition: ToolDefinition = {
  name: "computer",
  mode: "pixels",
  description:
    "Observe or act on the user's computer — screenshot, click, type, scroll. Only available on the desktop surface; other surfaces do not expose this tool. Every observation and action emits a signed receipt and flows through the governance gate. See spec/computer-use-v1.md.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description:
          "Open computer-use session identifier. Optional — if omitted, the runtime's default session for this motebit is used.",
      },
      action: {
        description: "Action to perform. Must be a discriminated variant with a `kind` field.",
        oneOf: [
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["screenshot"] },
            },
            required: ["kind"],
            additionalProperties: false,
            description: "Capture the primary display's current frame.",
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["cursor_position"] },
            },
            required: ["kind"],
            additionalProperties: false,
            description: "Read the current cursor coordinates.",
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["click"] },
              target: POINT_SCHEMA,
              button: { type: "string", enum: ["left", "right", "middle"] },
              modifiers: MODIFIERS_SCHEMA,
              target_hint: TARGET_HINT_SCHEMA,
            },
            required: ["kind", "target"],
            additionalProperties: false,
            description: "Single mouse click at `target`.",
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["double_click"] },
              target: POINT_SCHEMA,
              button: { type: "string", enum: ["left", "right", "middle"] },
              modifiers: MODIFIERS_SCHEMA,
              target_hint: TARGET_HINT_SCHEMA,
            },
            required: ["kind", "target"],
            additionalProperties: false,
            description: "Double click at `target`.",
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["mouse_move"] },
              target: POINT_SCHEMA,
              target_hint: TARGET_HINT_SCHEMA,
            },
            required: ["kind", "target"],
            additionalProperties: false,
            description: "Move cursor to `target` without clicking.",
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["drag"] },
              from: POINT_SCHEMA,
              to: POINT_SCHEMA,
              button: { type: "string", enum: ["left", "right", "middle"] },
              modifiers: MODIFIERS_SCHEMA,
              duration_ms: { type: "integer", minimum: 0 },
              target_hint: TARGET_HINT_SCHEMA,
            },
            required: ["kind", "from", "to"],
            additionalProperties: false,
            description: "Press at `from`, move to `to`, release.",
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["type"] },
              text: { type: "string", description: "Text to type." },
              per_char_delay_ms: { type: "integer", minimum: 0 },
            },
            required: ["kind", "text"],
            additionalProperties: false,
            description: "Keyboard text input.",
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["key"] },
              key: {
                type: "string",
                description: "Key combination. Example: 'cmd+c', 'escape'.",
              },
            },
            required: ["kind", "key"],
            additionalProperties: false,
            description: "Keyboard combination.",
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["scroll"] },
              target: POINT_SCHEMA,
              dx: { type: "integer", description: "Scroll wheel delta X." },
              dy: { type: "integer", description: "Scroll wheel delta Y." },
            },
            required: ["kind", "target", "dx", "dy"],
            additionalProperties: false,
            description: "Scroll at `target` by `(dx, dy)` wheel deltas.",
          },
        ],
      },
    },
    required: ["action"],
  },
};

/**
 * Dispatcher invoked by the tool runtime to actually execute an action on
 * the OS. Implemented by the desktop surface's Tauri bridge; absent on
 * sandboxed surfaces. Return value parallels the `data` field of a
 * successful `ToolResult` — observation actions return
 * `ComputerObservationResult`-shaped payloads, input actions return
 * `{ ok: true }` on success.
 */
export interface ComputerDispatcher {
  execute(request: unknown): Promise<unknown>;
}

export interface ComputerHandlerOptions {
  /**
   * When omitted, the handler returns `{ ok: false, error, reason:
   * "not_supported" }` on every call — the correct behavior on surfaces
   * that do not implement computer use. The desktop surface supplies a
   * dispatcher backed by the Tauri Rust bridge.
   */
  dispatcher?: ComputerDispatcher;
}

/**
 * Build the `computer` tool handler. Surfaces that cannot reach the OS
 * should NOT register this tool at all (per the doctrine). Surfaces that
 * CAN reach the OS pass a `dispatcher` backed by their platform bridge.
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
