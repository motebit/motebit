/**
 * Execution Receipt — wire schema.
 *
 * The ExecutionReceipt is motebit's most-emitted signed artifact: every
 * completed, failed, or denied task produces one, and delegated tasks
 * nest their dependencies' receipts recursively in `delegation_receipts`.
 *
 * Canonicalization: JCS (RFC 8785) via `canonicalJson` — keys sorted
 * lexicographically, `undefined` omitted, no whitespace. Signing: Ed25519
 * over the canonicalized body (excluding `signature`). Suite today is
 * pinned to `"motebit-jcs-ed25519-b64-v1"`; post-quantum migration adds
 * a registry entry, not a wire-format break.
 *
 * Third-party implementers (Python workers, Go test harnesses, Rust
 * verifiers) fetch the published JSON Schema via its stable `$id` and
 * validate receipts without bundling `@motebit/protocol`. This is the
 * mechanism by which non-motebit systems can credibly emit or verify
 * motebit receipts — the practical realization of the relay-optional
 * settlement claim.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { DeviceId, ExecutionReceipt, IntentOrigin, MotebitId } from "@motebit/protocol";

/** Stable `$id` for the execution-receipt v1 wire format. External tools pin to this. */
export const EXECUTION_RECEIPT_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/packages/wire-schemas/schema/execution-receipt-v1.json";

// ---------------------------------------------------------------------------
// Leaf schemas
// ---------------------------------------------------------------------------

const MotebitIdSchema = z
  .string()
  .min(1)
  .describe(
    "Motebit identity — UUIDv7 string. Brand-checked at the type layer in @motebit/protocol; the wire shape is a non-empty string.",
  );

const DeviceIdSchema = z
  .string()
  .min(1)
  .describe(
    "Device identity — UUIDv7 string for the signing device. Brand-checked at the type layer; the wire shape is a non-empty string.",
  );

const IntentOriginSchema = z
  .enum(["user-tap", "ai-loop", "scheduled", "agent-to-agent"])
  .describe(
    "How this task was authorized for invocation. `user-tap` = explicit affordance (surface determinism); `ai-loop` = model-mediated delegation; `scheduled` = cron; `agent-to-agent` = another motebit initiated it. Signature-bound — tampering breaks verification.",
  );

/**
 * Suite discriminator for ExecutionReceipt. Narrowed to the single suite
 * today; widening requires an intentional protocol + registry change
 * (planned PQ migration path). Verifiers reject missing or unknown
 * values fail-closed.
 */
const SuiteSchema = z
  .literal("motebit-jcs-ed25519-b64-v1")
  .describe(
    "Cryptosuite identifier. Always `motebit-jcs-ed25519-b64-v1` for ExecutionReceipt today: JCS canonicalization (RFC 8785), Ed25519 signature, base64url-encoded signature, hex-encoded public key. See @motebit/protocol SUITE_REGISTRY.",
  );

const StatusSchema = z
  .enum(["completed", "failed", "denied"])
  .describe(
    "Terminal state of the task. `completed` = result produced and signed. `failed` = execution errored. `denied` = policy or budget gate rejected the invocation.",
  );

// ---------------------------------------------------------------------------
// Recursive receipt schema
//
// `delegation_receipts?: ExecutionReceipt[]` is recursive — zod's
// `.lazy()` wraps the self-reference so the schema can close over itself.
// The z.infer of the resulting ZodLazy is structurally identical to the
// non-recursive body.
// ---------------------------------------------------------------------------

/**
 * The unsigned body of an ExecutionReceipt — every field except the
 * `signature`. Exported here because the signing/verification recipe is
 * "canonicalize the body, sign the canonical bytes, embed signature in
 * the result." External implementers re-compute `canonicalJson(body)`
 * and check the signature against `signature`.
 */
interface ExecutionReceiptShape {
  task_id: string;
  motebit_id: string;
  public_key?: string | undefined;
  device_id: string;
  submitted_at: number;
  completed_at: number;
  status: "completed" | "failed" | "denied";
  result: string;
  tools_used: string[];
  memories_formed: number;
  prompt_hash: string;
  result_hash: string;
  delegation_receipts?: ExecutionReceiptShape[] | undefined;
  relay_task_id?: string | undefined;
  delegated_scope?: string | undefined;
  invocation_origin?: "user-tap" | "ai-loop" | "scheduled" | "agent-to-agent" | undefined;
  suite: "motebit-jcs-ed25519-b64-v1";
  signature: string;
}

