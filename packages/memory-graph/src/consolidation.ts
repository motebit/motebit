/**
 * Memory consolidation — detect contradictions, supersede, reinforce, or skip.
 *
 * Pure functions — no storage writes, no provider dependencies.
 * Adapted from Mem0 consolidation pattern for local-first/SQLite.
 */

import { cosineSimilarity } from "./index.js";
import type { MemoryNode } from "@motebit/sdk";

// === Types ===

export enum ConsolidationAction {
  ADD = "add",
  UPDATE = "update",
  REINFORCE = "reinforce",
  NOOP = "noop",
}

export interface ConsolidationDecision {
  action: ConsolidationAction;
  existingNodeId?: string;
  reason: string;
}

export interface ConsolidationProvider {
  classify(
    newContent: string,
    existing: Array<{ node_id: string; content: string; confidence: number }>,
  ): Promise<ConsolidationDecision>;
}

// === Prompt Builder ===

export function buildConsolidationPrompt(
  newContent: string,
  existing: Array<{ node_id: string; content: string; confidence: number }>,
): string {
  const memoryList = existing
    .map((m, i) => `  ${i + 1}. [id=${m.node_id}] (confidence=${m.confidence.toFixed(2)}) "${m.content}"`)
    .join("\n");

  return `You are a memory consolidation engine. A new memory is being formed. Compare it against existing memories and decide what to do.

NEW MEMORY: "${newContent}"

EXISTING MEMORIES:
${memoryList}

Decide ONE action:
- "add": The new memory is genuinely new information, not covered by any existing memory.
- "update": The new memory contradicts or supersedes an existing memory (e.g. changed job, moved city, updated preference). Specify which existing memory it replaces.
- "reinforce": The new memory aligns with and confirms an existing memory. Specify which one.
- "noop": The new memory is too similar to an existing memory to be worth storing separately.

Respond with ONLY a JSON object:
{"action": "add"|"update"|"reinforce"|"noop", "existingNodeId": "<id if update/reinforce/noop, omit for add>", "reason": "<brief explanation>"}`;
}

// === Response Parser ===

export function parseConsolidationResponse(
  raw: string,
  validNodeIds: string[],
): ConsolidationDecision {
  const fallback: ConsolidationDecision = {
    action: ConsolidationAction.ADD,
    reason: "Failed to parse consolidation response — defaulting to ADD",
  };

  try {
    // Extract JSON from response (may have surrounding text)
    const jsonMatch = raw.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return fallback;

    const parsed = JSON.parse(jsonMatch[0]) as {
      action?: string;
      existingNodeId?: string;
      reason?: string;
    };

    const action = parsed.action?.toLowerCase();
    if (!action || !Object.values(ConsolidationAction).includes(action as ConsolidationAction)) {
      return fallback;
    }

    const decision: ConsolidationDecision = {
      action: action as ConsolidationAction,
      reason: parsed.reason ?? "No reason provided",
    };

    // Validate node ID for actions that reference existing memories
    if (action !== ConsolidationAction.ADD) {
      if (!parsed.existingNodeId || !validNodeIds.includes(parsed.existingNodeId)) {
        return fallback;
      }
      decision.existingNodeId = parsed.existingNodeId;
    }

    return decision;
  } catch {
    return fallback;
  }
}

// === Clustering ===

/**
 * Greedy single-linkage clustering by cosine similarity.
 * Used for episodic consolidation — groups related memories for summarization.
 */
export function clusterBySimilarity(
  nodes: MemoryNode[],
  threshold: number,
): MemoryNode[][] {
  const assigned = new Set<number>();
  const clusters: MemoryNode[][] = [];

  for (let i = 0; i < nodes.length; i++) {
    if (assigned.has(i)) continue;

    const cluster = [nodes[i]!];
    assigned.add(i);

    // Greedily expand: check all unassigned nodes against any cluster member
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (let j = 0; j < nodes.length; j++) {
        if (assigned.has(j)) continue;
        const candidate = nodes[j]!;
        for (const member of cluster) {
          const sim = cosineSimilarity(candidate.embedding, member.embedding);
          if (sim >= threshold) {
            cluster.push(candidate);
            assigned.add(j);
            expanded = true;
            break;
          }
        }
      }
    }

    clusters.push(cluster);
  }

  return clusters;
}
