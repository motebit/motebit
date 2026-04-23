/**
 * Computer-use payload schemas — wire artifacts for `computer-use-v1.md`.
 *
 * Four top-level payload types:
 *   - ComputerActionRequest       — the tool call, action as nested variant
 *   - ComputerObservationResult   — screenshot | cursor_position
 *   - ComputerSessionOpened       — signed session-start event
 *   - ComputerSessionClosed       — signed session-end event
 *
 * Every schema has a `.passthrough()` envelope (v2 emitters adding fields
 * don't break v1 validators), a `_TYPE_PARITY` compile-time assertion
 * against the `@motebit/protocol` type, and a `buildXxxJsonSchema()`
 * emitter registered in `scripts/build-schemas.ts`.
 *
 * Actions are a **discriminated union** via zod's `discriminatedUnion` so
 * JSON Schema emits clean `oneOf` branches per variant.
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

const SCHEMA_BASE = "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas";

// ── Primitives ───────────────────────────────────────────────────────

const ComputerPointSchema = z.object({
  x: z.number().int().describe("Logical pixel X coordinate."),
  y: z.number().int().describe("Logical pixel Y coordinate."),
});

const ComputerTargetHintSchema = z.object({
  role: z.string().optional().describe("Accessibility role. Examples: 'button', 'link'."),
  label: z.string().optional().describe("Accessible label or visible text."),
  source: z
    .string()
    .describe("Source of the hint: 'accessibility', 'dom', 'vision', 'user_annotation'."),
});

const ModifiersSchema = z
  .array(z.string())
  .optional()
  .describe('Modifier keys held during the action. Subset of `["cmd", "ctrl", "alt", "shift"]`.');

// ── Action variants ──────────────────────────────────────────────────

const ScreenshotActionSchema = z
  .object({
    kind: z.literal("screenshot"),
  })
  .passthrough();

const CursorPositionActionSchema = z
  .object({
    kind: z.literal("cursor_position"),
  })
  .passthrough();

const ClickActionSchema = z
  .object({
    kind: z.literal("click"),
    target: ComputerPointSchema,
    button: z.string().optional().describe('"left" | "right" | "middle". Defaults to "left".'),
    modifiers: ModifiersSchema,
    target_hint: ComputerTargetHintSchema.optional(),
  })
  .passthrough();

const DoubleClickActionSchema = z
  .object({
    kind: z.literal("double_click"),
    target: ComputerPointSchema,
    button: z.string().optional(),
    modifiers: ModifiersSchema,
    target_hint: ComputerTargetHintSchema.optional(),
  })
  .passthrough();

const MouseMoveActionSchema = z
  .object({
    kind: z.literal("mouse_move"),
    target: ComputerPointSchema,
    target_hint: ComputerTargetHintSchema.optional(),
  })
  .passthrough();

const DragActionSchema = z
  .object({
    kind: z.literal("drag"),
    from: ComputerPointSchema,
    to: ComputerPointSchema,
    button: z.string().optional(),
    modifiers: ModifiersSchema,
    duration_ms: z.number().int().nonnegative().optional(),
    target_hint: ComputerTargetHintSchema.optional(),
  })
  .passthrough();

const TypeActionSchema = z
  .object({
    kind: z.literal("type"),
    text: z.string().describe("Text to type."),
    per_char_delay_ms: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const KeyActionSchema = z
  .object({
    kind: z.literal("key"),
    key: z.string().describe("Key combination. Example: 'cmd+c', 'escape'."),
  })
  .passthrough();

const ScrollActionSchema = z
  .object({
    kind: z.literal("scroll"),
    target: ComputerPointSchema,
    dx: z.number().int().describe("Scroll wheel delta X."),
    dy: z.number().int().describe("Scroll wheel delta Y."),
  })
  .passthrough();

/**
 * Discriminated union of all action variants. Exported so consumers can
 * validate an action value directly without wrapping in a request.
 */
export const ComputerActionSchema = z.discriminatedUnion("kind", [
  ScreenshotActionSchema,
  CursorPositionActionSchema,
  ClickActionSchema,
  DoubleClickActionSchema,
  MouseMoveActionSchema,
  DragActionSchema,
  TypeActionSchema,
  KeyActionSchema,
  ScrollActionSchema,
]);

