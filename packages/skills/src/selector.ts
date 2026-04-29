/**
 * SkillSelector — picks skills for context injection per turn.
 *
 * Pure given inputs. The selection algorithm follows spec §7.2:
 *   1. Filter to enabled AND trusted skills (provenance gate, §7.1).
 *   2. Filter by platform.
 *   3. Filter by sensitivity (skill tier ≤ session tier; medical|financial|secret never auto).
 *   4. Filter by hardware-attestation gate.
 *   5. Rank remaining skills by BM25 over the `description` field.
 *   6. Return top-K (default 3).
 */

import type { SkillManifest, SkillSensitivity } from "@motebit/protocol";
import { SKILL_AUTO_LOADABLE_TIERS, SKILL_SENSITIVITY_TIERS } from "@motebit/protocol";

import type {
  SkillFilteredCandidate,
  SkillRecord,
  SkillSelection,
  SkillSelectionContext,
} from "./types.js";

const BM25_K1 = 1.5;
const BM25_B = 0.75;
const DEFAULT_TOP_K = 3;
const MIN_RELEVANCE_SCORE = 0.0001; // skills below this aren't injected even within top-K

export interface SkillSelectorResult {
  selected: SkillSelection[];
  filtered: SkillFilteredCandidate[];
}

export class SkillSelector {
  /**
   * Select skills for the given context. Returns selected skills (sorted by
   * descending relevance) and filtered candidates (with reason) for UI surfaces.
   */
  select(records: SkillRecord[], ctx: SkillSelectionContext): SkillSelectorResult {
    const filtered: SkillFilteredCandidate[] = [];
    const passed: SkillRecord[] = [];

    const sessionRank = sensitivityRank(ctx.sessionSensitivity);

    for (const r of records) {
      if (!r.index.enabled) {
        filtered.push(filterEntry(r, "disabled"));
        continue;
      }
      // Provenance gate: only verified or trusted_unsigned skills pass
      if (r.provenance_status !== "verified" && r.provenance_status !== "trusted_unsigned") {
        filtered.push(filterEntry(r, "untrusted"));
        continue;
      }
      // Platform gate
      if (
        r.manifest.platforms &&
        r.manifest.platforms.length > 0 &&
        !r.manifest.platforms.includes(ctx.platform)
      ) {
        filtered.push(filterEntry(r, "platform_mismatch"));
        continue;
      }
      // Sensitivity gate
      const skillTier = r.manifest.motebit.sensitivity ?? "none";
      if (!SKILL_AUTO_LOADABLE_TIERS.includes(skillTier)) {
        filtered.push(filterEntry(r, "sensitivity_above_session"));
        continue;
      }
      if (sensitivityRank(skillTier) > sessionRank) {
        filtered.push(filterEntry(r, "sensitivity_above_session"));
        continue;
      }
      // Hardware-attestation gate
      const haGate = r.manifest.motebit.hardware_attestation;
      if (haGate?.required && (haGate.minimum_score ?? 0) > ctx.hardwareAttestationScore) {
        filtered.push(filterEntry(r, "hardware_attestation_gate"));
        continue;
      }
      passed.push(r);
    }

    // Rank passed by BM25 over description against turn
    const ranked = rankByBm25(passed, ctx.turn);

    const topK = ctx.topK ?? DEFAULT_TOP_K;
    const selected: SkillSelection[] = [];
    for (const { record, score } of ranked) {
      if (score < MIN_RELEVANCE_SCORE) {
        filtered.push(filterEntry(record, "low_relevance"));
        continue;
      }
      if (selected.length >= topK) {
        filtered.push(filterEntry(record, "low_relevance"));
        continue;
      }
      const status = record.provenance_status;
      // narrowed type — passed gate so it's verified or trusted_unsigned
      if (status !== "verified" && status !== "trusted_unsigned") continue;
      selected.push({
        name: record.manifest.name,
        version: record.manifest.version,
        body: new TextDecoder().decode(record.body),
        provenance_status: status,
        score,
      });
    }

    return { selected, filtered };
  }
}

// ---------------------------------------------------------------------------
// Sensitivity ranking
// ---------------------------------------------------------------------------

function sensitivityRank(tier: SkillSensitivity): number {
  return SKILL_SENSITIVITY_TIERS.indexOf(tier);
}

// ---------------------------------------------------------------------------
// BM25 ranking over description
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function rankByBm25(
  records: SkillRecord[],
  turn: string,
): Array<{ record: SkillRecord; score: number }> {
  const queryTokens = tokenize(turn);

  // Build per-doc statistics
  const docs = records.map((r) => {
    const text = describeForRanking(r.manifest);
    const tokens = tokenize(text);
    const freq = new Map<string, number>();
    for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
    return { record: r, tokens, freq, length: tokens.length };
  });

  if (docs.length === 0) return [];

  const totalDocs = docs.length;
  const avgLength = docs.reduce((acc, d) => acc + d.length, 0) / totalDocs || 1;

  // Document frequency for each query token
  const docFreq = new Map<string, number>();
  for (const t of new Set(queryTokens)) {
    let count = 0;
    for (const d of docs) {
      if ((d.freq.get(t) ?? 0) > 0) count++;
    }
    docFreq.set(t, count);
  }

  const scored = docs.map((d) => {
    if (queryTokens.length === 0 || d.length === 0) return { record: d.record, score: 0 };
    let score = 0;
    for (const t of queryTokens) {
      const tf = d.freq.get(t) ?? 0;
      if (tf === 0) continue;
      const df = docFreq.get(t) ?? 0;
      const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
      const numerator = tf * (BM25_K1 + 1);
      const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (d.length / avgLength));
      score += idf * (numerator / denominator);
    }
    return { record: d.record, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Build the text the selector ranks against. Uses description + tags
 * (tags are weighted by being present in the corpus, not by repetition;
 * if richer ranking is needed phase 2 adds it).
 */
function describeForRanking(manifest: SkillManifest): string {
  const parts: string[] = [manifest.description];
  if (manifest.metadata?.tags) parts.push(...manifest.metadata.tags);
  if (manifest.metadata?.category) parts.push(manifest.metadata.category);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function filterEntry(
  r: SkillRecord,
  reason: SkillFilteredCandidate["reason"],
): SkillFilteredCandidate {
  return { name: r.manifest.name, version: r.manifest.version, reason };
}
