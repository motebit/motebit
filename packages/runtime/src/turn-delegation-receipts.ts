/**
 * Delegation receipts, attributed AT CAPTURE to the context that made the
 * call (#943).
 *
 * A worker's signed `ExecutionReceipt` for a hire carries the verbatim
 * `result` of what was asked. A `motebit_task`'s own signed receipt embeds
 * the receipts of the hires its turn made (`delegation_receipts`) — correct
 * provenance for the task's sub-work — and is sent to the submitter and the
 * relay. Before this, every hire stashed into shared buckets (the
 * interactive-delegation stash, each MCP adapter's array) that only
 * `handleAgentTask` drained, so the owner's hires were signed into the NEXT
 * customer's task receipt. A later attempt drained the MCP buckets at turn
 * close, which still swept in an owner's concurrent out-of-turn call (an
 * `invokeLocalTool` tap, a PlanEngine step) made while a task held the turn.
 *
 * Now there is no bucket. A tool that produced a hire returns the receipt ON
 * ITS RESULT (`delegation_receipt`); the runtime's tool registry takes it off
 * the result and records it for the DESTINATION the caller threaded into
 * that very call:
 *  - a turn's key — the runtime's per-turn loop deps (`loopDepsForTurn`)
 *    pass the in-flight turn's key into every execute they make;
 *  - `OWNER_ACT` — the default for every other caller: out-of-turn owner
 *    doors (`invokeLocalTool`, PlanEngine steps, the approval queue, taps,
 *    attached frontends, the MCP serve path).
 * A turn's receipts (with their `trustCredited` flag) go, at close, to the turn's sink (`handleAgentTask` sets
 * one to build its receipt) or, for an owner turn, to the owner's record.
 * The owner's record has a consumer: `onOwnerIntake` — the runtime credits
 * trust for each receipt, computes chain trust (`ChainTrustComputed`),
 * adds the graph edges and records latency, attributed to the owner.
 */
import type { ExecutionReceipt, ToolResult } from "@motebit/sdk";

/** The destination for receipts from an owner act outside any turn. */
export const OWNER_ACT: unique symbol = Symbol("owner-act");
/** Where a call's delegation receipt belongs: a turn's key, or the owner. */
export type ReceiptDestination = symbol;

/**
 * A tool result that carries the delegation receipt of the hire it made
 * (`@motebit/mcp-client` sets it on a verified `motebit_task` call; the
 * `delegate_to_agent` tool sets it with `delegation_receipt_trust_credited`
 * because it already credited trust at production).
 */
export type ReceiptCarryingResult = ToolResult & {
  delegation_receipt?: ExecutionReceipt;
  delegation_receipt_trust_credited?: boolean;
};

/** Take the carried receipt off a result (the field is removed). */
export function takeCarriedReceipt(
  result: ToolResult,
): { receipt: ExecutionReceipt; trustCredited: boolean } | null {
  const r = result as ReceiptCarryingResult;
  const receipt = r.delegation_receipt;
  const trustCredited = r.delegation_receipt_trust_credited === true;
  delete r.delegation_receipt;
  delete r.delegation_receipt_trust_credited;
  return receipt != null ? { receipt, trustCredited } : null;
}

/** One receipt headed for the owner's record. */
export interface OwnerReceipt {
  receipt: ExecutionReceipt;
  /** Trust was already credited at production (don't bump twice). */
  trustCredited: boolean;
}

/** Oldest owner-record receipts are dropped past this. */
const OWNER_RECORD_CAP = 256;

export interface TurnReceiptScope {
  /** Who receives this turn's receipts on close. Absent ⇒ the owner's record. */
  sink?: (receipts: OwnerReceipt[]) => void;
}

export class TurnDelegationReceipts {
  private active: {
    key: symbol;
    scope: TurnReceiptScope;
    entries: OwnerReceipt[];
  } | null = null;
  private owner: ExecutionReceipt[] = [];

  /**
   * @param onOwnerIntake the owner record's consumer (trust credit, chain
   *   trust, graph edges, latency). Called for every receipt that lands in
   *   the owner's record.
   */
  constructor(private readonly onOwnerIntake: (entries: OwnerReceipt[]) => void = () => {}) {}

  /** Start a turn's collector. Returns its key (the call destination) and scope. */
  open(): { key: symbol; scope: TurnReceiptScope } {
    if (this.active != null) this.toOwner(this.active.entries);
    const key = Symbol("turn");
    const scope: TurnReceiptScope = {};
    this.active = { key, scope, entries: [] };
    return { key, scope };
  }

  /** Close the turn `key`: its receipts go to its sink, or to the owner's record. */
  close(key: symbol): ExecutionReceipt[] {
    if (this.active == null || this.active.key !== key) return [];
    const { scope, entries } = this.active;
    this.active = null;
    // The sink gets `{ receipt, trustCredited }` (#943 round 5): a hire
    // already credited where it was made must not be credited again.
    if (scope.sink != null) scope.sink(entries);
    else this.toOwner(entries);
    return entries.map((e) => e.receipt);
  }

  /**
   * Record a receipt for the destination the CALLER named. A turn key lands
   * in that turn only while it is the open turn; `OWNER_ACT`, or a turn that
   * has already closed, lands in the owner's record. Never "whatever turn
   * happens to be open".
   */
  recordFor(
    destination: ReceiptDestination,
    receipt: ExecutionReceipt,
    trustCredited = false,
  ): void {
    if (destination !== OWNER_ACT && this.active != null && this.active.key === destination) {
      this.active.entries.push({ receipt, trustCredited });
      return;
    }
    this.toOwner([{ receipt, trustCredited }]);
  }

  /** An owner act outside any turn (a user tap, credited at production). */
  recordOwnerAct(receipt: ExecutionReceipt, trustCredited = true): void {
    this.toOwner([{ receipt, trustCredited }]);
  }

  /** The in-flight turn's key, for a caller running AS that turn (the approval resume). */
  activeKey(): symbol | null {
    return this.active?.key ?? null;
  }

  /** Non-draining view of the in-flight turn's collector (the #493 beat). */
  count(): number {
    return this.active?.entries.length ?? 0;
  }

  /** See {@link count} — the peek half of the pair. */
  peekSince(count: number): ExecutionReceipt[] {
    return this.active?.entries.slice(count).map((e) => e.receipt) ?? [];
  }

  /** Drain the owner's record (an owner-only read; never a task's). */
  drainOwner(): ExecutionReceipt[] {
    const out = this.owner;
    this.owner = [];
    return out;
  }

  private toOwner(entries: OwnerReceipt[]): void {
    if (entries.length === 0) return;
    this.owner.push(...entries.map((e) => e.receipt));
    if (this.owner.length > OWNER_RECORD_CAP) {
      this.owner = this.owner.slice(this.owner.length - OWNER_RECORD_CAP);
    }
    this.onOwnerIntake(entries);
  }
}
