/**
 * Runtime-parse tests for the ExecutionReceipt zod schema.
 *
 * The drift.test.ts suite pins the JSON Schema artifact; this suite
 * verifies the zod schema actually accepts real motebit receipts and
 * rejects malformed ones. The two are independent: the artifact could
 * match zod exactly while zod itself rejects valid data. Tested together
 * they close the loop.
 */
import { describe, expect, it } from "vitest";

import { ExecutionReceiptSchema, assembleJsonSchema } from "../execution-receipt.js";

const SAMPLE: Record<string, unknown> = {
  task_id: "01HTV8X9QZ-task-1",
  motebit_id: "019cd9d4-3275-7b24-8265-61ebee41d9d0",
  public_key: "deadbeef".repeat(8),
  device_id: "019cd9d4-3275-7b24-8265-61ebee41d9d1",
  submitted_at: 1_713_456_000_000,
  completed_at: 1_713_456_003_000,
  status: "completed",
  result: "hello",
  tools_used: ["web_search"],
  memories_formed: 2,
  prompt_hash: "a".repeat(64),
  result_hash: "b".repeat(64),
  suite: "motebit-jcs-ed25519-b64-v1",
  signature: "sig-base64url-here",
};

describe("ExecutionReceiptSchema", () => {
  it("parses a minimal valid receipt", () => {
    const r = ExecutionReceiptSchema.parse(SAMPLE);
    expect(r.task_id).toBe("01HTV8X9QZ-task-1");
    expect(r.status).toBe("completed");
  });

  it("parses a receipt with a nested delegation_receipts chain", () => {
    const nested = {
      ...SAMPLE,
      delegation_receipts: [
        { ...SAMPLE, task_id: "nested-1", status: "completed" },
        { ...SAMPLE, task_id: "nested-2", status: "failed" },
      ],
    };
    const r = ExecutionReceiptSchema.parse(nested);
    expect(r.delegation_receipts).toHaveLength(2);
    expect(r.delegation_receipts?.[0]?.task_id).toBe("nested-1");
  });

  it("rejects an unknown cryptosuite", () => {
    const bad = { ...SAMPLE, suite: "motebit-future-pqc-v7" };
    expect(() => ExecutionReceiptSchema.parse(bad)).toThrow();
  });

  it("rejects an unknown status", () => {
    const bad = { ...SAMPLE, status: "in-progress" };
    expect(() => ExecutionReceiptSchema.parse(bad)).toThrow();
  });

  it("rejects an unknown invocation_origin", () => {
    const bad = { ...SAMPLE, invocation_origin: "telepathy" };
    expect(() => ExecutionReceiptSchema.parse(bad)).toThrow();
  });

  it("rejects extra top-level keys (strict mode)", () => {
    const bad = { ...SAMPLE, sneak: "not allowed" };
    expect(() => ExecutionReceiptSchema.parse(bad)).toThrow();
  });

  it("rejects a receipt missing a required field", () => {
    const bad = { ...SAMPLE };
    delete (bad as Record<string, unknown>).signature;
    expect(() => ExecutionReceiptSchema.parse(bad)).toThrow();
  });

  it("accepts all four IntentOrigin values when set", () => {
    const origins = ["user-tap", "ai-loop", "scheduled", "agent-to-agent"] as const;
    for (const origin of origins) {
      const r = ExecutionReceiptSchema.parse({ ...SAMPLE, invocation_origin: origin });
      expect(r.invocation_origin).toBe(origin);
    }
  });
});

describe("assembleJsonSchema", () => {
  const META = { $id: "https://example/test.json", title: "Test", description: "Test schema" };

  it("assembles the happy-path schema from a definitions envelope", () => {
    const raw = {
      $ref: "#/definitions/ExecutionReceipt",
      definitions: { ExecutionReceipt: { type: "object", properties: { a: { type: "string" } } } },
    };
    const out = assembleJsonSchema(raw, META);
    expect(out.$id).toBe(META.$id);
    expect(out.title).toBe(META.title);
    expect(out.type).toBe("object");
    expect(out.definitions).toEqual(raw.definitions);
  });

  it("throws if the raw schema has no definitions bag (upstream library changed)", () => {
    expect(() => assembleJsonSchema({ type: "object" }, META)).toThrow(/definitions bag/);
  });

  it("throws if definitions is present but has no ExecutionReceipt key", () => {
    expect(() => assembleJsonSchema({ definitions: { Other: { type: "object" } } }, META)).toThrow(
      /ExecutionReceipt/,
    );
  });
});
