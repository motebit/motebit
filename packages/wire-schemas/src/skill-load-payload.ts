/**
 * Skill Load Payload — wire schema (spec/skills-v1.md §7.4).
 *
 * Per-skill audit detail emitted as `EventType.SkillLoaded` event-log
 * entries. The runtime appends one event per skill the `SkillSelector`
 * pulls into context, immediately after the selector returns and before
 * the AI loop receives the system prompt. The event-log envelope
 * (`event_id`, `motebit_id`, `timestamp`, `tombstoned`) is the existing
 * `EventLogEntry` shape; this schema covers the per-skill payload only.
 *
 * Audit utility: a stale ledger entry whose `skill_signature` does not
 * resolve in the current registry is itself a useful signal — the skill
 * was re-signed (legitimate update) or removed (less common). Both
 * provable from the audit trail without retaining the original bytes.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { SkillLoadPayload } from "@motebit/protocol";

import { assembleJsonSchemaFor } from "./assemble.js";

/** Stable `$id` for the skill-load-payload v1 wire format. */
export const SKILL_LOAD_PAYLOAD_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/skill-load-payload-v1.json";

const SkillSensitivitySchema = z
  .enum(["none", "personal", "medical", "financial", "secret"])
  .describe("Session sensitivity tier in effect when the skill loaded.");

export const SkillLoadPayloadSchema = z
  .object({
    skill_id: z
      .string()
      .min(1)
      .describe('Composite identifier `"name@version"`. Convenient for log queries.'),
    skill_name: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .describe("Skill slug. Matches `SkillManifest.name`."),
    skill_version: z.string().min(1).describe("Skill SemVer. Matches `SkillManifest.version`."),
    skill_signature: z
      .string()
      .describe(
        "Base64url envelope `signature.value`. Empty string when manifest is `trusted_unsigned` (no cryptographic signature exists). Pins the audit entry to exact bytes — re-signing produces a new value.",
      ),
    provenance: z
      .enum(["verified", "trusted_unsigned"])
      .describe(
        "Provenance status at load time. Display-grade copy of the runtime's `SkillProvenanceStatus`.",
      ),
    score: z
      .number()
      .describe(
        "BM25 relevance score against the user's turn. Higher = more relevant. Selector threshold is 0.0001 (§7.2).",
      ),
    run_id: z
      .string()
      .optional()
      .describe(
        "Run identifier the load was keyed to. Matches `runId` on `runtime.sendMessage`. Optional — proactive-cycle loads (future) may have no explicit run context.",
      ),
    session_sensitivity: SkillSensitivitySchema,
  })
  .strict();

// Type parity — drift defense
type InferredSkillLoadPayload = z.infer<typeof SkillLoadPayloadSchema>;

type _ForwardCheck = SkillLoadPayload extends InferredSkillLoadPayload ? true : never;
type _ReverseCheck = InferredSkillLoadPayload extends SkillLoadPayload ? true : never;

export const _SKILL_LOAD_PAYLOAD_TYPE_PARITY: {
  forward: _ForwardCheck;
  reverse: _ReverseCheck;
} = {
  forward: true as _ForwardCheck,
  reverse: true as _ReverseCheck,
};

export function buildSkillLoadPayloadJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(SkillLoadPayloadSchema, {
    name: "SkillLoadPayload",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("SkillLoadPayload", raw, {
    $id: SKILL_LOAD_PAYLOAD_SCHEMA_ID,
    title: "SkillLoadPayload (v1)",
    description:
      "Per-skill audit payload for `EventType.SkillLoaded` event-log entries. Emitted by the runtime when the SkillSelector pulls a skill body into the system context. Spec: https://raw.githubusercontent.com/motebit/motebit/main/spec/skills-v1.md",
  });
}
