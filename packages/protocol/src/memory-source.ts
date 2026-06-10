/**
 * Memory source types — provenance classification for memory formation.
 *
 * Permissive floor (Apache-2.0): these types define the interoperable
 * vocabulary for memory provenance — WHO contributed a remembered fact.
 * A memory formed from a web page, a peer agent's message, or a tool
 * result must be distinguishable from one the user stated directly;
 * without this field, absorbed third-party content is byte-identical to
 * durable user intent, which is the persistent-prompt-injection and
 * hallucinated-authority channel the provenance arc closes.
 *
 * Assignment rule (interop law, enforced by `check-memory-source-canonical`):
 * `source` is assigned by the FORMING CODE PATH — never parsed from model
 * output, never accepted from a peer's self-declaration. The model's
 * `<memory>` tag carries no source attribute; the MCP server hard-codes
 * `peer_agent` for remote writes. A source the subject did not assign is
 * not provenance, it's a claim.
 *
 * Doctrine: `docs/doctrine/memory-provenance.md`.
 */

// === Memory Source ===

/**
 * Provenance of a memory node — the origin that contributed the fact.
 *
 * - `user_stated` — the user told the agent directly in conversation.
 * - `agent_inferred` — the reflection engine synthesized it from
 *   observation patterns (carries `DerivedFrom` edges to antecedents).
 * - `tool_derived` — formed in a turn whose content came through tool
 *   results (web pages, files, MCP tools) — an unverified external claim.
 * - `peer_agent` — written by a remote agent through the MCP server.
 * - `consolidation_derived` — synthesized by the idle consolidation
 *   cycle from an episodic cluster (carries `PartOf` edges to members).
 */
export type MemorySource =
  | "user_stated"
  | "agent_inferred"
  | "tool_derived"
  | "peer_agent"
  | "consolidation_derived";

/**
 * Canonical iteration order over `MemorySource`, frozen. The single
 * source of truth for "every memory source" — drift gates, exhaustive
 * switches, render maps, and the registry-coverage gate
 * (`check-memory-source-canonical`) all enumerate through this array.
 *
 * Promoted to a registered registry per
 * [`docs/doctrine/registry-pattern-canonical.md`](../../../docs/doctrine/registry-pattern-canonical.md)
 * on 2026-06-10 — the tenth instance. The four criteria are met:
 * interop law (peers must agree on the provenance vocabulary for
 * synced memories to keep their epistemic standing), multi-consumer
 * (ai-core, memory-graph, persistence, runtime, reflection,
 * mcp-server, panels), wire-format presence
 * (`MemoryFormedPayload.source`), anticipated drift (the vocabulary
 * grows with new ingestion paths — `web_content` split out of
 * `tool_derived` when the loop can distinguish them, voice, sensors).
 *
 * Same shape as `ALL_SUITE_IDS`, `ALL_TOKEN_AUDIENCES`,
 * `ALL_CONTENT_ARTIFACT_TYPES`, `ALL_TASK_SHAPES`,
 * `ALL_SENSITIVITY_LEVELS`, `ALL_EVENT_TYPES`, `ALL_SETTLEMENT_MODES`.
 * Adding a memory source is intentional protocol-level work: new union
 * entry + new entry here + `MEMORY_SOURCE_MARKERS` entry (the
 * `Record<MemorySource, string>` makes omission a compile error) +
 * gate reference update + spec update.
 */
export const ALL_MEMORY_SOURCES: readonly MemorySource[] = Object.freeze([
  "user_stated",
  "agent_inferred",
  "tool_derived",
  "peer_agent",
  "consolidation_derived",
] as MemorySource[]);

/**
 * Type guard — narrows `unknown` to `MemorySource`. Consumers that
 * derive source values from external input (synced wire payloads,
 * stored rows, peer messages) call this before trusting the value;
 * unknown values degrade to `undefined` (rendered as provenance
 * `unknown`), never to a trusted tier like `user_stated`.
 *
 * Same shape as `isSuiteId`, `isSensitivityLevel`, `isEventType`,
 * `isSettlementMode`.
 */
export function isMemorySource(value: unknown): value is MemorySource {
  return typeof value === "string" && (ALL_MEMORY_SOURCES as readonly string[]).includes(value);
}

/**
 * Canonical short render markers for prompt surfaces — the `[from:X]`
 * labels the model and panel surfaces show next to a memory. A
 * `Record<MemorySource, string>` so a registry append without a marker
 * is a compile error (the render map cannot silently lag the registry).
 *
 * A node with NO source field (formed before provenance tracking, or
 * synced from a peer with an unknown vocabulary) renders as
 * `"unknown"` — honestly absent, never fabricated.
 */
export const MEMORY_SOURCE_MARKERS: Readonly<Record<MemorySource, string>> = Object.freeze({
  user_stated: "user",
  agent_inferred: "inference",
  tool_derived: "tool",
  peer_agent: "peer-agent",
  consolidation_derived: "consolidation",
});

/** Render marker for nodes without a known source. */
export const MEMORY_SOURCE_MARKER_UNKNOWN = "unknown";
