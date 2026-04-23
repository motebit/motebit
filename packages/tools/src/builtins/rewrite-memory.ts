/**
 * `rewrite_memory` — the agent's self-healing correction tool.
 *
 * When the motebit learns that a memory it holds is wrong (user
 * corrects them, a newer fact contradicts an older one, reflection
 * flags an outdated claim), the cleanest path is for the agent itself
 * to rewrite the stale entry in-conversation rather than let
 * housekeeping consolidation find it later.
 *
 * The tool accepts a short `node_id` (the 8-char prefix surfaced by
 * the Layer-1 memory index) plus the new content and a reason. The
 * handler resolves the short id against the full graph, emits a
 * `memory_consolidated` event with `action: "supersede"` (reusing the
 * existing wire format — no new event type needed), and the existing
 * memory-graph replay semantics tombstone the old node and pick up
 * the new one.
 *
 * Critical: the handler does NOT delete the original `memory_formed`
 * event. The event log is append-only per spec/memory-delta-v1.md
 * §3.1; supersede is expressed as a fresh event referencing the old
 * and new node ids. This preserves the sovereign audit guarantee
 * autoDream (Claude Code's file-rewriting equivalent) does not have.
 */

import type { ToolDefinition, ToolHandler } from "@motebit/sdk";

export const rewriteMemoryDefinition: ToolDefinition = {
  name: "rewrite_memory",
  mode: "api",
  description:
    "Correct a stale or incorrect memory by superseding it with new content. " +
    "Use when you discover a previously-formed memory is wrong — the user corrected " +
    "something, a newer fact contradicts an older one, or you realize your prior " +
    "claim was mistaken. Pass the 8-char short node id shown in the memory index " +
    "(the `[xxxxxxxx]` prefix). The original memory is tombstoned but preserved in " +
    "the event log for audit.",
  inputSchema: {
    type: "object",
    properties: {
      node_id: {
        type: "string",
        description:
          "The short node id (8-char prefix from the Memory Index) or full UUID of the memory to rewrite.",
      },
      new_content: {
        type: "string",
        description: "The corrected content that supersedes the stale memory.",
      },
      reason: {
        type: "string",
        description:
          "Why the rewrite is happening — user correction, newer evidence, prior error. Free text; consumers treat as opaque.",
      },
    },
    required: ["node_id", "new_content", "reason"],
  },
};

/**
 * Minimal interface the handler depends on — avoids a direct
 * `@motebit/memory-graph` dependency in `@motebit/tools` (different
 * layer). Callers wire a closure that resolves the short id and
 * supersedes through the graph's consolidation machinery.
 */
export interface RewriteMemoryDeps {
  /**
   * Resolve an 8-char prefix (or full UUID) to a full node id. Returns
   * null when no live (non-tombstoned) node matches, or when the
   * prefix is ambiguous across multiple live nodes.
   */
  resolveNodeId(
    shortIdOrUuid: string,
  ): Promise<
    | { kind: "ok"; nodeId: string }
    | { kind: "not_found" }
    | { kind: "ambiguous"; matches: string[] }
  >;
  /**
   * Supersede the named node with new content + reason. Implementation
   * tombstones the original and emits a `memory_consolidated` event
   * with `action: "supersede"`, plus a fresh `memory_formed` event for
   * the replacement. Returns the new node's id.
   */
  supersedeMemory(nodeId: string, newContent: string, reason: string): Promise<string>;
}

export function createRewriteMemoryHandler(deps: RewriteMemoryDeps): ToolHandler {
  return async (args) => {
    const nodeIdInput = args.node_id as string;
    const newContent = args.new_content as string;
    const reason = args.reason as string;

    if (!nodeIdInput) return { ok: false, error: "Missing required parameter: node_id" };
    if (!newContent) return { ok: false, error: "Missing required parameter: new_content" };
    if (!reason) return { ok: false, error: "Missing required parameter: reason" };

    try {
      const resolution = await deps.resolveNodeId(nodeIdInput.trim());
      switch (resolution.kind) {
        case "not_found":
          return {
            ok: false,
            error: `No live memory found matching "${nodeIdInput}". It may have already been superseded or deleted.`,
          };
        case "ambiguous":
          return {
            ok: false,
            error: `Short id "${nodeIdInput}" matches multiple memories: ${resolution.matches
              .map((m) => m.slice(0, 8))
              .join(", ")}. Use a longer prefix or the full UUID.`,
          };
        case "ok": {
          const newNodeId = await deps.supersedeMemory(resolution.nodeId, newContent, reason);
          return {
            ok: true,
            data: `Memory rewritten. Previous node ${resolution.nodeId.slice(0, 8)} tombstoned; replacement is ${newNodeId.slice(0, 8)}. Original event preserved in the log.`,
          };
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `rewrite_memory failed: ${msg}` };
    }
  };
}
