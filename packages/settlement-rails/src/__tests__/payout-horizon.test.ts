import { describe, it, expect } from "vitest";
import {
  isManualPayoutRail,
  isPayoutNotSent,
  PayoutNotSentError,
  payoutValidityMsOf,
} from "../payout-horizon.js";

// The relay reads these declarations to decide when an unresolved payout may
// be reconciled as "not paid" (#921). A wrong answer here either strands a
// withdrawal or opens the refund door while the payout can still land.
describe("payout horizon declarations (#921)", () => {
  it("only a rail that declares payoutMode 'manual' is manual", () => {
    expect(isManualPayoutRail({ payoutMode: "manual" })).toBe(true);
    expect(isManualPayoutRail({ payoutMode: "sent" })).toBe(false);
    expect(isManualPayoutRail({})).toBe(false);
  });

  it("a declared positive finite validity is returned as-is", () => {
    const ms = 3_600_000;
    expect(payoutValidityMsOf({ payoutValidityMs: ms })).toBe(ms);
  });

  it("an absent, zero, negative, non-finite or non-number validity is null — never a shorter horizon", () => {
    expect(payoutValidityMsOf({})).toBeNull();
    expect(payoutValidityMsOf({ payoutValidityMs: 0 })).toBeNull();
    expect(payoutValidityMsOf({ payoutValidityMs: -5 })).toBeNull();
    expect(payoutValidityMsOf({ payoutValidityMs: Number.POSITIVE_INFINITY })).toBeNull();
    expect(payoutValidityMsOf({ payoutValidityMs: Number.NaN })).toBeNull();
    expect(payoutValidityMsOf({ payoutValidityMs: "3600000" as unknown as number })).toBeNull();
  });
});

// The relay refunds a batched payout only on this proof (#1034). Its rail
// producer (x402's pre-sign refusals) went with x402's withdraw (#948); the
// brand is still read structurally for any rail that throws it.
describe("PayoutNotSentError (#1034)", () => {
  it("is read by its brand; any other error, or a bare object with the brand, is not proof", () => {
    expect(isPayoutNotSent(new PayoutNotSentError("rejected before signing"))).toBe(true);
    const foreign = Object.assign(new Error("another copy"), { payoutNotSent: true });
    expect(isPayoutNotSent(foreign)).toBe(true);
    expect(isPayoutNotSent(new Error("timeout"))).toBe(false);
    expect(isPayoutNotSent({ payoutNotSent: true })).toBe(false);
  });
});
