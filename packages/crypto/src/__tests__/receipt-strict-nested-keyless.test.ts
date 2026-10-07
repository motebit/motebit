/**
 * Strict result_hash binding does not depend on whether a nested receipt's
 * key is present or well-formed. A delegation child at depth 1 or 2 with NO
 * `public_key` (or a malformed one) still has its `result_hash` checked, and
 * it fails its own signature check rather than being skipped.
 * `collectReceiptTreeErrors` flattens the whole tree into per-node failures
 * so both CLIs (`motebit verify receipt`, `motebit-verify`) read ONE walk.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  collectReceiptTreeErrors,
  generateKeypair,
  signExecutionReceipt,
  verifyReceipt,
} from "../index.js";
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

type KeyDefect = "missing" | "malformed-short" | "malformed-nonhex";

function defect(r: ExecutionReceipt, how: KeyDefect): ExecutionReceipt {
  const copy = { ...r } as Record<string, unknown>;
  if (how === "missing") delete copy.public_key;
  else if (how === "malformed-short") copy.public_key = "not-a-key";
  else copy.public_key = "z".repeat(64);
  return copy as unknown as ExecutionReceipt;
}

/**
 * outer(0) → child(1) → grandchild(2). The node at `depth` has result "z",
 * result_hash = sha256("y"), and a defective key. Every other node is bound.
 */
async function chain(depth: 1 | 2, how: KeyDefect): Promise<ExecutionReceipt> {
  let grandchild = await mint(
    "task-depth-2",
    depth === 2 ? "z" : "grandchild result",
    depth === 2 ? sha256Hex("y") : sha256Hex("grandchild result"),
  );
  if (depth === 2) grandchild = defect(grandchild, how);
  let child = await mint(
    "task-depth-1",
    depth === 1 ? "z" : "child result",
    depth === 1 ? sha256Hex("y") : sha256Hex("child result"),
    [grandchild],
  );
  if (depth === 1) child = defect(child, how);
  return mint("task-outer", "outer result", sha256Hex("outer result"), [child]);
}

describe("verifyReceipt strict — nested hash binding is independent of the child's key", () => {
  for (const how of ["missing", "malformed-short", "malformed-nonhex"] as const) {
    for (const depth of [1, 2] as const) {
      it(`${how} key at depth ${depth}: result_hash still checked, signature fails`, async () => {
        const r = await verifyReceipt(await chain(depth, how), { strictHashBinding: true });
        expect(r.valid).toBe(false);
        const errs = collectReceiptTreeErrors(r);
        const hashErr = errs.find((e) => e.path === "result_hash" && e.depth === depth);
        expect(hashErr?.task_id).toBe(`task-depth-${depth}`);
        expect(hashErr?.message).toContain(
          `delegation depth ${depth}, task_id task-depth-${depth}`,
        );
        const sigErr = errs.find((e) => e.path !== "result_hash" && e.depth === depth);
        expect(sigErr).toBeDefined();
        // Only the defective node fails: the outer and other nodes are clean.
        expect(errs.every((e) => e.depth === depth)).toBe(true);
      });
    }
  }

  it("a fully bound chain collects no errors", async () => {
    const gc = await mint("task-depth-2", "g", sha256Hex("g"));
    const c = await mint("task-depth-1", "c", sha256Hex("c"), [gc]);
    const o = await mint("task-outer", "o", sha256Hex("o"), [c]);
    const r = await verifyReceipt(o, { strictHashBinding: true });
    expect(r.valid).toBe(true);
    expect(collectReceiptTreeErrors(r)).toEqual([]);
  });

  it("an outer receipt with no key still has its own result_hash checked under strict", async () => {
    const o = defect(await mint("task-outer", "z", sha256Hex("y")), "missing");
    const r = await verifyReceipt(o, { strictHashBinding: true });
    const errs = collectReceiptTreeErrors(r);
    expect(errs.some((e) => e.path === "result_hash" && e.depth === 0)).toBe(true);
    expect(errs.some((e) => e.path !== "result_hash" && e.depth === 0)).toBe(true);
  });
});
