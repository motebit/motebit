/**
 * classifyRelayError — relay error envelope → closed DelegationErrorCode.
 *
 * Focused on the Arc 3.5 boundary: a paid cross-agent delegation rejected by the
 * P2P-by-default gate returns 402 with `code: "TASK_P2P_PROOF_REQUIRED"`, and the
 * client must report `payment_proof_required` (honest: "this path settles P2P"),
 * NOT `insufficient_balance` (misleading: implies a funding shortfall). The
 * gate-code branch sits before the generic 402 branch; this locks that order.
 */
import { describe, it, expect } from "vitest";
import { classifyRelayError } from "../relay-delegation.js";

const envelope = (code: string, error = "rejected") => JSON.stringify({ code, error });

describe("classifyRelayError — Arc 3.5 402 disambiguation", () => {
  it("maps 402 TASK_P2P_PROOF_REQUIRED → payment_proof_required (not insufficient_balance)", () => {
    const result = classifyRelayError(402, envelope("TASK_P2P_PROOF_REQUIRED"));
    expect(result.code).toBe("payment_proof_required");
    expect(result.status).toBe(402);
  });

  it("maps 402 INSUFFICIENT_FUNDS → insufficient_balance", () => {
    expect(classifyRelayError(402, envelope("INSUFFICIENT_FUNDS")).code).toBe(
      "insufficient_balance",
    );
  });

  it("maps a bare 402 (no code) → insufficient_balance", () => {
    expect(classifyRelayError(402, "Payment Required").code).toBe("insufficient_balance");
  });

  it("preserves the relay's error message for the gate code", () => {
    const result = classifyRelayError(402, envelope("TASK_P2P_PROOF_REQUIRED", "needs a proof"));
    expect(result.message).toBe("needs a proof");
  });
});
