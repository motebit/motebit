/**
 * Money-meter unit suite — the runtime half of the R4 AND-composition.
 * Every absence is a deny: no ceiling on the grant, unmeterable args,
 * missing signed nonce. The allow path drives the real enforcer through
 * the InMemory store, and one-tick-one-action is proven via nonce replay.
 */
import { describe, it, expect } from "vitest";
import { InMemoryGrantSpendStore } from "@motebit/policy";
import { createMoneyMeter } from "../money-meter.js";

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
