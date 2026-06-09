/**
 * Free "first taste" credit — the activation grant. Asserts the three caps
 * (one-time per motebit, per-IP daily, global daily budget), the off-by-default
 * behavior, and that the grant flows through the proxy-token endpoint so a fresh
 * motebit's token carries a usable balance.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSyncRelay } from "../index.js";
import type { SyncRelay } from "../index.js";
import { grantFreeCreditIfEligible, type FreeCreditConfig } from "../free-credit.js";
import { getAccountBalance, toMicro } from "../accounts.js";

const API_TOKEN = "test-token";
const NOW = Date.UTC(2026, 5, 9, 12, 0, 0);

// Small, explicit config so the caps are easy to hit in tests.
const CFG: FreeCreditConfig = {
  amountMicro: toMicro(0.1),
  ipDailyCap: 2,
  dailyBudgetMicro: toMicro(0.25), // fits exactly two 0.10 grants, not a third
};

async function createTestRelay(): Promise<SyncRelay> {
  return createSyncRelay({
    apiToken: API_TOKEN,
    enableDeviceAuth: true,
    x402: {
      payToAddress: "0x0000000000000000000000000000000000000000",
      network: "eip155:84532",
      testnet: true,
    },
  });
}

describe("grantFreeCreditIfEligible", () => {
  let relay: SyncRelay;
  let db: import("@motebit/persistence").DatabaseDriver;

  beforeEach(async () => {
    relay = await createTestRelay();
    db = relay.moteDb.db;
  });
  afterEach(async () => {
    await relay.close();
  });

  it("is inert when disabled (amount 0) — grants nothing", () => {
    const r = grantFreeCreditIfEligible(db, "m-off", "1.1.1.1", {
      config: { ...CFG, amountMicro: 0 },
      nowMs: NOW,
    });
    expect(r).toEqual({ granted: false, reason: "disabled" });
    expect(getAccountBalance(db, "m-off")).toBeNull();
  });

  it("grants once, then is idempotent for the same motebit", () => {
    const first = grantFreeCreditIfEligible(db, "m1", "1.1.1.1", { config: CFG, nowMs: NOW });
    expect(first).toEqual({ granted: true, amountMicro: toMicro(0.1) });
    expect(getAccountBalance(db, "m1")?.balance).toBe(toMicro(0.1));

    const second = grantFreeCreditIfEligible(db, "m1", "1.1.1.1", { config: CFG, nowMs: NOW });
    expect(second).toEqual({ granted: false, reason: "already_granted" });
    // Balance unchanged — no double grant.
    expect(getAccountBalance(db, "m1")?.balance).toBe(toMicro(0.1));
  });

  it("caps grants per IP per day (different motebits, same IP)", () => {
    // Generous budget so the IP cap (not the global budget) is what bites.
    const cfg = { ...CFG, dailyBudgetMicro: toMicro(1) };
    const ip = "2.2.2.2";
    expect(grantFreeCreditIfEligible(db, "a", ip, { config: cfg, nowMs: NOW }).granted).toBe(true);
    expect(grantFreeCreditIfEligible(db, "b", ip, { config: cfg, nowMs: NOW }).granted).toBe(true);
    // Third from the same IP exceeds ipDailyCap=2.
    expect(grantFreeCreditIfEligible(db, "c", ip, { config: cfg, nowMs: NOW })).toEqual({
      granted: false,
      reason: "ip_cap",
    });
    // A different IP is unaffected.
    expect(grantFreeCreditIfEligible(db, "c", "3.3.3.3", { config: cfg, nowMs: NOW }).granted).toBe(
      true,
    );
  });

  it("enforces the global daily budget regardless of IP", () => {
    // Budget fits exactly two grants (0.25 > 0.20, < 0.30). Each from a fresh IP.
    expect(
      grantFreeCreditIfEligible(db, "x", "10.0.0.1", { config: CFG, nowMs: NOW }).granted,
    ).toBe(true);
    expect(
      grantFreeCreditIfEligible(db, "y", "10.0.0.2", { config: CFG, nowMs: NOW }).granted,
    ).toBe(true);
    // Third would push 0.30 > 0.25 budget — rejected even from a brand-new IP.
    expect(grantFreeCreditIfEligible(db, "z", "10.0.0.3", { config: CFG, nowMs: NOW })).toEqual({
      granted: false,
      reason: "daily_budget",
    });
  });

  it("the per-IP cap resets on a new day", () => {
    const ip = "4.4.4.4";
    grantFreeCreditIfEligible(db, "d1", ip, { config: CFG, nowMs: NOW });
    grantFreeCreditIfEligible(db, "d2", ip, { config: CFG, nowMs: NOW });
    expect(grantFreeCreditIfEligible(db, "d3", ip, { config: CFG, nowMs: NOW }).granted).toBe(
      false,
    );
    // Next day, same IP, fresh budget — allowed again.
    const nextDay = NOW + 24 * 60 * 60 * 1000;
    expect(grantFreeCreditIfEligible(db, "d3", ip, { config: CFG, nowMs: nextDay }).granted).toBe(
      true,
    );
  });
});

describe("POST /api/v1/agents/:motebitId/proxy-token — free credit lands in the token", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
    // Enable a generous free credit for the duration of this test.
    process.env.MOTEBIT_FREE_CREDIT_USD = "0.50";
  });
  afterEach(async () => {
    delete process.env.MOTEBIT_FREE_CREDIT_USD;
    await relay.close();
  });

  it("a fresh motebit's first proxy-token carries the granted balance", async () => {
    const motebitId = crypto.randomUUID();
    const res = await relay.app.request(`/api/v1/agents/${motebitId}/proxy-token`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { balance: number; balance_usd: number; models: string[] };
    expect(body.balance).toBe(toMicro(0.5));
    expect(body.balance_usd).toBeCloseTo(0.5);
    // bal > 0 ⇒ models are populated (the proxy will serve).
    expect(body.models.length).toBeGreaterThan(0);
    // Idempotent: a second token request does not double-grant.
    const res2 = await relay.app.request(`/api/v1/agents/${motebitId}/proxy-token`, {
      method: "POST",
    });
    const body2 = (await res2.json()) as { balance: number };
    expect(body2.balance).toBe(toMicro(0.5));
  });
});
