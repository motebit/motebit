/**
 * Computer-use payload schemas — wire artifacts for `computer-use-v1.md`.
 *
 * Four payload types cover the full computer-use surface: action requests,
 * observation results, session-opened events, session-closed events. Every
 * schema has a `.passthrough()` envelope (v2 emitters adding fields don't
 * break v1 validators), a `_TYPE_PARITY` compile-time assertion against the
 * `@motebit/protocol` type, and a `buildXxxJsonSchema()` emitter called by
 * `scripts/build-schemas.ts` to refresh the committed JSON Schema artifact.
 * See `spec/computer-use-v1.md` §5 for the normative field list.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type {
  ComputerActionRequest,
  ComputerObservationResult,
  ComputerSessionOpened,
  ComputerSessionClosed,
} from "@motebit/protocol";

import { assembleJsonSchemaFor } from "./assemble.js";

const SCHEMA_BASE =
  "https://raw.githubusercontent.com/motebit/motebit/main/packages/wire-schemas/schema";

// ── 5.1 ComputerActionRequest ────────────────────────────────────────

export const COMPUTER_ACTION_REQUEST_SCHEMA_ID = `${SCHEMA_BASE}/computer-action-request-v1.json`;

export const ComputerActionRequestSchema = z
  .object({
    session_id: z.string().min(1).describe("Open session the action belongs to."),
    action: z
      .string()
      .describe(
        "Discriminator. One of: screenshot, cursor_position, click, double_click, mouse_move, drag, type, key, scroll.",
      ),
    x: z.number().int().optional().describe("Target X pixel coordinate."),
    y: z.number().int().optional().describe("Target Y pixel coordinate."),
    x1: z.number().int().optional().describe("Drag-end X. Required when action === 'drag'."),
    y1: z.number().int().optional().describe("Drag-end Y. Required when action === 'drag'."),
    button: z.string().optional().describe('Mouse button. Defaults to "left".'),
    modifiers: z
      .array(z.string())
      .optional()
      .describe('Modifier keys held. Subset of `["cmd", "ctrl", "alt", "shift"]`.'),
    text: z.string().optional().describe("Keyboard text. Required when action === 'type'."),
    key: z
      .string()
      .optional()
      .describe("Key combination. Required when action === 'key'. Example: 'cmd+c'."),
    dx: z.number().int().optional().describe("Scroll wheel delta X."),
    dy: z.number().int().optional().describe("Scroll wheel delta Y."),
  })
  .passthrough();

type InferredAction = z.infer<typeof ComputerActionRequestSchema>;
type _ActionForward = ComputerActionRequest extends InferredAction ? true : never;
type _ActionReverse = InferredAction extends ComputerActionRequest ? true : never;
export const _COMPUTER_ACTION_REQUEST_TYPE_PARITY: {
  forward: _ActionForward;
  reverse: _ActionReverse;
} = {
  forward: true as _ActionForward,
  reverse: true as _ActionReverse,
};

export function buildComputerActionRequestJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(ComputerActionRequestSchema, {
    name: "ComputerActionRequest",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("ComputerActionRequest", raw, {
    $id: COMPUTER_ACTION_REQUEST_SCHEMA_ID,
    title: "ComputerActionRequest (v1)",
    description:
      "One invocation of the `computer` tool — observation or input action. Discriminated by `action`. See spec/computer-use-v1.md §5.1.",
  });
}

// ── 5.2 ComputerObservationResult ────────────────────────────────────

export const COMPUTER_OBSERVATION_RESULT_SCHEMA_ID = `${SCHEMA_BASE}/computer-observation-result-v1.json`;

export const ComputerObservationResultSchema = z
  .object({
    session_id: z.string().min(1).describe("Session the observation belongs to."),
    kind: z.string().describe("Discriminator. 'screenshot' or 'cursor_position'."),
    image_format: z.string().optional().describe("Screenshot only. 'png' or 'jpeg'."),
    image_base64: z.string().optional().describe("Screenshot only. Base64-encoded image bytes."),
    width: z.number().int().nonnegative().optional().describe("Screenshot image width (px)."),
    height: z.number().int().nonnegative().optional().describe("Screenshot image height (px)."),
    x: z.number().int().optional().describe("Cursor-position only. Cursor X."),
    y: z.number().int().optional().describe("Cursor-position only. Cursor Y."),
    captured_at: z.number().int().nonnegative().describe("Unix ms of the capture."),
    redaction_applied: z
      .boolean()
      .describe(
        "True iff the sensitivity classification layer masked one or more regions before these bytes left the OS-access boundary.",
      ),
  })
  .passthrough();

type InferredObservation = z.infer<typeof ComputerObservationResultSchema>;
type _ObservationForward = ComputerObservationResult extends InferredObservation ? true : never;
type _ObservationReverse = InferredObservation extends ComputerObservationResult ? true : never;
export const _COMPUTER_OBSERVATION_RESULT_TYPE_PARITY: {
  forward: _ObservationForward;
  reverse: _ObservationReverse;
} = {
  forward: true as _ObservationForward,
  reverse: true as _ObservationReverse,
};

export function buildComputerObservationResultJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(ComputerObservationResultSchema, {
    name: "ComputerObservationResult",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("ComputerObservationResult", raw, {
    $id: COMPUTER_OBSERVATION_RESULT_SCHEMA_ID,
    title: "ComputerObservationResult (v1)",
    description:
      "Result payload of a computer-use observation action (screenshot or cursor_position). See spec/computer-use-v1.md §5.2.",
  });
}

// ── 5.3 ComputerSessionOpened ────────────────────────────────────────

export const COMPUTER_SESSION_OPENED_SCHEMA_ID = `${SCHEMA_BASE}/computer-session-opened-v1.json`;

export const ComputerSessionOpenedSchema = z
  .object({
    session_id: z.string().min(1).describe("Newly allocated session identifier."),
    motebit_id: z.string().min(1).describe("Identity binding."),
    display_width: z.number().int().positive().describe("Primary display logical width in pixels."),
    display_height: z
      .number()
      .int()
      .positive()
      .describe("Primary display logical height in pixels."),
    scaling_factor: z
      .number()
      .positive()
      .describe("Display scaling factor. Retina = 2.0, HiDPI variable."),
    opened_at: z.number().int().nonnegative().describe("Unix ms."),
  })
  .passthrough();

type InferredOpened = z.infer<typeof ComputerSessionOpenedSchema>;
type _OpenedForward = ComputerSessionOpened extends InferredOpened ? true : never;
type _OpenedReverse = InferredOpened extends ComputerSessionOpened ? true : never;
export const _COMPUTER_SESSION_OPENED_TYPE_PARITY: {
  forward: _OpenedForward;
  reverse: _OpenedReverse;
} = {
  forward: true as _OpenedForward,
  reverse: true as _OpenedReverse,
};

export function buildComputerSessionOpenedJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(ComputerSessionOpenedSchema, {
    name: "ComputerSessionOpened",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("ComputerSessionOpened", raw, {
    $id: COMPUTER_SESSION_OPENED_SCHEMA_ID,
    title: "ComputerSessionOpened (v1)",
    description:
      "Signed event emitted when a computer-use session begins. See spec/computer-use-v1.md §5.3.",
  });
}

// ── 5.4 ComputerSessionClosed ────────────────────────────────────────

export const COMPUTER_SESSION_CLOSED_SCHEMA_ID = `${SCHEMA_BASE}/computer-session-closed-v1.json`;

export const ComputerSessionClosedSchema = z
  .object({
    session_id: z.string().min(1),
    closed_at: z.number().int().nonnegative().describe("Unix ms."),
    reason: z
      .string()
      .optional()
      .describe("Free-text code. Examples: 'user_closed', 'timeout', 'error'."),
  })
  .passthrough();

type InferredClosed = z.infer<typeof ComputerSessionClosedSchema>;
type _ClosedForward = ComputerSessionClosed extends InferredClosed ? true : never;
type _ClosedReverse = InferredClosed extends ComputerSessionClosed ? true : never;
export const _COMPUTER_SESSION_CLOSED_TYPE_PARITY: {
  forward: _ClosedForward;
  reverse: _ClosedReverse;
} = {
  forward: true as _ClosedForward,
  reverse: true as _ClosedReverse,
};

export function buildComputerSessionClosedJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(ComputerSessionClosedSchema, {
    name: "ComputerSessionClosed",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("ComputerSessionClosed", raw, {
    $id: COMPUTER_SESSION_CLOSED_SCHEMA_ID,
    title: "ComputerSessionClosed (v1)",
    description:
      "Signed event emitted when a computer-use session ends. See spec/computer-use-v1.md §5.4.",
  });
}
