/**
 * Goal-lifecycle event payload schemas — wire artifacts for `goal-lifecycle-v1.md`.
 *
 * Five event-shaped payloads covering goal creation, per-run execution,
 * mid-run progress notes, terminal completion, and removal. Every schema
 * has a `.passthrough()` envelope (v2 emitters adding fields don't break
 * v1 validators), a `_TYPE_PARITY` compile-time assertion against the
 * `@motebit/protocol` type, and a `buildXxxJsonSchema()` emitter called
 * by `scripts/build-schemas.ts` to refresh the committed JSON Schema
 * artifact. See `spec/goal-lifecycle-v1.md` §5 for the normative field
 * list.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type {
  GoalCreatedPayload,
  GoalExecutedPayload,
  GoalProgressPayload,
  GoalCompletedPayload,
  GoalRemovedPayload,
} from "@motebit/protocol";

import { assembleJsonSchemaFor } from "./assemble.js";

const SCHEMA_BASE =
  "https://raw.githubusercontent.com/motebit/motebit/main/packages/wire-schemas/schema";

// ── 5.1 GoalCreatedPayload ───────────────────────────────────────────

export const GOAL_CREATED_PAYLOAD_SCHEMA_ID = `${SCHEMA_BASE}/goal-created-payload-v1.json`;

export const GoalCreatedPayloadSchema = z
  .object({
    goal_id: z
      .string()
      .min(1)
      .describe("Stable UUID of the goal; stable across yaml-driven revisions."),
    prompt: z
      .string()
      .optional()
      .describe(
        "Natural-language goal text. REQUIRED on initial creation; MAY be absent on revision when only scheduling metadata changed.",
      ),
    interval_ms: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Scheduling cadence in milliseconds. Absent for one-shot goals."),
    mode: z
      .string()
      .optional()
      .describe('Scheduling mode — e.g. `"recurring"` or `"once"`. Future variants reserved.'),
    wall_clock_ms: z
      .number()
      .int()
      .optional()
      .describe("Wall-clock anchor for the first run (Unix milliseconds)."),
    project_id: z
      .string()
      .optional()
      .describe("User-facing project grouping. Opaque to the protocol."),
    routine_id: z
      .string()
      .optional()
      .describe("Source routine id when materialized from a motebit.yaml routine."),
    routine_source: z
      .string()
      .optional()
      .describe("Free-text source attribution (e.g. yaml file path)."),
    routine_hash: z
      .string()
      .optional()
      .describe("Canonical hash of the source routine. Used to detect yaml drift."),
    update: z
      .literal(true)
      .optional()
      .describe("Marker set on yaml-driven revisions; absent on initial creation."),
  })
  .passthrough();

type InferredGoalCreated = z.infer<typeof GoalCreatedPayloadSchema>;
type _GoalCreatedForward = GoalCreatedPayload extends InferredGoalCreated ? true : never;
type _GoalCreatedReverse = InferredGoalCreated extends GoalCreatedPayload ? true : never;
export const _GOAL_CREATED_PAYLOAD_TYPE_PARITY: {
  forward: _GoalCreatedForward;
  reverse: _GoalCreatedReverse;
} = {
  forward: true as _GoalCreatedForward,
  reverse: true as _GoalCreatedReverse,
};

export function buildGoalCreatedPayloadJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(GoalCreatedPayloadSchema, {
    name: "GoalCreatedPayload",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("GoalCreatedPayload", raw, {
    $id: GOAL_CREATED_PAYLOAD_SCHEMA_ID,
    title: "GoalCreatedPayload (v1)",
    description:
      "Payload of a `goal_created` event — initial declaration or yaml-driven revision of a goal. See spec/goal-lifecycle-v1.md §5.1.",
  });
}

// ── 5.2 GoalExecutedPayload ──────────────────────────────────────────

export const GOAL_EXECUTED_PAYLOAD_SCHEMA_ID = `${SCHEMA_BASE}/goal-executed-payload-v1.json`;

export const GoalExecutedPayloadSchema = z
  .object({
    goal_id: z.string().min(1).describe("UUID of the executed goal."),
    summary: z
      .string()
      .optional()
      .describe("Up to ~200 characters of the agent's response text for this run."),
    tool_calls: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Number of tool calls performed during the run."),
    memories: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Number of memory nodes formed during the run."),
  })
  .passthrough();

type InferredGoalExecuted = z.infer<typeof GoalExecutedPayloadSchema>;
type _GoalExecutedForward = GoalExecutedPayload extends InferredGoalExecuted ? true : never;
type _GoalExecutedReverse = InferredGoalExecuted extends GoalExecutedPayload ? true : never;
export const _GOAL_EXECUTED_PAYLOAD_TYPE_PARITY: {
  forward: _GoalExecutedForward;
  reverse: _GoalExecutedReverse;
} = {
  forward: true as _GoalExecutedForward,
  reverse: true as _GoalExecutedReverse,
};

export function buildGoalExecutedPayloadJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(GoalExecutedPayloadSchema, {
    name: "GoalExecutedPayload",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("GoalExecutedPayload", raw, {
    $id: GOAL_EXECUTED_PAYLOAD_SCHEMA_ID,
    title: "GoalExecutedPayload (v1)",
    description:
      "Payload of a `goal_executed` event — records one run's terminal outcome. Recurring goals emit this repeatedly. See spec/goal-lifecycle-v1.md §5.2.",
  });
}

// ── 5.3 GoalProgressPayload ──────────────────────────────────────────

export const GOAL_PROGRESS_PAYLOAD_SCHEMA_ID = `${SCHEMA_BASE}/goal-progress-payload-v1.json`;

export const GoalProgressPayloadSchema = z
  .object({
    goal_id: z.string().min(1).describe("UUID of the goal."),
    note: z
      .string()
      .describe(
        "Free-text progress narration from the `report_progress` tool. Consumers MUST NOT parse it semantically.",
      ),
  })
  .passthrough();

type InferredGoalProgress = z.infer<typeof GoalProgressPayloadSchema>;
type _GoalProgressForward = GoalProgressPayload extends InferredGoalProgress ? true : never;
type _GoalProgressReverse = InferredGoalProgress extends GoalProgressPayload ? true : never;
export const _GOAL_PROGRESS_PAYLOAD_TYPE_PARITY: {
  forward: _GoalProgressForward;
  reverse: _GoalProgressReverse;
} = {
  forward: true as _GoalProgressForward,
  reverse: true as _GoalProgressReverse,
};

export function buildGoalProgressPayloadJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(GoalProgressPayloadSchema, {
    name: "GoalProgressPayload",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("GoalProgressPayload", raw, {
    $id: GOAL_PROGRESS_PAYLOAD_SCHEMA_ID,
    title: "GoalProgressPayload (v1)",
    description:
      "Payload of a `goal_progress` event — narrative progress note emitted mid-run. See spec/goal-lifecycle-v1.md §5.3.",
  });
}

// ── 5.4 GoalCompletedPayload ─────────────────────────────────────────

export const GOAL_COMPLETED_PAYLOAD_SCHEMA_ID = `${SCHEMA_BASE}/goal-completed-payload-v1.json`;

export const GoalCompletedPayloadSchema = z
  .object({
    goal_id: z.string().min(1).describe("UUID of the completed goal."),
    reason: z
      .string()
      .optional()
      .describe("Free-text rationale for completion. Consumers MUST NOT parse it semantically."),
    status: z
      .string()
      .optional()
      .describe(
        'Terminal status — `"completed" | "failed" | "suspended"`. Optional in v1 for back-compat with emitters that predate the field.',
      ),
  })
  .passthrough();

type InferredGoalCompleted = z.infer<typeof GoalCompletedPayloadSchema>;
type _GoalCompletedForward = GoalCompletedPayload extends InferredGoalCompleted ? true : never;
type _GoalCompletedReverse = InferredGoalCompleted extends GoalCompletedPayload ? true : never;
export const _GOAL_COMPLETED_PAYLOAD_TYPE_PARITY: {
  forward: _GoalCompletedForward;
  reverse: _GoalCompletedReverse;
} = {
  forward: true as _GoalCompletedForward,
  reverse: true as _GoalCompletedReverse,
};

export function buildGoalCompletedPayloadJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(GoalCompletedPayloadSchema, {
    name: "GoalCompletedPayload",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("GoalCompletedPayload", raw, {
    $id: GOAL_COMPLETED_PAYLOAD_SCHEMA_ID,
    title: "GoalCompletedPayload (v1)",
    description:
      "Payload of a `goal_completed` event — goal reached its terminal state. See spec/goal-lifecycle-v1.md §5.4.",
  });
}

// ── 5.5 GoalRemovedPayload ───────────────────────────────────────────

export const GOAL_REMOVED_PAYLOAD_SCHEMA_ID = `${SCHEMA_BASE}/goal-removed-payload-v1.json`;

export const GoalRemovedPayloadSchema = z
  .object({
    goal_id: z.string().min(1).describe("UUID of the removed goal."),
    routine_id: z
      .string()
      .optional()
      .describe("Source routine id when the removal was yaml-pruned."),
    reason: z
      .string()
      .optional()
      .describe('Free-text rationale (e.g. `"yaml_pruned"` or a user reason).'),
  })
  .passthrough();

type InferredGoalRemoved = z.infer<typeof GoalRemovedPayloadSchema>;
type _GoalRemovedForward = GoalRemovedPayload extends InferredGoalRemoved ? true : never;
type _GoalRemovedReverse = InferredGoalRemoved extends GoalRemovedPayload ? true : never;
export const _GOAL_REMOVED_PAYLOAD_TYPE_PARITY: {
  forward: _GoalRemovedForward;
  reverse: _GoalRemovedReverse;
} = {
  forward: true as _GoalRemovedForward,
  reverse: true as _GoalRemovedReverse,
};

export function buildGoalRemovedPayloadJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(GoalRemovedPayloadSchema, {
    name: "GoalRemovedPayload",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("GoalRemovedPayload", raw, {
    $id: GOAL_REMOVED_PAYLOAD_SCHEMA_ID,
    title: "GoalRemovedPayload (v1)",
    description:
      "Payload of a `goal_removed` event — goal deleted via user command or yaml pruning. See spec/goal-lifecycle-v1.md §5.5.",
  });
}
