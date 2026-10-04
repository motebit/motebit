/**
 * The shared receipt verdict ladder — worst wins, judged over the WHOLE chain.
 */
import { describe, expect, it, vi } from "vitest";

const verifyReceiptChainMock = vi.fn();
vi.mock("@motebit/encryption", () => ({
  verifyReceiptChain: (...args: unknown[]) => verifyReceiptChainMock(...args),
}));

const { receiptVerdictFor, verifyReceiptVerdict, RECEIPT_VERDICT_LABELS } =
  await import("../receipt-verdict.js");

const ok = { status: "completed" } as const;

describe("receiptVerdictFor", () => {
  it("failed when the root fails", () => {
    expect(receiptVerdictFor(ok, { verified: false, keySource: "external" })).toBe("failed");
  });

  it("failed when any delegation child fails, even with a verified root", () => {
    const tree = {
      verified: true,
      keySource: "external" as const,
      delegations: [
        { verified: true, keySource: "external" as const, delegations: [{ verified: false }] },
      ],
    };
    expect(receiptVerdictFor(ok, tree)).toBe("failed");
  });

  it("task-failed when signatures hold, the chain is bound, and status=failed", () => {
    expect(receiptVerdictFor({ status: "failed" }, { verified: true, keySource: "external" })).toBe(
      "task-failed",
    );
  });

  it("status never outranks binding: unbound + status=failed is task-failed-unanchored", () => {
    const fail = { status: "failed" } as const;
    expect(receiptVerdictFor(fail, { verified: true, keySource: "embedded" })).toBe(
      "task-failed-unanchored",
    );
    expect(receiptVerdictFor(fail, { verified: true })).toBe("task-failed-unanchored");
    const partial = {
      verified: true,
      keySource: "external" as const,
      delegations: [{ verified: true, keySource: "embedded" as const }],
    };
    expect(receiptVerdictFor(fail, partial)).toBe("task-failed-unanchored");
    // A broken signature still wins over the task outcome.
    expect(receiptVerdictFor(fail, { verified: false, keySource: "external" })).toBe("failed");
  });

  it("verified only when every node is externally anchored", () => {
    const bound = {
      verified: true,
      keySource: "external" as const,
      delegations: [{ verified: true, keySource: "external" as const }],
    };
    expect(receiptVerdictFor(ok, bound)).toBe("verified");
    const partial = {
      verified: true,
      keySource: "external" as const,
      delegations: [{ verified: true, keySource: "embedded" as const }],
    };
    expect(receiptVerdictFor(ok, partial)).toBe("integrity-only");
  });

  it("embedded or missing keySource is integrity-only", () => {
    expect(receiptVerdictFor(ok, { verified: true, keySource: "embedded" })).toBe("integrity-only");
    expect(receiptVerdictFor(ok, { verified: true })).toBe("integrity-only");
  });
});

describe("verifyReceiptVerdict", () => {
  it("passes an empty anchor (never the receipt's own keys) when none is given", async () => {
    verifyReceiptChainMock.mockResolvedValueOnce({ verified: true, keySource: "embedded" });
    const receipt = { status: "completed", public_key: "ab".repeat(32), motebit_id: "m" } as never;
    expect(await verifyReceiptVerdict(receipt)).toBe("integrity-only");
    const anchorArg = verifyReceiptChainMock.mock.calls[0]![1] as Map<string, Uint8Array>;
    expect(anchorArg.size).toBe(0);
  });

  it("a verification error is the failed rung (never throws)", async () => {
    verifyReceiptChainMock.mockRejectedValueOnce(new Error("crypto fault"));
    expect(await verifyReceiptVerdict({ status: "completed" } as never)).toBe("failed");
  });

  it("has a label for every rung, and only 'verified' claims an intact chain", () => {
    expect(RECEIPT_VERDICT_LABELS.verified).toContain("chain intact");
    for (const k of [
      "integrity-only",
      "task-failed",
      "task-failed-unanchored",
      "failed",
    ] as const) {
      expect(RECEIPT_VERDICT_LABELS[k]).not.toContain("chain intact");
    }
  });
});
