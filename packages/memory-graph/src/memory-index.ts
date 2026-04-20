/**
 * Memory Index — the always-loaded Layer-1 projection of motebit's
 * memory graph, injected into every AI turn's system prompt so the
 * agent has a cheap overview of what it knows without round-tripping
 * the retrieval path.
 *
 * Why this exists. Motebit's retrieval today runs `recallRelevant`
 * per turn — an embedding query against the memory store. That works
 * but has two costs: (1) the agent has no sense of what it knows
 * *generally* until it asks; (2) every turn pays the retrieval round
 * trip even when the user's question is unrelated to prior memory.
 *
 * The Layer-1 index is the fix. A compact (~2KB) list of one-line
 * pointers — `[node_id] topic summary (certainty)` — is built from
 * the live memory graph, sorted by "what matters to know you know,"
 * and folded into the system prompt at a stable offset for prompt
 * caching. Per-turn retrieval becomes Layer 2: pulled only when the
 * index indicates relevance; the index itself is the fast path.
 *
 * This mirrors the three-layer memory pattern revealed by the Claude
 * Code source leak, but sovereign: the index is a pure projection
 * over the user's event-sourced graph, with no telemetry, no vendor
 * round-trip, and no "self-healing" file rewrites. If the agent
 * corrects a memory, it does so via the explicit `rewrite_memory`
 * tool — a fresh `memory_consolidated` event, never a file mutation.
 *
 * The module is pure — no I/O. Callers (runtime context-packer)
 * supply the node + edge snapshot; the module scores, sorts, and
 * renders.
 */

import type { MemoryNode, MemoryEdge } from "@motebit/sdk";
import { computeDecayedConfidence } from "./index.js";

/**
 * Target byte budget for the rendered index. Defaults to 2 KB — small
 * enough to sit in every turn's system prompt without crowding the
 * context window, large enough to surface ~30–50 notable memories at
 * typical summary length. Callers MAY override; the rendered index
 * truncates at the first line boundary that would exceed the budget.
 */
export const DEFAULT_INDEX_BYTE_BUDGET = 2048;

/**
 * Certainty label surfaced on each index line. Derived from the
 * node's current confidence:
 *
 *   - `absolute`  — confidence ≥ 0.95 (crossed the promotion threshold
 *                   from `promotion.ts`).
 *   - `confident` — 0.7 ≤ confidence < 0.95.
 *   - `tentative` — confidence < 0.7.
 *
 * These map to the three states the agent cares about when citing
 * memory: ground truth, working belief, hypothesis.
 */
export type IndexCertainty = "absolute" | "confident" | "tentative";

export interface MemoryIndexOptions {
  /** Byte budget for the rendered index. Defaults to `DEFAULT_INDEX_BYTE_BUDGET`. */
  readonly maxBytes?: number;
  /** Unix ms clock override — used by tests for deterministic decay. */
  readonly nowMs?: number;
  /** Maximum characters per line summary. Defaults to 120. */
  readonly maxSummaryChars?: number;
}

export interface MemoryIndexEntry {
  readonly node: MemoryNode;
  readonly certainty: IndexCertainty;
  readonly score: number;
  readonly edgeCount: number;
  readonly decayedConfidence: number;
}

const DEFAULT_MAX_SUMMARY_CHARS = 120;

function resolveOptions(options?: MemoryIndexOptions): Required<MemoryIndexOptions> {
  return {
    maxBytes: options?.maxBytes ?? DEFAULT_INDEX_BYTE_BUDGET,
    nowMs: options?.nowMs ?? Date.now(),
    maxSummaryChars: options?.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS,
  };
}

function classifyCertainty(confidence: number): IndexCertainty {
  if (confidence >= 0.95) return "absolute";
  if (confidence >= 0.7) return "confident";
  return "tentative";
}

/**
 * Score a node for its value as a piece of "known knowledge." Distinct
 * from notability (which surfaces decay / conflict / phantom problems).
 * Here we're asking the opposite question: what does the agent have
 * the strongest ground to treat as part of its working model?
 *
 * Weights (deliberate):
 *   - `decayedConfidence` (0..1) — primary signal; post-decay
 *     confidence captures both baseline reliability and recent
 *     reinforcement.
 *   - `pinned` — flat bonus; explicit user pin is a hard signal.
 *   - `edgeCount` — logarithmic boost; well-connected memories
 *     anchor the graph and deserve index presence.
 */