// ── 5.1 ComputerActionRequest ────────────────────────────────────────

export const COMPUTER_ACTION_REQUEST_SCHEMA_ID = `${SCHEMA_BASE}/computer-action-request-v1.json`;

export const ComputerActionRequestSchema = z
  .object({
    session_id: z.string().min(1).describe("Open session the action belongs to."),
    action: ComputerActionSchema.describe(
      "Discriminated action variant. The `kind` field selects the branch.",
    ),
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
      "One invocation of the `computer` tool. Action is a nested discriminated variant. See spec/computer-use-v1.md §5.1.",
  });
}

// ── 5.2 ComputerObservationResult ────────────────────────────────────

export const COMPUTER_OBSERVATION_RESULT_SCHEMA_ID = `${SCHEMA_BASE}/computer-observation-result-v1.json`;

const ComputerRedactionSchema = z.object({
  applied: z.boolean().describe("True iff one or more regions were masked."),
  projection_kind: z
    .string()
    .describe("'raw' | 'masked' | 'blurred' | 'cropped'. Describes the shape of bytes the AI saw."),
  policy_version: z.string().optional().describe("Version of the classification policy that ran."),
  classified_regions_count: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Number of sensitive regions classified in the raw frame."),
  classified_regions_digest: z
    .string()
    .optional()
    .describe(
      "SHA-256 of a canonical JSON array of classified regions. Lets a verifier replay what was masked.",
    ),
});

const ScreenshotObservationSchema = z
  .object({
    kind: z.literal("screenshot"),
    session_id: z.string().min(1),
    artifact_id: z.string().min(1).describe("Artifact ID of the raw capture."),
    artifact_sha256: z.string().min(1).describe("SHA-256 of the raw capture bytes."),
    image_format: z.string().describe('"png" | "jpeg".'),
    width: z.number().int().positive().describe("Image width in logical pixels."),
    height: z.number().int().positive().describe("Image height in logical pixels."),
    captured_at: z.number().int().nonnegative().describe("Unix ms."),
    redaction: ComputerRedactionSchema,
    projection_artifact_id: z
      .string()
      .optional()
      .describe("Artifact ID of the redacted projection when it differs from the raw capture."),
    projection_artifact_sha256: z
      .string()
      .optional()
      .describe("SHA-256 of the projection bytes. Paired with projection_artifact_id."),
  })
  .passthrough();

const CursorPositionObservationSchema = z
  .object({
    kind: z.literal("cursor_position"),
    session_id: z.string().min(1),
    x: z.number().int(),
    y: z.number().int(),
    captured_at: z.number().int().nonnegative(),
  })
  .passthrough();

export const ComputerObservationResultSchema = z.discriminatedUnion("kind", [
  ScreenshotObservationSchema,
  CursorPositionObservationSchema,
]);

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
      "Result payload of a computer-use observation action. Screenshot bytes live in the artifact store; this payload binds to them by hash. See spec/computer-use-v1.md §5.2.",
  });
}

// ── 5.3 ComputerSessionOpened ────────────────────────────────────────

export const COMPUTER_SESSION_OPENED_SCHEMA_ID = `${SCHEMA_BASE}/computer-session-opened-v1.json`;

export const ComputerSessionOpenedSchema = z
  .object({
    session_id: z.string().min(1).describe("Newly allocated computer-use session identifier."),
    motebit_id: z.string().min(1).describe("Motebit identity binding for this session."),
    display_width: z.number().int().positive().describe("Primary display logical width in pixels."),
    display_height: z
      .number()
      .int()
      .positive()
      .describe("Primary display logical height in pixels."),
    scaling_factor: z.number().positive().describe("Logical-to-physical ratio. Retina = 2.0."),
    opened_at: z.number().int().nonnegative().describe("Unix ms when the session opened."),
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
    session_id: z.string().min(1).describe("Computer-use session identifier being closed."),
    closed_at: z.number().int().nonnegative().describe("Unix ms when the session closed."),
    reason: z
      .string()
      .optional()
      .describe(
        "Free-text close reason. Examples: 'user_closed', 'timeout', 'error', 'manager_disposed'.",
      ),
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
