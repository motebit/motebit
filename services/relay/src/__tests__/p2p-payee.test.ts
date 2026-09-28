/**
 * The one rule every P2P settlement writer reads (#959): the payee is the
 * admitted worker, the receipt must be from it, and which relay verifies the
 * worker leg is declared from the entry — shared by `handleReceiptIngestion`,
 * `settleSubReceipt` and the federated origin writer in federation-callbacks.
 */
import { describe, it, expect } from "vitest";
import type { AgentTask } from "@motebit/sdk";
import { p2pPayeeOf, p2pWorkerLegScope, receiptDischargesP2p } from "../p2p-payee.js";

const task = (motebitId: string) => ({ motebit_id: motebitId }) as unknown as AgentTask;

describe("p2pPayeeOf", () => {
  it("is the pinned target_agent, never the path agent (the payer on a P2P submission)", () => {
    const entry = { task: task("delegator"), target_agent: "worker" };
    expect(p2pPayeeOf(entry)).toBe("worker");
    expect(receiptDischargesP2p(entry, "worker")).toBe(true);
    expect(receiptDischargesP2p(entry, "delegator")).toBe(false);
    expect(receiptDischargesP2p(entry, "stranger")).toBe(false);
  });

  it("is the forwarded task's worker on the executor relay (no target_agent there)", () => {
    expect(p2pPayeeOf({ task: task("worker") })).toBe("worker");
    expect(p2pPayeeOf({ task: task("worker"), target_agent: "" })).toBe("worker");
  });
});

describe("p2pWorkerLegScope", () => {
  const twoLeg = { to_address: "w", fee_to_address: "t" };
  const threeLeg = { ...twoLeg, b_fee_to_address: "tb" };
  it("single-operator P2P: the worker is local", () => {
    expect(p2pWorkerLegScope({ p2p_payment_proof: twoLeg as never })).toBe("local");
  });
  it("the executor relay of a federated task hosts the worker", () => {
    expect(
      p2pWorkerLegScope({ origin_relay: "relay-a", p2p_payment_proof: threeLeg as never }),
    ).toBe("local");
  });
  it("the origin relay of a federated task does not", () => {
    expect(p2pWorkerLegScope({ p2p_payment_proof: threeLeg as never })).toBe("remote");
  });
});
