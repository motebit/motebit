/**
 * POST /api/v1/agents/:motebitId/debit — proxy debit endpoint.
 * Authenticated via x-relay-secret header (shared secret, not user auth).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import { AUTH_HEADER, createTestRelay, seedBalance } from "./test-helpers.js";

const RELAY_SECRET = "test-relay-secret";

let relay: SyncRelay;
let motebitId: string;

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
  seedBalance(r, id, amount);
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

  afterEach(async () => {
    delete process.env.RELAY_PROXY_SECRET;
    await relay.close();
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

  // ── Idempotency on reference_id ──────────────────────────────────────────
  // The proxy debits fire-and-forget after serving the response and retries a
  // failed debit with the SAME reference_id. The endpoint must apply it once.

  it("is idempotent on reference_id — a retried debit does not double-charge", async () => {
    await deposit(relay, motebitId, 0.1); // 100,000 micro

    const first = await debitRequest(
      relay,
      motebitId,
      { amount: 30_000, reference_id: "ref-retry" },
      RELAY_SECRET,
    );
    const b1 = (await first.json()) as { success: boolean; balance: number; idempotent?: boolean };
    expect(b1.success).toBe(true);
    expect(b1.balance).toBe(70_000);
    expect(b1.idempotent).toBeUndefined();

    // Same reference_id again (a retry) — must NOT debit a second time.
    const retry = await debitRequest(
      relay,
      motebitId,
      { amount: 30_000, reference_id: "ref-retry" },
      RELAY_SECRET,
    );
    expect(retry.status).toBe(200);
    const b2 = (await retry.json()) as { success: boolean; balance: number; idempotent?: boolean };
    expect(b2.success).toBe(true);
    expect(b2.idempotent).toBe(true);
    expect(b2.balance).toBe(70_000); // unchanged — no second charge
  });

  it("idempotent replay reports success even if the balance later dropped to zero", async () => {
    await deposit(relay, motebitId, 0.05); // 50,000 micro
    // Original debit recorded under ref-A.
    await debitRequest(relay, motebitId, { amount: 30_000, reference_id: "ref-A" }, RELAY_SECRET);
    // A different request spends the rest.
    await debitRequest(relay, motebitId, { amount: 20_000, reference_id: "ref-B" }, RELAY_SECRET);

    // Retry of ref-A: already recorded, so a no-op replay — success, no debit,
    // not the insufficient-balance path even though spendable is now 0.
    const retry = await debitRequest(
      relay,
      motebitId,
      { amount: 30_000, reference_id: "ref-A" },
      RELAY_SECRET,
    );
    const body = (await retry.json()) as {
      success: boolean;
      balance: number;
      idempotent?: boolean;
    };
    expect(body.success).toBe(true);
    expect(body.idempotent).toBe(true);
    expect(body.balance).toBe(0);
  });

  it("distinct reference_ids both apply (idempotency does not over-dedupe)", async () => {
    await deposit(relay, motebitId, 0.1); // 100,000 micro
    const r1 = await debitRequest(
      relay,
      motebitId,
      { amount: 10_000, reference_id: "ref-x" },
      RELAY_SECRET,
    );
    expect(((await r1.json()) as { balance: number }).balance).toBe(90_000);
    const r2 = await debitRequest(
      relay,
      motebitId,
      { amount: 10_000, reference_id: "ref-y" },
      RELAY_SECRET,
    );
    expect(((await r2.json()) as { balance: number }).balance).toBe(80_000);
  });
});
