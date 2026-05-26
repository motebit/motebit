/**
 * Multi-hop settlement depth — recursion-safety invariant.
 *
 * Locks two things the relay-mode multi-hop residual depends on:
 *  1. `exceedsSettlementDepth` — the single depth-limit comparison, as a truth table.
 *  2. `settlementTreeDepths` — the depth-assignment plumbing (root receipts = depth 1,
 *     +1 per nesting level), so a 2-level chain settles and a 12-level chain blocks its
 *     tail. Pure-predicate testing alone would not catch "predicate correct, plumbing
 *     wrong" (an off-by-one in how depth is assigned); the structural case does.
 *
 * The "comparison lives in exactly one file" half of the invariant is structural and
 * is enforced by `check-multihop-depth-single-site`, not here.
 */
import { describe, it, expect } from "vitest";
import type { ExecutionReceipt } from "@motebit/sdk";
import {
  MAX_SETTLEMENT_DEPTH,
  exceedsSettlementDepth,
  settlementTreeDepths,
} from "../multihop-depth.js";

/** Minimal receipt-shaped node; only the fields the pure walk reads are populated. */
function node(id: string, nested?: ExecutionReceipt): ExecutionReceipt {
  return {
    motebit_id: id,
    relay_task_id: `task-${id}`,
    delegation_receipts: nested ? [nested] : undefined,
  } as unknown as ExecutionReceipt;
}

/** Build a linearly-nested chain of `levels` delegation receipts under a root. */
function chain(levels: number): ExecutionReceipt {
  let cur: ExecutionReceipt | undefined;
  for (let i = levels; i >= 1; i--) cur = node(`n${i}`, cur);
  // `cur` is the root's single direct delegation receipt; wrap it in a root receipt.
  return node("root", cur);
}

describe("exceedsSettlementDepth — truth table", () => {
  it.each([
    [0, false],
    [1, false],
    [9, false],
    [10, false], // at the limit settles; only strictly-greater blocks
    [11, true],
    [Number.MAX_SAFE_INTEGER, true],
  ])("depth %i (default max=10) → blocked=%s", (depth, blocked) => {
    expect(exceedsSettlementDepth(depth)).toBe(blocked);
  });

  it("honors an injected maxDepth (test relays lower it)", () => {
    expect(exceedsSettlementDepth(3, 2)).toBe(true);
    expect(exceedsSettlementDepth(2, 2)).toBe(false);
  });

  it("MAX_SETTLEMENT_DEPTH is the documented default of 10", () => {
    expect(MAX_SETTLEMENT_DEPTH).toBe(10);
    expect(exceedsSettlementDepth(MAX_SETTLEMENT_DEPTH)).toBe(false);
    expect(exceedsSettlementDepth(MAX_SETTLEMENT_DEPTH + 1)).toBe(true);
  });
});

describe("settlementTreeDepths — depth-assignment plumbing", () => {
  it("seeds root's direct delegation receipts at depth 1 (matches tasks.ts)", () => {
    const nodes = settlementTreeDepths(node("root", node("a")));
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ motebitId: "a", depth: 1, depthBlocked: false });
  });

  it("a 2-level chain settles fully — no node blocked", () => {
    const nodes = settlementTreeDepths(chain(2));
    expect(nodes.map((n) => n.depth)).toEqual([1, 2]);
    expect(nodes.every((n) => !n.depthBlocked)).toBe(true);
  });

  it("a 12-level chain blocks exactly the tail beyond the limit (depths 11,12)", () => {
    const nodes = settlementTreeDepths(chain(12));
    expect(nodes.map((n) => n.depth)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const blocked = nodes.filter((n) => n.depthBlocked).map((n) => n.depth);
    expect(blocked).toEqual([11, 12]);
  });

  it("carries relay_task_id through, null when absent", () => {
    const missingTaskId = {
      motebit_id: "x",
      delegation_receipts: undefined,
    } as unknown as ExecutionReceipt;
    const nodes = settlementTreeDepths(node("root", missingTaskId));
    expect(nodes[0]).toMatchObject({ motebitId: "x", relayTaskId: null });
  });

  it("empty tree yields no nodes", () => {
    expect(settlementTreeDepths(node("root"))).toEqual([]);
  });
});
