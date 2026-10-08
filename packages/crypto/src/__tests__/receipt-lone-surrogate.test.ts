/**
 * UTF-8(s) is undefined for a string holding an unpaired UTF-16 surrogate
 * (spec/execution-ledger-v1.md §11.4; JCS requires I-JSON, RFC 8785 §3.1 /
 * RFC 7493 §2.1). Under STRICT hash binding a receipt carrying one anywhere in
 * its body is INVALID — the verifier never substitutes U+FFFD, which would let
 * two distinct results share one signature and one result_hash — and so is its
 * structured verdict (which always checks result_hash binding). Matches the
 * Python reference verifier, which cannot UTF-8 encode such a string.
 * Signature-only verification keeps main's behaviour (see
 * receipt-lone-surrogate-compat.test.ts).
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  EXECUTION_RECEIPT_SUITE,
  bytesToHex,
  canonicalJson,
  ed25519Sign,
  generateKeypair,
  toBase64Url,
  verifyReceipt,
  verifyReceiptVerdict,
} from "../index.js";
import type { ExecutionReceipt } from "../index.js";

const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** Signed the way receipts were signed before producers repaired surrogates. */
async function mintLegacy(result: string, extra: Record<string, unknown> = {}) {
  const kp = await generateKeypair();
  const body = {
    task_id: "task-surrogate",
    motebit_id: "019cd9d4-3275-7b24-8265-61ebee41d9d0",
    device_id: "019cd9d4-3275-7b24-8265-61ebee41d9d1",
    submitted_at: 1_713_456_000_000,
    completed_at: 1_713_456_001_000,
    status: "completed",
    result,
    tools_used: [],
    memories_formed: 0,
    prompt_hash: "a".repeat(64),
    // Node's utf8 encoder substitutes U+FFFD — the lenient reading.
    result_hash: sha256Hex(result),
    ...extra,
    public_key: bytesToHex(kp.publicKey),
    suite: EXECUTION_RECEIPT_SUITE,
  };
  const sig = await ed25519Sign(new TextEncoder().encode(canonicalJson(body)), kp.privateKey);
  return { ...body, signature: toBase64Url(sig) } as unknown as ExecutionReceipt;
}

describe("strict verification rejects receipts with an unpaired UTF-16 surrogate", () => {
  for (const [label, s] of [
    ["lone high", "x \ud800"],
    ["lone low", "\udc00 y"],
    ["reversed pair", "\udc00\ud800"],
  ] as const) {
    it(`${label} in result → invalid strict with a §11.4 reason; verdict invalid`, async () => {
      const r = await mintLegacy(s);
      const v = await verifyReceipt(r, { strictHashBinding: true });
      expect(v.valid).toBe(false);
      expect((v.errors ?? []).map((e) => e.message).join("\n")).toMatch(
        /§11\.4 violation: .*unpaired UTF-16 surrogate/,
      );
      // Signature-only (the library default) is unchanged from main.
      expect((await verifyReceipt(r)).valid).toBe(true);
      const verdict = await verifyReceiptVerdict(r);
      expect(verdict.integrity).toBe("invalid");
      expect(verdict.repair?.code).toBe("integrity.unpaired_surrogate");
    });
  }

  it("a surrogate in a member name is rejected strict too", async () => {
    const r = await mintLegacy("ok", { ["k\ud800"]: "v" });
    expect((await verifyReceipt(r, { strictHashBinding: true })).valid).toBe(false);
    expect((await verifyReceipt(r)).valid).toBe(true);
  });

  it("a surrogate in a nested child invalidates the tree strict, not signature-only", async () => {
    const child = await mintLegacy("\ud83d");
    const outer = await mintLegacy("o", { delegation_receipts: [child] });
    expect((await verifyReceipt(outer, { strictHashBinding: true })).valid).toBe(false);
    expect((await verifyReceipt(outer)).valid).toBe(true);
  });

  it("a well-formed astral character (a valid pair) still verifies strict", async () => {
    const r = await mintLegacy("ok 😀");
    expect((await verifyReceipt(r, { strictHashBinding: true })).valid).toBe(true);
  });
});
