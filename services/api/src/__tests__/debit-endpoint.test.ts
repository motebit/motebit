/**
 * POST /api/v1/agents/:motebitId/debit — proxy debit endpoint.
 * Authenticated via x-relay-secret header (shared secret, not user auth).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSyncRelay } from "../index.js";
import type { SyncRelay } from "../index.js";

const API_TOKEN = "test-token";
const AUTH_HEADER = { Authorization: `Bearer ${API_TOKEN}` };
const RELAY_SECRET = "test-relay-secret";

let relay: SyncRelay;
let motebitId: string;

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

async function createIdentity(r: SyncRelay): Promise<string> {
  const res = await r.app.request("/identity", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({ owner_id: `owner-${crypto.randomUUID()}` }),
  });
  const body = (await res.json()) as { motebit_id: string };
  return body.motebit_id;
}

async function deposit(r: SyncRelay, id: string, amount: number): Promise<void> {
  const res = await r.app.request(`/api/v1/agents/${id}/deposit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...AUTH_HEADER,
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({ amount }),
  });
  expect(res.status).toBe(200);
}

async function debitRequest(
  r: SyncRelay,
  id: string,
  body: Record<string, unknown>,
  secret?: string,
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== undefined) headers["x-relay-secret"] = secret;
  return await r.app.request(`/api/v1/agents/${id}/debit`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/v1/agents/:motebitId/debit", () => {
  beforeEach(async () => {
    process.env.RELAY_PROXY_SECRET = RELAY_SECRET;
    relay = await createTestRelay();
    motebitId = await createIdentity(relay);
  });

  afterEach(() => {
    delete process.env.RELAY_PROXY_SECRET;
    relay.close();
  });

  // ── Auth ────────────────────────────────────────────────────────────────

  it("rejects requests with no x-relay-secret header", async () => {
    const res = await debitRequest(relay, motebitId, {
      amount: 1000,
      reference_id: "ref-no-secret",
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  it("rejects requests with wrong x-relay-secret", async () => {
    const res = await debitRequest(
      relay,
      motebitId,
      { amount: 1000, reference_id: "ref-bad-secret" },
      "wrong-secret",
    );
    expect(res.status).toBe(401);
  });

  it("rejects when RELAY_PROXY_SECRET is not set in env", async () => {
    delete process.env.RELAY_PROXY_SECRET;
    const res = await debitRequest(
      relay,
      motebitId,
      { amount: 1000, reference_id: "ref-no-env" },
      RELAY_SECRET,
    );
    expect(res.status).toBe(401);
  });

  // ── Validation ──────────────────────────────────────────────────────────

  it("rejects zero amount", async () => {
    const res = await debitRequest(
      relay,
      motebitId,
      { amount: 0, reference_id: "ref-zero" },
      RELAY_SECRET,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("positive");
  });

  it("rejects negative amount", async () => {
    const res = await debitRequest(
      relay,
      motebitId,
      { amount: -500, reference_id: "ref-neg" },
      RELAY_SECRET,
    );
    expect(res.status).toBe(400);
  });

  // ── Insufficient balance ────────────────────────────────────────────────

  it("returns success: false when account has zero balance", async () => {
    const res = await debitRequest(
      relay,
      motebitId,
      { amount: 1000, reference_id: "ref-empty" },
      RELAY_SECRET,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; balance: number };
    expect(body.success).toBe(false);
    expect(body.balance).toBe(0);
  });

  it("returns success: false when debit exceeds balance", async () => {
    // Deposit $0.01 = 10,000 micro-units, then try to debit 20,000
    await deposit(relay, motebitId, 0.01);
    const res = await debitRequest(
      relay,
      motebitId,
      { amount: 20_000, reference_id: "ref-overdraw" },
      RELAY_SECRET,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; balance: number };
    expect(body.success).toBe(false);
    expect(body.balance).toBe(0);
  });

  // ── Successful debit ───────────────────────────────────────────────────

  it("debits successfully and returns new balance", async () => {
    // Deposit $0.10 = 100,000 micro-units, then debit 30,000 micro
    await deposit(relay, motebitId, 0.1);
    const res = await debitRequest(
      relay,
      motebitId,
      { amount: 30_000, reference_id: "ref-ok", description: "test debit" },
      RELAY_SECRET,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; balance: number };
    expect(body.success).toBe(true);
    expect(body.balance).toBe(70_000);
  });

  it("debits multiple times and tracks running balance", async () => {
    // Deposit $0.05 = 50,000 micro-units
    await deposit(relay, motebitId, 0.05);

    const r1 = await debitRequest(
      relay,
      motebitId,
      { amount: 10_000, reference_id: "ref-1" },
      RELAY_SECRET,
    );
    const b1 = (await r1.json()) as { success: boolean; balance: number };
    expect(b1.success).toBe(true);
    expect(b1.balance).toBe(40_000);

    const r2 = await debitRequest(
      relay,
      motebitId,
      { amount: 25_000, reference_id: "ref-2" },
      RELAY_SECRET,
    );
    const b2 = (await r2.json()) as { success: boolean; balance: number };
    expect(b2.success).toBe(true);
    expect(b2.balance).toBe(15_000);

    // Third debit exceeds remaining balance
    const r3 = await debitRequest(
      relay,
      motebitId,
      { amount: 20_000, reference_id: "ref-3" },
      RELAY_SECRET,
    );
    const b3 = (await r3.json()) as { success: boolean; balance: number };
    expect(b3.success).toBe(false);
    expect(b3.balance).toBe(0);
  });
});
