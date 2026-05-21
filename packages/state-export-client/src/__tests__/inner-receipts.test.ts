/**
 * Inner-receipt recursive verification tests. Builds real signed
 * `ExecutionReceipt` instances with keypairs under test, embeds their
 * canonical JSON inside a v1.1 execution-ledger body, and asserts:
 *   - all-valid bundles return `allValid: true`
 *   - tampered receipts surface typed failure reasons
 *   - missing public_key paths reject cleanly
 *   - v1.0 bodies and bodies without `signed_receipts` return
 *     `applicable: false` without attempting recursion
 *
 * The `verifyReceipt` primitive is exhaustively tested in `@motebit/crypto`;
 * this file pins the consumer-side bridge from JSON-strings on the wire
 * to per-receipt verification outcomes.
 */

import { describe, it, expect } from "vitest";
import { generateKeypair, bytesToHex, signExecutionReceipt } from "@motebit/crypto";
import type { ExecutionReceipt } from "@motebit/protocol";

import { verifyInnerSignedReceipts } from "../inner-receipts.js";

async function makeSignedReceipt(overrides: Partial<ExecutionReceipt> = {}): Promise<{
  json: string;
  receipt: ExecutionReceipt;
  publicKeyHex: string;
}> {
  const kp = await generateKeypair();
  const publicKeyHex = bytesToHex(kp.publicKey);
  const unsigned = {
    task_id: overrides.task_id ?? "task-inner-1",
    motebit_id: overrides.motebit_id ?? "delegate-mote",
    device_id: overrides.device_id ?? "delegate-device",
    submitted_at: overrides.submitted_at ?? 1000,
    completed_at: overrides.completed_at ?? 2000,
    status: overrides.status ?? "completed",
    result: overrides.result ?? "ok",
    tools_used: overrides.tools_used ?? ["web_search"],
    memories_formed: overrides.memories_formed ?? 0,
    prompt_hash: overrides.prompt_hash ?? "0".repeat(64),
    result_hash: overrides.result_hash ?? "1".repeat(64),
    public_key: publicKeyHex,
  } as unknown as Parameters<typeof signExecutionReceipt>[0];
  const signed = await signExecutionReceipt(unsigned, kp.privateKey);
  return { json: JSON.stringify(signed), receipt: signed, publicKeyHex };
}

describe("verifyInnerSignedReceipts — happy path", () => {
  it("verifies every entry in a v1.1 body with all-valid inner receipts", async () => {
    const r1 = await makeSignedReceipt({ task_id: "t1", motebit_id: "mote-a" });
    const r2 = await makeSignedReceipt({ task_id: "t2", motebit_id: "mote-b" });
    const body = {
      spec: "motebit/execution-ledger@1.1",
      signed_receipts: [r1.json, r2.json],
    };
    const result = await verifyInnerSignedReceipts(body);
    expect(result.applicable).toBe(true);
    expect(result.allValid).toBe(true);
    expect(result.verifiedCount).toBe(2);
    expect(result.totalCount).toBe(2);
    expect(result.results[0]!.taskId).toBe("t1");
    expect(result.results[1]!.taskId).toBe("t2");
    expect(result.results[0]!.signerDid).toMatch(/^did:key:/);
    // Inner receipts verify against their own embedded key — integrity, not
    // identity binding. The result must say so structurally so a UI never
    // renders "from <motebit>" without an external anchor.
    expect(result.results[0]!.identityBinding).toBe("embedded-key-unverified");
  });

  it("returns applicable=false on v1.0 bodies", async () => {
    const result = await verifyInnerSignedReceipts({
      spec: "motebit/execution-ledger@1.0",
      delegation_receipts: [],
    });
    expect(result.applicable).toBe(false);
    expect(result.results).toHaveLength(0);
  });

  it("returns applicable=false when signed_receipts is absent or empty", async () => {
    const empty = await verifyInnerSignedReceipts({
      spec: "motebit/execution-ledger@1.1",
      signed_receipts: [],
    });
    expect(empty.applicable).toBe(false);

    const missing = await verifyInnerSignedReceipts({
      spec: "motebit/execution-ledger@1.1",
    });
    expect(missing.applicable).toBe(false);
  });

  it("returns applicable=false on non-execution-ledger bodies", async () => {
    const result = await verifyInnerSignedReceipts({
      motebit_id: "x",
      entries: [],
    });
    expect(result.applicable).toBe(false);
  });

  it("returns applicable=false on non-object input", async () => {
    expect((await verifyInnerSignedReceipts(null)).applicable).toBe(false);
    expect((await verifyInnerSignedReceipts("string")).applicable).toBe(false);
    expect((await verifyInnerSignedReceipts(42)).applicable).toBe(false);
  });
});

describe("verifyInnerSignedReceipts — failure modes", () => {
  it("flags signature_invalid when an inner receipt has been tampered", async () => {
    const r = await makeSignedReceipt({ task_id: "t-tampered" });
    // Mutate one byte of the receipt's `result` after signing — the
    // signature was computed over the original payload.
    const tampered = JSON.parse(r.json) as ExecutionReceipt;
    (tampered as { result: string }).result = "different-result-than-signed";
    const body = {
      spec: "motebit/execution-ledger@1.1",
      signed_receipts: [JSON.stringify(tampered)],
    };
    const result = await verifyInnerSignedReceipts(body);
    expect(result.applicable).toBe(true);
    expect(result.allValid).toBe(false);
    expect(result.verifiedCount).toBe(0);
    expect(result.results[0]!.valid).toBe(false);
    expect(result.results[0]!.reason).toBe("signature_invalid");
  });

  it("flags missing_public_key when the receipt has no embedded public_key", async () => {
    const r = await makeSignedReceipt({ task_id: "t-no-key" });
    const stripped = JSON.parse(r.json) as ExecutionReceipt;
    delete (stripped as { public_key?: string }).public_key;
    const body = {
      spec: "motebit/execution-ledger@1.1",
      signed_receipts: [JSON.stringify(stripped)],
    };
    const result = await verifyInnerSignedReceipts(body);
    expect(result.applicable).toBe(true);
    expect(result.allValid).toBe(false);
    expect(result.results[0]!.valid).toBe(false);
    expect(result.results[0]!.reason).toBe("missing_public_key");
  });

  it("flags malformed_json when an inner entry isn't parseable", async () => {
    const body = {
      spec: "motebit/execution-ledger@1.1",
      signed_receipts: ["{not-json"],
    };
    const result = await verifyInnerSignedReceipts(body);
    expect(result.applicable).toBe(true);
    expect(result.allValid).toBe(false);
    expect(result.results[0]!.valid).toBe(false);
    expect(result.results[0]!.reason).toBe("malformed_json");
  });

  it("partial-success: one valid + one invalid → allValid=false, verifiedCount=1", async () => {
    const valid = await makeSignedReceipt({ task_id: "t-good" });
    const r2 = await makeSignedReceipt({ task_id: "t-bad" });
    const tampered = JSON.parse(r2.json) as ExecutionReceipt;
    (tampered as { result: string }).result = "tampered";
    const body = {
      spec: "motebit/execution-ledger@1.1",
      signed_receipts: [valid.json, JSON.stringify(tampered)],
    };
    const result = await verifyInnerSignedReceipts(body);
    expect(result.applicable).toBe(true);
    expect(result.allValid).toBe(false);
    expect(result.verifiedCount).toBe(1);
    expect(result.totalCount).toBe(2);
    expect(result.results[0]!.valid).toBe(true);
    expect(result.results[1]!.valid).toBe(false);
  });
});
