/**
 * Memory housekeeping — decay pruning, retention enforcement, episodic
 * consolidation, curiosity target computation.
 *
 * Extracted from MotebitRuntime. Runs periodically to maintain memory
 * health: tombstones decayed or expired memories, consolidates episodic
 * clusters into semantic summaries, and identifies curiosity targets.
 */

import { EventType, MemoryType, RelationType } from "@motebit/sdk";
import type { MemoryNode } from "@motebit/sdk";
import type { StreamingProvider } from "@motebit/ai-core";
import {
  computeDecayedConfidence,
  findCuriosityTargets,
  clusterBySimilarity,
  embedText,
  MemoryGraph,
} from "@motebit/memory-graph";
import type { CuriosityTarget } from "@motebit/memory-graph";
import type { EventStore } from "@motebit/event-log";
import type { StateVectorEngine } from "@motebit/state-vector";
import { MemoryClass } from "@motebit/policy";
import type { MemoryGovernor } from "@motebit/policy";
import type { PrivacyLayer } from "@motebit/privacy-layer";

/** Dependencies injected by the runtime. */
export interface HousekeepingDeps {
  motebitId: string;
  memory: MemoryGraph;
  events: EventStore;
  state: StateVectorEngine;
  memoryGovernor: MemoryGovernor;
  privacy: PrivacyLayer;
  episodicConsolidation: boolean;
  /** Structured logger — consistent with every other runtime deps interface. */
  logger: { warn(message: string, context?: Record<string, unknown>): void };
  /** Resolve current AI provider (may change over lifetime). */
  getProvider(): StreamingProvider | null;
  /** Callback to compute and store the intelligence gradient after pruning. */
  computeAndStoreGradient(nodes: MemoryNode[]): Promise<void>;
}

export interface HousekeepingResult {
  curiosityTargets: CuriosityTarget[];
}

/**
 * Prune decayed and retention-expired memories.
 * Tombstones memories where:
 *   1. Decayed confidence falls below memoryGovernor.persistenceThreshold
 *   2. Age exceeds the sensitivity-level retention period
 * Pinned memories are always preserved.
 *
 * @deprecated Use `runConsolidationCycle` from `./consolidation-cycle.ts` for
 * the prune + episodic-consolidation work; curiosity-target computation (the
 * one behavior this function provides that the cycle does not yet cover)
 * should be called separately via `findCuriosityTargets` from
 * `@motebit/memory-graph`.
 *
 * Reason: this function is the pre-unification housekeeping path. The
 * four-phase consolidation cycle (`runConsolidationCycle`) is the canonical
 * maintenance loop per `docs/doctrine/proactive-interior.md` — its prune
 * phase supersedes this function's retention/decay/episodic work. The
 * one remaining asymmetry is curiosity-target computation; resolving
 * that is a separate design conversation before the 1.0.0 removal.
 * The drift-defense allowlist in
 * `scripts/check-consolidation-primitives.ts` already calls this a
 * "deprecated alias"; the annotation here formalizes the claim so the
 * doctrine is visible in every consumer's IDE and enforced by
 * drift-defense #39.
 */
