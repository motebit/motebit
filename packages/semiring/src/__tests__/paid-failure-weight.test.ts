/**
 * A paid failure costs more trust than a free one — the trust-graph recourse
 * of docs/doctrine/paid-failure-recourse.md, read by the ranker. The runtime
 * writes `paid_failure_penalty` (extra integer pseudo-failures) into the
 * capability bucket; the selector adds it to the failure count. Pinned as
 * probabilities so the recourse cannot silently regress to money-blind.
 */
import { describe, it, expect } from "vitest";
import { asMotebitId, AgentTrustLevel } from "@motebit/protocol";
import type { AgentTrustRecord } from "@motebit/protocol";
import { rankWorkers } from "../worker-selection.js";

const self = asMotebitId("self");
const CAP = "web_search";
const rec = (
  id: string,
  s: number,
  f: number,
  penalty = 0,
  level = AgentTrustLevel.FirstContact,
): AgentTrustRecord =>
  ({
    motebit_id: self,
    remote_motebit_id: asMotebitId(id),
    trust_level: level,
    first_seen_at: 0,
    last_seen_at: 0,
    interaction_count: s + f,
    successful_tasks: s,
    failed_tasks: f,
    capability_stats: {
      [CAP]: {
        successful_tasks: s,
        failed_tasks: f,
        ...(penalty > 0 ? { paid_failure_penalty: penalty } : {}),
      },
    },
  }) as AgentTrustRecord;

const DRAWS = 2000;
function rehireRate(offender: AgentTrustRecord, rival: AgentTrustRecord | null): number {
  let wins = 0;
  for (let i = 0; i < DRAWS; i++) {
    const r = rankWorkers(
      self,
      [
        { motebit_id: "offender", trustRecord: offender, unitCost: 0.003 },
        { motebit_id: "rival", trustRecord: rival, unitCost: 0.003 },
      ],
      { explore: { seed: `pf-${i}`, strength: 1 }, capability: CAP },
    );
    if (r[0]!.motebit_id === "offender") wins++;
  }
  return wins / DRAWS;
}

describe("a paid failure weighs more than a free one (re-hire odds vs an equal rival)", () => {
  const rival = rec("rival", 3, 0);
  it("free failure roughly halves the re-hire odds; a $0.003 paid failure (weight 2) and a $0.25 one (weight 5) cut deeper", () => {
    const clean = rehireRate(rec("o", 3, 0), rival); // ≈ 0.50 — symmetric
    const free = rehireRate(rec("o", 3, 1), rival); // one failure, penalty 0 — measured 0.29
    const atom = rehireRate(rec("o", 3, 1, 1), rival); // weight 2 ⇒ penalty 1 — measured 0.17
    const molecule = rehireRate(rec("o", 3, 1, 4), rival); // weight 5 ⇒ penalty 4 — measured 0.06
    expect(clean).toBeGreaterThan(0.4);
    expect(clean).toBeLessThan(0.6);
    expect(free).toBeLessThan(clean);
    expect(atom).toBeLessThan(free);
    expect(molecule).toBeLessThan(atom);
    expect(atom).toBeLessThanOrEqual(0.25);
    expect(molecule).toBeLessThanOrEqual(0.1);
  });

  it("is expensive, never annihilating: one weight-3 paid failure barely dents a 60-success incumbent against a cold rival", () => {
    const before = rehireRate(rec("o", 60, 0, 0, AgentTrustLevel.Trusted), null);
    const after = rehireRate(rec("o", 60, 1, 2, AgentTrustLevel.Trusted), null);
    expect(before).toBeGreaterThan(0.95);
    expect(after).toBeGreaterThan(0.9);
    expect(after).toBeLessThan(before);
  });

  it("the penalty is read per capability, and aggregate reads sum every bucket including the unscoped `*` bucket", () => {
    const scoped = {
      ...rec("o", 3, 1, 4),
      capability_stats: {
        [CAP]: { successful_tasks: 3, failed_tasks: 1, paid_failure_penalty: 4 },
        read_url: { successful_tasks: 5, failed_tasks: 0 },
        "*": { successful_tasks: 0, failed_tasks: 0, paid_failure_penalty: 2 },
      },
    } as AgentTrustRecord;
    // Hiring for read_url ignores the web_search penalty entirely.
    const readUrl = rankWorkers(
      self,
      [
        { motebit_id: "o", trustRecord: scoped, unitCost: 0.003 },
        { motebit_id: "rival", trustRecord: rec("rival", 5, 0), unitCost: 0.003 },
      ],
      { capability: "read_url" },
    );
    expect(readUrl[0]!.route.reliability).toBeCloseTo((1 + 5) / (2 + 5), 10);
    // Capability-blind read: failed = 1 + 4 + 2 = 7 on top of the aggregate counts.
    const blind = rankWorkers(self, [{ motebit_id: "o", trustRecord: scoped, unitCost: 0.003 }]);
    expect(blind[0]!.route.reliability).toBeCloseTo((1 + 3) / (2 + 3 + 7), 10);
  });
});
