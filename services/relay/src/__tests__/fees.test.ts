/**
 * Fee aggregation tests — total / by-rail / by-period sums over the
 * relay_settlements ledger, plus the live HTTP endpoint round-trip
 * (master-token gated).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import { aggregateFees } from "../fees.js";
import { AUTH_HEADER, createTestRelay } from "./test-helpers.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function insertSettlement(
  db: import("@motebit/persistence").DatabaseDriver,
  settlementId: string,
  amountSettledMicro: number,
  platformFeeMicro: number,
  settledAtMs: number,
  mode: "relay" | "p2p" = "relay",
) {
  db.prepare(
    `INSERT OR IGNORE INTO relay_settlements
     (settlement_id, allocation_id, task_id, motebit_id, receipt_hash,
      amount_settled, platform_fee, platform_fee_rate, status, settled_at,
      settlement_mode)
     VALUES (?, ?, ?, ?, '', ?, ?, ?, 'completed', ?, ?)`,
  ).run(
    settlementId,
    `alloc-${settlementId}`,
    `task-${settlementId}`,
    "test-worker",
    amountSettledMicro,
    platformFeeMicro,
    0.05,
    settledAtMs,
    mode,
  );
}

describe("aggregateFees", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
  });

  afterEach(async () => {
    await relay.close();
  });

  it("returns zero totals when ledger is empty", () => {
    const now = Date.now();
    const out = aggregateFees(relay.moteDb.db, 0.05, 30, now);
    expect(out.total_collected_micro).toBe(0);
    expect(out.by_rail).toEqual([]);
    expect(out.by_period).toEqual([]);
    expect(out.fee_rate).toBe(0.05);
    expect(out.sample_window_days).toBe(30);
    expect(out.total_collected_currency).toBe("USDC");
  });

  it("sums platform_fee across the window", () => {
    const now = Date.UTC(2026, 3, 15, 12, 0, 0); // 2026-04-15 12:00 UTC
    insertSettlement(relay.moteDb.db, "s1", 100_000, 5_000, now - DAY_MS);
    insertSettlement(relay.moteDb.db, "s2", 200_000, 10_000, now - 2 * DAY_MS);
    insertSettlement(relay.moteDb.db, "s3", 50_000, 2_500, now - 5 * DAY_MS);
    const out = aggregateFees(relay.moteDb.db, 0.05, 30, now);
    expect(out.total_collected_micro).toBe(17_500);
  });

  it("excludes settlements outside the window", () => {
    const now = Date.UTC(2026, 3, 15, 12, 0, 0);
    insertSettlement(relay.moteDb.db, "in-window", 100_000, 5_000, now - 5 * DAY_MS);
    insertSettlement(relay.moteDb.db, "before-window", 100_000, 5_000, now - 60 * DAY_MS);
    const out = aggregateFees(relay.moteDb.db, 0.05, 30, now);
    expect(out.total_collected_micro).toBe(5_000);
  });

  it("groups by rail (settlement_mode)", () => {
    const now = Date.UTC(2026, 3, 15, 12, 0, 0);
    insertSettlement(relay.moteDb.db, "r1", 100_000, 5_000, now - DAY_MS, "relay");
    insertSettlement(relay.moteDb.db, "r2", 200_000, 10_000, now - 2 * DAY_MS, "relay");
    insertSettlement(relay.moteDb.db, "p1", 50_000, 0, now - DAY_MS, "p2p");
    const out = aggregateFees(relay.moteDb.db, 0.05, 30, now);
    expect(out.by_rail.length).toBe(2);
    const relay_row = out.by_rail.find((r) => r.rail === "relay");
    const p2p_row = out.by_rail.find((r) => r.rail === "p2p");
    expect(relay_row?.collected_micro).toBe(15_000);
    expect(p2p_row?.collected_micro).toBe(0);
  });

  it("buckets by UTC day in by_period", () => {
    const day0 = Date.UTC(2026, 3, 10, 0, 0, 0);
    const day1 = day0 + DAY_MS;
    const day2 = day0 + 2 * DAY_MS;
    insertSettlement(relay.moteDb.db, "d0a", 100_000, 5_000, day0 + 3_600_000);
    insertSettlement(relay.moteDb.db, "d0b", 100_000, 3_000, day0 + 7_200_000);
    insertSettlement(relay.moteDb.db, "d2", 100_000, 7_000, day2 + 3_600_000);
    const out = aggregateFees(relay.moteDb.db, 0.05, 30, day2 + 12 * 3_600_000);
    expect(out.by_period.length).toBe(2);
    const d0_bucket = out.by_period.find((p) => p.period_start === day0);
    const d2_bucket = out.by_period.find((p) => p.period_start === day2);
    expect(d0_bucket?.collected_micro).toBe(8_000);
    expect(d0_bucket?.period_end).toBe(day1);
    expect(d2_bucket?.collected_micro).toBe(7_000);
  });
});

describe("GET /api/v1/admin/fees (HTTP)", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
  });

  afterEach(async () => {
    await relay.close();
  });

  it("returns 401 without master bearer", async () => {
    const res = await relay.app.request("/api/v1/admin/fees");
    expect(res.status).toBe(401);
  });

  it("returns aggregated fees with master bearer", async () => {
    const now = Date.now();
    insertSettlement(relay.moteDb.db, "s1", 100_000, 5_000, now - DAY_MS);
    insertSettlement(relay.moteDb.db, "s2", 200_000, 10_000, now - 2 * DAY_MS);

    const res = await relay.app.request("/api/v1/admin/fees", { headers: AUTH_HEADER });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total_collected_micro: number;
      total_collected_currency: string;
      fee_rate: number;
      sample_window_days: number;
      by_rail: Array<{ rail: string; collected_micro: number }>;
    };
    expect(body.total_collected_micro).toBe(15_000);
    expect(body.total_collected_currency).toBe("USDC");
    expect(body.fee_rate).toBe(0.05);
    expect(body.sample_window_days).toBe(30);
    expect(body.by_rail[0]?.rail).toBe("relay");
  });

  it("clamps window_days to [1, 365]", async () => {
    const res1 = await relay.app.request("/api/v1/admin/fees?window_days=99999", {
      headers: AUTH_HEADER,
    });
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { sample_window_days: number };
    expect(body1.sample_window_days).toBe(365);

    const res2 = await relay.app.request("/api/v1/admin/fees?window_days=0", {
      headers: AUTH_HEADER,
    });
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { sample_window_days: number };
    expect(body2.sample_window_days).toBe(30); // falls back to default

    const res3 = await relay.app.request("/api/v1/admin/fees?window_days=7", {
      headers: AUTH_HEADER,
    });
    expect(res3.status).toBe(200);
    const body3 = (await res3.json()) as { sample_window_days: number };
    expect(body3.sample_window_days).toBe(7);
  });

  it("rejects non-numeric window_days, falls back to 30", async () => {
    const res = await relay.app.request("/api/v1/admin/fees?window_days=banana", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sample_window_days: number };
    expect(body.sample_window_days).toBe(30);
  });
});
