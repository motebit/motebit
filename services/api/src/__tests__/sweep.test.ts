/**
 * Auto-sweep tests — relay balance → sovereign wallet.
 *
 * Tests that the sweep loop creates withdrawals for agents whose
 * balance exceeds their configured sweep_threshold.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import { creditAccount } from "../accounts.js";
import { startSweepLoop } from "../sweep.js";
import { AUTH_HEADER, createTestRelay } from "./test-helpers.js";

async function registerAgent(
  relay: SyncRelay,
  motebitId: string,
  publicKeyHex: string,
  opts?: { settlementAddress?: string; settlementModes?: string; sweepThreshold?: number },
) {
  await relay.app.request(`/api/v1/agents/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({
      motebit_id: motebitId,
      endpoint_url: "http://localhost:9999/mcp",
      capabilities: ["web_search"],
      public_key: publicKeyHex,
      ...(opts?.settlementAddress ? { settlement_address: opts.settlementAddress } : {}),
      ...(opts?.settlementModes ? { settlement_modes: opts.settlementModes } : {}),
      ...(opts?.sweepThreshold !== undefined ? { sweep_threshold: opts.sweepThreshold } : {}),
    }),
  });
}

describe("Auto-sweep", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
  });

  afterEach(async () => {
    await relay.close();
  });

  it("creates withdrawal when balance exceeds sweep_threshold", async () => {
    const kp = await generateKeypair();
    const address = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv";
    await registerAgent(relay, "sweep-agent", bytesToHex(kp.publicKey), {
      settlementAddress: address,
      settlementModes: "relay,p2p",
      sweepThreshold: 5_000_000, // keep $5 as reserve
    });

    // Credit $10 to the agent
    creditAccount(relay.moteDb.db, "sweep-agent", 10_000_000, "deposit", "test-dep-1", "test");

    // Run sweep with a short interval and wait for it to fire
    const interval = startSweepLoop(relay.moteDb.db, { intervalMs: 50, minSweepAmount: 1_000_000 });
    await new Promise((r) => setTimeout(r, 200));
    clearInterval(interval);

    // Verify a withdrawal was created
    const withdrawals = relay.moteDb.db
      .prepare("SELECT * FROM relay_withdrawals WHERE motebit_id = ?")
      .all("sweep-agent") as Array<{
      withdrawal_id: string;
      amount: number;
      destination: string;
      status: string;
    }>;

    expect(withdrawals.length).toBe(1);
    const w = withdrawals[0]!;
    expect(w.amount).toBe(5_000_000); // $10 - $5 threshold = $5 swept
    expect(w.destination).toBe(address);
    expect(w.status).toBe("pending");
  });

  it("does not sweep when balance is below threshold", async () => {
    const kp = await generateKeypair();
    await registerAgent(relay, "low-agent", bytesToHex(kp.publicKey), {
      settlementAddress: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv",
      sweepThreshold: 10_000_000,
    });

    // Credit only $5 (threshold is $10)
    creditAccount(relay.moteDb.db, "low-agent", 5_000_000, "deposit", "test-dep-2", "test");

    const shortInterval = startSweepLoop(relay.moteDb.db, { intervalMs: 50 });
    await new Promise((r) => setTimeout(r, 200));
    clearInterval(shortInterval);

    const withdrawals = relay.moteDb.db
      .prepare("SELECT * FROM relay_withdrawals WHERE motebit_id = ?")
      .all("low-agent");
    expect(withdrawals.length).toBe(0);
  });

  it("does not sweep agents without sweep_threshold configured", async () => {
    const kp = await generateKeypair();
    await registerAgent(relay, "no-sweep-agent", bytesToHex(kp.publicKey), {
      settlementAddress: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv",
      // No sweep_threshold
    });

    creditAccount(relay.moteDb.db, "no-sweep-agent", 100_000_000, "deposit", "test-dep-3", "test");

    const shortInterval = startSweepLoop(relay.moteDb.db, { intervalMs: 50 });
    await new Promise((r) => setTimeout(r, 200));
    clearInterval(shortInterval);

    const withdrawals = relay.moteDb.db
      .prepare("SELECT * FROM relay_withdrawals WHERE motebit_id = ?")
      .all("no-sweep-agent");
    expect(withdrawals.length).toBe(0);
  });

  it("does not sweep agents without settlement_address", async () => {
    const kp = await generateKeypair();
    await registerAgent(relay, "no-addr-agent", bytesToHex(kp.publicKey), {
      sweepThreshold: 1_000_000,
      // No settlement_address
    });

    creditAccount(relay.moteDb.db, "no-addr-agent", 100_000_000, "deposit", "test-dep-4", "test");

    const shortInterval = startSweepLoop(relay.moteDb.db, { intervalMs: 50 });
    await new Promise((r) => setTimeout(r, 200));
    clearInterval(shortInterval);

    const withdrawals = relay.moteDb.db
      .prepare("SELECT * FROM relay_withdrawals WHERE motebit_id = ?")
      .all("no-addr-agent");
    expect(withdrawals.length).toBe(0);
  });

  it("does not sweep below minimum sweep amount", async () => {
    const kp = await generateKeypair();
    await registerAgent(relay, "dust-agent", bytesToHex(kp.publicKey), {
      settlementAddress: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv",
      sweepThreshold: 9_500_000, // threshold $9.50
    });

    // Credit $10 — excess is only $0.50, below $1 minimum
    creditAccount(relay.moteDb.db, "dust-agent", 10_000_000, "deposit", "test-dep-5", "test");

    const shortInterval = startSweepLoop(relay.moteDb.db, {
      intervalMs: 50,
      minSweepAmount: 1_000_000,
    });
    await new Promise((r) => setTimeout(r, 200));
    clearInterval(shortInterval);

    const withdrawals = relay.moteDb.db
      .prepare("SELECT * FROM relay_withdrawals WHERE motebit_id = ?")
      .all("dust-agent");
    expect(withdrawals.length).toBe(0);
  });

  it("skips when emergency freeze is active", async () => {
    const kp = await generateKeypair();
    await registerAgent(relay, "frozen-agent", bytesToHex(kp.publicKey), {
      settlementAddress: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv",
      sweepThreshold: 1_000_000,
    });

    creditAccount(relay.moteDb.db, "frozen-agent", 50_000_000, "deposit", "test-dep-6", "test");

    const shortInterval = startSweepLoop(
      relay.moteDb.db,
      { intervalMs: 50 },
      () => true, // frozen
    );
    await new Promise((r) => setTimeout(r, 200));
    clearInterval(shortInterval);

    const withdrawals = relay.moteDb.db
      .prepare("SELECT * FROM relay_withdrawals WHERE motebit_id = ?")
      .all("frozen-agent");
    expect(withdrawals.length).toBe(0);
  });
});
