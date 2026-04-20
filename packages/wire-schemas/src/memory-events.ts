/**
 * Memory event payload schemas — wire artifacts for `memory-delta-v1.md`.
 *
 * Seven event-shaped payloads. Six are runtime-observable across the
 * sync path (memory_formed / memory_accessed / memory_pinned /
 * memory_deleted / memory_consolidated / memory_decayed) — the
 * seventh (`memory_audit`) is local-only by protocol but still has a
 * schema so implementations can validate it at emission time. A
 * non-motebit implementer (Python sync daemon, Go federation peer)
 * fetches these JSON Schemas at their stable `$id` URLs and validates
 * payloads without bundling motebit TypeScript.
 *
 * Every schema has:
 *   - A `.passthrough()` envelope — forward-compat: v2 peers adding
 *     fields don't break v1 validators.
 *   - A `_TYPE_PARITY` compile-time assertion — zod shape drifting
 *     from the `@motebit/protocol` type breaks `tsc`.
 *   - A `buildXxxJsonSchema()` emitter called by the build-schemas
 *     script to refresh the committed JSON artifact.
 *
 * See `spec/memory-delta-v1.md` §5 for the normative field list and
 * sensitivity-redaction contract.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type {
  MemoryFormedPayload,
  MemoryAccessedPayload,
  MemoryPinnedPayload,
  MemoryDeletedPayload,
  MemoryConsolidatedPayload,
  MemoryAuditPayload,
  MemoryDecayedPayload,
  MemoryPromotedPayload,
} from "@motebit/protocol";

import { assembleJsonSchemaFor } from "./assemble.js";

const SCHEMA_BASE =
  "https://raw.githubusercontent.com/motebit/motebit/main/packages/wire-schemas/schema";

// ── SensitivityLevel (closed enum) ───────────────────────────────────

const SensitivityLevelSchema = z
  .enum(["none", "personal", "medical", "financial", "secret"])
  .describe(
    "Sensitivity classification used by sync forwarders to decide whether to redact memory content before crossing a device boundary. Emitter-authored; not forwarder-mutable.",
  );

// ── 5.1 MemoryFormedPayload ──────────────────────────────────────────

export const MEMORY_FORMED_PAYLOAD_SCHEMA_ID = `${SCHEMA_BASE}/memory-formed-payload-v1.json`;

export const MemoryFormedPayloadSchema = z
  .object({
    node_id: z
      .string()
      .min(1)
      .describe("UUID v4 of the newly-formed memory node. Unique per emitter."),
    content: z
      .string()
      .describe(
        'Textual content. MAY be replaced with "[REDACTED]" by a sync forwarder when `sensitivity` exceeds the forwarder policy.',
      ),
    sensitivity: SensitivityLevelSchema,
    redacted: z
      .literal(true)
      .optional()
      .describe(
        "Present only on the wire when a sync forwarder has replaced `content`. Original events MUST NOT carry this field.",
      ),
    redacted_sensitivity: SensitivityLevelSchema.optional().describe(
      "Original sensitivity retained after redaction so downstream receivers honor policy without seeing content.",
    ),
  })
  .passthrough();

type InferredMemoryFormed = z.infer<typeof MemoryFormedPayloadSchema>;
type _MemoryFormedForward = MemoryFormedPayload extends InferredMemoryFormed ? true : never;
type _MemoryFormedReverse = InferredMemoryFormed extends MemoryFormedPayload ? true : never;
export const _MEMORY_FORMED_PAYLOAD_TYPE_PARITY: {
  forward: _MemoryFormedForward;
  reverse: _MemoryFormedReverse;
} = {
  forward: true as _MemoryFormedForward,
  reverse: true as _MemoryFormedReverse,
};

export function buildMemoryFormedPayloadJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(MemoryFormedPayloadSchema, {
    name: "MemoryFormedPayload",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("MemoryFormedPayload", raw, {
    $id: MEMORY_FORMED_PAYLOAD_SCHEMA_ID,
    title: "MemoryFormedPayload (v1)",
    description:
      "Payload of a `memory_formed` event — a new memory node with its declared sensitivity. See spec/memory-delta-v1.md §5.1.",
  });
}

// ── 5.2 MemoryAccessedPayload ────────────────────────────────────────

export const MEMORY_ACCESSED_PAYLOAD_SCHEMA_ID = `${SCHEMA_BASE}/memory-accessed-payload-v1.json`;

export const MemoryAccessedPayloadSchema = z
  .object({
    node_id: z.string().min(1).describe("UUID of the accessed node."),
  })
  .passthrough();

type InferredMemoryAccessed = z.infer<typeof MemoryAccessedPayloadSchema>;
type _MemoryAccessedForward = MemoryAccessedPayload extends InferredMemoryAccessed ? true : never;
type _MemoryAccessedReverse = InferredMemoryAccessed extends MemoryAccessedPayload ? true : never;
export const _MEMORY_ACCESSED_PAYLOAD_TYPE_PARITY: {
  forward: _MemoryAccessedForward;
  reverse: _MemoryAccessedReverse;
} = {
  forward: true as _MemoryAccessedForward,
  reverse: true as _MemoryAccessedReverse,
};

export function buildMemoryAccessedPayloadJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(MemoryAccessedPayloadSchema, {
    name: "MemoryAccessedPayload",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("MemoryAccessedPayload", raw, {
    $id: MEMORY_ACCESSED_PAYLOAD_SCHEMA_ID,
    title: "MemoryAccessedPayload (v1)",
    description:
      "Payload of a `memory_accessed` event — emitted when a live node is read for recall, reflection, or consolidation. See spec/memory-delta-v1.md §5.2.",
  });
}

// ── 5.3 MemoryPinnedPayload ──────────────────────────────────────────

export const MEMORY_PINNED_PAYLOAD_SCHEMA_ID = `${SCHEMA_BASE}/memory-pinned-payload-v1.json`;

export const MemoryPinnedPayloadSchema = z
  .object({
    node_id: z.string().min(1).describe("UUID of the affected node."),
    pinned: z
      .boolean()
      .describe("True when the node is now pinned, false when unpinned. Most-recent-event wins."),
  })
  .passthrough();

type InferredMemoryPinned = z.infer<typeof MemoryPinnedPayloadSchema>;
type _MemoryPinnedForward = MemoryPinnedPayload extends InferredMemoryPinned ? true : never;
type _MemoryPinnedReverse = InferredMemoryPinned extends MemoryPinnedPayload ? true : never;
export const _MEMORY_PINNED_PAYLOAD_TYPE_PARITY: {
  forward: _MemoryPinnedForward;
  reverse: _MemoryPinnedReverse;
} = {
  forward: true as _MemoryPinnedForward,
  reverse: true as _MemoryPinnedReverse,
};

export function buildMemoryPinnedPayloadJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(MemoryPinnedPayloadSchema, {
    name: "MemoryPinnedPayload",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("MemoryPinnedPayload", raw, {
    $id: MEMORY_PINNED_PAYLOAD_SCHEMA_ID,
    title: "MemoryPinnedPayload (v1)",
    description:
      "Payload of a `memory_pinned` event — toggles a node's pinned state. Pinned nodes are exempt from decay pruning and phantom-certainty flagging. See spec/memory-delta-v1.md §5.3.",
  });
}

// ── 5.4 MemoryDeletedPayload ─────────────────────────────────────────

export const MEMORY_DELETED_PAYLOAD_SCHEMA_ID = `${SCHEMA_BASE}/memory-deleted-payload-v1.json`;

export const MemoryDeletedPayloadSchema = z
  .object({
    node_id: z.string().min(1).describe("UUID of the deleted node. Tombstones it in-log."),
  })
  .passthrough();

type InferredMemoryDeleted = z.infer<typeof MemoryDeletedPayloadSchema>;
type _MemoryDeletedForward = MemoryDeletedPayload extends InferredMemoryDeleted ? true : never;
type _MemoryDeletedReverse = InferredMemoryDeleted extends MemoryDeletedPayload ? true : never;
export const _MEMORY_DELETED_PAYLOAD_TYPE_PARITY: {
  forward: _MemoryDeletedForward;
  reverse: _MemoryDeletedReverse;
} = {
  forward: true as _MemoryDeletedForward,
  reverse: true as _MemoryDeletedReverse,
};

export function buildMemoryDeletedPayloadJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(MemoryDeletedPayloadSchema, {
    name: "MemoryDeletedPayload",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("MemoryDeletedPayload", raw, {
    $id: MEMORY_DELETED_PAYLOAD_SCHEMA_ID,
    title: "MemoryDeletedPayload (v1)",
    description:
      "Payload of a `memory_deleted` event — tombstones a node; the original memory_formed event persists. See spec/memory-delta-v1.md §5.4.",
  });
}

// ── 5.5 MemoryConsolidatedPayload ────────────────────────────────────

export const MEMORY_CONSOLIDATED_PAYLOAD_SCHEMA_ID = `${SCHEMA_BASE}/memory-consolidated-payload-v1.json`;

const ConsolidationActionSchema = z
  .enum(["merge", "supersede", "reject", "accept"])
  .describe(
    "Consolidation decision taxonomy, mirroring @motebit/memory-graph's ConsolidationDecision.action.",
  );

export const MemoryConsolidatedPayloadSchema = z
  .object({
    action: ConsolidationActionSchema,
    existing_node_id: z
      .string()
      .min(1)
      .nullable()
      .describe(
        'UUID of the node being merged-into or superseded. `null` for "accept" and "reject".',
      ),
    new_node_id: z
      .string()
      .min(1)
      .nullable()
      .describe(
        'UUID of the newly-formed node when one was created. `null` for "reject" and supersede-in-place.',
      ),
    reason: z
      .string()
      .describe(
        "Free-text rationale from the consolidation decider. Consumers MUST NOT parse it semantically.",
      ),
  })
  .passthrough();

type InferredMemoryConsolidated = z.infer<typeof MemoryConsolidatedPayloadSchema>;
type _MemoryConsolidatedForward = MemoryConsolidatedPayload extends InferredMemoryConsolidated
  ? true
  : never;
type _MemoryConsolidatedReverse = InferredMemoryConsolidated extends MemoryConsolidatedPayload
  ? true
  : never;
export const _MEMORY_CONSOLIDATED_PAYLOAD_TYPE_PARITY: {
  forward: _MemoryConsolidatedForward;
  reverse: _MemoryConsolidatedReverse;
} = {
  forward: true as _MemoryConsolidatedForward,
  reverse: true as _MemoryConsolidatedReverse,
};

export function buildMemoryConsolidatedPayloadJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(MemoryConsolidatedPayloadSchema, {
    name: "MemoryConsolidatedPayload",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("MemoryConsolidatedPayload", raw, {
    $id: MEMORY_CONSOLIDATED_PAYLOAD_SCHEMA_ID,
    title: "MemoryConsolidatedPayload (v1)",
    description:
      "Payload of a `memory_consolidated` event — records a merge/supersede/reject/accept outcome from consolidation. See spec/memory-delta-v1.md §5.5.",
  });
}

// ── 5.6 MemoryAuditPayload ───────────────────────────────────────────

export const MEMORY_AUDIT_PAYLOAD_SCHEMA_ID = `${SCHEMA_BASE}/memory-audit-payload-v1.json`;

export const MemoryAuditPayloadSchema = z
  .object({
    missed_patterns: z
      .array(SensitivityLevelSchema)
      .describe(
        "Sensitivity classifications the ai-core heuristic believes apply to the current turn but weren't tagged on the resulting memory.",
      ),
    turn_message: z
      .string()
      .max(200)
      .describe(
        "Up to 200 characters of the triggering user message. Implementations MUST truncate at emission.",
      ),
  })
  .passthrough();

type InferredMemoryAudit = z.infer<typeof MemoryAuditPayloadSchema>;
type _MemoryAuditForward = MemoryAuditPayload extends InferredMemoryAudit ? true : never;
type _MemoryAuditReverse = InferredMemoryAudit extends MemoryAuditPayload ? true : never;
export const _MEMORY_AUDIT_PAYLOAD_TYPE_PARITY: {
  forward: _MemoryAuditForward;
  reverse: _MemoryAuditReverse;
} = {
  forward: true as _MemoryAuditForward,
  reverse: true as _MemoryAuditReverse,
};

export function buildMemoryAuditPayloadJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(MemoryAuditPayloadSchema, {
    name: "MemoryAuditPayload",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("MemoryAuditPayload", raw, {
    $id: MEMORY_AUDIT_PAYLOAD_SCHEMA_ID,
    title: "MemoryAuditPayload (v1)",
    description:
      "Payload of a `memory_audit` event — ai-core's detection of missed sensitivity tagging. Local-only by protocol (§3 of spec/memory-delta-v1.md §5.6).",
  });
}

// ── 5.7 MemoryDecayedPayload (reserved) ──────────────────────────────

export const MEMORY_DECAYED_PAYLOAD_SCHEMA_ID = `${SCHEMA_BASE}/memory-decayed-payload-v1.json`;

export const MemoryDecayedPayloadSchema = z.object({}).passthrough();

type InferredMemoryDecayed = z.infer<typeof MemoryDecayedPayloadSchema>;
type _MemoryDecayedForward = MemoryDecayedPayload extends InferredMemoryDecayed ? true : never;
// Reserved / empty record has no reverse parity obligation beyond
// structural match; the forward check is sufficient.

export const _MEMORY_DECAYED_PAYLOAD_TYPE_PARITY: {
  forward: _MemoryDecayedForward;
} = {
  forward: true as _MemoryDecayedForward,
};

export function buildMemoryDecayedPayloadJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(MemoryDecayedPayloadSchema, {
    name: "MemoryDecayedPayload",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("MemoryDecayedPayload", raw, {
    $id: MEMORY_DECAYED_PAYLOAD_SCHEMA_ID,
    title: "MemoryDecayedPayload (v1)",
    description:
      "Payload of a `memory_decayed` event — reserved for future use. No emitter today; receivers MUST accept without assuming a shape. See spec/memory-delta-v1.md §5.7.",
  });
}

// ── 5.8 MemoryPromotedPayload ────────────────────────────────────────

export const MEMORY_PROMOTED_PAYLOAD_SCHEMA_ID = `${SCHEMA_BASE}/memory-promoted-payload-v1.json`;

export const MemoryPromotedPayloadSchema = z
  .object({
    node_id: z.string().min(1).describe("UUID of the promoted node."),
    from_confidence: z.number().min(0).max(1).describe("Confidence score before promotion."),
    to_confidence: z
      .number()
      .min(0)
      .max(1)
      .describe("Confidence score after promotion. Typically 1.0."),
    reinforcement_count: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Count of consolidation reinforcement events against this node before the promotion fired.",
      ),
    reason: z
      .string()
      .describe("Free-text rationale from the promoter. Consumers MUST NOT parse it semantically."),
  })
  .passthrough();

type InferredMemoryPromoted = z.infer<typeof MemoryPromotedPayloadSchema>;
type _MemoryPromotedForward = MemoryPromotedPayload extends InferredMemoryPromoted ? true : never;
type _MemoryPromotedReverse = InferredMemoryPromoted extends MemoryPromotedPayload ? true : never;
export const _MEMORY_PROMOTED_PAYLOAD_TYPE_PARITY: {
  forward: _MemoryPromotedForward;
  reverse: _MemoryPromotedReverse;
} = {
  forward: true as _MemoryPromotedForward,
  reverse: true as _MemoryPromotedReverse,
};

export function buildMemoryPromotedPayloadJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(MemoryPromotedPayloadSchema, {
    name: "MemoryPromotedPayload",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("MemoryPromotedPayload", raw, {
    $id: MEMORY_PROMOTED_PAYLOAD_SCHEMA_ID,
    title: "MemoryPromotedPayload (v1)",
    description:
      "Payload of a `memory_promoted` event — discrete tentative→absolute transition after enough reinforcement. See spec/memory-delta-v1.md §5.8.",
  });
}
