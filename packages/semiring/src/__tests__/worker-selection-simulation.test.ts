/**
 * The end-game proof for exploration (docs/doctrine/exploration-as-market-vitality.md
 * Inc 4): a deterministic multi-round bandit simulation. Workers have a HIDDEN
 * true quality θ; each round the market ranks them (first-person, explore mode),
 * hires the top, runs the task (seeded coin vs θ), and updates that worker's
 * record. Everything is seeded — no Math.random, no Date — so the whole market
 * trajectory is reproducible.
 *
 * It proves, at once, the four properties a healthy trust market must have:
 *   1. it DISCOVERS a good newcomer and converges to it (exploration pays off),
 *   2. it STARVES a sybil (repeat-failer → picked ~never),
 *   3. it does NOT explore on high-stakes hops (strength 0 ⇒ pure exploit),
 *   4. a BOND promotes a good newcomer faster (priority, not quality).
 */
import { describe, it, expect } from "vitest";
import { asMotebitId, AgentTrustLevel } from "@motebit/protocol";
import type { MotebitId } from "@motebit/protocol";
import { selectWorker } from "../worker-selection.js";
import type { RankableWorker } from "../worker-selection.js";
import { mulberry32, hashSeed } from "../thompson.js";

const SELF = asMotebitId("market");

interface SimWorker {
  id: string;
  /** Hidden true success probability — the market never sees this, only outcomes. */
  theta: number;
  bonded?: boolean;
  level: AgentTrustLevel;
  succ: number;
  fail: number;
}

function toRankable(w: SimWorker): RankableWorker {
  const hasHistory = w.succ + w.fail > 0;
  const known = hasHistory || w.level !== AgentTrustLevel.Unknown;
  return {
    motebit_id: w.id,
    unitCost: 0.003,
    ...(w.bonded ? { bonded: true } : {}),
    trustRecord: known
      ? {
          motebit_id: SELF,
          remote_motebit_id: asMotebitId(w.id) as MotebitId,
          trust_level: w.level,
          first_seen_at: 0,
          last_seen_at: 0,
          interaction_count: w.succ + w.fail,
          successful_tasks: w.succ,
          failed_tasks: w.fail,
        }
      : null,
  };
}

/** Run `rounds` of hire → outcome → update. Mutates `workers`. Fully seeded. */
function simulate(
  workers: SimWorker[],
  rounds: number,
  strength: number,
): { picks: Record<string, number>; lastWindow: Record<string, number> } {
  const picks: Record<string, number> = {};
  const lastWindow: Record<string, number> = {};
  for (const w of workers) {
    picks[w.id] = 0;
    lastWindow[w.id] = 0;
  }
  const windowStart = Math.floor(rounds * 0.75);
  for (let t = 0; t < rounds; t++) {
    const pick = selectWorker(SELF, workers.map(toRankable), {
      explore: { seed: `round-${t}`, strength },
    });
    if (!pick) continue;
    const w = workers.find((x) => x.id === pick.motebit_id);
    if (!w) continue;
    picks[w.id] = (picks[w.id] ?? 0) + 1;
    if (t >= windowStart) lastWindow[w.id] = (lastWindow[w.id] ?? 0) + 1;
    // Seeded Bernoulli outcome against the hidden θ.
    const u = mulberry32(hashSeed(`outcome-${t}-${w.id}`))();
    if (u < w.theta) w.succ += 1;
    else w.fail += 1;
  }
  return { picks, lastWindow };
}

describe("exploration — bandit-market simulation (end-game proof)", () => {
  const star = (): SimWorker => ({
    id: "star",
    theta: 0.85,
    level: AgentTrustLevel.Trusted,
    succ: 20,
    fail: 2,
  });
  const goodNewcomer = (bonded = false): SimWorker => ({
    id: "good",
    theta: 0.95, // secretly BETTER than the seeded star
    level: AgentTrustLevel.Unknown,
    succ: 0,
    fail: 0,
    bonded,
  });
  const sybil = (): SimWorker => ({
    id: "sybil",
    theta: 0.05,
    level: AgentTrustLevel.Unknown,
    succ: 0,
    fail: 0,
  });

  it("discovers a better newcomer and converges to it — while starving the sybil", () => {
    const workers = [star(), goodNewcomer(), sybil()];
    const { picks, lastWindow } = simulate(workers, 400, 1);

    // 1. Convergence: by the last window the market has learned the good newcomer
    //    (θ=0.95) beats the seeded star (θ=0.85) and prefers it.
    expect(lastWindow["good"]).toBeGreaterThan(lastWindow["star"]!);

    // 2. The good newcomer was genuinely promoted (tried and kept, real history).
    const good = workers.find((w) => w.id === "good")!;
    expect(good.succ + good.fail).toBeGreaterThan(50);

    // 3. The sybil is starved — a handful of exploratory tries early, then ~never.
    expect(picks["sybil"]).toBeLessThan(picks["good"]! / 10);
  });

  it("high-stakes hops never explore — strength 0 stays on the proven incumbent", () => {
    const workers = [star(), goodNewcomer(), sybil()];
    const { picks } = simulate(workers, 200, 0);
    // Pure exploit on the posterior mean: the seeded star is hired every round;
    // the unproven newcomer and the sybil are never risked on a high-value job.
    expect(picks["star"]).toBe(200);
    expect(picks["good"]).toBe(0);
    expect(picks["sybil"]).toBe(0);
  });

  it("a bond promotes a good newcomer faster (priority, not quality)", () => {
    // Moderate stakes (strength 0.5, where the ×2 bond boost isn't clipped).
    const unbonded = simulate([star(), goodNewcomer(false), sybil()], 150, 0.5);
    const bonded = simulate([star(), goodNewcomer(true), sybil()], 150, 0.5);
    // Same hidden quality; the bond only buys earlier shots ⇒ more picks by now.
    expect(bonded.picks["good"]!).toBeGreaterThan(unbonded.picks["good"]!);
  });

  it("is fully reproducible — the same market runs identically twice", () => {
    const a = simulate([star(), goodNewcomer(), sybil()], 120, 1);
    const b = simulate([star(), goodNewcomer(), sybil()], 120, 1);
    expect(a.picks).toEqual(b.picks);
  });
});
