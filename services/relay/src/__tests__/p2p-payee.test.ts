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

describe("p2pWorkerLegScope — declared by admission, never inferred from the proof", () => {
  it("reads the admission record", () => {
    expect(p2pWorkerLegScope({ p2p_admission: { worker_leg: "local" } })).toBe("local");
    expect(p2pWorkerLegScope({ p2p_admission: { worker_leg: "remote" } })).toBe("remote");
  });

  it("ignores the proof's shape: a local admission whose proof carries b_fee fields stays local", () => {
    // Cold review, #959 round 2: inferring 'remote' from payer-supplied b_fee_*
    // let a payer switch the worker-leg check off on a local task.
    const entry = {
      p2p_admission: { worker_leg: "local" as const },
      p2p_payment_proof: { b_fee_to_address: "tb", b_fee_amount_micro: 1 },
    };
    expect(p2pWorkerLegScope(entry as never)).toBe("local");
  });

  it("an entry admitted before round 2 (no admission record) reads local — the fail-closed side", () => {
    expect(p2pWorkerLegScope({})).toBe("local");
  });
});
