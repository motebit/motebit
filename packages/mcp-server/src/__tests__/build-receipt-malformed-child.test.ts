/**
 * An old child receipt holding an unpaired UTF-16 surrogate (signed before
 * producers stopped emitting one) is dropped from `delegation_receipts`; the
 * service's own receipt is still signed and strict-valid. A third party's
 * malformed child must never cost the parent
 * (docs/design/payment-receipt-wellformed-stop-condition.md §3, decision (a)).
 */
import { describe, expect, it } from "vitest";
import {
  bytesToHex,
  canonicalJson,
  generateKeypair,
  hash as sha256,
  sign,
  toBase64Url,
  verifyExecutionReceipt,
  verifyReceipt,
} from "@motebit/encryption";
import type { ExecutionReceipt } from "@motebit/sdk";
import { buildServiceReceipt } from "../build-receipt.js";

/** A child signed the way producers signed before the §11.4 boundary: no refusal. */
async function legacyChild(taskId: string, result: string): Promise<ExecutionReceipt> {
  const kp = await generateKeypair();
  const body = {
    task_id: taskId,
    motebit_id: "motebit-child",
    device_id: "child-device",
    submitted_at: 1_700_000_000_000,
    completed_at: 1_700_000_000_500,
    status: "completed",
    result,
    tools_used: [],
    memories_formed: 0,
    prompt_hash: "a".repeat(64),
    result_hash: await sha256(new TextEncoder().encode(result)),
    public_key: bytesToHex(kp.publicKey),
    suite: "motebit-jcs-ed25519-b64-v1",
  };
  const sig = await sign(new TextEncoder().encode(canonicalJson(body)), kp.privateKey);
  return { ...body, signature: toBase64Url(sig) } as unknown as ExecutionReceipt;
}

describe("buildServiceReceipt — an old child with an unpaired surrogate", () => {
  it("drops that child, keeps the well-formed one, and still signs the parent", async () => {
    const kp = await generateKeypair();
    const bad = await legacyChild("child-bad", "cut \uD83D");
    const good = await legacyChild("child-good", "fine 😀");
    // The old child is a valid signature over its escaped bytes.
    expect(
      await verifyExecutionReceipt(bad, new Uint8Array(Buffer.from(bad.public_key!, "hex"))),
    ).toBe(true);

    const receipt = await buildServiceReceipt({
      motebitId: "motebit-svc",
      deviceId: "svc-device",
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
      prompt: "delegate",
      taskId: "task-parent",
      submittedAt: 1_700_000_000_000,
      result: "done",
      ok: true,
      toolsUsed: [],
      delegationReceipts: [bad, good],
    });

    expect(receipt.delegation_receipts?.map((d) => d.task_id)).toEqual(["child-good"]);
    expect(await verifyExecutionReceipt(receipt, kp.publicKey)).toBe(true);
    expect((await verifyReceipt(receipt, { strictHashBinding: true })).valid).toBe(true);
  });

  it("omits delegation_receipts entirely when every child is malformed", async () => {
    const kp = await generateKeypair();
    const receipt = await buildServiceReceipt({
      motebitId: "motebit-svc",
      deviceId: "svc-device",
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
      prompt: "delegate",
      taskId: "task-parent",
      submittedAt: 1_700_000_000_000,
      result: "done",
      ok: true,
      toolsUsed: [],
      delegationReceipts: [await legacyChild("child-bad", "\uDC00 lone low")],
    });
    expect(receipt.delegation_receipts).toBeUndefined();
    expect((await verifyReceipt(receipt, { strictHashBinding: true })).valid).toBe(true);
  });
});
