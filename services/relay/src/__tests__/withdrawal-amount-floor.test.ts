/**
 * Money amount floor at the relay boundary.
 *
 * Incident: production held two `pending` relay_withdrawals of 0 micro-units.
 * POST /withdraw validated the DOLLAR value (`amount > 0`) and then converted
 * with `toMicro`, so a positive sub-micro amount (1e-7 USD → round(0.1) = 0)
 * passed validation and recorded a $0 withdrawal. The rule is now one
 * function, `parsePositiveMicro` (@motebit/protocol): a client-supplied
 * dollar amount is accepted only when it is finite and converts to at least
 * 1 micro-unit (0.000001 USD). Every sibling route that converts a
 * request-derived dollar value is pinned here too.
 */
import { describe, it, expect, afterEach } from "vitest";
import { toMicro } from "@motebit/protocol";
import type { SyncRelay } from "../index.js";
import { creditAccount, getAccountBalance, getTransactions } from "../accounts.js";
import { enqueuePendingWithdrawal } from "../batch-withdrawals.js";
import { processStripeCheckout } from "../stripe-credit.js";
import { AUTH_HEADER, createTestRelay, jsonAuthWithIdempotency } from "./test-helpers.js";

const FUNDED = 5_000_000;
const AGENT = "agent-amount-floor";

let relay: SyncRelay | undefined;
afterEach(async () => {
  await relay?.close();
  relay = undefined;
});

function withdrawalRows(r: SyncRelay, motebitId: string): Array<{ amount: number }> {
  return r.moteDb.db
    .prepare("SELECT amount FROM relay_withdrawals WHERE motebit_id = ?")
    .all(motebitId) as Array<{ amount: number }>;
}

function postWithdraw(r: SyncRelay, rawBody: string): Promise<Response> {
  return Promise.resolve(
    r.app.request(`/api/v1/agents/${AGENT}/withdraw`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: rawBody,
    }),
  );
}

describe("POST /withdraw — converted-value floor", () => {
  // Raw JSON bodies: `1e400` parses to Infinity, which JSON.stringify cannot emit.
  const REFUSED: Array<[string, string]> = [
    ["1e-7 (rounds to 0 micro)", '{"amount":1e-7,"destination":"pending"}'],
    ["4e-7 (rounds to 0 micro)", '{"amount":4e-7,"destination":"pending"}'],
    ["0.0000004 (rounds to 0 micro)", '{"amount":0.0000004,"destination":"pending"}'],
    ["1e400 (parses to Infinity)", '{"amount":1e400,"destination":"pending"}'],
  ];

  it.each(REFUSED)("refuses %s: 400, no row, no debit", async (_, rawBody) => {
    relay = await createTestRelay();
    creditAccount(relay.moteDb.db, AGENT, FUNDED, "deposit", "floor-seed", "seed");
    const txBefore = getTransactions(relay.moteDb.db, AGENT).length;

    const res = await postWithdraw(relay, rawBody);

    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("0.000001");
    expect(withdrawalRows(relay, AGENT)).toHaveLength(0);
    expect(getAccountBalance(relay.moteDb.db, AGENT)?.balance).toBe(FUNDED);
    expect(getTransactions(relay.moteDb.db, AGENT)).toHaveLength(txBefore);
  });

  it("accepts the minimum 0.000001 USD as exactly 1 micro", async () => {
    relay = await createTestRelay();
    creditAccount(relay.moteDb.db, AGENT, FUNDED, "deposit", "floor-seed", "seed");
    const res = await postWithdraw(relay, '{"amount":0.000001,"destination":"pending"}');
    expect(res.status).toBe(200);
    expect(withdrawalRows(relay, AGENT)).toEqual([{ amount: 1 }]);
    expect(getAccountBalance(relay.moteDb.db, AGENT)?.balance).toBe(FUNDED - 1);
  });
});

