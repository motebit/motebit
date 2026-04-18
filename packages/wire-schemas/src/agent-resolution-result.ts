/**
 * AgentResolutionResult — wire schema.
 *
 * The relay's response shape for `GET /api/v1/discover/{motebitId}`.
 * Every external client that calls discovery parses this; making it a
 * fetchable JSON Schema means a Python client SDK, a Go test harness,
 * or a third-party dashboard can validate the response without
 * bundling motebit's TypeScript types.
 *
 * Federation rules embedded in the type:
 *   - `resolved_via` carries the audit trail of relay_ids traversed —
 *     loop prevention requires the caller forward this set when
 *     re-querying a federated peer.
 *   - `cached` flags whether the result is fresh (queried) or
 *     reused from a previous resolution within `ttl` seconds.
 *   - `settlement_modes` defaults to `["relay"]` when absent — the
 *     wire schema preserves the absence (optional field) and lets the
 *     caller apply the default; encoding the default in the schema
 *     would lose the "agent didn't declare" signal.
 *
 * See spec/discovery-v1.md §5.1 for the full specification.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { AgentResolutionResult } from "@motebit/protocol";

import { assembleJsonSchemaFor } from "./assemble.js";

/** Stable `$id` for the agent-resolution-result v1 wire format. */
export const AGENT_RESOLUTION_RESULT_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/packages/wire-schemas/schema/agent-resolution-result-v1.json";

export const AgentResolutionResultSchema = z
  .object({
    motebit_id: z
      .string()
      .min(1)
      .describe(
        "The queried agent's motebit identity (UUIDv7). Always present, regardless of `found`.",
      ),
    found: z
      .boolean()
      .describe(
        "True when the agent was located somewhere in the federation. False when no relay (local or peer) hosts the agent — in that case all `if found` fields are absent.",
      ),
    relay_id: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Hosting relay's motebit identity. Required when `found` is true; omitted when not found.",
      ),
    relay_url: z
      .string()
      .url()
      .optional()
      .describe(
        "HTTPS endpoint of the hosting relay. Required when `found` is true; omitted when not found. Clients dial this URL for downstream task submission.",
      ),
    capabilities: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "Agent's advertised capabilities. Optional even when found — an agent may advertise no capabilities yet still be addressable.",
      ),
    public_key: z
      .string()
      .optional()
      .describe(
        "Agent's hex-encoded Ed25519 public key. Required when `found` is true so callers can verify subsequent receipts without a second relay round-trip.",
      ),
    settlement_address: z
      .string()
      .optional()
      .describe(
        "Agent's declared settlement address (e.g. Solana base58). Explicit field — NOT inferred from `public_key`. Absent when the agent has not declared an on-chain payout target.",
      ),
    settlement_modes: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'Settlement modes the agent accepts. Each element is conventionally `relay` or `p2p`. Absent ≡ default `["relay"]` per spec; absence is meaningful and preserved on the wire.',
      ),
    resolved_via: z
      .array(z.string().min(1))
      .describe(
        "Audit trail of relay_ids traversed during resolution, in walk order. Loop prevention: callers re-querying a federated peer MUST forward this set so the peer can refuse to re-process.",
      ),
    cached: z
      .boolean()
      .describe(
        "True if the result came from the resolving relay's cache rather than a live query. Combined with `ttl` lets callers decide whether to trust the freshness.",
      ),
    ttl: z
      .number()
      .describe(
        "Seconds until this result should be re-resolved. Caller-side cache hint; the resolving relay does not enforce it.",
      ),
  })
  .strict();

// ---------------------------------------------------------------------------
// Type parity — drift defense #22 compile-time half
// ---------------------------------------------------------------------------

type InferredResult = z.infer<typeof AgentResolutionResultSchema>;

type _ForwardCheck = AgentResolutionResult extends InferredResult ? true : never;
type _ReverseCheck = InferredResult extends AgentResolutionResult ? true : never;

export const _AGENT_RESOLUTION_RESULT_TYPE_PARITY: {
  forward: _ForwardCheck;
  reverse: _ReverseCheck;
} = {
  forward: true as _ForwardCheck,
  reverse: true as _ReverseCheck,
};

// ---------------------------------------------------------------------------
// JSON Schema emitter
// ---------------------------------------------------------------------------

export function buildAgentResolutionResultJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(AgentResolutionResultSchema, {
    name: "AgentResolutionResult",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("AgentResolutionResult", raw, {
    $id: AGENT_RESOLUTION_RESULT_SCHEMA_ID,
    title: "AgentResolutionResult (v1)",
    description:
      "Relay's response shape for GET /api/v1/discover/{motebitId} — locates an agent across the federation, including resolution audit trail and freshness signals. See spec/discovery-v1.md §5.1.",
  });
}
