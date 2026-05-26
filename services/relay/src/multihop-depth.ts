/**
 * Multi-hop settlement recursion depth — the single source of the depth-limit
 * comparison and the structural tree-walk it guards.
 *
 * Why a dedicated module: the relay-mode multi-hop settlement WRITE in
 * `tasks.ts` (`settleSubReceipt`) is a deferred residual (services/relay/CLAUDE.md
 * rule 8 — "only `settleSubReceipt`'s relay-mode write is a deferred residual").
 * Its recursion-safety invariant is "the depth-limit comparison happens in
 * exactly one place." Re-inlining `depth > maxDepth` anywhere else is the drift
 * this module + `check-multihop-depth-single-site` exist to prevent — re-inlined
 * comparisons drifting out of sync with the recursion is the failure class that
 * produced the residual branch in the first place.
 *
 * The comparison is extracted as a pure predicate so it is unit-testable as a
 * truth table; the structural tree-walk is extracted so the depth-assignment
 * plumbing (root's direct delegation receipts are depth 1) is lockable against
 * off-by-one drift without standing up the full HTTP settlement route.
 */
import type { ExecutionReceipt } from "@motebit/sdk";

/** Default maximum delegation-chain depth for multi-hop settlement recursion. */
export const MAX_SETTLEMENT_DEPTH = 10;

/**
 * The single source of the depth-limit comparison. Returns `true` when `depth`
 * exceeds `maxDepth` and the recursion must stop — the node is left unsettled.
 *
 * This is the ONLY place in the relay permitted to compare a recursion depth
 * against the settlement limit; `check-multihop-depth-single-site` enforces it.
 */
export function exceedsSettlementDepth(
  depth: number,
  maxDepth: number = MAX_SETTLEMENT_DEPTH,
): boolean {
  return depth > maxDepth;
}

export interface SettlementTreeNode {
  motebitId: string;
  relayTaskId: string | null;
  /** Recursion depth this node is visited at (root's direct receipts = 1). */
  depth: number;
  /** True when this node sits beyond `maxDepth` and would be left unsettled. */
  depthBlocked: boolean;
}

/**
 * Pure structural walk of a receipt's nested `delegation_receipts`, modeling the
 * depth each node would be visited at by `settleSubReceipt`. The root receipt's
 * direct delegation receipts are visited at depth 1 (matching `tasks.ts`, which
 * seeds the recursion with `settleSubReceipt(sub, taskId, 1)`); each nesting
 * level is depth + 1.
 *
 * Models ONLY the depth-assignment plumbing — NOT the runtime gates the live
 * recursion also applies (sub-task presence in the queue, signature validity,
 * prior settlement, zero cost). It exists to (a) emit settlement-tree depth
 * telemetry on the loud residual path and (b) lock the depth plumbing under test.
 */
export function settlementTreeDepths(
  root: ExecutionReceipt,
  maxDepth: number = MAX_SETTLEMENT_DEPTH,
  startDepth = 1,
): SettlementTreeNode[] {
  const out: SettlementTreeNode[] = [];
  const walk = (receipts: readonly ExecutionReceipt[], depth: number): void => {
    for (const r of receipts) {
      const relayTaskId = (r as unknown as Record<string, unknown>).relay_task_id;
      out.push({
        motebitId: r.motebit_id,
        relayTaskId: typeof relayTaskId === "string" ? relayTaskId : null,
        depth,
        depthBlocked: exceedsSettlementDepth(depth, maxDepth),
      });
      const nested = r.delegation_receipts ?? [];
      if (nested.length > 0) walk(nested, depth + 1);
    }
  };
  walk(root.delegation_receipts ?? [], startDepth);
  return out;
}
