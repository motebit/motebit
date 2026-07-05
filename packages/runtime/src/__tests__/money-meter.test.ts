/**
 * Money-meter unit suite — the runtime half of the R4 AND-composition.
 * Every absence is a deny: no ceiling on the grant, unmeterable args,
 * missing signed nonce. The allow path drives the real enforcer through
 * the InMemory store, and one-tick-one-action is proven via nonce replay.
 */
import { describe, it, expect } from "vitest";
import { InMemoryGrantSpendStore } from "@motebit/policy";
import { createMoneyMeter, wrapP2pPaymentWithMeter } from "../money-meter.js";

const M = 1_000_000;
const GRANT = {
  grant_id: "grant-1",
  verified_at: 1,
  token_issued_at: 100,
  spend_ceiling: {
    schema: "motebit.spend-ceiling.v1" as const,
    lifetime_limit_micro: 5 * M,
  },
};
const ARGS = { amount_micro: 1 * M, counterparty: "payee-1" };

const meterWith = (store = new InMemoryGrantSpendStore()) =>
  createMoneyMeter(store, { now: () => 1_000_000_000 });

describe("createMoneyMeter", () => {
  it("denies ceiling_absent for a grant with no spend_ceiling (a @1.0/@1.1 grant moves no money)", async () => {
    const { spend_ceiling: _none, ...bare } = GRANT;
    expect(await meterWith()(bare, "pay_invoice", ARGS)).toEqual({
      allowed: false,
      denial: "ceiling_absent",
    });
  });

  it("denies unmeterable_action when money facts are not extractable from args", async () => {
    for (const bad of [
      {},
      { amount_micro: 1 * M },
      { amount_micro: -5, counterparty: "p" },
      { amount_micro: 1.5, counterparty: "p" },
      { amount_micro: 1 * M, counterparty: "  " },
      { amount: 1 * M, counterparty: "p" }, // wrong field name — no guessing
    ]) {
      expect(await meterWith()(GRANT, "pay_invoice", bad)).toEqual({
        allowed: false,
        denial: "unmeterable_action",
      });
    }
  });

  it("denies nonce_absent for a VerifiedGrant without token_issued_at", async () => {
    const { token_issued_at: _none, ...noNonce } = GRANT;
    expect(await meterWith()(noNonce, "pay_invoice", ARGS)).toEqual({
      allowed: false,
      denial: "nonce_absent",
    });
  });

  it("allows within the signed ceiling, and one tick meters at most ONE action (replay)", async () => {
    const meter = meterWith();
    expect(await meter(GRANT, "pay_invoice", ARGS)).toEqual({ allowed: true });
    // Same token (same signed issued_at nonce) — second action is a replay.
    expect(await meter(GRANT, "pay_invoice", ARGS)).toEqual({
      allowed: false,
      denial: "replay",
    });
    // A NEXT tick (fresh signed issued_at) meters again.
    expect(await meter({ ...GRANT, token_issued_at: 101 }, "pay_invoice", ARGS)).toEqual({
      allowed: true,
    });
  });

  it("propagates the enforcer's denial vocabulary (lifetime_exceeded)", async () => {
    const meter = meterWith();
    for (let i = 0; i < 5; i++) {
      expect(
        (await meter({ ...GRANT, token_issued_at: 100 + i }, "pay_invoice", ARGS)).allowed,
      ).toBe(true);
    }
    expect(await meter({ ...GRANT, token_issued_at: 200 }, "pay_invoice", ARGS)).toEqual({
      allowed: false,
      denial: "lifetime_exceeded",
    });
  });
});

describe("wrapP2pPaymentWithMeter — the rail-seam enforcement", () => {
  const REQUEST = {
    workerAddress: "worker-addr",
    amountMicro: 2 * M,
    treasuryAddress: "treasury-addr",
    feeAmountMicro: 100_000, // $0.10 fee leg
  };
  const PROOF = {
    tx_hash: "tx",
    chain: "solana",
    network: "mainnet",
    to_address: "worker-addr",
    amount_micro: 2 * M,
    fee_to_address: "treasury-addr",
    fee_amount_micro: 100_000,
  };

  function harness(grant: unknown, store = new InMemoryGrantSpendStore()) {
    const calls: unknown[] = [];
    const build = async (req: unknown) => {
      calls.push(req);
      return PROOF as never;
    };
    const wrapped = wrapP2pPaymentWithMeter(
      build as never,
      () => grant as never,
      createMoneyMeter(store, { now: () => 1_000_000_000 }),
    );
    return { wrapped, calls };
  }

  it("passes through UNMETERED when no grant is active (the human-approved path)", async () => {
    const { wrapped, calls } = harness(null);
    await expect(wrapped(REQUEST as never)).resolves.toBeDefined();
    expect(calls).toHaveLength(1);
  });

  it("meters the TOTAL outflow (net + every fee leg) and allows within the ceiling", async () => {
    const store = new InMemoryGrantSpendStore();
    const { wrapped, calls } = harness(GRANT, store);
    await wrapped(REQUEST as never);
    expect(calls).toHaveLength(1);
    // $2.10 committed (net $2 + fee $0.10), not just the worker net.
    expect(store.peek("grant-1")!.lifetime_spent_micro).toBe(2 * M + 100_000);
  });

  it("includes the federated executor fee leg in the metered outflow", async () => {
    const store = new InMemoryGrantSpendStore();
    const { wrapped } = harness(GRANT, store);
    await wrapped({ ...REQUEST, executorFeeAmountMicro: 50_000 } as never);
    expect(store.peek("grant-1")!.lifetime_spent_micro).toBe(2 * M + 100_000 + 50_000);
  });

  it("REFUSES before broadcast when the spend exceeds the signed ceiling — build never called", async () => {
    const { wrapped, calls } = harness(GRANT);
    const oversized = { ...REQUEST, amountMicro: 6 * M }; // > $5 lifetime
    await expect(wrapped(oversized as never)).rejects.toMatchObject({
      name: "MoneyMeterDeniedError",
      reason: "money_meter_denied",
      denial: "lifetime_exceeded",
    });
    expect(calls).toHaveLength(0); // no broadcast, no money moved
  });

  it("one tick meters ONE payment — a second under the same token replays and never broadcasts", async () => {
    const store = new InMemoryGrantSpendStore();
    const { wrapped, calls } = harness(GRANT, store);
    await wrapped(REQUEST as never);
    await expect(wrapped(REQUEST as never)).rejects.toMatchObject({ denial: "replay" });
    expect(calls).toHaveLength(1);
  });

  it("a ceiling-less grant moves nothing through the rail (ceiling_absent)", async () => {
    const { spend_ceiling: _none, ...bare } = GRANT;
    const { wrapped, calls } = harness(bare);
    await expect(wrapped(REQUEST as never)).rejects.toMatchObject({ denial: "ceiling_absent" });
    expect(calls).toHaveLength(0);
  });
});
