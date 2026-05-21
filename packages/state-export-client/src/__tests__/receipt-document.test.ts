/**
 * verifyReceiptDocument projects a pasted ExecutionReceipt into an honest view
 * model. The contract under test: a valid offline check is INTEGRITY-ONLY (never
 * "bound") because it verifies against the receipt's own embedded key; bad input
 * surfaces typed reasons rather than throwing. The crypto primitive itself is
 * exhaustively tested in @motebit/crypto — this pins the document-level bridge.
 */
import { describe, it, expect } from "vitest";
import { generateKeypair, bytesToHex, signExecutionReceipt } from "@motebit/crypto";
import type { ExecutionReceipt } from "@motebit/protocol";

import { verifyReceiptDocument } from "../receipt-document.js";

async function signedReceipt(overrides: Partial<ExecutionReceipt> = {}): Promise<ExecutionReceipt> {
  const kp = await generateKeypair();
  const unsigned = {
    task_id: overrides.task_id ?? "task-1",
    motebit_id: overrides.motebit_id ?? "mote-worker",
    device_id: "device-1",
    submitted_at: 1000,
    completed_at: 2000,
    status: overrides.status ?? "completed",
    result: "ok",
    tools_used: ["web_search"],
    memories_formed: 0,
    prompt_hash: "0".repeat(64),
    result_hash: "1".repeat(64),
    public_key: bytesToHex(kp.publicKey),
  } as unknown as Parameters<typeof signExecutionReceipt>[0];
  return signExecutionReceipt(unsigned, kp.privateKey);
}

describe("verifyReceiptDocument", () => {
  it("a valid receipt is integrity-only, never bound (verified against its own embedded key)", async () => {
    const receipt = await signedReceipt({ task_id: "t-abc", motebit_id: "mote-x" });
    const v = await verifyReceiptDocument(JSON.stringify(receipt));
    expect(v.integrity).toBe(true);
    expect(v.binding).toBe("integrity-only"); // the whole point: no anchor ⇒ not bound
    expect(v.signerDid).toMatch(/^did:key:/);
    expect(v.motebitId).toBe("mote-x");
    expect(v.taskId).toBe("t-abc");
    expect(v.reason).toBeUndefined();
  });

  it("a tampered signature → integrity false, binding unverified, signature_invalid", async () => {
    const receipt = await signedReceipt();
    const tampered = { ...receipt, signature: receipt.signature.slice(0, -2) + "AA" };
    const v = await verifyReceiptDocument(JSON.stringify(tampered));
    expect(v.integrity).toBe(false);
    expect(v.binding).toBe("unverified");
    expect(v.reason).toBe("signature_invalid");
  });

  it("a receipt without an embedded public_key → missing_public_key", async () => {
    const receipt = await signedReceipt();
    const { public_key: _drop, ...noKey } = receipt;
    const v = await verifyReceiptDocument(JSON.stringify(noKey));
    expect(v.integrity).toBe(false);
    expect(v.binding).toBe("unverified");
    expect(v.reason).toBe("missing_public_key");
  });

  it("malformed JSON → malformed_json (no throw)", async () => {
    const v = await verifyReceiptDocument("{ not json ");
    expect(v.integrity).toBe(false);
    expect(v.binding).toBe("unverified");
    expect(v.reason).toBe("malformed_json");
  });

  it("valid JSON that isn't a receipt → not_a_receipt", async () => {
    const v = await verifyReceiptDocument(JSON.stringify({ hello: "world" }));
    expect(v.integrity).toBe(false);
    expect(v.reason).toBe("not_a_receipt");
  });

  it("carries a verified delegation through as a nested integrity-only result", async () => {
    const child = await signedReceipt({ task_id: "t-child", motebit_id: "mote-child" });
    // Sign the parent WITH the child embedded so the parent's signature covers
    // the delegation (signing after-the-fact would invalidate it).
    const kp = await generateKeypair();
    const parentUnsigned = {
      task_id: "t-parent",
      motebit_id: "mote-parent",
      device_id: "device-1",
      submitted_at: 1000,
      completed_at: 2000,
      status: "completed",
      result: "ok",
      tools_used: [],
      memories_formed: 0,
      prompt_hash: "0".repeat(64),
      result_hash: "1".repeat(64),
      public_key: bytesToHex(kp.publicKey),
      delegation_receipts: [child],
    } as unknown as Parameters<typeof signExecutionReceipt>[0];
    const parent = await signExecutionReceipt(parentUnsigned, kp.privateKey);
    const v = await verifyReceiptDocument(JSON.stringify(parent));
    expect(v.integrity).toBe(true);
    expect(v.binding).toBe("integrity-only");
    expect(v.delegations).toBeDefined();
    expect(v.delegations![0]!.taskId).toBe("t-child");
    expect(v.delegations![0]!.binding).toBe("integrity-only");
  });
});
