/**
 * felt-memory — the memory resting record (`docs/doctrine/felt-interior.md` §5):
 * "what the interior holds, at rest," the RECORD to consolidation's ACTS.
 *
 * The honesty model is the INVERSE of felt-consolidation's. Consolidation shows
 * DETAIL because it is signed (a `ConsolidationMutationManifest` gives it
 * verified/receipt_only evidence). The memory graph's standing state is
 * unsigned-and-local by construction — there is no `MemoryGraphStateReceipt`,
 * and there must not be one minted per glance — so memory shows SHAPE because it
 * is not signed:
 *   - the record makes NO assurance claim — `FeltMemoryRecord` has no
 *     verified/attested field; claiming verification is unrepresentable by the type.
 *   - it carries NO memory content — `FeltMemoryNode` is deliberately content-free,
 *     so content cannot enter the projection. The record is pure shape + presence.
 *   - it is sensitivity-ceilinged — a medical/financial/secret memory adds to the
 *     felt mass but never to an itemized line ("private"), and never its content.
 *   - it has NO trend/delta/history — a memory count that goes up is the vanity
 *     metric the doctrine's "What not to build" forbids.
 *
 * Locked by `check-felt-interior-honesty` (invariant 3). Surfaces call only
 * `resolveFeltMemory` and render the returned `FeltMemoryRecord`.
 */
import { SensitivityLevel, MemoryType } from "@motebit/protocol";

/**
 * Minimal structural slice of a memory node — the projection reads only these
 * fields, so callers (and tests) pass plain objects (no `@motebit/sdk` dep).
 * DELIBERATELY content-free: there is no `content` field, so memory content
 * cannot enter the felt record. (locked by check-felt-interior-honesty)
 */
export interface FeltMemoryNode {
  readonly tombstoned: boolean;
  readonly pinned: boolean;
  readonly confidence: number;
  readonly half_life: number;
  readonly last_accessed: number;
  readonly sensitivity: SensitivityLevel;
  readonly memory_type?: MemoryType;
}

/**
 * A coarse, sensitivity-bounded shape entry — `"episodic"`/`"semantic"` for
 * low-tier memories, `"private"` for the sensitivity-ceilinged mass. Never content.
 */
export interface FeltMemoryShapeEntry {
  readonly kind: "episodic" | "semantic" | "private";
  readonly count: number;
}

/**
 * The memory resting record — presence + shape only. No assurance/verified field
 * (the record claims no verification, by construction), no trend/delta/history,
 * no content.
 */
export interface FeltMemoryRecord {
  /** A calm resting headline — qualitative presence, never a score or trend. */
  readonly headline: string;
  /** The standing mass: live memories held. Presence, not a growing number. */
  readonly held: number;
  /** How many are gently fading (decayed below the near-death threshold). */
  readonly fading: number;
  /** Coarse shape of what is held, sensitivity-bounded. */
  readonly shape: ReadonlyArray<FeltMemoryShapeEntry>;
}

/** Default near-death threshold — mirrors `auditMemoryGraph`'s default (0.15). */
const NEAR_DEATH_THRESHOLD = 0.15;

/**
 * Trivial exponential decay, inlined per the layer-boundary util rule (<10 lines,
 * no crypto/state/IO). The canonical form is `computeDecayedConfidence` in
 * `@motebit/memory-graph`, which `@motebit/panels` does not depend on.
 */
function decayedConfidence(confidence: number, halfLife: number, elapsedMs: number): number {
  if (halfLife <= 0) return confidence;
  return confidence * Math.pow(0.5, elapsedMs / halfLife);
}

function feltMemoryHeadline(held: number, fading: number): string {
  if (held === 0) return "Your interior is still gathering its first memories.";
  const base = "Your interior holds a body of memories about you and your work";
  return fading > 0 ? `${base}; a few are gently fading.` : `${base}, held at rest.`;
}

/**
 * Project local memory-graph state into a calm resting record. Pure: no I/O, no
 * clock except the injectable `now`. Content-free and assurance-free by
 * construction (see the module header).
 */
export function resolveFeltMemory(
  nodes: readonly FeltMemoryNode[],
  options?: { now?: number; nearDeathThreshold?: number },
): FeltMemoryRecord {
  const now = options?.now ?? Date.now();
  const threshold = options?.nearDeathThreshold ?? NEAR_DEATH_THRESHOLD;

  const live = nodes.filter((n) => !n.tombstoned);
  let fading = 0;
  let episodic = 0;
  let semantic = 0;
  let priv = 0;

  for (const n of live) {
    // The shed side: a non-pinned memory decayed below the near-death threshold.
    if (
      !n.pinned &&
      decayedConfidence(n.confidence, n.half_life, now - n.last_accessed) < threshold
    ) {
      fading++;
    }
    // Shape, sensitivity-ceilinged: low-tier itemized by kind; high-tier → "private" mass.
    if (n.sensitivity === SensitivityLevel.None || n.sensitivity === SensitivityLevel.Personal) {
      if (n.memory_type === MemoryType.Semantic) semantic++;
      else episodic++;
    } else {
      priv++;
    }
  }

  const shape: FeltMemoryShapeEntry[] = [];
  if (episodic > 0) shape.push({ kind: "episodic", count: episodic });
  if (semantic > 0) shape.push({ kind: "semantic", count: semantic });
  if (priv > 0) shape.push({ kind: "private", count: priv });

  return { headline: feltMemoryHeadline(live.length, fading), held: live.length, fading, shape };
}
