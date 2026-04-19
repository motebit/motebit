/**
 * Intent disambiguation — the fourth semiring consumer in the codebase.
 *
 * Prior consumers (in landing order):
 *   #1 agent routing (`@motebit/semiring/agent-network.ts`)
 *   #2 memory retrieval (`@motebit/memory-graph/retrieval.ts`)
 *   #2b notability ranking (`@motebit/memory-graph/notability.ts`)
 *   #3 trust propagation (`@motebit/market/trust-propagation.ts`)
 *   #4 intent disambiguation (this file)
 *
 * ## What this solves
 *
 * The runtime and every surface regularly faces "the user said X —
 * which of these N candidates did they mean?" situations:
 *
 *   - voice: "load conversation python" — which conversation?
 *   - delegation: "ask the research agent" — which agent?
 *   - tool invocation: "show me my sovereign state" — which capability?
 *   - memory reference: "that thing I told you about" — which node?
 *
 * Every site has historically solved this with a handful of ad-hoc
 * lines:
 *
 *     candidates.find(c => c.title.toLowerCase().includes(keyword))
 *
 * That's first-match on substring. It doesn't weigh exactness, doesn't
 * prefer recent items over stale ones, can't express "high confidence
 * vs. ask the user to clarify", and gives identical behavior no matter
 * whether the candidate list holds two items or two hundred.
 *
 * The algebraic shape is the one every prior semiring consumer uses:
 * a record of independent signals composed via a semiring, ranked by
 * the composed scalar. This module ships the primitive — generic over
 * the candidate type and the semiring — plus string-similarity signals
 * as a convenience for the most common case.
 *
 * ## Algebra
 *
 * Each signal returns a semiring element for a given candidate. The
 * primitive composes them under `semiring.mul` (along the signal
 * dimensions) and ranks candidates by the resulting scalar using the
 * supplied `compare`. A default comparator exists for numeric
 * semirings; other scalar shapes (records, booleans) require an
 * explicit compare function.
 *
 * ## Drift gate
 *
 * `check-disambiguation-primitives.ts` (invariant #32) flags files
 * that compute multi-signal candidate scores (two or more distinct
 * scoring expressions over the same candidate list + sort/rank) without
 * importing the canonical primitive. Same heuristic shape as #27/#28/
 * #29/#30 — the drift this family of gates prevents is always the
 * same: parallel scoring implementations diverging silently.
 */

import type { Semiring } from "@motebit/protocol";
import { TrustSemiring } from "@motebit/protocol";

// ── Core primitive ───────────────────────────────────────────────────

/** A named dimension of the disambiguation score. */
export interface DisambiguationSignal<T, S> {
  /** Display name — used in provenance so consumers can explain
   *  "why did this candidate win?" */
  readonly name: string;
  /** Score this candidate on this dimension. Pure, deterministic. */
  readonly score: (candidate: T) => S;
}

export interface DisambiguationResult<T, S> {
  readonly candidate: T;
  /** Composed score under the supplied semiring. */
  readonly score: S;
  /** Per-signal breakdown, in the order signals were supplied.
   *  Useful for UI: "matched because: exact=1, substring=1, fuzzy=0.8". */
  readonly breakdown: ReadonlyArray<{ name: string; value: S }>;
  /** Zero-indexed rank after sorting — `rank === 0` is the winner. */
  readonly rank: number;
}

export interface DisambiguateOptions<S> {
  /** Top-K cap (default: all). */
  readonly limit?: number;
  /** Comparator: negative if `a` should rank above `b`. Required when
   *  the semiring scalar is not `number`; defaults to descending numeric
   *  order when the scalar is numeric. */
  readonly compare?: (a: S, b: S) => number;
  /** Minimum composed score to include (uses semiring.eq against
   *  semiring.zero by default; drops only true-zero candidates). */
  readonly minScore?: S;
}

/**
 * Rank `candidates` by composing per-candidate signal scores under
 * `semiring`. Returns `DisambiguationResult<T, S>[]` sorted by the
 * composed score descending (or by the supplied comparator).
 *
 * Deterministic, pure, no I/O. Same input → same output, always.
 */
export function disambiguate<T, S>(
  candidates: ReadonlyArray<T>,
  signals: ReadonlyArray<DisambiguationSignal<T, S>>,
  semiring: Semiring<S>,
  options: DisambiguateOptions<S> = {},
): ReadonlyArray<DisambiguationResult<T, S>> {
  if (candidates.length === 0 || signals.length === 0) return [];

  const eq = semiring.eq ?? ((a, b) => a === b);
  const compare = options.compare ?? defaultNumericCompare(semiring);

  const scored: Array<Omit<DisambiguationResult<T, S>, "rank">> = [];
  for (const candidate of candidates) {
    const breakdown: Array<{ name: string; value: S }> = [];
    let composed: S = semiring.one;
    for (const signal of signals) {
      const v = signal.score(candidate);
      breakdown.push({ name: signal.name, value: v });
      composed = semiring.mul(composed, v);
    }
    if (eq(composed, semiring.zero)) continue;
    if (options.minScore !== undefined && compare(composed, options.minScore) > 0) continue;
    scored.push({ candidate, score: composed, breakdown });
  }

  scored.sort((a, b) => compare(a.score, b.score));

  const limit = options.limit ?? scored.length;
  return scored.slice(0, limit).map((r, i) => ({ ...r, rank: i }));
}

