/**
 * Strict result_hash binding is recursive: when `strictHashBinding` is set,
 * every `delegation_receipts` entry at every depth must bind its own result.
 * A signed outer receipt carrying a self-inconsistent child (depth 1 or 2) is
 * INVALID, and the error names the child's depth and task_id. Without the
 * option the verdict is unchanged (signature-only at every level).
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { generateKeypair, signExecutionReceipt, verifyReceipt } from "../index.js";
import type { ExecutionReceipt } from "../index.js";

const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

async function mint(
  taskId: string,
  result: string,
  resultHash: string,
  delegations?: ExecutionReceipt[],
): Promise<ExecutionReceipt> {
  const kp = await generateKeypair();
  return (await signExecutionReceipt(
    {
      task_id: taskId,
      motebit_id: "019cd9d4-3275-7b24-8265-61ebee41d9d0",
      device_id: "019cd9d4-3275-7b24-8265-61ebee41d9d1",
      submitted_at: 1_713_456_000_000,
      completed_at: 1_713_456_001_000,
      status: "completed",
      result,
      tools_used: [],
      memories_formed: 0,
      prompt_hash: "a".repeat(64),
      result_hash: resultHash,
      ...(delegations ? { delegation_receipts: delegations } : {}),
    },
    kp.privateKey,
    kp.publicKey,
  )) as ExecutionReceipt;
}

/** outer(depth 0) → child(depth 1) → grandchild(depth 2); `bad` names the unbound level. */
async function chain(bad: 0 | 1 | 2 | null): Promise<ExecutionReceipt> {
  const h = (level: number, r: string) => (bad === level ? "b".repeat(64) : sha256Hex(r));
  const grandchild = await mint("task-depth-2", "grandchild result", h(2, "grandchild result"));
  const child = await mint("task-depth-1", "child result", h(1, "child result"), [grandchild]);
  return mint("task-outer", "outer result", h(0, "outer result"), [child]);
}

describe("verifyReceipt — strict result_hash binding is recursive", () => {
  it("depth-1 mismatch → invalid under strict, naming depth 1 and its task_id", async () => {
    const r = await verifyReceipt(await chain(1), { strictHashBinding: true });
    expect(r.valid).toBe(false);
    const msgs = (r.errors ?? []).map((e) => e.message).join("\n");
    expect(msgs).toMatch(/delegation depth 1, task_id task-depth-1/);
    expect(r.delegations?.[0]?.valid).toBe(false);
  });

  it("depth-2 mismatch → invalid under strict, naming depth 2 and its task_id", async () => {
    const r = await verifyReceipt(await chain(2), { strictHashBinding: true });
    expect(r.valid).toBe(false);
    const msgs = (r.errors ?? []).map((e) => e.message).join("\n");
    expect(msgs).toMatch(/delegation depth 2, task_id task-depth-2/);
    expect(r.delegations?.[0]?.delegations?.[0]?.valid).toBe(false);
  });

  it("a fully bound chain is valid both strict and default", async () => {
    const c = await chain(null);
    expect((await verifyReceipt(c, { strictHashBinding: true })).valid).toBe(true);
    expect((await verifyReceipt(c)).valid).toBe(true);
  });

  it("default (no option) is signature-only at every depth: nested mismatches read valid", async () => {
    for (const bad of [0, 1, 2] as const) {
      const r = await verifyReceipt(await chain(bad));
      expect(r.valid).toBe(true);
      expect(r.errors).toBeUndefined();
    }
  });

  it("top-level strict mismatch message is unchanged (no depth suffix)", async () => {
    const r = await verifyReceipt(await chain(0), { strictHashBinding: true });
    expect(r.valid).toBe(false);
    expect(r.errors).toEqual([
      {
        message:
          "result_hash does not equal hex(SHA-256(result)) — receipt is not self-consistent (strict mode)",
        path: "result_hash",
      },
    ]);
  });
});