export async function runHousekeeping(deps: HousekeepingDeps): Promise<HousekeepingResult> {
  try {
    const { nodes } = await deps.memory.exportAll();
    const now = Date.now();
    const threshold = deps.memoryGovernor.getConfig().persistenceThreshold;
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    let tombstonedDecay = 0;
    let tombstonedRetention = 0;
    let skippedPinned = 0;

    for (const node of nodes) {
      // Skip already tombstoned
      if (node.tombstoned) continue;

      // Never touch pinned memories
      if (node.pinned) {
        skippedPinned++;
        continue;
      }

      // Check retention period by sensitivity level
      const retention = deps.privacy.getRetentionRules(node.sensitivity);
      if (retention.max_retention_days !== Infinity) {
        const ageMs = now - node.created_at;
        const maxMs = retention.max_retention_days * MS_PER_DAY;
        if (ageMs > maxMs) {
          // Use privacy layer to create deletion certificate + tombstone
          await deps.privacy.deleteMemory(node.node_id, "retention_enforcement");
          tombstonedRetention++;
          continue;
        }
      }

      // Check decayed confidence against persistence threshold
      const elapsed = now - node.created_at;
      const decayed = computeDecayedConfidence(node.confidence, node.half_life, elapsed);
      if (decayed < threshold) {
        await deps.memory.deleteMemory(node.node_id);
        tombstonedDecay++;
      }
    }

    // Compute curiosity targets — decaying high-value memories worth asking about
    const curiosityTargets = findCuriosityTargets(nodes.filter((n) => !n.tombstoned && !n.pinned));

    // Log housekeeping run
    await deps.events.appendWithClock({
      event_id: crypto.randomUUID(),
      motebit_id: deps.motebitId,
      timestamp: now,
      event_type: EventType.HousekeepingRun,
      payload: {
        source: "memory_housekeeping",
        total_memories: nodes.length,
        tombstoned_decay: tombstonedDecay,
        tombstoned_retention: tombstonedRetention,
        skipped_pinned: skippedPinned,
        curiosity_targets: curiosityTargets.length,
      },
      tombstoned: false,
    });

    // Episodic consolidation (guarded by config flag)
    if (deps.episodicConsolidation && deps.getProvider()) {
      await consolidateEpisodicMemories(deps, nodes, now);
    }

    // Compute intelligence gradient — data already loaded
    await deps.computeAndStoreGradient(nodes);

    return { curiosityTargets };
  } catch (err: unknown) {
    // Housekeeping is best-effort — don't crash the runtime
    deps.logger.warn("housekeeping failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { curiosityTargets: [] };
  }
}

/**
 * Consolidate aging episodic memories into semantic summaries.
 * Groups similar episodic memories by embedding, asks LLM to summarize each cluster,
 * and forms a new semantic memory from the summary.
 */
async function consolidateEpisodicMemories(
  deps: HousekeepingDeps,
  allNodes: MemoryNode[],
  now: number,
): Promise<void> {
  // Find episodic memories past 50% of their half-life, not tombstoned, not pinned
  const candidates = allNodes.filter((n) => {
    if (n.tombstoned || n.pinned) return false;
    if (n.memory_type !== MemoryType.Episodic) return false;
    const elapsed = now - n.created_at;
    return elapsed > n.half_life * 0.5;
  });

  if (candidates.length < 3) return; // Not enough to consolidate

  // Cluster by cosine similarity
  const clusters = clusterBySimilarity(candidates, 0.6);

  for (const cluster of clusters) {
    if (cluster.length < 2) continue;

    // Summarize cluster via LLM
    const contents = cluster.map((n) => `- ${n.content}`).join("\n");
    const prompt = `Summarize the following episodic observations into a single factual statement:\n${contents}\n\nRespond with ONLY the summary sentence.`;

    try {
      const provider = deps.getProvider();
      if (!provider) return; // Provider may have been cleared concurrently
      const result = await provider.generate({
        recent_events: [],
        relevant_memories: [],
        current_state: deps.state.getState(),
        user_message: prompt,
      });

      const summary = result.text.trim();
      if (summary.length < 5) continue;

      // Compute average confidence + boost
      const avgConf = cluster.reduce((sum, n) => sum + n.confidence, 0) / cluster.length;
      const newConf = Math.min(1.0, avgConf + 0.1);

      // Form new semantic memory — governor checks for secrets in the summary text
      const candidate = {
        content: summary,
        confidence: newConf,
        sensitivity: cluster[0]!.sensitivity,
        memory_type: MemoryType.Semantic,
      };
      const [decision] = deps.memoryGovernor.evaluate([candidate]);
      if (decision && decision.memoryClass === MemoryClass.REJECTED) {
        continue;
      }
      const embedding = await embedText(summary);
      const synthesized = await deps.memory.formMemory(
        candidate,
        embedding,
        MemoryGraph.HALF_LIFE_SEMANTIC,
      );

      // Create PartOf edges — lineage trail from synthesis to each source
      for (const sourceNode of cluster) {
        await deps.memory.link(synthesized.node_id, sourceNode.node_id, RelationType.PartOf);
      }

      // Tombstone the episodic cluster members (edges preserved for lineage)
      for (const node of cluster) {
        await deps.memory.deleteMemory(node.node_id);
      }
    } catch {
      // Consolidation is best-effort per cluster
    }
  }
}
