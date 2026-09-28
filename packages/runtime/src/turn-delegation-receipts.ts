/**
 * Delegation receipts, collected PER TURN (#943).
 *
 * A worker's signed `ExecutionReceipt` for a hire carries the verbatim
 * `result` of what was asked. A `motebit_task`'s own signed receipt embeds
 * the receipts of the hires its turn made (`delegation_receipts`) — correct
 * provenance for the task's sub-work — and is sent to the submitter and the
 * relay. Before this, every hire stashed into ONE shared bucket that only
 * `handleAgentTask` drained, so the owner's hires (a `delegate_to_agent`
 * call in an owner turn, an `invokeCapability` tap, an owner MCP tool call
 * to another motebit) were embedded into the NEXT customer's task receipt:
 * the owner's private results, signed and sent to another principal.
 *
 * Now a receipt belongs to the turn that produced it:
 *  - `open()` starts a turn's collector (the runtime opens one whenever a
 *    turn takes the single-writer hold). Receipts already sitting in the
 *    MCP adapters were produced before this turn, so they go to the owner's
 *    record, never into this turn.
 *  - `record()` — an AI-loop hire during the turn — lands in THAT turn's
 *    collector. Outside any turn it is the owner's.
 *  - `recordOwnerAct()` — an owner act that is not part of any turn (a
 *    user tap) — always lands in the owner's record, even while another
 *    principal's turn is in flight.
 *  - `close()` hands the turn's receipts (plus what its MCP calls produced)
 *    to the turn's sink — `handleAgentTask` sets one to build its receipt —
 *    and to nobody else. An owner turn has no sink: its receipts go to the
 *    owner's record (they have also already reached their live consumers —
 *    the `delegation_complete` beat with the full receipt, trust bumps,
 *    the settlement ledger).
 *
 * The owner's record is a bounded, owner-only drain
 * (`getAndResetInteractiveDelegationReceipts`), never read by a task.
 */
import type { ExecutionReceipt } from "@motebit/sdk";

/** Oldest owner-record receipts are dropped past this (nothing drains it in production). */
const OWNER_RECORD_CAP = 256;

export interface TurnReceiptScope {
  /** Who receives this turn's receipts on close. Absent ⇒ nobody (an owner turn). */
  sink?: (receipts: ExecutionReceipt[]) => void;
}

export class TurnDelegationReceipts {
  private active: { key: symbol; scope: TurnReceiptScope; receipts: ExecutionReceipt[] } | null =
    null;
  private owner: ExecutionReceipt[] = [];

  constructor(private readonly drainMcpAdapters: () => ExecutionReceipt[] = () => []) {}

  /** Start a turn's collector. Returns its key and scope (set `sink` on the scope). */
  open(): { key: symbol; scope: TurnReceiptScope } {
    // Anything the adapters hold predates this turn — the owner's.
    this.pushOwner(this.drainMcpAdapters());
    if (this.active != null) this.pushOwner(this.active.receipts);
    const key = Symbol("turn");
    const scope: TurnReceiptScope = {};
    this.active = { key, scope, receipts: [] };
    return { key, scope };
  }

  /** Close the turn `key`: its receipts go to its sink, and only there. */
  close(key: symbol): ExecutionReceipt[] {
    if (this.active == null || this.active.key !== key) return [];
    const { scope, receipts } = this.active;
    this.active = null;
    const all = [...receipts, ...this.drainMcpAdapters()];
    // A turn with a sink (a task) hands its receipts to it; a turn without
    // one is the owner's, so they go to the owner's record.
    if (scope.sink != null) scope.sink(all);
    else this.pushOwner(all);
    return all;
  }

  /** A hire made by the in-flight turn (the AI loop's `delegate_to_agent`). */
  record(receipt: ExecutionReceipt): void {
    if (this.active != null) this.active.receipts.push(receipt);
    else this.pushOwner([receipt]);
  }

  /** An owner act outside any turn (a user tap). Never enters a turn's collector. */
  recordOwnerAct(receipt: ExecutionReceipt): void {
    this.pushOwner([receipt]);
  }

  /** Non-draining view of the in-flight turn's collector (the #493 beat). */
  count(): number {
    return this.active?.receipts.length ?? 0;
  }

  /** See {@link count} — the peek half of the pair. */
  peekSince(count: number): ExecutionReceipt[] {
    return this.active?.receipts.slice(count) ?? [];
  }

  /** Drain the owner's record (receipts produced outside any task's turn). */
  drainOwner(): ExecutionReceipt[] {
    const out = this.owner;
    this.owner = [];
    return out;
  }

  private pushOwner(receipts: ExecutionReceipt[]): void {
    if (receipts.length === 0) return;
    this.owner.push(...receipts);
    if (this.owner.length > OWNER_RECORD_CAP) {
      this.owner = this.owner.slice(this.owner.length - OWNER_RECORD_CAP);
    }
  }
}
