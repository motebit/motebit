/**
 * felt-trust — the trust resting record (`docs/doctrine/felt-interior.md` §6):
 * the RELATIONAL register, "whom the interior has come to know," to memory's
 * "what it holds" (§5) and consolidation's "what it changed" (§2).
 *
 * The honesty model is the third distinct floor, and it is the moat turned
 * inward. Consolidation shows DETAIL because it is signed; memory shows SHAPE
 * because it is unsigned-local; trust shows DEPTH because it is proven, and
 * REFUSES the aggregate because the global reputation score is the very thing
 * the trust graph exists to refuse:
 *   - PROVEN-ONLY — built from KNOWN edges (proven from receipts) alone. A
 *     Discover row is a relay claim, never an earned edge; "detail ⟺ verified"
 *     becomes "felt ⟺ proven-from-receipts." The input is the Known `AgentRecord`
 *     type — a `DiscoveredAgent` is structurally a different type and cannot enter.
 *   - NO INWARD GLOBAL SCORE — `FeltTrustRecord` carries no reputation/rank/
 *     aggregate field; claiming one is unrepresentable by the type. Minting that
 *     score for the owner, about the owner's own graph, re-introduces the §1
 *     sybil-bait pointed inward. First-person counts at rest, never a ranking.
 *   - PRESENT SHAPE, NOT TREND — "deepening" is a quality of the standing graph
 *     (the present tier distribution), never a delta/streak/growth chart.
 *   - MONEY IS COUNTS-ONLY — "settled work with N peers" (a count); the per-peer
 *     signed net stays in the per-row `formatPeerEconomics` projection.
 *
 * Locked by `check-felt-interior-honesty` (invariant 4). Surfaces call only
 * `resolveFeltTrust` and render the returned `FeltTrustRecord`.
 */
import type { AgentRecord, AgentEconomicSummary } from "./controller";

/**
 * A coarse tier-shape entry — the earned trust ladder, present-state. `unknown`
 * and `first_contact` collapse into `first_contact` (early edges); `blocked` is
 * not trust held and never appears (excluded from the mass entirely). Never a score.
 */
export interface FeltTrustShapeEntry {
  readonly kind: "first_contact" | "verified" | "trusted";
  readonly count: number;
}

/**
 * The trust resting record — first-person counts at rest, presence + shape only.
 * Deliberately carries NO reputation/rank/aggregate/score field: the global-score
 * refusal that is the core of sybil-resistance, turned inward and made structural
 * (locked by check-felt-interior-honesty invariant 4).
 */
export interface FeltTrustRecord {
  /** A calm resting headline — qualitative depth, never a score or trend. */
  readonly headline: string;
  /** Proven Known peers held, excluding blocked. Presence, not a climbing number. */
  readonly known: number;
  /** Earned depth: peers at `verified` or `trusted`. Present-state, not a delta. */
  readonly trusted: number;
  /** Peers whose identity key is hardware-rooted (additive trust signal). */
  readonly hardwareBacked: number;
  /** Peers the owner has settled work with (counts-only — never an amount). */
  readonly settledWith: number;
  /** Coarse tier shape of the held graph. */
  readonly shape: ReadonlyArray<FeltTrustShapeEntry>;
}

function feltTrustHeadline(known: number, trusted: number): string {
  if (known === 0) return "Your trust graph is still forming — no peers yet.";
  const peers = known === 1 ? "peer" : "peers";
  if (trusted > 0) {
    return `Your trust graph holds ${known} ${peers}; ${trusted} you've come to trust.`;
  }
  return `Your trust graph is forming with ${known} ${peers} at first contact.`;
}

/**
 * Project the Known trust edges (and the verified economic summary, if present)
 * into a calm resting record. Pure: no I/O, no clock. Proven-only by
 * construction — the input is the Known `AgentRecord` slice; relay-claimed
 * Discover rows are a different type and cannot enter. Assurance-free and
 * score-free by construction (see the module header).
 *
 * @param known    The proven-from-receipts Known peers (`state.known`).
 * @param economic The verified first-person economic summary, or null/absent.
 */
export function resolveFeltTrust(
  known: readonly AgentRecord[],
  economic?: AgentEconomicSummary | null,
): FeltTrustRecord {
  // Blocked is not trust held — excluded from the deepening mass entirely
  // (parallel to a tombstoned memory excluded from the resting mass, §5).
  const held = known.filter((a) => a.trust_level !== "blocked");

  let firstContact = 0;
  let verified = 0;
  let trustedTier = 0;
  let hardwareBacked = 0;
  const heldIds = new Set<string>();

  for (const a of held) {
    heldIds.add(a.remote_motebit_id);
    switch (a.trust_level) {
      case "verified":
        verified++;
        break;
      case "trusted":
        trustedTier++;
        break;
      // `unknown` and `first_contact` are both early edges — a Known peer you
      // have met but not yet verified.
      default:
        firstContact++;
        break;
    }
    // Hardware-rooted: a real attestation surface, not the `software` sentinel.
    if (a.hardware_attestation && a.hardware_attestation.platform !== "software") {
      hardwareBacked++;
    }
  }

  // Counts-only money: peers (within the held graph) with settled work. Never
  // an amount — the per-peer signed net stays in `formatPeerEconomics`.
  let settledWith = 0;
  if (economic) {
    for (const p of economic.peers) {
      if (p.settled_count > 0 && heldIds.has(p.peer_id)) settledWith++;
    }
  }

  const shape: FeltTrustShapeEntry[] = [];
  if (firstContact > 0) shape.push({ kind: "first_contact", count: firstContact });
  if (verified > 0) shape.push({ kind: "verified", count: verified });
  if (trustedTier > 0) shape.push({ kind: "trusted", count: trustedTier });

  const trusted = verified + trustedTier;
  return {
    headline: feltTrustHeadline(held.length, trusted),
    known: held.length,
    trusted,
    hardwareBacked,
    settledWith,
    shape,
  };
}
