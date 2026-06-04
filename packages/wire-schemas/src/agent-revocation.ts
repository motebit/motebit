/**
 * Agent-revocation wire schemas — the operator's de-list power, sovereign-verifiable.
 *
 * `AgentRevocationRecord` is one signed state change (de-list / reinstate);
 * `AgentRevocationFeed` is the relay's signed, append-only moderation history
 * served at `GET /api/v1/agents/revocations`. Both sign under
 * `motebit-jcs-ed25519-hex-v1` (HEX encoding, like the transparency
 * declaration + credential anchors) against the relay's pinned key.
 *
 * See `spec/agent-revocation-v1.md`.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { AgentRevocationRecord, AgentRevocationFeed } from "@motebit/protocol";

import { assembleJsonSchemaFor } from "./assemble.js";
import type { ParityForward, ParityReverse } from "./__parity/check.js";

// ---------------------------------------------------------------------------
// Stable $id URLs
// ---------------------------------------------------------------------------

export const AGENT_REVOCATION_RECORD_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/agent-revocation-record-v1.json";

export const AGENT_REVOCATION_FEED_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/agent-revocation-feed-v1.json";

// ---------------------------------------------------------------------------
// Leaf vocabularies
// ---------------------------------------------------------------------------

const AgentRevocationReasonSchema = z
  .enum([
    "operator_test_cleanup",
    "spam",
    "abuse",
    "malware",
    "policy_violation",
    "dmca",
    "reinstated",
  ])
  .describe(
    "Categorized reason (`AgentRevocationReason`). `reinstated` accompanies a reinstatement (`revoked: false`).",
  );

const AgentRevocationActorSchema = z
  .enum(["operator", "self"])
  .describe(
    "Who performed the change. `operator` = master-token hygiene; `self` = the agent itself.",
  );

// ---------------------------------------------------------------------------
// AgentRevocationRecord
// ---------------------------------------------------------------------------

export const AgentRevocationRecordSchema = z
  .object({
    spec: z
      .string()
      .min(1)
      .describe("Spec identifier — e.g. `motebit-agent-revocation/draft-2026-06-04`."),
    motebit_id: z.string().min(1).describe("The agent whose discoverability changed."),
    revoked: z
      .boolean()
      .describe("Resulting state: `true` = de-listed from Discover, `false` = reinstated."),
    reason: AgentRevocationReasonSchema,
    actor: AgentRevocationActorSchema,
    note: z
      .string()
      .optional()
      .describe("Optional free-text operator note. Not a substitute for `reason`."),
    effective_at: z.number().describe("Epoch milliseconds when the change took effect."),
    relay_id: z.string().min(1).describe("The relay's MotebitId."),
    relay_public_key: z
      .string()
      .regex(/^[0-9a-f]{64}$/, "relay_public_key MUST be 64 lowercase hex characters")
      .describe("Hex-encoded Ed25519 public key (32 bytes / 64 chars) — the trust anchor."),
    hash: z
      .string()
      .regex(/^[0-9a-f]{64}$/, "hash MUST be 64 lowercase hex characters")
      .describe("Hex-encoded SHA-256 of `canonicalJson` of the signed payload."),
    suite: z
      .literal("motebit-jcs-ed25519-hex-v1")
      .describe("Cryptosuite — always `motebit-jcs-ed25519-hex-v1` (JCS, Ed25519, HEX encoding)."),
    signature: z
      .string()
      .min(1)
      .describe("Hex-encoded Ed25519 signature over the canonical-JSON signed payload."),
  })
  .strict();

type _InferredRecord = z.infer<typeof AgentRevocationRecordSchema>;
type _RecordForward = ParityForward<AgentRevocationRecord, _InferredRecord>;
type _RecordReverse = ParityReverse<AgentRevocationRecord, _InferredRecord>;

export const _AGENT_REVOCATION_RECORD_TYPE_PARITY: {
  forward: _RecordForward;
  reverse: _RecordReverse;
} = {
  forward: true,
  reverse: true,
};

export function buildAgentRevocationRecordJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(AgentRevocationRecordSchema, {
    name: "AgentRevocationRecord",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("AgentRevocationRecord", raw, {
    $id: AGENT_REVOCATION_RECORD_SCHEMA_ID,
    title: "AgentRevocationRecord (v1)",
    description:
      "One signed agent de-listing / reinstatement. Signed by `relay_public_key` over canonicalJson of every field except `hash`/`suite`/`signature`. De-list, not de-identify — the agent's identity, key, and receipts remain valid. See spec/agent-revocation-v1.md.",
  });
}

// ---------------------------------------------------------------------------
// AgentRevocationFeed
// ---------------------------------------------------------------------------

export const AgentRevocationFeedSchema = z
  .object({
    spec: z.string().min(1).describe("Spec identifier — matches the records' `spec`."),
    relay_id: z.string().min(1).describe("The relay's MotebitId."),
    relay_public_key: z
      .string()
      .regex(/^[0-9a-f]{64}$/, "relay_public_key MUST be 64 lowercase hex characters")
      .describe("Hex-encoded Ed25519 public key (32 bytes / 64 chars)."),
    generated_at: z.number().describe("Epoch milliseconds when the feed snapshot was minted."),
    records: z
      .array(AgentRevocationRecordSchema)
      .describe("Every revocation state change, oldest-first — the append-only history."),
    suite: z
      .literal("motebit-jcs-ed25519-hex-v1")
      .describe("Cryptosuite — always `motebit-jcs-ed25519-hex-v1`."),
    signature: z
      .string()
      .min(1)
      .describe(
        "Hex-encoded Ed25519 signature over canonicalJson({spec, relay_id, relay_public_key, generated_at, records}).",
      ),
  })
  .strict();

type _InferredFeed = z.infer<typeof AgentRevocationFeedSchema>;
type _FeedForward = ParityForward<AgentRevocationFeed, _InferredFeed>;
type _FeedReverse = ParityReverse<AgentRevocationFeed, _InferredFeed>;

export const _AGENT_REVOCATION_FEED_TYPE_PARITY: {
  forward: _FeedForward;
  reverse: _FeedReverse;
} = {
  forward: true,
  reverse: true,
};

export function buildAgentRevocationFeedJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(AgentRevocationFeedSchema, {
    name: "AgentRevocationFeed",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("AgentRevocationFeed", raw, {
    $id: AGENT_REVOCATION_FEED_SCHEMA_ID,
    title: "AgentRevocationFeed (v1)",
    description:
      "A relay's signed, append-only agent-revocation moderation history, served at GET /api/v1/agents/revocations. The feed digest is signed; each contained record is also independently signed. See spec/agent-revocation-v1.md.",
  });
}
