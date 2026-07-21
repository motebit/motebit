/**
 * The routing-decision transcript's semiring half (Inc 2 —
 * docs/doctrine/routing-decision-transcript.md): the produced-basis emitter
 * (`rankWorkersWithBasis`) freezes exactly what the ranking consumed, and the
 * faithfulness rung (`recomputeRoutingDecision`) recomputes the decision from
 * the frozen inputs — accepting an honest transcript and catching a tampered
 * one (a lied-about draw, a substituted winner).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTrustRecord, MotebitId } from "@motebit/protocol";
import { AgentTrustLevel } from "@motebit/protocol";
import {
  rankWorkers,
  rankWorkersWithBasis,
  recomputeRoutingDecision,
  WORKER_SELECTION_ALGORITHM_VERSION,
  type RankableWorker,
} from "../worker-selection.js";

const SELF = "alice" as MotebitId;

function record(over: Partial<AgentTrustRecord> = {}): AgentTrustRecord {
  return {
    motebit_id: "alice",
    remote_motebit_id: "bob",
    trust_level: AgentTrustLevel.Verified,
    interaction_count: 10,
    successful_tasks: 8,
    failed_tasks: 1,
    first_seen_at: 0,
    last_seen_at: 0,
    ...over,
  } as AgentTrustRecord;
}

const incumbent: RankableWorker = {
  motebit_id: "bob",
  trustRecord: record({ remote_motebit_id: "bob", successful_tasks: 20, failed_tasks: 1 }),
  unitCost: 0.05,
};
const newcomer: RankableWorker = {
  motebit_id: "carol",
  trustRecord: null,
  unitCost: 0.03,
  bonded: true,
};

describe("rankWorkersWithBasis — the produced-basis emitter", () => {
  it("returns the same winner as rankWorkers and a basis whose recomputation is consistent (explore mode)", () => {
    const opts = { explore: { seed: "tick-sig-1", strength: 1 }, capability: "web_search" };
    const { winner, basis } = rankWorkersWithBasis(SELF, [incumbent, newcomer], opts);
    expect(winner?.motebit_id).toBe(rankWorkers(SELF, [incumbent, newcomer], opts)[0]!.motebit_id);
    expect(basis).not.toBeNull();
    expect(basis!.winner_motebit_id).toBe(winner!.motebit_id);
    expect(basis!.algorithm_version).toBe(WORKER_SELECTION_ALGORITHM_VERSION);
    expect(basis!.seed).toBe("tick-sig-1");
    expect(basis!.capability).toBe("web_search");
    // Every explore-mode candidate freezes its posterior + draw.
    for (const c of basis!.candidates) {
      expect(c.alpha).toBeGreaterThan(0);
      expect(c.beta).toBeGreaterThan(0);
      expect(typeof c.theta).toBe("number");
    }
    // The bonded flag survives as explicit-true only.
    const carol = basis!.candidates.find((c) => c.motebit_id === "carol");
    expect(carol?.bonded).toBe(true);
    expect(basis!.candidates.find((c) => c.motebit_id === "bob")?.bonded).toBeUndefined();
    // Frozen order is the ranked order.
    expect(basis!.candidates[0]!.motebit_id).toBe(winner!.motebit_id);

    expect(recomputeRoutingDecision(basis!)).toEqual({
      consistent: true,
      recomputed_winner: winner!.motebit_id,
    });
  });

  it("exploit mode (strength 0) freezes axis values without a posterior and still recomputes", () => {
    const { winner, basis } = rankWorkersWithBasis(SELF, [incumbent, newcomer], {
      explore: { seed: "tick-sig-2", strength: 0 },
      capability: "web_search",
    });
    expect(winner).not.toBeNull();
    expect(basis!.strength).toBe(0);
    for (const c of basis!.candidates) {
      expect(c.alpha).toBeUndefined();
      expect(c.theta).toBeUndefined();
      expect(typeof c.trust_axis).toBe("number");
    }
    expect(recomputeRoutingDecision(basis!).consistent).toBe(true);
  });

  it("capability-blind, explore-less, unpriced ranking still freezes a recomputable basis", () => {
    // No explore config, no weights, no capability, no unit costs — every
    // optional input takes its default path. The basis records seed "" and
    // strength 0, exploit axes, and still recomputes.
    const bare: RankableWorker[] = [
      { motebit_id: "bob", trustRecord: record({ remote_motebit_id: "bob" }) },
      { motebit_id: "carol", trustRecord: null },
    ];
    const { winner, basis } = rankWorkersWithBasis(SELF, bare);
    expect(winner).not.toBeNull();
    expect(basis!.seed).toBe("");
    expect(basis!.strength).toBe(0);
    expect(basis!.capability).toBe("");
    expect(basis!.explored).toBe(false);
    for (const c of basis!.candidates) expect(c.unit_cost).toBeUndefined();
    expect(recomputeRoutingDecision(basis!).consistent).toBe(true);
  });

  it("a blocked candidate is excluded from the frozen set entirely", () => {
    const blocked: RankableWorker = {
      motebit_id: "mallory",
      trustRecord: record({
        remote_motebit_id: "mallory",
        trust_level: AgentTrustLevel.Blocked,
      }),
    };
    const { basis } = rankWorkersWithBasis(SELF, [incumbent, blocked], {
      explore: { seed: "s", strength: 1 },
      capability: "web_search",
    });
    expect(basis!.candidates.some((c) => c.motebit_id === "mallory")).toBe(false);
  });

  it("returns null basis exactly when there is no admissible candidate", () => {
    const { winner, basis } = rankWorkersWithBasis(SELF, [], {
      explore: { seed: "s", strength: 1 },
    });
    expect(winner).toBeNull();
    expect(basis).toBeNull();
  });
});

describe("recomputeRoutingDecision — the faithfulness rung", () => {
  const mint = () =>
    rankWorkersWithBasis(SELF, [incumbent, newcomer], {
      explore: { seed: "tick-sig-3", strength: 1 },
      capability: "web_search",
    }).basis!;

  it("catches a lied-about draw (theta_mismatch)", () => {
    const basis = mint();
    const tampered = {
      ...basis,
      candidates: basis.candidates.map((c, i) => (i === 0 ? { ...c, theta: 0.999999 } : c)),
    };
    expect(recomputeRoutingDecision(tampered)).toMatchObject({
      consistent: false,
      reason: "theta_mismatch",
    });
  });

  it("catches a substituted winner (winner_mismatch)", () => {
    const basis = mint();
    const loser = basis.candidates.find((c) => c.motebit_id !== basis.winner_motebit_id)!;
    expect(
      recomputeRoutingDecision({ ...basis, winner_motebit_id: loser.motebit_id }),
    ).toMatchObject({
      consistent: false,
      reason: "winner_mismatch",
      recomputed_winner: basis.winner_motebit_id,
    });
  });

  it("catches a doctored axis value (axis_mismatch)", () => {
    const basis = mint();
    const tampered = {
      ...basis,
      candidates: basis.candidates.map((c, i) => (i === 1 ? { ...c, trust_axis: 0.0001 } : c)),
    };
    expect(recomputeRoutingDecision(tampered)).toMatchObject({
      consistent: false,
      reason: "axis_mismatch",
    });
  });

  it("explore config without a strength field defaults to full exploration (strength 1)", () => {
    const { basis } = rankWorkersWithBasis(SELF, [incumbent, newcomer], {
      explore: { seed: "tick-sig-defaults" },
      capability: "web_search",
    });
    expect(basis!.strength).toBe(1);
    expect(recomputeRoutingDecision(basis!).consistent).toBe(true);
  });

  it("a non-array candidates field fails closed as empty_candidates", () => {
    const basis = mint();
    expect(recomputeRoutingDecision({ ...basis, candidates: "notanarray" as never })).toEqual({
      consistent: false,
      reason: "empty_candidates",
    });
  });

  it("recomputation breaks composite ties by motebit_id ascending, like the live ranker", () => {
    const basis = mint();
    const twin = { ...basis.candidates[0]!, motebit_id: "zz-twin" };
    const { theta: _t, alpha: _a, beta: _b, ...bare } = twin;
    const first = basis.candidates[0]!;
    const { theta: _t2, alpha: _a2, beta: _b2, ...bareFirst } = first;
    const tied = {
      ...basis,
      strength: 0,
      candidates: [bare, bareFirst],
      winner_motebit_id:
        bareFirst.motebit_id < bare.motebit_id ? bareFirst.motebit_id : bare.motebit_id,
    };
    expect(recomputeRoutingDecision(tied).consistent).toBe(true);
  });

  it("rejects an empty candidate set (a decision among nobody is not a decision)", () => {
    const basis = mint();
    expect(recomputeRoutingDecision({ ...basis, candidates: [] })).toEqual({
      consistent: false,
      reason: "empty_candidates",
    });
  });

  it("a tampered non-integer posterior makes the sampler throw — caught as theta_mismatch", () => {
    const basis = mint();
    const tampered = {
      ...basis,
      candidates: basis.candidates.map((c, i) => (i === 0 ? { ...c, alpha: 1.5 } : c)),
    };
    expect(recomputeRoutingDecision(tampered)).toMatchObject({
      consistent: false,
      reason: "theta_mismatch",
    });
  });

  it("a posterior-carrying candidate under zero effective strength must sit at the mean", () => {
    // A foreign/tampered basis shape the emitter never mints: posteriors
    // present but strength 0. The axis must equal the posterior mean.
    const basis = mint();
    const zeroStrength = {
      ...basis,
      strength: 0,
      candidates: basis.candidates.map((c) => {
        const mean = c.alpha! / (c.alpha! + c.beta!);
        const { theta: _t, ...rest } = c;
        return { ...rest, trust_axis: mean, reliability_axis: mean };
      }),
    };
    // Honest mean-axes: step 1 passes; winner may legitimately differ from the
    // recorded explore-time winner, so only assert the axis law here.
    const honest = recomputeRoutingDecision(zeroStrength);
    expect(honest.reason === "axis_mismatch").toBe(false);
    // Doctored axis under zero strength → axis_mismatch.
    const doctored = {
      ...zeroStrength,
      candidates: zeroStrength.candidates.map((c, i) => (i === 0 ? { ...c, trust_axis: 0.99 } : c)),
    };
    expect(recomputeRoutingDecision(doctored)).toMatchObject({
      consistent: false,
      reason: "axis_mismatch",
    });
  });

  it("rejects an unknown algorithm version fail-closed, never guessing", () => {
    const basis = mint();
    expect(recomputeRoutingDecision({ ...basis, algorithm_version: "someone-elses@9" })).toEqual({
      consistent: false,
      reason: "unsupported_algorithm_version",
    });
  });

  it("reproduces every faithfulness case in the conformance corpus (spec §6)", () => {
    const corpus = JSON.parse(
      readFileSync(
        join(
          dirname(fileURLToPath(import.meta.url)),
          "../../../../spec/conformance/routing-transcript/corpus.json",
        ),
        "utf8",
      ),
    ) as {
      cases: Array<{ check: string; name: string; input: { basis?: unknown }; expected: unknown }>;
    };
    const cases = corpus.cases.filter((c) => c.check === "faithfulness");
    expect(cases.length).toBeGreaterThanOrEqual(3);
    for (const c of cases) {
      expect(recomputeRoutingDecision(c.input.basis as never), c.name).toEqual(c.expected);
    }
  });
});
