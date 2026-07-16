import { describe, it, expect } from "vitest";
import { asMotebitId, AgentTrustLevel } from "@motebit/protocol";
import type { AgentTrustRecord } from "@motebit/protocol";
import { rankWorkers, selectWorker } from "../worker-selection.js";
import type { RankableWorker } from "../worker-selection.js";

const SELF = asMotebitId("self-molecule");

function record(
  remoteId: string,
  level: AgentTrustLevel,
  successful = 0,
  failed = 0,
): AgentTrustRecord {
  return {
    motebit_id: SELF,
    remote_motebit_id: asMotebitId(remoteId),
    trust_level: level,
    first_seen_at: Date.now() - 86_400_000,
    last_seen_at: Date.now(),
    interaction_count: successful + failed,
    successful_tasks: successful,
    failed_tasks: failed,
  };
}

function cand(
  motebit_id: string,
  trustRecord: AgentTrustRecord | null,
  unitCost?: number,
): RankableWorker {
  return { motebit_id, trustRecord, ...(unitCost != null ? { unitCost } : {}) };
}

describe("selectWorker — first-person worker selection", () => {
  it("returns null when there are no candidates", () => {
    expect(selectWorker(SELF, [])).toBeNull();
  });

  it("prefers a trusted worker over an unknown one (trust-dominant)", () => {
    const winner = selectWorker(SELF, [
      cand("unknown-atom", null, 0.001),
      cand("trusted-atom", record("trusted-atom", AgentTrustLevel.Trusted, 20, 0), 0.001),
    ]);
    expect(winner?.motebit_id).toBe("trusted-atom");
  });

  it("still hires an unknown (no record) worker — cold-start floor, not exclusion", () => {
    // The only candidate has never been worked with. It must still be selectable.
    const winner = selectWorker(SELF, [cand("fresh-atom", null, 0.003)]);
    expect(winner?.motebit_id).toBe("fresh-atom");
    expect(winner?.route.trust).toBeGreaterThan(0); // floor, not annihilated
  });

  it("never selects a blocked worker, even when it is cheapest", () => {
    const winner = selectWorker(SELF, [
      cand("blocked-atom", record("blocked-atom", AgentTrustLevel.Blocked, 50, 0), 0.0001),
      cand("ok-atom", record("ok-atom", AgentTrustLevel.Verified, 5, 0), 0.01),
    ]);
    expect(winner?.motebit_id).toBe("ok-atom");
  });

  it("cheaper wins a tie between equally-trusted, equally-reliable workers", () => {
    // Both unknown (no record) → identical trust + reliability; cost decides.
    const winner = selectWorker(SELF, [cand("pricey", null, 0.05), cand("cheap", null, 0.001)]);
    expect(winner?.motebit_id).toBe("cheap");
  });

  it("reliability (success rate) breaks a tie between same-level workers", () => {
    // Both Verified, same price → the one with the better completed-task record wins.
    const winner = selectWorker(SELF, [
      cand("flaky", record("flaky", AgentTrustLevel.Verified, 0, 10), 0.003),
      cand("solid", record("solid", AgentTrustLevel.Verified, 10, 0), 0.003),
    ]);
    expect(winner?.motebit_id).toBe("solid");
  });

  it("accumulated successful work lifts a worker above an untried one (thesis #2)", () => {
    // A first-contact worker we've completed real work with should beat a
    // never-seen worker at the same price — the continuous reliability lever.
    const winner = selectWorker(SELF, [
      cand("untried", null, 0.003),
      cand("proven", record("proven", AgentTrustLevel.FirstContact, 15, 0), 0.003),
    ]);
    expect(winner?.motebit_id).toBe("proven");
  });

  it("is deterministic: identical-score candidates break ties by motebit_id ascending", () => {
    // Two identical unknown candidates, same price → tie → lexicographic id.
    const a = selectWorker(SELF, [cand("bbb", null, 0.002), cand("aaa", null, 0.002)]);
    const b = selectWorker(SELF, [cand("aaa", null, 0.002), cand("bbb", null, 0.002)]);
    expect(a?.motebit_id).toBe("aaa");
    expect(b?.motebit_id).toBe("aaa"); // order-independent
  });

  it("carries provenance — the winning route weight that produced the score", () => {
    const winner = selectWorker(SELF, [
      cand("atom", record("atom", AgentTrustLevel.Trusted, 8, 2), 0.004),
    ]);
    expect(winner?.route).toMatchObject({
      trust: expect.any(Number),
      cost: 0.004,
      reliability: expect.any(Number),
    });
    // 8/10 completed → Beta-binomial (1+8)/(2+10) = 0.75
    expect(winner?.route.reliability).toBeCloseTo(0.75, 5);
  });

  it("rankWorkers returns the full ordering, best first", () => {
    const ranked = rankWorkers(SELF, [
      cand("mid", record("mid", AgentTrustLevel.Verified, 3, 0), 0.003),
      cand("best", record("best", AgentTrustLevel.Trusted, 20, 0), 0.003),
      cand("worst", null, 0.003),
    ]);
    expect(ranked.map((r) => r.motebit_id)).toEqual(["best", "mid", "worst"]);
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
    expect(ranked[1]!.score).toBeGreaterThan(ranked[2]!.score);
  });

  // ── Exploration (Thompson sampling — the newcomer on-ramp) ──────────────
  const incumbent = () =>
    cand("incumbent", record("incumbent", AgentTrustLevel.Trusted, 20, 0), 0.003);

  /** How often the newcomer is hired over the incumbent across N distinct seeds. */
  function newcomerWins(newcomer: RankableWorker, N: number, strength = 1): number {
    let wins = 0;
    for (let i = 0; i < N; i++) {
      const w = selectWorker(SELF, [incumbent(), newcomer], {
        explore: { seed: `seed-${i}`, strength },
      });
      if (w?.motebit_id === newcomer.motebit_id) wins++;
    }
    return wins;
  }

  it("strength 0 is pure exploit — the newcomer never displaces the incumbent", () => {
    expect(newcomerWins(cand("newcomer", null, 0.003), 200, 0)).toBe(0);
  });

  it("full exploration gives a fresh newcomer a shot, but the incumbent still wins the majority", () => {
    const wins = newcomerWins(cand("newcomer", null, 0.003), 300, 1);
    expect(wins).toBeGreaterThan(0); // the on-ramp exists
    expect(wins).toBeLessThan(150); // …but exploitation dominates (incumbent > 50%)
  });

  it("one failure shrinks the newcomer's shots (self-correcting)", () => {
    const fresh = newcomerWins(cand("fresh", null, 0.003), 300, 1);
    const failedOnce = newcomerWins(
      cand("failed", record("failed", AgentTrustLevel.Unknown, 0, 1), 0.003),
      300,
      1,
    );
    expect(failedOnce).toBeLessThan(fresh);
  });

  it("a repeat-failer (sybil signature) collapses toward never-picked — un-farmable", () => {
    const sybil = newcomerWins(
      cand("sybil", record("sybil", AgentTrustLevel.Unknown, 0, 20), 0.003),
      300,
      1,
    );
    expect(sybil).toBeLessThan(9); // < 3% — the posterior, not a budget, is the limit
  });

  it("more strength ⇒ more exploration (monotone in the knob the runtime scales by stakes)", () => {
    const newcomer = () => cand("newcomer", null, 0.003);
    expect(newcomerWins(newcomer(), 300, 1)).toBeGreaterThan(newcomerWins(newcomer(), 300, 0.25));
  });

  it("uses the earned level as the exploration prior — Verified starts above Unknown", () => {
    // The categorical badge is a head start, not a reset: a Verified worker with
    // no task history explores from Beta(2,1) (mean 0.67), a true Unknown from
    // Beta(1,1) (mean 0.5), so Verified is hired more often than not.
    let verifiedWins = 0;
    for (let i = 0; i < 300; i++) {
      const pick = selectWorker(
        SELF,
        [
          cand("unknown-nc", null, 0.003),
          cand("verified-nc", record("verified-nc", AgentTrustLevel.Verified, 0, 0), 0.003),
        ],
        { explore: { seed: `s${i}`, strength: 1 } },
      );
      if (pick?.motebit_id === "verified-nc") verifiedWins++;
    }
    expect(verifiedWins).toBeGreaterThan(150);
  });

  it("is reproducible: the same seed yields the same hire (offline-auditable)", () => {
    const cands = [incumbent(), cand("newcomer", null, 0.003)];
    const a = selectWorker(SELF, cands, { explore: { seed: "jti-fixed", strength: 1 } });
    const b = selectWorker(SELF, cands, { explore: { seed: "jti-fixed", strength: 1 } });
    expect(a?.motebit_id).toBe(b?.motebit_id);
    expect(a?.score).toBe(b?.score);
  });

  it("honors custom weights — a cost-dominant caller prefers the cheaper on a material gap", () => {
    // Cost normalization (1/(1+cost)) is nearly flat below ~$0.10, so cost is a
    // weak tiebreaker at micro-scale by design — you don't drop a trusted worker
    // to save a fraction of a cent. But across a MATERIAL gap ($0.001 vs $3.00)
    // a cost-dominant caller correctly takes the cheap unknown over pricey trust.
    const winner = selectWorker(
      SELF,
      [
        cand("cheap-unknown", null, 0.001),
        cand("pricey-trusted", record("pricey-trusted", AgentTrustLevel.Trusted, 20, 0), 3.0),
      ],
      { weights: { trust: 0.1, reliability: 0.1, cost: 0.8, latency: 0 } },
    );
    expect(winner?.motebit_id).toBe("cheap-unknown");
  });
});
