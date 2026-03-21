/**
 * Stripe Checkout integration tests.
 *
 * Tests the processStripeCheckout() function directly (pure logic, no Stripe API calls)
 * and the webhook/checkout route wiring via the relay app.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSyncRelay } from "../index.js";
import type { SyncRelay } from "../index.js";
import { processStripeCheckout, getOrCreateAccount, getTransactions } from "../accounts.js";
import { openMotebitDatabase } from "@motebit/persistence";
import type { MotebitDatabase } from "@motebit/persistence";

const API_TOKEN = "test-token";
const AUTH_HEADER = { Authorization: `Bearer ${API_TOKEN}` };

// === Direct unit tests for processStripeCheckout ===

describe("processStripeCheckout", () => {
  let moteDb: MotebitDatabase;

  beforeEach(async () => {
    moteDb = await openMotebitDatabase(":memory:");
    // Create account tables
    moteDb.db.exec(`
      CREATE TABLE IF NOT EXISTS relay_accounts (
        motebit_id TEXT PRIMARY KEY,
        balance REAL NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'USD',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS relay_transactions (
        transaction_id TEXT PRIMARY KEY,
        motebit_id TEXT NOT NULL,
        type TEXT NOT NULL,
        amount REAL NOT NULL,
        balance_after REAL NOT NULL,
        reference_id TEXT,
        description TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_relay_txn_motebit ON relay_transactions (motebit_id, created_at DESC);
    `);
  });

  afterEach(() => {
    moteDb.db.close();
  });

  it("credits agent balance on first call", () => {
    const motebitId = "agent-001";
    const sessionId = "cs_test_abc123";

    const applied = processStripeCheckout(moteDb.db, sessionId, motebitId, 25.0, "pi_xyz");
    expect(applied).toBe(true);

    const account = getOrCreateAccount(moteDb.db, motebitId);
    expect(account.balance).toBe(25.0);

    const txns = getTransactions(moteDb.db, motebitId);
    expect(txns).toHaveLength(1);
    const txn = txns[0]!;
    expect(txn.type).toBe("deposit");
    expect(txn.amount).toBe(25.0);
    expect(txn.reference_id).toBe(sessionId);
    expect(txn.description).toBe("Stripe Checkout: pi_xyz");
  });

  it("is idempotent — same session ID does not double-credit", () => {
    const motebitId = "agent-002";
    const sessionId = "cs_test_idempotent";

    const first = processStripeCheckout(moteDb.db, sessionId, motebitId, 50.0);
    expect(first).toBe(true);

    const second = processStripeCheckout(moteDb.db, sessionId, motebitId, 50.0);
    expect(second).toBe(false);

    const account = getOrCreateAccount(moteDb.db, motebitId);
    expect(account.balance).toBe(50.0); // not 100

    const txns = getTransactions(moteDb.db, motebitId);
    expect(txns).toHaveLength(1);
  });

  it("rejects zero or negative amounts", () => {
    const motebitId = "agent-003";

    expect(processStripeCheckout(moteDb.db, "cs_zero", motebitId, 0)).toBe(false);
    expect(processStripeCheckout(moteDb.db, "cs_neg", motebitId, -10)).toBe(false);

    const account = getOrCreateAccount(moteDb.db, motebitId);
    expect(account.balance).toBe(0);
  });

  it("uses session ID as description fallback when no payment intent", () => {
    const motebitId = "agent-004";
    const sessionId = "cs_test_nopi";

    processStripeCheckout(moteDb.db, sessionId, motebitId, 10.0);

    const txns = getTransactions(moteDb.db, motebitId);
    expect(txns[0]!.description).toBe(`Stripe Checkout: ${sessionId}`);
  });

  it("handles multiple deposits to the same agent", () => {
    const motebitId = "agent-005";

    processStripeCheckout(moteDb.db, "cs_1", motebitId, 10.0);
    processStripeCheckout(moteDb.db, "cs_2", motebitId, 20.0);
    processStripeCheckout(moteDb.db, "cs_3", motebitId, 30.0);

    const account = getOrCreateAccount(moteDb.db, motebitId);
    expect(account.balance).toBe(60.0);

    const txns = getTransactions(moteDb.db, motebitId);
    expect(txns).toHaveLength(3);
  });
});

// === Route-level tests ===

describe("Stripe Checkout routes", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createSyncRelay({
      apiToken: API_TOKEN,
      enableDeviceAuth: true,
      x402: {
        payToAddress: "0x0000000000000000000000000000000000000000",
        network: "eip155:84532",
        testnet: true,
      },
      // No stripe config — endpoints should return 501
    });
  });

  afterEach(() => {
    relay.close();
  });

  it("POST /checkout returns 501 when Stripe is not configured", async () => {
    // Create an identity first
    const identityRes = await relay.app.request("/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ owner_id: "owner-checkout-test" }),
    });
    const identity = (await identityRes.json()) as { motebit_id: string };

    const res = await relay.app.request(`/api/v1/agents/${identity.motebit_id}/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ amount: 10 }),
    });
    expect(res.status).toBe(501);
  });

  it("POST /stripe/webhook returns 501 when Stripe is not configured", async () => {
    const res = await relay.app.request("/api/v1/stripe/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": "t=123,v1=abc",
      },
      body: JSON.stringify({ type: "checkout.session.completed" }),
    });
    expect(res.status).toBe(501);
  });
});
