/**
 * Fee-payer solvency guard tests.
 *
 * The guard exists because Solana freezes a fee-payer that would drop below the
 * rent-exempt floor — spendable headroom is `balance - rentExemptMin`, not the
 * raw balance. These tests pin the decision boundary with the exact prod
 * incident numbers (2026-07-25) and the throw-to-alert behavior.
 */
import { describe, it, expect } from "vitest";
import {
  classifyFeePayerSolvency,
  checkFeePayerSolvencyOnce,
  startFeePayerBalanceGuardLoop,
  BASE_TX_FEE_LAMPORTS,
  DEFAULT_WARN_HEADROOM_TXS,
  type FeePayerSolvencySource,
  type FeePayerGuardState,
} from "../fee-payer-guard.js";
import { LoopSupervisor } from "../loop-supervisor.js";

// The prod incident: balance sat just above the rent floor → frozen.
const INCIDENT_BALANCE = 895_000;
const INCIDENT_RENT_MIN = 890_880;

describe("classifyFeePayerSolvency — rent-floor-aware headroom", () => {
  it("headroom is balance MINUS rent-exempt-min, not the raw balance", () => {
    const s = classifyFeePayerSolvency(INCIDENT_BALANCE, INCIDENT_RENT_MIN);
    expect(s.headroomLamports).toBe(4_120); // 895_000 - 890_880
    // The trap the guard exists to close: 895_000 / 5_000 = 179 "txs" if you
    // ignore rent — but the real capacity is 0.
    expect(s.headroomTxs).toBe(0);
  });

  it("flags the incident state as frozen AND low", () => {
    const s = classifyFeePayerSolvency(INCIDENT_BALANCE, INCIDENT_RENT_MIN);
    expect(s.frozen).toBe(true); // 4_120 < 5_000 base fee
    expect(s.status).toBe("low");
  });

  it("a well-funded fee-payer is ok and not frozen", () => {
    const s = classifyFeePayerSolvency(25_000_000, INCIDENT_RENT_MIN);
    expect(s.frozen).toBe(false);
    expect(s.status).toBe("ok");
    expect(s.headroomTxs).toBeGreaterThan(DEFAULT_WARN_HEADROOM_TXS);
  });

  it("warns BEFORE the freeze — low while still spendable (proactive lead time)", () => {
    // Headroom for 50 txs: spendable but below the 200-tx warn threshold.
    const balance = INCIDENT_RENT_MIN + 50 * BASE_TX_FEE_LAMPORTS;
    const s = classifyFeePayerSolvency(balance, INCIDENT_RENT_MIN);
    expect(s.frozen).toBe(false); // can still anchor
    expect(s.status).toBe("low"); // but already alerting
    expect(s.headroomTxs).toBe(50);
  });

  it("is exactly at the boundary: warnHeadroomTxs is the first ok count", () => {
    const rent = 1_000_000;
    const atThreshold = rent + DEFAULT_WARN_HEADROOM_TXS * BASE_TX_FEE_LAMPORTS;
    expect(classifyFeePayerSolvency(atThreshold, rent).status).toBe("ok");
    expect(classifyFeePayerSolvency(atThreshold - BASE_TX_FEE_LAMPORTS, rent).status).toBe("low");
  });

  it("clamps a below-rent-min balance to 0 txs (never negative)", () => {
    const s = classifyFeePayerSolvency(500_000, INCIDENT_RENT_MIN);
    expect(s.headroomLamports).toBeLessThan(0);
    expect(s.headroomTxs).toBe(0);
    expect(s.frozen).toBe(true);
    expect(s.status).toBe("low");
  });
});

describe("checkFeePayerSolvencyOnce — throw-to-alert", () => {
  const source = (
    balanceLamports: number,
    rentExemptMinLamports: number,
  ): FeePayerSolvencySource => ({
    address: "TreasuryAddr1111111111111111111111111111111",
    getFeePayerSolvency: async () => ({ balanceLamports, rentExemptMinLamports }),
  });

  it("throws a descriptive, frozen-labeled error on the incident state", async () => {
    await expect(
      checkFeePayerSolvencyOnce(source(INCIDENT_BALANCE, INCIDENT_RENT_MIN)),
    ).rejects.toThrow(/solvency LOW.*FROZEN.*Top up/s);
  });

  it("throws (alerts) while low-but-not-yet-frozen — the proactive window", async () => {
    const balance = INCIDENT_RENT_MIN + 50 * BASE_TX_FEE_LAMPORTS;
    await expect(checkFeePayerSolvencyOnce(source(balance, INCIDENT_RENT_MIN))).rejects.toThrow(
      /solvency LOW/,
    );
    // Not frozen, so the message must NOT claim the freeze.
    await expect(checkFeePayerSolvencyOnce(source(balance, INCIDENT_RENT_MIN))).rejects.not.toThrow(
      /FROZEN/,
    );
  });

  it("returns ok (no throw) when well-funded", async () => {
    const s = await checkFeePayerSolvencyOnce(source(25_000_000, INCIDENT_RENT_MIN));
    expect(s.status).toBe("ok");
    expect(s.frozen).toBe(false);
  });

  it("propagates an RPC read failure (a distinct unhappy signal)", async () => {
    const failing: FeePayerSolvencySource = {
      address: "TreasuryAddr1111111111111111111111111111111",
      getFeePayerSolvency: async () => {
        throw new Error("429 Too Many Requests");
      },
    };
    await expect(checkFeePayerSolvencyOnce(failing)).rejects.toThrow("429 Too Many Requests");
  });

  it("marks the first healthy check once (boot-time liveness INFO), then stays marked", async () => {
    const state: FeePayerGuardState = { firstHealthyLogged: false };
    const src = source(25_000_000, INCIDENT_RENT_MIN);
    await checkFeePayerSolvencyOnce(src, {}, state);
    expect(state.firstHealthyLogged).toBe(true); // first healthy → INFO emitted
    await checkFeePayerSolvencyOnce(src, {}, state);
    expect(state.firstHealthyLogged).toBe(true); // subsequent → debug, no repeat INFO
  });

  it("does not mark first-healthy on a low check — INFO waits for the first RECOVERED-healthy tick", async () => {
    const state: FeePayerGuardState = { firstHealthyLogged: false };
    // Low at boot: throws (visible at warn), never counts as the healthy signal.
    await expect(
      checkFeePayerSolvencyOnce(source(INCIDENT_BALANCE, INCIDENT_RENT_MIN), {}, state),
    ).rejects.toThrow();
    expect(state.firstHealthyLogged).toBe(false);
    // Recovers → the first healthy tick now emits the liveness INFO.
    await checkFeePayerSolvencyOnce(source(25_000_000, INCIDENT_RENT_MIN), {}, state);
    expect(state.firstHealthyLogged).toBe(true);
  });
});

describe("startFeePayerBalanceGuardLoop — supervised registration", () => {
  it("registers `fee-payer-balance-guard` on the supervisor and returns a clearable handle", () => {
    const supervisor = new LoopSupervisor();
    const source: FeePayerSolvencySource = {
      address: "TreasuryAddr1111111111111111111111111111111",
      getFeePayerSolvency: async () => ({
        balanceLamports: 25_000_000,
        rentExemptMinLamports: 890_880,
      }),
    };
    // Huge interval so the first tick never fires during the test; the loop is
    // registered synchronously by superviseInterval before any tick.
    const handle = startFeePayerBalanceGuardLoop(source, () => false, supervisor, {
      intervalMs: 2_147_483_646,
    });
    expect(supervisor.snapshot().map((l) => l.name)).toContain("fee-payer-balance-guard");
    clearInterval(handle);
  });
});
