/**
 * Health-summary aggregation tests — single SQL pass over agent_registry,
 * relay_peers, relay_settlements, relay_federation_settlements.
 *
 * The summary is the load-bearing signal for the operator console's
 * Health panel; it answers "is the relay being used, and by whom"
 * without any external analytics infrastructure.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import { aggregateHealthSummary } from "../health-summary.js";
import { AUTH_HEADER, createTestRelay } from "./test-helpers.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function insertAgent(
  db: import("@motebit/persistence").DatabaseDriver,
  motebitId: string,
  lastHeartbeatMs: number,
) {
  db.prepare(
    `INSERT OR IGNORE INTO agent_registry
     (motebit_id, public_key, endpoint_url, capabilities, registered_at, last_heartbeat, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    motebitId,
    "pk",
    "http://example/mcp",
    "[]",
    lastHeartbeatMs,
    lastHeartbeatMs,
    lastHeartbeatMs + 15 * 60_000,
  );
}

function insertSettlement(
  db: import("@motebit/persistence").DatabaseDriver,
  settlementId: string,
  amountMicro: number,
  feeMicro: number,
  settledAtMs: number,
) {
  db.prepare(
    `INSERT OR IGNORE INTO relay_settlements
     (settlement_id, allocation_id, task_id, motebit_id, receipt_hash,
      amount_settled, platform_fee, platform_fee_rate, status, settled_at, settlement_mode)
     VALUES (?, ?, ?, ?, '', ?, ?, ?, 'completed', ?, 'relay')`,
  ).run(
    settlementId,
    `alloc-${settlementId}`,
    `task-${settlementId}`,
    "motebit-1",
    amountMicro,
    feeMicro,
    0.05,
    settledAtMs,
  );
}

function insertSubscription(
  db: import("@motebit/persistence").DatabaseDriver,
  motebitId: string,
  status: string,
  createdAtMs: number,
) {
  db.prepare(
    `INSERT OR IGNORE INTO relay_subscriptions
     (motebit_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).run(motebitId, status, createdAtMs, createdAtMs);
}

describe("aggregateHealthSummary", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
  });

  afterEach(async () => {
    await relay.close();
  });

  it("returns honest zeros on empty schema", () => {
    const now = Date.now();
    const out = aggregateHealthSummary(relay.moteDb.db, now);
    expect(out.motebits.total_registered).toBe(0);
    expect(out.motebits.active_24h).toBe(0);
    expect(out.motebits.active_7d).toBe(0);
    expect(out.motebits.active_30d).toBe(0);
    expect(out.federation.peer_count).toBe(0);
    expect(out.federation.federation_settlements_7d).toBe(0);
    expect(out.tasks.settlements_7d).toBe(0);
    expect(out.tasks.settlements_30d).toBe(0);
    expect(out.tasks.fees_7d_micro).toBe(0);
    expect(out.subscribers.total_active).toBe(0);
    expect(out.subscribers.total_lifetime).toBe(0);
    expect(out.subscribers.created_7d).toBe(0);
    expect(out.subscribers.created_30d).toBe(0);
    expect(out.subscribers.status_counts).toEqual({});
    expect(out.generated_at).toBe(now);
  });

  it("counts motebits by activity window", () => {
    const now = Date.UTC(2026, 3, 15, 12, 0, 0);
    insertAgent(relay.moteDb.db, "fresh", now - 1 * 60 * 60 * 1000); // 1h ago
    insertAgent(relay.moteDb.db, "yesterday", now - 23 * 60 * 60 * 1000); // 23h ago
    insertAgent(relay.moteDb.db, "this-week", now - 5 * DAY_MS);
    insertAgent(relay.moteDb.db, "this-month", now - 20 * DAY_MS);
    insertAgent(relay.moteDb.db, "stale", now - 60 * DAY_MS);

    const out = aggregateHealthSummary(relay.moteDb.db, now);
    expect(out.motebits.total_registered).toBe(5);
    expect(out.motebits.active_24h).toBe(2); // fresh + yesterday
    expect(out.motebits.active_7d).toBe(3); // + this-week
    expect(out.motebits.active_30d).toBe(4); // + this-month (stale excluded)
  });

  it("sums settlements + fees over 7d / 30d windows", () => {
    const now = Date.UTC(2026, 3, 15, 12, 0, 0);
    insertSettlement(relay.moteDb.db, "s1", 100_000, 5_000, now - 1 * DAY_MS);
    insertSettlement(relay.moteDb.db, "s2", 200_000, 10_000, now - 5 * DAY_MS);
    insertSettlement(relay.moteDb.db, "s3", 300_000, 15_000, now - 20 * DAY_MS); // outside 7d, inside 30d
    insertSettlement(relay.moteDb.db, "s4", 400_000, 20_000, now - 60 * DAY_MS); // outside both

    const out = aggregateHealthSummary(relay.moteDb.db, now);
    expect(out.tasks.settlements_7d).toBe(2);
    expect(out.tasks.settlements_30d).toBe(3);
    expect(out.tasks.volume_7d_micro).toBe(300_000);
    expect(out.tasks.volume_30d_micro).toBe(600_000);
    expect(out.tasks.fees_7d_micro).toBe(15_000);
    expect(out.tasks.fees_30d_micro).toBe(30_000);
  });

  it("counts subscribers by status and creation window", () => {
    const now = Date.UTC(2026, 3, 15, 12, 0, 0);
    insertSubscription(relay.moteDb.db, "paying-1", "active", now - 1 * DAY_MS);
    insertSubscription(relay.moteDb.db, "paying-2", "active", now - 5 * DAY_MS);
    insertSubscription(relay.moteDb.db, "paying-3", "active", now - 20 * DAY_MS); // outside 7d, inside 30d
    insertSubscription(relay.moteDb.db, "churned-1", "canceled", now - 10 * DAY_MS);
    insertSubscription(relay.moteDb.db, "delinquent-1", "past_due", now - 3 * DAY_MS);
    insertSubscription(relay.moteDb.db, "ancient-1", "canceled", now - 60 * DAY_MS); // outside both

    const out = aggregateHealthSummary(relay.moteDb.db, now);
    expect(out.subscribers.total_active).toBe(3);
    expect(out.subscribers.total_lifetime).toBe(6);
    expect(out.subscribers.created_7d).toBe(3); // paying-1, paying-2, delinquent-1
    expect(out.subscribers.created_30d).toBe(5); // + paying-3 + churned-1
    expect(out.subscribers.status_counts).toEqual({
      active: 3,
      canceled: 2,
      past_due: 1,
    });
  });
});

describe("GET /api/v1/admin/health (HTTP)", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
  });

  afterEach(async () => {
    await relay.close();
  });

  it("returns 401 without master bearer", async () => {
    const res = await relay.app.request("/api/v1/admin/health");
    expect(res.status).toBe(401);
  });

  it("returns the typed health-summary shape with master bearer", async () => {
    const now = Date.now();
    insertAgent(relay.moteDb.db, "m1", now - 1000);
    insertSettlement(relay.moteDb.db, "s1", 100_000, 5_000, now - 1 * DAY_MS);
    insertSubscription(relay.moteDb.db, "m1", "active", now - 1000);

    const res = await relay.app.request("/api/v1/admin/health", { headers: AUTH_HEADER });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      motebits: { total_registered: number; active_24h: number };
      federation: { peer_count: number };
      tasks: { settlements_7d: number; volume_7d_micro: number };
      subscribers: {
        total_active: number;
        total_lifetime: number;
        status_counts: Record<string, number>;
      };
      generated_at: number;
    };
    expect(body.motebits.total_registered).toBe(1);
    expect(body.motebits.active_24h).toBe(1);
    expect(body.tasks.settlements_7d).toBe(1);
    expect(body.tasks.volume_7d_micro).toBe(100_000);
    expect(body.subscribers.total_active).toBe(1);
    expect(body.subscribers.total_lifetime).toBe(1);
    expect(body.subscribers.status_counts).toEqual({ active: 1 });
    expect(typeof body.generated_at).toBe("number");
  });
});
