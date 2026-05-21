/**
 * The receipt satellite's orb color must distinguish identity binding from mere
 * signature integrity: green ("verified") only when the chain verified against a
 * trusted anchor, cyan ("integrity-only") when it verified against the receipt's
 * own embedded key. verifyReceiptChain is stubbed so each binding outcome is
 * deterministic and the coordinator's state machine is exercised in isolation.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutionReceipt } from "@motebit/sdk";

const verifyReceiptChainMock = vi.fn();
vi.mock("@motebit/encryption", () => ({
  verifyReceiptChain: (...args: unknown[]) => verifyReceiptChainMock(...args),
}));

const { ReceiptSatelliteCoordinator } = await import("../receipt-satellites.js");

function makeReceipt(overrides: Partial<ExecutionReceipt> = {}): ExecutionReceipt {
  return {
    spec: "motebit/execution-ledger@1.0",
    motebit_id: "mb_worker",
    task_id: "t1",
    status: "completed",
    tools_used: ["research"],
    public_key: "",
    suite: "motebit-jcs-ed25519-b64-v1",
    signature: "sig",
    ...overrides,
  } as ExecutionReceipt;
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => verifyReceiptChainMock.mockReset());

describe("ReceiptSatelliteCoordinator — identity binding state", () => {
  it("external key (trusted anchor) → verified (green)", async () => {
    verifyReceiptChainMock.mockResolvedValue({
      verified: true,
      keySource: "external",
      delegations: [],
    });
    const c = new ReceiptSatelliteCoordinator();
    c.addReceipt(makeReceipt());
    await settle();
    expect(c.getState("t1")).toBe("verified");
  });

  it("embedded key (no anchor) → integrity-only (cyan)", async () => {
    verifyReceiptChainMock.mockResolvedValue({
      verified: true,
      keySource: "embedded",
      delegations: [],
    });
    const c = new ReceiptSatelliteCoordinator();
    c.addReceipt(makeReceipt());
    await settle();
    expect(c.getState("t1")).toBe("integrity-only");
  });

  it("a delegation verified only by embedded key downgrades the whole chain", async () => {
    verifyReceiptChainMock.mockResolvedValue({
      verified: true,
      keySource: "external",
      delegations: [{ verified: true, keySource: "embedded", delegations: [] }],
    });
    const c = new ReceiptSatelliteCoordinator();
    c.addReceipt(makeReceipt());
    await settle();
    expect(c.getState("t1")).toBe("integrity-only");
  });

  it("missing keySource is treated as integrity-only", async () => {
    verifyReceiptChainMock.mockResolvedValue({ verified: true, delegations: [] });
    const c = new ReceiptSatelliteCoordinator();
    c.addReceipt(makeReceipt());
    await settle();
    expect(c.getState("t1")).toBe("integrity-only");
  });

  it("verification failure → failed", async () => {
    verifyReceiptChainMock.mockResolvedValue({ verified: false, delegations: [] });
    const c = new ReceiptSatelliteCoordinator();
    c.addReceipt(makeReceipt());
    await settle();
    expect(c.getState("t1")).toBe("failed");
  });
});
