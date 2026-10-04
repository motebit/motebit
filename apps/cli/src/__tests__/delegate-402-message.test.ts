/**
 * `motebit delegate`'s 402 remedy. The relay answers 402 for two different
 * refusals: an empty virtual account (relay custody — self-delegation,
 * zero-cost, x402), and the Arc 3.5 submission gate `TASK_P2P_PROOF_REQUIRED`
 * — paid delegation to ANOTHER agent must settle P2P, so `motebit fund` can
 * never clear it. The message must name the remedy that actually applies.
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
    const text = describeDelegateSubmit402(body).join("\n");
    expect(text).toMatch(/settles P2P/);
    expect(text).toContain("--sovereign");
    expect(text).not.toContain("motebit fund");
  });

  it("keeps the deposit remedy for any other 402", () => {
    const body = JSON.stringify({ error: "Insufficient balance", code: "INSUFFICIENT_FUNDS" });
    expect(describeDelegateSubmit402(body).join("\n")).toContain("motebit fund");
  });

  it("keeps the deposit remedy when the body is not JSON", () => {
    expect(describeDelegateSubmit402("Payment Required").join("\n")).toContain("motebit fund");
  });
});
