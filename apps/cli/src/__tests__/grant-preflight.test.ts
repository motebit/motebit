/**
 * Grant pre-flight — the refusal that teaches, applied to the product.
 * Each check mirrors a REAL silent boundary from the first-metered-dollar
 * ceremony (2026-07-06/07); the suite pins that every blocker carries a
 * remedy (the repair-instruction contract) and that the pre-flight is
 * advisory (it never throws, never blocks).
 */
import { describe, it, expect } from "vitest";
import { preflightGrant, renderPreflight } from "../grant-preflight.js";
import type { StoredGrant } from "../subcommands/grant.js";

const NOW = 1_783_400_000_000;
const HOUR = 3_600_000;

function stored(overrides: Partial<StoredGrant> = {}): StoredGrant {
  return {
    grant: {
      grant_id: "019f0000-0000-7000-8000-000000000000",
      scope: "delegate_to_agent",
      expires_at: NOW + 7 * 24 * HOUR,
    },
    ticks: [{ issued_at: NOW - HOUR, not_before: NOW - HOUR, expires_at: NOW + HOUR }],
    ...overrides,
  } as never;
}

const ARMED_CONFIG = {
  governance: { approvalPreset: "autonomous" },
  relay_public_key: "11c266f2749a00aa",
} as never;

describe("preflightGrant", () => {
  it("all-green chain reports armed", async () => {
    const pf = await preflightGrant({
      stored: stored(),
      now: NOW,
      fullConfig: ARMED_CONFIG,
      hasRail: true,
      getBalanceMicro: async () => 1_578_590n,
    });
    expect(pf.armed).toBe(true);
    expect(pf.checks.every((c) => c.ok)).toBe(true);
    const [line] = renderPreflight(pf, (s) => s);
    expect(line).toContain("grant armed");
  });

  it("every blocker carries a remedy — the repair-instruction contract", async () => {
    const pf = await preflightGrant({
      stored: stored({ ticks: [] }), // no tick
      now: NOW,
      fullConfig: { governance: { approvalPreset: "balanced" } } as never, // denies R4, no pin
      hasRail: false, // no rail
      getBalanceMicro: async () => 0n, // unfunded
    });
    expect(pf.armed).toBe(false);
    const failing = pf.checks.filter((c) => !c.ok);
    expect(failing.length).toBeGreaterThanOrEqual(4);
    for (const c of failing) {
      expect(c.remedy, `check "${c.name}" must teach its remedy`).toBeTruthy();
    }
    const lines = renderPreflight(pf, (s) => s).join("\n");
    expect(lines).toContain("NOT armed");
    expect(lines).toContain("autonomous"); // the exact governance fix
    expect(lines).toContain("motebit register"); // the exact pin fix
  });

  it("balanced preset is named as the R4 blocker (the ceremony's silent boundary)", async () => {
    const pf = await preflightGrant({
      stored: stored(),
      now: NOW,
      fullConfig: {
        relay_public_key: "11c266f2749a00aa",
        governance: { approvalPreset: "balanced" },
      } as never,
      hasRail: true,
    });
    const gov = pf.checks.find((c) => c.name === "governance")!;
    expect(gov.ok).toBe(false);
    expect(gov.remedy).toContain("hard ceiling");
  });

  it("undue tick names the unlock time — the schedule is the cadence", async () => {
    const pf = await preflightGrant({
      stored: stored({
        ticks: [{ issued_at: NOW, not_before: NOW + HOUR, expires_at: NOW + 2 * HOUR }],
      } as never),
      now: NOW,
      fullConfig: ARMED_CONFIG,
      hasRail: true,
    });
    const tick = pf.checks.find((c) => c.name === "tick")!;
    expect(tick.ok).toBe(false);
    expect(tick.remedy).toContain("next tick unlocks");
  });

  it("revoked grant is terminal and says so", async () => {
    const pf = await preflightGrant({
      stored: stored({ revocation: { revoked_at: NOW } } as never),
      now: NOW,
      fullConfig: ARMED_CONFIG,
      hasRail: true,
    });
    const g = pf.checks.find((c) => c.name === "grant")!;
    expect(g.ok).toBe(false);
    expect(g.detail).toContain("REVOKED");
    expect(g.remedy).toContain("terminal");
  });

  it("RPC failure on the balance check soft-passes — advisory, never blocking", async () => {
    const pf = await preflightGrant({
      stored: stored(),
      now: NOW,
      fullConfig: ARMED_CONFIG,
      hasRail: true,
      getBalanceMicro: async () => {
        throw new Error("rpc down");
      },
    });
    expect(pf.armed).toBe(true);
    expect(pf.checks.find((c) => c.name === "wallet")!.detail).toContain("meter still bounds");
  });
});
