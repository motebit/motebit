/**
 * `motebit delegate`'s 402 remedy. The relay answers 402 for two different
 * refusals: an empty virtual account (relay custody — self-delegation,
 * zero-cost, x402), and the Arc 3.5 submission gate `TASK_P2P_PROOF_REQUIRED`
 * — paid delegation to ANOTHER agent must settle P2P, so `motebit fund` can
 * never clear it. A codeless 402 (the x402 challenge) precedes both, so a
 * deposit clears it only on self-delegation. The message must name the remedy
 * that actually applies.
 */
import { describe, it, expect } from "vitest";
import { describeDelegateSubmit402 } from "../subcommands/delegate.js";

describe("describeDelegateSubmit402", () => {
  it("points a TASK_P2P_PROOF_REQUIRED refusal at --sovereign, never at `motebit fund`", () => {
    const body = JSON.stringify({
      error: "Paid direct delegation requires a P2P payment_proof: ...",
      code: "TASK_P2P_PROOF_REQUIRED",
      status: 402,
    });
    const text = describeDelegateSubmit402(body, "direct", "other").join("\n");
    expect(text).toMatch(/settles P2P/);
    expect(text).toContain("--sovereign");
    expect(text).not.toContain("motebit fund");
  });

  it("keeps the deposit remedy for INSUFFICIENT_FUNDS", () => {
    const body = JSON.stringify({ error: "Insufficient balance", code: "INSUFFICIENT_FUNDS" });
    expect(describeDelegateSubmit402(body, "direct", "other").join("\n")).toContain("motebit fund");
  });

  it("keeps the deposit remedy for a non-JSON 402 on self-delegation only", () => {
    expect(describeDelegateSubmit402("Payment Required", "direct", "self").join("\n")).toContain(
      "motebit fund",
    );
    expect(
      describeDelegateSubmit402("Payment Required", "direct", "other").join("\n"),
    ).not.toContain("motebit fund");
  });
});
