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

  it("drains the balance and reports the shortfall when the debit exceeds it", async () => {
    // The turn was already served. Recording nothing would leave the balance
    // intact for the next proxy token — an undrainable, unbilled tail.
    // Deposit $0.01 = 10,000 micro-units, then try to debit 20,000.
    await deposit(relay, motebitId, 0.01);
    const res = await debitRequest(
      relay,
      motebitId,
      { amount: 20_000, reference_id: "ref-overdraw" },
      RELAY_SECRET,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      balance: number;
      partial?: boolean;
      debited?: number;
      shortfall?: number;
    };
    expect(body).toMatchObject({
      success: true,
      balance: 0,
      partial: true,
      debited: 10_000,
      shortfall: 10_000,
    });
    const fees = relay.moteDb.db
      .prepare(
        "SELECT amount, reference_id FROM relay_transactions WHERE motebit_id = ? AND type = 'fee'",
      )
      .all(motebitId);
    expect(fees).toEqual([{ amount: -10_000, reference_id: "ref-overdraw" }]);

    // A retry of the same reference is a replay, not a second drain.
    const retry = await debitRequest(
      relay,
      motebitId,
      { amount: 20_000, reference_id: "ref-overdraw" },
      RELAY_SECRET,
    );
    expect(((await retry.json()) as { idempotent?: boolean }).idempotent).toBe(true);
  });

  it("rejects a fractional amount (micro-units are integers) with 400, not a 500", async () => {
    await deposit(relay, motebitId, 0.01);
    const res = await debitRequest(
      relay,
      motebitId,
      { amount: 12.5, reference_id: "ref-frac" },
      RELAY_SECRET,
    );
    expect(res.status).toBe(400);
  });

  it("rejects a non-JSON body with 400", async () => {
    const res = await relay.app.request(`/api/v1/agents/${motebitId}/debit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-relay-secret": RELAY_SECRET },
      body: "not json",
    });
    expect(res.status).toBe(400);
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

    // Third debit exceeds the remaining balance: drains it, shortfall reported.
    const r3 = await debitRequest(
      relay,
      motebitId,
      { amount: 20_000, reference_id: "ref-3" },
      RELAY_SECRET,
    );
    const b3 = (await r3.json()) as { success: boolean; balance: number; shortfall?: number };
    expect(b3.success).toBe(true);
    expect(b3.balance).toBe(0);
    expect(b3.shortfall).toBe(5_000);

    // Nothing spendable left: now the debit records nothing and says so.
    const r4 = await debitRequest(
      relay,
      motebitId,
      { amount: 1_000, reference_id: "ref-4" },
      RELAY_SECRET,
    );
    const b4 = (await r4.json()) as { success: boolean; balance: number; shortfall?: number };
    expect(b4.success).toBe(false);
    expect(b4.shortfall).toBe(1_000);
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

  // reference_id is the idempotency key. Without it a retried debit (the proxy
  // retries after a lost 200) would record a second fee row — so it is required.
  it("requires a non-empty string reference_id — 400, nothing recorded", async () => {
    await deposit(relay, motebitId, 0.1); // 100,000 micro
    for (const body of [
      { amount: 10_000 },
      { amount: 10_000, reference_id: "" },
      { amount: 10_000, reference_id: 42 },
      { amount: 10_000, reference_id: null },
    ]) {
      const res = await debitRequest(relay, motebitId, body, RELAY_SECRET);
      expect(res.status).toBe(400);
    }
    const fees = relay.moteDb.db
      .prepare("SELECT COUNT(*) AS n FROM relay_transactions WHERE motebit_id = ? AND type = 'fee'")
      .get(motebitId) as { n: number };
    expect(fees.n).toBe(0);
  });

  it("a secret differing only in its last byte, or by length, is refused", async () => {
    for (const s of [RELAY_SECRET.slice(0, -1) + "X", RELAY_SECRET + "x", RELAY_SECRET.slice(1)]) {
      const res = await debitRequest(
        relay,
        motebitId,
        { amount: 1000, reference_id: `ref-${s.length}` },
        s,
      );
      expect(res.status).toBe(401);
    }
  });
});
