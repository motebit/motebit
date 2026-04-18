/**
 * AgentTask — wire schema.
 *
 * The task envelope every executing agent receives. Submitted as the
 * request body on `POST /api/v1/tasks` (delegator → relay), then
 * dispatched to the chosen executor with relay-stamped fields
 * (`task_id`, `motebit_id`, `submitted_at`, `status`).
 *
 * This is the "execute" link in the marketplace participation loop:
 *   discover → advertise → authorize → **execute** → emit receipt
 *
 * A non-motebit worker (Python, Go, Rust) that wants to receive
 * delegated work fetches this JSON Schema, validates incoming task
 * payloads, runs the requested capability against `prompt`, and
 * returns an ExecutionReceipt. No motebit TypeScript required at any
 * step.
 *
 * Two facets the schema preserves:
 *   1. `required_capabilities` is a closed enum (DeviceCapability) — a
 *      task that requires `mind_reading` is rejected at the schema
 *      layer, before any routing logic decides what to do with it.
 *   2. `invocation_origin` and `delegated_scope` are signature-bound
 *      when the task chains into a receipt (see ExecutionReceipt) —
 *      the wire schema accepts them here so the executor can echo
 *      them faithfully into the receipt body it signs.
 *
 * See spec/delegation-v1.md §3.1 for the full specification.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { AgentTask } from "@motebit/protocol";

import { assembleJsonSchemaFor } from "./assemble.js";

/** Stable `$id` for the agent-task v1 wire format. */
export const AGENT_TASK_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/packages/wire-schemas/schema/agent-task-v1.json";

const AgentTaskStatusSchema = z
  .enum(["pending", "claimed", "running", "completed", "failed", "denied", "expired"])
  .describe(
    "Lifecycle state. `pending` → just submitted; `claimed` → an executor accepted; `running` → execution in flight; terminal: `completed` / `failed` / `denied` / `expired`. State transitions are forward-only.",
  );

const DeviceCapabilitySchema = z
  .enum(["stdio_mcp", "http_mcp", "file_system", "keyring", "background", "local_llm", "push_wake"])
  .describe(
    "Device-side capability the executor must possess. Closed set defined in @motebit/protocol — `stdio_mcp`, `http_mcp` (transports); `file_system`, `keyring` (resources); `background`, `push_wake` (lifecycle); `local_llm` (sovereign mode). New capabilities are protocol additions, not free-form strings.",
  );

const IntentOriginSchema = z
  .enum(["user-tap", "ai-loop", "scheduled", "agent-to-agent"])
  .describe(
    "How this task was authorized for invocation. Propagated into the eventual ExecutionReceipt where it becomes signature-bound. See spec/execution-ledger-v1.md §IntentOrigin and docs/doctrine/surface-determinism.md.",
  );

export const AgentTaskSchema = z
  .object({
    task_id: z
      .string()
      .min(1)
      .describe(
        "Relay-assigned task identifier (UUID). Stable across retries and the entire lifecycle; the executor echoes this in the ExecutionReceipt's `task_id`.",
      ),
    motebit_id: z
      .string()
      .min(1)
      .describe(
        "Motebit identity of the executing agent (UUIDv7). Set by the relay when the task is dispatched to a chosen executor.",
      ),
    prompt: z
      .string()
      .min(1)
      .describe(
        "Natural-language task body. Required and non-empty — the relay rejects empty prompts at submission.",
      ),
    submitted_at: z
      .number()
      .describe("Unix timestamp in milliseconds when the relay accepted the submission."),
    submitted_by: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Motebit identity of the delegator (the agent that submitted the task). Used for trust tracking and budget allocation. Absent for self-submitted tasks.",
      ),
    wall_clock_ms: z
      .number()
      .optional()
      .describe(
        "Optional hard wall-clock timeout for this execution in milliseconds. The executor self-terminates and emits a `failed` receipt if this is exceeded. Default: implementation-defined.",
      ),
    status: AgentTaskStatusSchema,
    claimed_by: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Motebit identity of the executor that claimed this task, when `status` ≥ `claimed`. Absent for `pending` tasks.",
      ),
    required_capabilities: z
      .array(DeviceCapabilitySchema)
      .optional()
      .describe(
        "Optional capability filter for routing. The relay only dispatches to agents whose `AgentServiceListing.capabilities` (broader concept) implies these device-level capabilities.",
      ),
    step_id: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional plan-step identifier when this task is part of a multi-step delegation plan. Lets a coordinating delegator correlate sub-task receipts.",
      ),
    delegated_scope: z
      .string()
      .optional()
      .describe(
        "Scope from the DelegationToken that authorized this task (when relay-mediated and authorized via a token). Restricts which tools the executor may invoke. Echoed into the ExecutionReceipt's `delegated_scope`.",
      ),
    invocation_origin: IntentOriginSchema.optional(),
  })
  // Unsigned envelope — spec/delegation-v1.md §3.1 mandates "unknown fields
  // MUST be ignored (forward compatibility)". `.passthrough()` accepts and
  // preserves unknown fields so v1 verifiers don't reject v2 payloads.
  // Inner enums (`status`, `required_capabilities[]`, `invocation_origin`)
  // remain closed via their own zod schemas — only the top-level envelope
  // is forward-compatible.
  .passthrough();

// ---------------------------------------------------------------------------
// Type parity — drift defense #22 compile-time half
// ---------------------------------------------------------------------------

type InferredTask = z.infer<typeof AgentTaskSchema>;

// AgentTask in @motebit/protocol uses branded MotebitId; relax for
// structural parity (the wire is just a string, the brand is a TS-only
// guard).
type BrandedToString<T> = {
  [K in keyof T]: T[K] extends string & { readonly __brand: unknown } ? string : T[K];
};

type _ForwardCheck = BrandedToString<AgentTask> extends InferredTask ? true : never;
type _ReverseCheck = InferredTask extends BrandedToString<AgentTask> ? true : never;

export const _AGENT_TASK_TYPE_PARITY: { forward: _ForwardCheck; reverse: _ReverseCheck } = {
  forward: true as _ForwardCheck,
  reverse: true as _ReverseCheck,
};

// ---------------------------------------------------------------------------
// JSON Schema emitter
// ---------------------------------------------------------------------------

export function buildAgentTaskJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(AgentTaskSchema, {
    name: "AgentTask",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("AgentTask", raw, {
    $id: AGENT_TASK_SCHEMA_ID,
    title: "AgentTask (v1)",
    description:
      "Task envelope dispatched from relay to executing agent. Carries the prompt, capability requirements, scope, and lifecycle status. The executor consumes this, runs the work, and returns an ExecutionReceipt referencing `task_id`. See spec/delegation-v1.md §3.1.",
  });
}