function scoreForIndex(node: MemoryNode, edgeCount: number, decayedConfidence: number): number {
  const pinBonus = node.pinned ? 0.5 : 0;
  const connectivityBonus = Math.log1p(edgeCount) * 0.15;
  return decayedConfidence + pinBonus + connectivityBonus;
}

/**
 * Rank every live memory node by index-worthiness and return the top
 * entries up to the byte budget. Ranking is deterministic for a given
 * (nodes, edges, nowMs) tuple.
 */
export function rankIndexEntries(
  nodes: readonly MemoryNode[],
  edges: readonly MemoryEdge[],
  options?: MemoryIndexOptions,
): MemoryIndexEntry[] {
  const o = resolveOptions(options);

  const liveNodes = nodes.filter((n) => !n.tombstoned);
  const edgeCounts = new Map<string, number>();
  for (const edge of edges) {
    edgeCounts.set(edge.source_id, (edgeCounts.get(edge.source_id) ?? 0) + 1);
    edgeCounts.set(edge.target_id, (edgeCounts.get(edge.target_id) ?? 0) + 1);
  }

  const entries: MemoryIndexEntry[] = [];
  for (const node of liveNodes) {
    const edgeCount = edgeCounts.get(node.node_id) ?? 0;
    const decayed = computeDecayedConfidence(
      node.confidence,
      node.half_life,
      o.nowMs - node.created_at,
    );
    const score = scoreForIndex(node, edgeCount, decayed);
    entries.push({
      node,
      certainty: classifyCertainty(decayed),
      score,
      edgeCount,
      decayedConfidence: decayed,
    });
  }

  // Stable-order sort: primarily by score desc, then by created_at
  // desc (newer wins ties), then node_id (lexicographic tiebreak so
  // the rendering is reproducible across runs).
  entries.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.node.created_at !== a.node.created_at) return b.node.created_at - a.node.created_at;
    return a.node.node_id < b.node.node_id ? -1 : 1;
  });

  return entries;
}

/**
 * Format a single ranked entry as an index line. Short-id format
 * (first 8 chars of UUID) keeps the line dense without losing the
 * identifier needed by the `rewrite_memory` tool.
 */
function renderLine(entry: MemoryIndexEntry, maxSummaryChars: number): string {
  const shortId = entry.node.node_id.slice(0, 8);
  const summary = entry.node.content.replace(/\s+/g, " ").trim().slice(0, maxSummaryChars);
  const suffix = entry.node.pinned ? " [pinned]" : "";
  return `- [${shortId}] ${summary} (${entry.certainty})${suffix}`;
}

/**
 * Build the full Layer-1 memory index as a single multi-line string,
 * bounded by `maxBytes`. Returns an empty string when no live memory
 * exists — callers MAY omit the index section entirely in that case.
 *
 * Leading header is a three-line contract the agent reads once:
 *   1. what the index is
 *   2. how to read the certainty labels
 *   3. how to correct an entry (points at the `rewrite_memory` tool)
 *
 * Keeping the header stable across turns lets the Anthropic prompt
 * cache match it once and reuse.
 */
export function buildMemoryIndex(
  nodes: readonly MemoryNode[],
  edges: readonly MemoryEdge[],
  options?: MemoryIndexOptions,
): string {
  const o = resolveOptions(options);
  const entries = rankIndexEntries(nodes, edges, options);
  if (entries.length === 0) return "";

  const header = [
    "# Memory Index (Layer 1)",
    "Entries ranked by index-worthiness. Certainty: absolute | confident | tentative. Pull full detail via recall; correct a stale entry via the `rewrite_memory` tool (node_id is the `[xxxxxxxx]` short id).",
    "",
  ];

  const lines: string[] = [...header];
  let bytesUsed = new Blob([lines.join("\n")]).size;

  for (const entry of entries) {
    const line = renderLine(entry, o.maxSummaryChars);
    const lineBytes = new Blob([line + "\n"]).size;
    if (bytesUsed + lineBytes > o.maxBytes) break;
    lines.push(line);
    bytesUsed += lineBytes;
  }

  return lines.join("\n");
}
