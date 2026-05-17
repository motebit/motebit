/**
 * BridgeSettlementRail unit tests.
 *
 * Bridge is treasury-only after Arc 1 Commit 2 of the off-ramp arc
 * (see `bridge-rail.ts` header + the future `docs/doctrine/off-ramp-as-
 * user-action.md`). User-facing withdrawal is structurally absent — the
 * `withdraw()` method does not exist on this class, `supportsWithdraw`
 * is `false`, and `isWithdrawableRail(bridgeRail)` returns false. These
 * tests pin the structural absence in three ways: discriminant, runtime
 * type guard, and compile-time `@ts-expect-error` on attempted assignment
 * to `WithdrawableGuestRail`.
 *
 * The remaining surface (`isAvailable`, `attachProof`) is what the relay
 * uses today — health checks and proof-callback wiring. Future treasury-
 * conversion methods compose on the retained `BridgeClient.createTransfer`
 * capability without re-introducing user-facing withdrawal.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { BridgeSettlementRail } from "../bridge-rail.js";
import {
  isDepositableRail,
  isBatchableRail,
  isWithdrawableRail,
  type WithdrawableGuestRail,
} from "@motebit/sdk";
import type { BridgeClient } from "../bridge-rail.js";

// --- Mock Bridge client ---

function createMockBridgeClient(overrides?: Partial<BridgeClient>): BridgeClient {
  return {
    createTransfer: vi.fn().mockResolvedValue({
      id: "bridge-transfer-001",
      state: "awaiting_funds",
      amount: "5.000000",
    }),
    getTransfer: vi.fn().mockResolvedValue({
      id: "bridge-transfer-001",
      state: "payment_processed",
      amount: "5.000000",
    }),
    isReachable: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe("BridgeSettlementRail", () => {
  let client: ReturnType<typeof createMockBridgeClient>;
  let rail: BridgeSettlementRail;

  beforeEach(() => {
    client = createMockBridgeClient();
    rail = new BridgeSettlementRail({
      bridgeClient: client,
      customerId: "cust-001",
      sourcePaymentRail: "base",
      sourceCurrency: "usdc",
    });
  });

  it("has correct railType and name", () => {
    expect(rail.railType).toBe("orchestration");
    expect(rail.name).toBe("bridge");
  });

  it("declares the three discriminants as false — treasury-only rail", () => {
    expect(rail.supportsDeposit).toBe(false);
    expect(rail.supportsWithdraw).toBe(false);
    expect(rail.supportsBatch).toBe(false);
  });

  it("is rejected by every specialization type guard", () => {
    expect(isDepositableRail(rail)).toBe(false);
    expect(isWithdrawableRail(rail)).toBe(false);
    expect(isBatchableRail(rail)).toBe(false);
  });

  describe("isAvailable", () => {
    it("returns true when Bridge API is reachable", async () => {
      expect(await rail.isAvailable()).toBe(true);
      expect(client.isReachable).toHaveBeenCalled();
    });

    it("returns false when Bridge API is unreachable", async () => {
      (client.isReachable as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
      expect(await rail.isAvailable()).toBe(false);
    });

    it("returns false on network error", async () => {
      (client.isReachable as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("ECONNREFUSED"),
      );
      expect(await rail.isAvailable()).toBe(false);
    });
  });

  describe("attachProof", () => {
    it("logs without throwing", async () => {
      await expect(
        rail.attachProof("settle-001", {
          reference: "tx-hash-1",
          railType: "orchestration",
          network: "base",
          confirmedAt: Date.now(),
        }),
      ).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Structural negative-proof — Bridge does NOT have user-facing withdrawal.
  //
  // The doctrinal absence is the enforcement: any consumer that tries to
  // call `bridgeRail.withdraw(...)` hits a compile error because the method
  // does not exist on the type. These tests pin the absence at runtime AND
  // compile-time so future refactors that accidentally re-introduce a
  // `withdraw` method fail multiple gates.
  // -------------------------------------------------------------------------
  describe("structural negative-proof — Bridge is treasury-only, never a user-withdrawal target", () => {
    it("does not have a withdraw method (runtime)", () => {
      expect((rail as unknown as { withdraw?: unknown }).withdraw).toBeUndefined();
    });

    it("does not satisfy WithdrawableGuestRail (compile-time)", () => {
      // The structural test: assignment to `WithdrawableGuestRail` must
      // fail at compile time. If the assignment ever starts compiling
      // (because someone added a `withdraw` method back), the
      // `@ts-expect-error` directive errors with "Unused" — a louder
      // failure than the test runtime would produce.
      // @ts-expect-error — BridgeSettlementRail intentionally lacks `withdraw`; this assignment must fail to compile per off-ramp doctrine
      const widening: WithdrawableGuestRail = rail;
      void widening;
    });

    it("does not have a withdrawBatch method (runtime — batch is a specialization of withdraw)", () => {
      expect((rail as unknown as { withdrawBatch?: unknown }).withdrawBatch).toBeUndefined();
    });
  });
});