function defaultNumericCompare<S>(semiring: Semiring<S>): (a: S, b: S) => number {
  // Most semiring scalars we use are number (Trust, Cost, Latency, etc.).
  // For these, "best" means the scalar that wins under semiring.add:
  // TrustSemiring.add = max, so higher is better; CostSemiring.add = min,
  // so lower is better. We express this directly by comparing via
  // semiring.add: a "wins" iff add(a, b) === a. This removes the need
  // for consumers to know whether their semiring is max-oriented or
  // min-oriented — the algebra decides.
  const eq = semiring.eq ?? ((a, b) => a === b);
  return (a, b) => {
    if (eq(a, b)) return 0;
    const winner = semiring.add(a, b);
    if (eq(winner, a)) return -1;
    if (eq(winner, b)) return 1;
    // Non-ordered semirings (e.g. record scalars): no stable order.
    // Callers must supply their own compare; falling back here would
    // be silently wrong. Surface the requirement as a throw.
    throw new Error(
      "disambiguate: semiring has no natural ordering for its scalar; pass options.compare",
    );
  };
}

// ── String-similarity signal (convenience) ──────────────────────────

/**
 * Canonical string-similarity signal for a text query.
 *
 * Returns ONE signal whose score is the max of three internal probes:
 *   - exact     — 1.0 when the query case-insensitively equals the text
 *   - substring — 0.8 when the query is a case-insensitive substring
 *   - fuzzy     — token-overlap Jaccard ratio × 0.6 (capped below
 *                 substring so exact and substring always dominate)
 *
 * Composition is intentionally a max (`semiring.add` on the three
 * internal probes, not `mul`) — a title either matches exactly, as a
 * substring, or fuzzily, and the best-of-three wins. That same signal
 * then composes with other signals (recency, trust, availability) via
 * the outer `disambiguate` primitive's `semiring.mul`, where product
 * semantics do fit: "recent AND relevant AND trusted" is an AND.
 *
 * Designed for the common case — conversation-title matching,
 * agent-name matching, tool-name matching. For structural fields
 * compose this with additional signals of your own.
 */
export function stringSimilaritySignal<T>(
  query: string,
  text: (candidate: T) => string,
): DisambiguationSignal<T, number> {
  const q = query.trim().toLowerCase();
  if (q === "") {
    return { name: "string-sim", score: () => 0 };
  }
  const qTokens = tokenize(q);

  return {
    name: "string-sim",
    score: (candidate) => {
      const raw = text(candidate);
      const t = raw.trim().toLowerCase();
      if (t === q) return 1.0;
      if (t.includes(q)) return 0.8;
      const tTokens = tokenize(t);
      if (tTokens.size === 0) return 0;
      let overlap = 0;
      for (const tok of qTokens) {
        if (tTokens.has(tok)) overlap++;
      }
      const union = qTokens.size + tTokens.size - overlap;
      const jaccard = union === 0 ? 0 : overlap / union;
      return jaccard * 0.6;
    },
  };
}

const STOP_WORDS = new Set(["a", "an", "the", "of", "to", "in", "for", "and", "or"]);

function tokenize(s: string): Set<string> {
  return new Set(s.split(/\s+/).filter((t) => t.length > 0 && !STOP_WORDS.has(t)));
}

// ── Match-or-ask helper ──────────────────────────────────────────────

export interface MatchDecision<T> {
  readonly kind: "match" | "ambiguous" | "none";
  /** The top candidate when `kind === "match"`. */
  readonly winner?: T;
  /** Ranked alternatives when `kind === "ambiguous"` — present
   *  in descending score order. A UI can prompt the user
   *  "did you mean X, Y, or Z?" */
  readonly alternatives?: ReadonlyArray<T>;
  /** Composed score of the winner (when `kind !== "none"`). */
  readonly score?: number;
}

/**
 * Convenience wrapper for the common "pick one with a confidence gate"
 * shape: run `disambiguate` with `TrustSemiring` (max-product on [0,1])
 * and decide among match / ambiguous / none based on the top two
 * candidates' scores.
 *
 *   - `match`     — top score ≥ `threshold` and second score ≤ `top * (1 - separation)`
 *   - `ambiguous` — top score ≥ `threshold` but second score is close
 *   - `none`      — top score below `threshold`
 */
export function matchOrAsk<T>(
  candidates: ReadonlyArray<T>,
  signals: DisambiguationSignal<T, number> | ReadonlyArray<DisambiguationSignal<T, number>>,
  options: { threshold?: number; separation?: number; maxAlternatives?: number } = {},
): MatchDecision<T> {
  const signalArray = Array.isArray(signals) ? signals : [signals];
  const threshold = options.threshold ?? 0.4;
  const separation = options.separation ?? 0.15;
  const maxAlts = options.maxAlternatives ?? 3;

  const ranked = disambiguate(candidates, signalArray, TrustSemiring, { limit: maxAlts + 1 });
  if (ranked.length === 0 || ranked[0]!.score < threshold) {
    return { kind: "none" };
  }
  const top = ranked[0]!;
  const runnerUp = ranked[1];
  if (runnerUp && runnerUp.score >= top.score * (1 - separation)) {
    return {
      kind: "ambiguous",
      alternatives: ranked.slice(0, maxAlts).map((r) => r.candidate),
      score: top.score,
    };
  }
  return { kind: "match", winner: top.candidate, score: top.score };
}
