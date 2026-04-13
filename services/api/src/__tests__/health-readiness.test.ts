/**
 * /health/ready tests — readiness probe schema + settlement rail manifest.
 *
 * The rail manifest is the defense against silent env-var gating: a rail
 * whose config env vars are missing never registers, and the only way an
 * operator notices is by comparing the expected rail list to what
 * /health/ready reports.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import { createTestRelay } from "./test-helpers.js";

interface HealthReadyBody {
  status: "ready" | "degraded" | "not_ready";
  uptime_s: number;
  checks: {
    database: { status: string; latency_ms: number; error?: string };
    emergency_freeze: { status: string; frozen: boolean };
    shutdown: { status: string; draining: boolean };
    task_queue: { status: string; size: number; capacity: number };
    settlement_rails: {
      status: "ok";
      count: number;
      rails: Array<{
        name: string;
        custody: "relay";
        railType: "fiat" | "protocol" | "orchestration";
        supportsDeposit: boolean;
      }>;
    };
  };
}

describe("GET /health/ready", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
  });

  afterEach(async () => {
    await relay.close();
  });

  it("returns 200 with full check schema", async () => {
    const res = await relay.app.request("/health/ready");
    expect(res.status).toBe(200);

    const body = (await res.json()) as HealthReadyBody;
    expect(body.status).toBe("ready");
    expect(body.checks.database.status).toBe("ok");
    expect(body.checks.emergency_freeze.frozen).toBe(false);
    expect(body.checks.shutdown.draining).toBe(false);
    expect(body.checks.task_queue.capacity).toBeGreaterThan(0);
    expect(body.checks.settlement_rails.status).toBe("ok");
  });

  it("settlement_rails section lists registered rails", async () => {
    // Test relay registers x402 by default via X402_TEST_CONFIG in
    // test-helpers. Stripe and Bridge require env-gated config and are
    // absent here — that asymmetry is the whole point of the manifest.
    const res = await relay.app.request("/health/ready");
    const body = (await res.json()) as HealthReadyBody;

    expect(body.checks.settlement_rails).toBeDefined();
    const names = body.checks.settlement_rails.rails.map((r) => r.name);
    expect(names).toContain("x402");
    expect(names).not.toContain("stripe");
    expect(names).not.toContain("bridge");
    expect(body.checks.settlement_rails.count).toBe(names.length);
  });
});

describe("GET /health/ready — settlement rails", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay({
      enableDeviceAuth: false,
      stripe: {
        secretKey: "sk_test_dummy",
        webhookSecret: "whsec_dummy",
      },
    });
  });

  afterEach(async () => {
    await relay.close();
  });

  it("reports stripe rail when configured", async () => {
    const res = await relay.app.request("/health/ready");
    const body = (await res.json()) as HealthReadyBody;

    const stripe = body.checks.settlement_rails.rails.find((r) => r.name === "stripe");
    expect(stripe).toBeDefined();
    expect(stripe?.railType).toBe("fiat");
    expect(stripe?.supportsDeposit).toBe(true);
  });
});