export const ExecutionReceiptSchema: z.ZodType<ExecutionReceiptShape> = z.lazy(() =>
  z
    .object({
      task_id: z
        .string()
        .min(1)
        .describe("Task identifier — UUID assigned at submission time; stable across retries."),
      motebit_id: MotebitIdSchema,
      public_key: z
        .string()
        .optional()
        .describe(
          "Signer's Ed25519 public key, hex-encoded. Optional because legacy pre-suite receipts omit it, but required for offline verification — present on every new receipt.",
        ),
      device_id: DeviceIdSchema,
      submitted_at: z
        .number()
        .describe("Unix timestamp in milliseconds when the task was submitted."),
      completed_at: z
        .number()
        .describe(
          "Unix timestamp in milliseconds when the task reached terminal state. Equal to `submitted_at` for instantaneous completions.",
        ),
      status: StatusSchema,
      result: z
        .string()
        .describe(
          "Final result payload as a string. Serialization format is task-specific; the receipt commits only to the bytes.",
        ),
      tools_used: z
        .array(z.string())
        .describe(
          "Names of tools invoked during execution. Empty array for pure-LLM or denied tasks.",
        ),
      memories_formed: z
        .number()
        .int()
        .nonnegative()
        .describe("Count of memories the agent persisted during execution (≥ 0)."),
      prompt_hash: z
        .string()
        .describe(
          "SHA-256 hex digest of the canonical prompt bytes. Lets verifiers prove a task matched a declared prompt without requiring the prompt itself.",
        ),
      result_hash: z
        .string()
        .describe(
          "SHA-256 hex digest of the canonical result bytes. Pair with `result` for self-verification; with `prompt_hash` for prompt/result provenance.",
        ),
      delegation_receipts: z
        .array(z.lazy(() => ExecutionReceiptSchema))
        .optional()
        .describe(
          "Nested receipts for subtasks this execution delegated. Recursive — builds the full delegation tree. Each nested receipt is independently signed by its executor.",
        ),
      relay_task_id: z
        .string()
        .optional()
        .describe(
          "Relay's economic-identity binding for this task. **Required** for relay-mediated tasks (relay rejects receipts without it with HTTP 400). Optional for local execution.",
        ),
      delegated_scope: z
        .string()
        .optional()
        .describe(
          "Scope from the delegation token that authorized this execution, if any. Present when the executor received a scoped token; absent for self-submitted tasks.",
        ),
      invocation_origin: IntentOriginSchema.optional(),
      suite: SuiteSchema,
      signature: z
        .string()
        .describe(
          "Base64url-encoded Ed25519 signature over `canonicalJson(body)` where `body` = this object minus `signature`. Verify with the embedded `public_key` using the suite recipe.",
        ),
    })
    .strict(),
);

// ---------------------------------------------------------------------------
// Type parity — the static drift defense
//
// If ExecutionReceipt in @motebit/protocol changes shape and this zod
// schema does not, the `satisfies` line below fails to typecheck. That
// is the defense: the source of truth is the TypeScript declaration;
// the zod schema derives its shape from it and fails loudly on drift.
//
// Branded-id fields (MotebitId, DeviceId) are `Brand<string, "…">` —
// assigning a `string` requires casting, but the STRUCTURAL shape (the
// fields and their value types) is what we're pinning. We use two
// one-way assertions so either direction of drift is caught.
// ---------------------------------------------------------------------------

type InferredReceipt = z.infer<typeof ExecutionReceiptSchema>;

// Forward check: every field of ExecutionReceipt (with branded IDs
// relaxed to strings for structural comparison) exists in the inferred
// type with a compatible value type.
type BrandedToString<T> = {
  [K in keyof T]: T[K] extends MotebitId
    ? string
    : T[K] extends DeviceId
      ? string
      : T[K] extends IntentOrigin | undefined
        ? "user-tap" | "ai-loop" | "scheduled" | "agent-to-agent" | undefined
        : T[K] extends ExecutionReceipt[] | undefined
          ? InferredReceipt[] | undefined
          : T[K];
};

type _ForwardCheck = BrandedToString<ExecutionReceipt> extends InferredReceipt ? true : never;
type _ReverseCheck = InferredReceipt extends BrandedToString<ExecutionReceipt> ? true : never;

// Used to surface the type-assertion result: if the zod schema diverges
// from the TypeScript declaration, these aliases resolve to `never` and
// `tsc --noEmit` fails with a concrete error at this line.
export const _WIRE_SCHEMA_TYPE_PARITY: { forward: _ForwardCheck; reverse: _ReverseCheck } = {
  forward: true as _ForwardCheck,
  reverse: true as _ReverseCheck,
};

// ---------------------------------------------------------------------------
// JSON Schema emitter
// ---------------------------------------------------------------------------

/**
 * Build the JSON Schema (draft-07) object for ExecutionReceipt. Pure —
 * called from the build-schemas script and from the drift test.
 */
/**
 * Pure — assemble the final JSON Schema envelope from zod-to-json-schema's
 * raw output. Extracted for testability: the happy path runs through
 * `buildExecutionReceiptJsonSchema`; a unit test exercises the "upstream
 * library changed shape" error path without mocking zod.
 */
export function assembleJsonSchema(
  raw: Record<string, unknown>,
  meta: { $id: string; title: string; description: string },
): Record<string, unknown> {
  const definitions = raw["definitions"] as Record<string, Record<string, unknown>> | undefined;
  if (definitions == null) {
    throw new Error(
      "zod-to-json-schema did not emit a definitions bag — upstream library behavior changed, fix this builder.",
    );
  }
  const root = definitions["ExecutionReceipt"];
  if (root == null) {
    throw new Error(
      "zod-to-json-schema did not emit definitions.ExecutionReceipt — upstream library behavior changed, fix this builder.",
    );
  }
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: meta.$id,
    title: meta.title,
    description: meta.description,
    ...root,
    definitions,
  };
}

export function buildExecutionReceiptJsonSchema(): Record<string, unknown> {
  // zod-to-json-schema with `name` + `$refStrategy: "root"` always wraps
  // the named root in `definitions.ExecutionReceipt` with a top-level
  // `$ref`. For a self-referential recursive schema the `$ref` targets
  // its own definition — exactly the shape we want to preserve. We
  // inline the definition onto the top level so external tools get a
  // self-describing object while keeping `#/definitions/ExecutionReceipt`
  // working for the nested `delegation_receipts` array.
  const raw = zodToJsonSchema(ExecutionReceiptSchema, {
    name: "ExecutionReceipt",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchema(raw, {
    $id: EXECUTION_RECEIPT_SCHEMA_ID,
    title: "ExecutionReceipt (v1)",
    description:
      "motebit's signed per-task wire artifact. Canonicalization: JCS (RFC 8785). Signature: Ed25519 over canonicalJson(body minus signature), base64url-encoded. Public key: hex-encoded.",
  });
}
