/**
 * UTF-8(s) is undefined for a string holding an unpaired UTF-16 surrogate
 * (spec/execution-ledger-v1.md §11.4; JCS requires I-JSON, RFC 8785 §3.1 /
 * RFC 7493 §2.1). A receipt carrying one anywhere in its body is INVALID in
 * every mode — the verifier never substitutes U+FFFD, which would let two
 * distinct results share one signature and one result_hash. Matches the
 * Python reference verifier, which cannot UTF-8 encode such a string.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  generateKeypair,
  signExecutionReceipt,
  verifyExecutionReceipt,
  verifyReceipt,
  verifyReceiptVerdict,
} from "../index.js";
import type { ExecutionReceipt } from "../index.js";

const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

async function mint(result: string, extra: Record<string, unknown> = {}) {
  const kp = await generateKeypair();
  const r = (await signExecutionReceipt(
    {
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
    },
    kp.privateKey,
    kp.publicKey,
  )) as ExecutionReceipt;
  return { r, kp };
}

describe("receipts with an unpaired UTF-16 surrogate are rejected", () => {
  for (const [label, s] of [
    ["lone high", "x \ud800"],
    ["lone low", "\udc00 y"],
    ["reversed pair", "\udc00\ud800"],
  ] as const) {
    it(`${label} in result → invalid default and strict, with a §11.4 reason`, async () => {
      const { r, kp } = await mint(s);
      for (const opts of [undefined, { strictHashBinding: true }]) {
        const v = await verifyReceipt(r, opts);
        expect(v.valid).toBe(false);
        expect((v.errors ?? []).map((e) => e.message).join("\n")).toMatch(
          /unpaired UTF-16 surrogate/,
        );
      }
      expect(await verifyExecutionReceipt(r, kp.publicKey)).toBe(false);
      const verdict = await verifyReceiptVerdict(r);
      expect(verdict.integrity).toBe("invalid");
      expect(verdict.repair?.code).toBe("integrity.unpaired_surrogate");
    });
  }

  it("a surrogate in a nested child invalidates the tree", async () => {
    const { r: child } = await mint("\ud83d");
    const { r: outer } = await mint("o", { delegation_receipts: [child] });
    expect((await verifyReceipt(outer)).valid).toBe(false);
  });

  it("a well-formed astral character (a valid pair) still verifies strict", async () => {
    const { r } = await mint("ok 😀");
    expect((await verifyReceipt(r, { strictHashBinding: true })).valid).toBe(true);
  });
});
