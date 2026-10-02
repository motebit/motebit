/**
 * The CLAIM — what the receipt's signed body says, in plain words. Pure mapping
 * from the parsed receipt JSON (untrusted, so every field is type-checked) plus
 * the verifier's view model for the per-node verdict. The DOM layer renders the
 * strings via `textContent` only, so `result` is always shown escaped.
 *
 * The nested tree pairs `delegation_receipts[i]` with `view.delegations[i]`:
 * `@motebit/crypto`'s `verifyReceipt` maps the array in order, so the index IS
 * the correspondence.
 */

import type { ReceiptDocumentVerification } from "@motebit/state-export-client";

/** Characters of `result` shown before the "show all" expander. */
export const RESULT_PREVIEW_CHARS = 280;

export interface ClaimTime {
  readonly ms: number;
  readonly iso: string;
  readonly local: string;
}

export interface ClaimNode {
  readonly taskId?: string;
  readonly motebitId?: string;
  readonly status?: string;
  readonly result?: string;
  readonly resultPreview?: string;
  readonly resultTruncated: boolean;
  readonly submitted?: ClaimTime;
  readonly completed?: ClaimTime;
  readonly toolsUsed: readonly string[];
  readonly memoriesFormed?: number;
  readonly delegatedScope?: string;
  /** Count of entries in `delegation_receipts` (as carried, verified or not). */
  readonly delegationCount: number;
  /** This node's own verdict, straight from the verifier's `integrity`. */
  readonly verdict: "valid" | "invalid";
  readonly view?: ReceiptDocumentVerification;
  readonly delegations: readonly ClaimNode[];
}

export function claimTime(value: unknown): ClaimTime | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return { ms: value, iso: d.toISOString(), local: d.toLocaleString() };
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Map a parsed receipt object + its verification view to the plain-words claim. */
export function buildClaim(receipt: unknown, view?: ReceiptDocumentVerification): ClaimNode | null {
  if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) return null;
  const r = receipt as Record<string, unknown>;
  const result = str(r["result"]);
  const truncated = result !== undefined && result.length > RESULT_PREVIEW_CHARS;
  const rawKids = Array.isArray(r["delegation_receipts"])
    ? (r["delegation_receipts"] as unknown[])
    : [];
  const kidViews = view?.delegations ?? [];
  const delegations: ClaimNode[] = [];
  rawKids.forEach((kid, i) => {
    const node = buildClaim(kid, kidViews[i]);
    if (node) delegations.push(node);
  });
  const tools = Array.isArray(r["tools_used"])
    ? (r["tools_used"] as unknown[]).filter((t): t is string => typeof t === "string")
    : [];
  const memories = r["memories_formed"];
  const node: {
    -readonly [K in keyof ClaimNode]: ClaimNode[K];
  } = {
    resultTruncated: truncated,
    toolsUsed: tools,
    delegationCount: rawKids.length,
    verdict: view?.integrity === true ? "valid" : "invalid",
    delegations,
  };
  const set = <K extends keyof ClaimNode>(k: K, v: ClaimNode[K] | undefined): void => {
    if (v !== undefined) node[k] = v;
  };
  set("taskId", str(r["task_id"]));
  set("motebitId", str(r["motebit_id"]));
  set("status", str(r["status"]));
  set("result", result);
  set("resultPreview", truncated ? `${result.slice(0, RESULT_PREVIEW_CHARS)}…` : result);
  set("submitted", claimTime(r["submitted_at"]));
  set("completed", claimTime(r["completed_at"]));
  set("memoriesFormed", typeof memories === "number" ? memories : undefined);
  set("delegatedScope", str(r["delegated_scope"]));
  set("view", view);
  return node;
}
