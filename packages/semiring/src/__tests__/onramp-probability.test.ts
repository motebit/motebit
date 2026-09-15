/**
 * The newcomer on-ramp, as a NUMBER — pinned so it cannot silently regress.
 *
 * 2026-09-15: the staging Researcher was unpinned with a second `web_search`
 * provider and, over five paid runs, the cold newcomer was never hired. The
 * question "is the on-ramp real?" has an exact answer, because the selector
 * is a pure function of (records, seed): the probability that an Unknown
 * newcomer (uniform prior, no history) out-draws a Trusted incumbent with a
 * long clean history is the Thompson posterior overlap — a few percent per
 * draw at micro stakes. Five draws seeing zero hires is the EXPECTED outcome
 * (≈ 0.95⁵ ≈ 77%), not evidence the ramp is closed. This file pins the band.
 */
import { describe, it, expect } from "vitest";
import { asMotebitId, AgentTrustLevel } from "@motebit/protocol";
import type { AgentTrustRecord } from "@motebit/protocol";
import { rankWorkers } from "../worker-selection.js";

const self = asMotebitId("self");
const CAP = "web_search";
const incumbentRecord = (s: number, f: number, level = AgentTrustLevel.Trusted): AgentTrustRecord =>
  ({
    motebit_id: self,
    remote_motebit_id: asMotebitId("incumbent"),
    trust_level: level,
    first_seen_at: 0,
    last_seen_at: 0,
    interaction_count: s + f,
    successful_tasks: s,
    failed_tasks: f,
    capability_stats: { [CAP]: { successful_tasks: s, failed_tasks: f } },
  }) as AgentTrustRecord;

const DRAWS = 2000;
function newcomerWinRate(
  incumbent: AgentTrustRecord,
  opts: { strength: number; bonded?: boolean; cost?: number } = { strength: 1 },
): number {
  let wins = 0;
  for (let i = 0; i < DRAWS; i++) {
    const ranked = rankWorkers(
      self,
      [
        { motebit_id: "incumbent", trustRecord: incumbent, unitCost: opts.cost ?? 0.003 },
        {
          motebit_id: "newcomer",
          trustRecord: null,
          unitCost: opts.cost ?? 0.003,
          ...(opts.bonded ? { bonded: true } : {}),
        },
      ],
      { explore: { seed: `onramp-${i}`, strength: opts.strength }, capability: CAP },
    );
    if (ranked[0]!.motebit_id === "newcomer") wins++;
  }
  return wins / DRAWS;
}

describe("newcomer on-ramp probability (full exploration, micro stakes)", () => {
  it("the staging shape — Trusted incumbent 60/2 vs an Unknown newcomer — gives the newcomer a few percent per draw", () => {
    const p = newcomerWinRate(incumbentRecord(60, 2));
    // Measured 0.047 on 2026-09-15. Band, not point: the seeded sampler is exact
    // but a refactor of the prior or the cap would move it; below 2% the ramp is
    // effectively closed, above 9% the incumbent's earned record stops mattering.
    expect(p).toBeGreaterThanOrEqual(0.02);
    expect(p).toBeLessThanOrEqual(0.09);
  });

  it("a perfect 50/0 incumbent still leaves the newcomer at least one draw in a hundred", () => {
    expect(newcomerWinRate(incumbentRecord(50, 0))).toBeGreaterThanOrEqual(0.01);
  });

  it("the ramp widens as the incumbent's record weakens (50/10 ⇒ ~18%) and closes at strength 0", () => {
    expect(newcomerWinRate(incumbentRecord(50, 10))).toBeGreaterThan(
      newcomerWinRate(incumbentRecord(50, 0)),
    );
    expect(newcomerWinRate(incumbentRecord(60, 2), { strength: 0 })).toBe(0);
  });

  it("at micro stakes the bond adds NOTHING to a newcomer's draw — strength is already 1, and the boost is capped there", () => {
    // The bond's exploration priority is real only where stakes have scaled
    // strength below 1 (the $0.10–$1 band); document the identity so nobody
    // reads "bonded newcomers are sampled harder" as a micro-stakes promise.
    const plain = newcomerWinRate(incumbentRecord(60, 2));
    const bonded = newcomerWinRate(incumbentRecord(60, 2), { strength: 1, bonded: true });
    expect(bonded).toBe(plain);
    // …and at mid stakes it does: strength 0.5 alone nearly closes the ramp, the bond reopens it.
    const midPlain = newcomerWinRate(incumbentRecord(60, 2), { strength: 0.5 });
    const midBonded = newcomerWinRate(incumbentRecord(60, 2), { strength: 0.5, bonded: true });
    expect(midBonded).toBeGreaterThan(midPlain);
  });
});
