/**
 * Plan-lifecycle event payload schemas — wire artifacts for `plan-lifecycle-v1.md`.
 *
 * Seven event-shaped payloads covering plan creation, per-step lifecycle
 * (started / completed / failed / delegated), and plan termination
 * (completed / failed). Every schema has a `.passthrough()` envelope, a
 * `_TYPE_PARITY` compile-time assertion, and a `buildXxxJsonSchema()`
 * emitter. See `spec/plan-lifecycle-v1.md` §5 for the normative field
 * list.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type {
  PlanCreatedPayload,
  PlanStepStartedPayload,
  PlanStepCompletedPayload,
  PlanStepFailedPayload,
  PlanStepDelegatedPayload,
  PlanCompletedPayload,
  PlanFailedPayload,
} from "@motebit/protocol";

import { assembleJsonSchemaFor } from "./assemble.js";

const SCHEMA_BASE =
  "https://raw.githubusercontent.com/motebit/motebit/main/packages/wire-schemas/schema";

// ── 5.1 PlanCreatedPayload ───────────────────────────────────────────

export const PLAN_CREATED_PAYLOAD_SCHEMA_ID = `${SCHEMA_BASE}/plan-created-payload-v1.json`;

export const PlanCreatedPayloadSchema = z
  .object({
    plan_id: z.string().min(1).describe("Stable UUID of the plan."),
    title: z.string().describe("Human-readable title summarizing the plan's goal."),
    total_steps: z
      .number()
      .int()
      .nonnegative()
      .describe("Total number of steps the plan was materialized with."),
    goal_id: z
      .string()
      .optional()
      .describe("Owning goal when the plan serves a scheduled or on-demand goal."),
  })
  .passthrough();

type InferredPlanCreated = z.infer<typeof PlanCreatedPayloadSchema>;
type _PlanCreatedForward = PlanCreatedPayload extends InferredPlanCreated ? true : never;
type _PlanCreatedReverse = InferredPlanCreated extends PlanCreatedPayload ? true : never;
export const _PLAN_CREATED_PAYLOAD_TYPE_PARITY: {
  forward: _PlanCreatedForward;
  reverse: _PlanCreatedReverse;
} = {
  forward: true as _PlanCreatedForward,
  reverse: true as _PlanCreatedReverse,
};

export function buildPlanCreatedPayloadJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(PlanCreatedPayloadSchema, {
    name: "PlanCreatedPayload",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("PlanCreatedPayload", raw, {
    $id: PLAN_CREATED_PAYLOAD_SCHEMA_ID,
    title: "PlanCreatedPayload (v1)",
    description:
      "Payload of a `plan_created` event — plan materialized with N steps. See spec/plan-lifecycle-v1.md §5.1.",
  });
}

// ── 5.2 PlanStepStartedPayload ───────────────────────────────────────

export const PLAN_STEP_STARTED_PAYLOAD_SCHEMA_ID = `${SCHEMA_BASE}/plan-step-started-payload-v1.json`;

export const PlanStepStartedPayloadSchema = z
  .object({
    plan_id: z.string().min(1).describe("UUID of the parent plan."),
    step_id: z.string().min(1).describe("UUID of the step; unique within the plan."),
    ordinal: z
      .number()
      .int()
      .nonnegative()
      .describe("Zero-based position of the step within its plan."),
    description: z.string().describe("Human-readable description of what the step does."),
    goal_id: z
      .string()
      .optional()
      .describe("Owning goal when the plan serves a scheduled or on-demand goal."),
  })
  .passthrough();

type InferredPlanStepStarted = z.infer<typeof PlanStepStartedPayloadSchema>;
type _PlanStepStartedForward = PlanStepStartedPayload extends InferredPlanStepStarted
  ? true
  : never;
type _PlanStepStartedReverse = InferredPlanStepStarted extends PlanStepStartedPayload
  ? true
  : never;
export const _PLAN_STEP_STARTED_PAYLOAD_TYPE_PARITY: {
  forward: _PlanStepStartedForward;
  reverse: _PlanStepStartedReverse;
} = {
  forward: true as _PlanStepStartedForward,
  reverse: true as _PlanStepStartedReverse,
};

export function buildPlanStepStartedPayloadJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(PlanStepStartedPayloadSchema, {
    name: "PlanStepStartedPayload",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("PlanStepStartedPayload", raw, {
    $id: PLAN_STEP_STARTED_PAYLOAD_SCHEMA_ID,
    title: "PlanStepStartedPayload (v1)",
    description:
      "Payload of a `plan_step_started` event — step transitioned from pending to running. See spec/plan-lifecycle-v1.md §5.2.",
  });
}

// ── 5.3 PlanStepCompletedPayload ─────────────────────────────────────

export const PLAN_STEP_COMPLETED_PAYLOAD_SCHEMA_ID = `${SCHEMA_BASE}/plan-step-completed-payload-v1.json`;

export const PlanStepCompletedPayloadSchema = z
  .object({
    plan_id: z.string().min(1).describe("UUID of the parent plan."),
    step_id: z.string().min(1).describe("UUID of the completed step."),
    ordinal: z
      .number()
      .int()
      .nonnegative()
      .describe("Zero-based position of the step within its plan."),
    tool_calls_made: z
      .number()
      .int()
      .nonnegative()
      .describe("Number of tool calls the step performed."),
    task_id: z
      .string()
      .optional()
      .describe("Delegation task id; present iff this step was delegated (§3.7)."),
    goal_id: z.string().optional().describe("Owning goal when the plan serves a goal."),
  })
  .passthrough();

type InferredPlanStepCompleted = z.infer<typeof PlanStepCompletedPayloadSchema>;
type _PlanStepCompletedForward = PlanStepCompletedPayload extends InferredPlanStepCompleted
  ? true
  : never;
type _PlanStepCompletedReverse = InferredPlanStepCompleted extends PlanStepCompletedPayload
  ? true
  : never;
export const _PLAN_STEP_COMPLETED_PAYLOAD_TYPE_PARITY: {
  forward: _PlanStepCompletedForward;
  reverse: _PlanStepCompletedReverse;
} = {
  forward: true as _PlanStepCompletedForward,
  reverse: true as _PlanStepCompletedReverse,
};

export function buildPlanStepCompletedPayloadJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(PlanStepCompletedPayloadSchema, {
    name: "PlanStepCompletedPayload",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("PlanStepCompletedPayload", raw, {
    $id: PLAN_STEP_COMPLETED_PAYLOAD_SCHEMA_ID,
    title: "PlanStepCompletedPayload (v1)",
    description:
      "Payload of a `plan_step_completed` event — step reached terminal success. See spec/plan-lifecycle-v1.md §5.3.",
  });
}

// ── 5.4 PlanStepFailedPayload ────────────────────────────────────────

export const PLAN_STEP_FAILED_PAYLOAD_SCHEMA_ID = `${SCHEMA_BASE}/plan-step-failed-payload-v1.json`;

export const PlanStepFailedPayloadSchema = z
  .object({
    plan_id: z.string().min(1).describe("UUID of the parent plan."),
    step_id: z.string().min(1).describe("UUID of the failed step."),
    ordinal: z
      .number()
      .int()
      .nonnegative()
      .describe("Zero-based position of the step within its plan."),
    error: z
      .string()
      .describe("Error message from the failing step. Consumers MUST NOT parse it semantically."),
    task_id: z
      .string()
      .optional()
      .describe("Delegation task id; present iff this step was delegated (§3.7)."),
    goal_id: z.string().optional().describe("Owning goal when the plan serves a goal."),
  })
  .passthrough();

type InferredPlanStepFailed = z.infer<typeof PlanStepFailedPayloadSchema>;
type _PlanStepFailedForward = PlanStepFailedPayload extends InferredPlanStepFailed ? true : never;
type _PlanStepFailedReverse = InferredPlanStepFailed extends PlanStepFailedPayload ? true : never;
export const _PLAN_STEP_FAILED_PAYLOAD_TYPE_PARITY: {
  forward: _PlanStepFailedForward;
  reverse: _PlanStepFailedReverse;
} = {
  forward: true as _PlanStepFailedForward,
  reverse: true as _PlanStepFailedReverse,
};

export function buildPlanStepFailedPayloadJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(PlanStepFailedPayloadSchema, {
    name: "PlanStepFailedPayload",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("PlanStepFailedPayload", raw, {
    $id: PLAN_STEP_FAILED_PAYLOAD_SCHEMA_ID,
    title: "PlanStepFailedPayload (v1)",
    description:
      "Payload of a `plan_step_failed` event — step reached terminal failure. See spec/plan-lifecycle-v1.md §5.4.",
  });
}

// ── 5.5 PlanStepDelegatedPayload ─────────────────────────────────────

export const PLAN_STEP_DELEGATED_PAYLOAD_SCHEMA_ID = `${SCHEMA_BASE}/plan-step-delegated-payload-v1.json`;

export const PlanStepDelegatedPayloadSchema = z
  .object({
    plan_id: z.string().min(1).describe("UUID of the parent plan."),
    step_id: z.string().min(1).describe("UUID of the delegated step."),
    ordinal: z
      .number()
      .int()
      .nonnegative()
      .describe("Zero-based position of the step within its plan."),
    task_id: z
      .string()
      .min(1)
      .describe("Relay-issued task identifier. Matches the subsequent AgentTaskCompleted.task_id."),
    routing_choice: z
      .record(z.unknown())
      .optional()
      .describe(
        "Routing provenance picked by the semiring. Opaque to this spec; forward-compat via passthrough.",
      ),
    goal_id: z.string().optional().describe("Owning goal when the plan serves a goal."),
  })
  .passthrough();

type InferredPlanStepDelegated = z.infer<typeof PlanStepDelegatedPayloadSchema>;
type _PlanStepDelegatedForward = PlanStepDelegatedPayload extends InferredPlanStepDelegated
  ? true
  : never;
type _PlanStepDelegatedReverse = InferredPlanStepDelegated extends PlanStepDelegatedPayload
  ? true
  : never;
export const _PLAN_STEP_DELEGATED_PAYLOAD_TYPE_PARITY: {
  forward: _PlanStepDelegatedForward;
  reverse: _PlanStepDelegatedReverse;
} = {
  forward: true as _PlanStepDelegatedForward,
  reverse: true as _PlanStepDelegatedReverse,
};

export function buildPlanStepDelegatedPayloadJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(PlanStepDelegatedPayloadSchema, {
    name: "PlanStepDelegatedPayload",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("PlanStepDelegatedPayload", raw, {
    $id: PLAN_STEP_DELEGATED_PAYLOAD_SCHEMA_ID,
    title: "PlanStepDelegatedPayload (v1)",
    description:
      "Payload of a `plan_step_delegated` event — step handed off to a remote agent. See spec/plan-lifecycle-v1.md §5.5.",
  });
}

// ── 5.6 PlanCompletedPayload ─────────────────────────────────────────

export const PLAN_COMPLETED_PAYLOAD_SCHEMA_ID = `${SCHEMA_BASE}/plan-completed-payload-v1.json`;

export const PlanCompletedPayloadSchema = z
  .object({
    plan_id: z.string().min(1).describe("UUID of the completed plan."),
    goal_id: z.string().optional().describe("Owning goal when the plan served a goal."),
  })
  .passthrough();

type InferredPlanCompleted = z.infer<typeof PlanCompletedPayloadSchema>;
type _PlanCompletedForward = PlanCompletedPayload extends InferredPlanCompleted ? true : never;
type _PlanCompletedReverse = InferredPlanCompleted extends PlanCompletedPayload ? true : never;
export const _PLAN_COMPLETED_PAYLOAD_TYPE_PARITY: {
  forward: _PlanCompletedForward;
  reverse: _PlanCompletedReverse;
} = {
  forward: true as _PlanCompletedForward,
  reverse: true as _PlanCompletedReverse,
};

export function buildPlanCompletedPayloadJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(PlanCompletedPayloadSchema, {
    name: "PlanCompletedPayload",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("PlanCompletedPayload", raw, {
    $id: PLAN_COMPLETED_PAYLOAD_SCHEMA_ID,
    title: "PlanCompletedPayload (v1)",
    description:
      "Payload of a `plan_completed` event — every step terminal; plan closed. See spec/plan-lifecycle-v1.md §5.6.",
  });
}

// ── 5.7 PlanFailedPayload ────────────────────────────────────────────

export const PLAN_FAILED_PAYLOAD_SCHEMA_ID = `${SCHEMA_BASE}/plan-failed-payload-v1.json`;

export const PlanFailedPayloadSchema = z
  .object({
    plan_id: z.string().min(1).describe("UUID of the failed plan."),
    reason: z
      .string()
      .describe("Free-text failure rationale. Consumers MUST NOT parse it semantically."),
    goal_id: z.string().optional().describe("Owning goal when the plan served a goal."),
  })
  .passthrough();

type InferredPlanFailed = z.infer<typeof PlanFailedPayloadSchema>;
type _PlanFailedForward = PlanFailedPayload extends InferredPlanFailed ? true : never;
type _PlanFailedReverse = InferredPlanFailed extends PlanFailedPayload ? true : never;
export const _PLAN_FAILED_PAYLOAD_TYPE_PARITY: {
  forward: _PlanFailedForward;
  reverse: _PlanFailedReverse;
} = {
  forward: true as _PlanFailedForward,
  reverse: true as _PlanFailedReverse,
};

export function buildPlanFailedPayloadJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(PlanFailedPayloadSchema, {
    name: "PlanFailedPayload",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("PlanFailedPayload", raw, {
    $id: PLAN_FAILED_PAYLOAD_SCHEMA_ID,
    title: "PlanFailedPayload (v1)",
    description:
      "Payload of a `plan_failed` event — plan terminated before completion. See spec/plan-lifecycle-v1.md §5.7.",
  });
}