describe("enqueuePendingWithdrawal — positive-safe-integer rule", () => {
  it.each([
    ["NaN", Number.NaN],
    ["fractional", 1.5],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 2],
  ])("refuses %s amountMicro with a RangeError and debits nothing", async (_, amountMicro) => {
    relay = await createTestRelay();
    const db = relay.moteDb.db;
    creditAccount(db, AGENT, FUNDED, "deposit", "floor-seed", "seed");
    expect(() =>
      enqueuePendingWithdrawal(db, {
        motebitId: AGENT,
        amountMicro,
        destination: "0xdest",
        rail: "fake",
        source: "sweep",
      }),
    ).toThrow(RangeError);
    expect(getAccountBalance(db, AGENT)?.balance).toBe(FUNDED);
    const n = db
      .prepare("SELECT COUNT(*) AS n FROM relay_pending_withdrawals WHERE motebit_id = ?")
      .get(AGENT) as { n: number };
    expect(n.n).toBe(0);
  });
});

describe("sibling: Stripe checkout credit — converted-value floor", () => {
  it("does not credit a sub-micro amount (no 0-micro deposit row)", async () => {
    relay = await createTestRelay();
    const db = relay.moteDb.db;
    expect(processStripeCheckout(db, "cs_submicro", AGENT, 1e-7)).toBe(false);
    expect(getTransactions(db, AGENT)).toHaveLength(0);
  });

  it("does not credit a non-finite amount", async () => {
    relay = await createTestRelay();
    const db = relay.moteDb.db;
    expect(processStripeCheckout(db, "cs_nan", AGENT, Number.NaN)).toBe(false);
    expect(processStripeCheckout(db, "cs_inf", AGENT, Number.POSITIVE_INFINITY)).toBe(false);
    expect(getTransactions(db, AGENT)).toHaveLength(0);
  });

  it("still credits a normal amount", async () => {
    relay = await createTestRelay();
    const db = relay.moteDb.db;
    expect(processStripeCheckout(db, "cs_ok", AGENT, 10)).toBe(true);
    expect(getAccountBalance(db, AGENT)?.balance).toBe(toMicro(10));
  });
});

describe("sibling: POST /checkout — non-finite amount", () => {
  it("refuses amount 1e400 (Infinity) with 400 before reaching Stripe", async () => {
    relay = await createTestRelay({
      stripe: { secretKey: "sk_test_amount_floor", webhookSecret: "whsec_amount_floor" },
    });
    const res = await relay.app.request(`/api/v1/agents/${AGENT}/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: '{"amount":1e400}',
    });
    expect(res.status).toBe(400);
  });
});

describe("sibling: POST /listing — unit_cost must be 0 or at least 1 micro", () => {
  const post = (r: SyncRelay, rawPricing: string): Promise<Response> =>
    Promise.resolve(
      r.app.request(`/api/v1/agents/${AGENT}/listing`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADER },
        body: `{"capabilities":["web_search"],"pricing":[{"capability":"web_search","unit_cost":${rawPricing},"currency":"USD","per":"task"}]}`,
      }),
    );

  it.each([
    ["1e-7 (rounds to 0 micro)", "1e-7"],
    ["negative", "-1"],
    ["1e400 (Infinity)", "1e400"],
    ["string", '"1"'],
  ])("refuses unit_cost %s with 400 and stores no listing", async (_, raw) => {
    relay = await createTestRelay();
    const res = await post(relay, raw);
    expect(res.status).toBe(400);
    const n = relay.moteDb.db
      .prepare("SELECT COUNT(*) AS n FROM relay_service_listings WHERE motebit_id = ?")
      .get(AGENT) as { n: number };
    expect(n.n).toBe(0);
  });

  it.each([
    ["free", "0"],
    ["one micro", "0.000001"],
    ["normal", "0.25"],
  ])("accepts unit_cost %s", async (_, raw) => {
    relay = await createTestRelay();
    const res = await post(relay, raw);
    expect(res.status).toBe(200);
  });
});
