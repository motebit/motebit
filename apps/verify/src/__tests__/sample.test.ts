/**
 * The on-load sample is a committed fixture: it must equal what the deterministic
 * builder produces from the public demo seeds (regenerate with
 * `pnpm --filter @motebit/verify-web mint-sample`), it must verify, and the
 * Tamper control must turn it INVALID by flipping exactly one byte of `result`.
 */
import { describe, it, expect } from "vitest";
// The committed bytes, exactly as on disk (Vite `?raw`).
import committed from "../sample-receipt.json?raw";
import { verifyReceiptDocument } from "@motebit/state-export-client";
import { buildSampleReceipt, serializeSample } from "../sample-build.js";
import { SAMPLE_JSON, tamperResult } from "../sample.js";

describe("sample receipt fixture", () => {
  it("is byte-identical to the deterministic builder's output", async () => {
    expect(serializeSample(await buildSampleReceipt())).toBe(committed);
  });

  it("verifies: integrity ✓, sovereign binding, nested receipt valid", async () => {
    const v = await verifyReceiptDocument(SAMPLE_JSON);
    expect(v.integrity).toBe(true);
    expect(v.binding).toBe("sovereign");
    expect(v.delegations).toHaveLength(1);
    expect(v.delegations![0]!.integrity).toBe(true);
    const parsed = JSON.parse(SAMPLE_JSON) as Record<string, unknown>;
    expect(parsed["delegation_receipts"]).toHaveLength(1);
  });
});

describe("tamper", () => {
  it("flips exactly one byte of result and the verifier says INVALID", async () => {
    const t = tamperResult(SAMPLE_JSON)!;
    const before = new TextEncoder().encode((JSON.parse(SAMPLE_JSON) as { result: string }).result);
    const after = new TextEncoder().encode((JSON.parse(t) as { result: string }).result);
    expect(after.length).toBe(before.length);
    const diffs = before.filter((b, i) => b !== after[i]).length;
    expect(diffs).toBe(1);
    const v = await verifyReceiptDocument(t);
    expect(v.integrity).toBe(false);
    expect(v.reason).toBe("signature_invalid");
  });

  it("returns null when there is nothing to flip", () => {
    expect(tamperResult("{nope")).toBeNull();
    expect(tamperResult("null")).toBeNull();
    expect(tamperResult(JSON.stringify({ result: 5 }))).toBeNull();
    expect(tamperResult(JSON.stringify({ result: "123 456" }))).toBeNull();
  });
});
