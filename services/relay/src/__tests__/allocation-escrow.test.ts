/**
 * allocation-escrow.ts — the one chokepoint every movement of allocation money
 * goes through, and the one reading of what an allocation holds.
 *
 * Each refusal is driven directly (the chokepoint refuses BEFORE writing), the
 * database guard triggers are driven by a raw write that bypasses the
 * chokepoint, the forward lifecycle and the fee journal are read back through
 * `allocationHeld`, and the upgrade backfill is run over legacy-shaped rows.
 * The exhaustive differential lives in dispute-conservation-harness.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SyncRelay } from "../index.js";
import { refundExhaustedForward, releaseStaleAllocations } from "../index.js";
import { createTestRelay, seedX402PaidTask } from "./test-helpers.js";
import { creditAccount, debitAccount, getAccountBalance } from "../accounts.js";
import {
  AllocationMoneyRefused,
  allocationHeld,
  allocationHeldRaw,
  allocationHoldPayer,
  backfillAllocationEscrow,
  forwardOf,
  markForwardDelivered,
  moveAllocationMoney,
  recordInboundFederatedSettlement,
  recordP2pSettlementAudit,
  type AllocationMove,
} from "../allocation-escrow.js";
import { forwardOriginSettlement } from "../federation-callbacks.js";
import { processSettlementRetries } from "../federation.js";
import type { RelayIdentity } from "../federation.js";
import { hexToBytes } from "@motebit/encryption";

let relay: SyncRelay;

afterEach(async () => {
  vi.unstubAllGlobals();
  await relay?.close();
});

function identity(r: SyncRelay): RelayIdentity {
  const row = r.moteDb.db
    .prepare(
      "SELECT relay_motebit_id, public_key, private_key_hex, did FROM relay_identity LIMIT 1",
    )
    .get() as {
    relay_motebit_id: string;
    public_key: string;
    private_key_hex: string;
    did: string;
  };
  return {
    relayMotebitId: row.relay_motebit_id,
    publicKey: hexToBytes(row.public_key),
    privateKey: hexToBytes(row.private_key_hex),
    publicKeyHex: row.public_key,
    did: row.did,
  };
}

async function funded(): Promise<{
  db: SyncRelay["moteDb"]["db"];
  a: string;
  t: string;
  locked: number;
}> {
  relay = await createTestRelay({ enableDeviceAuth: false });
  const t = seedX402PaidTask(relay, {
    workerId: "wrk-esc",
    delegatorId: "del-esc",
    prompt: "p",
    unitCostUsd: 1.0,
  });
  const a = `x402-${t}`;
  const db = relay.moteDb.db;
  return { db, a, t, locked: allocationHeld(db, a) };
}

/** The task's answer, claimed for `sig`, as the relay's archive holds it (the queue evicted). */
function claim(db: SyncRelay["moteDb"]["db"], t: string, sig = "sig-esc"): void {
  db.prepare("DELETE FROM relay_task_queue WHERE task_id = ?").run(t);
  db.prepare(
    `INSERT OR IGNORE INTO relay_task_answers
       (task_id, executor_id, status, receipt_json, settling, settled, answer_version, answered_at)
     VALUES (?, 'wrk-esc', 'completed', '{}', ?, 0, 1, ?)`,
  ).run(t, sig, Date.now());
}

/** A dispute row (a dispute credit names the dispute it pays). */
function dispute(db: SyncRelay["moteDb"]["db"], id: string, a: string, t: string): void {
  db.prepare(
    `INSERT INTO relay_disputes
     (dispute_id, task_id, allocation_id, filed_by, respondent, category, description, state,
      amount_locked, filing_fee, filed_at, evidence_deadline, body_json, filer_role)
     VALUES (?, ?, ?, 'del-esc', 'wrk-esc', 'quality', 'x', 'final', 1, 0, ?, ?, '', 'delegator')`,
  ).run(id, t, a, Date.now(), Date.now());
}

function refusal(db: SyncRelay["moteDb"]["db"], move: AllocationMove): string {
  try {
    moveAllocationMoney(db, move);
  } catch (err) {
    if (err instanceof AllocationMoneyRefused) return err.reason;
    throw err;
  }
  return "moved";
}

function txCount(db: SyncRelay["moteDb"]["db"]): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM relay_transactions").get() as { n: number }).n;
}

/**
 * A relay settlement row for allocation `a`. Its task is one the queue does
 * not know (#890 r9's claim guard governs a known task's rows; the escrow is
 * keyed on the allocation, never the task).
 */
function settlementRow(a: string, _t: string, id: string, fee: number, payee = "wrk-esc") {
  return {
    settlement_id: id,
    allocation_id: a,
    task_id: `unq-${id}`,
    motebit_id: payee,
    receipt_hash: "rh",
    amount_settled: 1000,
    platform_fee: fee,
    platform_fee_rate: 0.05,
    status: "completed",
    settled_at: Date.now(),
    settlement_mode: "relay",
    record_json: JSON.stringify({ motebit_id: payee }),
  };
}

describe("moveAllocationMoney refuses before it writes", () => {
  it("refuses invalid amounts, a missing allocation and an overdraw — writing nothing", async () => {
    const { db, a, locked } = await funded();
    const before = txCount(db);
    const base = { allocationId: a, party: "del-esc", description: "x" } as const;
    expect(refusal(db, { kind: "sweep_refund", ...base, amount: -1 })).toBe("invalid_amount");
    expect(refusal(db, { kind: "sweep_refund", ...base, amount: 1.5 })).toBe("invalid_amount");
    expect(refusal(db, { kind: "sweep_refund", ...base, allocationId: "nope", amount: 1 })).toBe(
      "no_allocation",
    );
    expect(refusal(db, { kind: "sweep_refund", ...base, amount: locked + 1 })).toBe("exceeds_held");
    expect(txCount(db)).toBe(before);
    expect(refusal(db, { kind: "sweep_refund", ...base, amount: 0 })).toBe("moved");
    expect(txCount(db)).toBe(before);
  });

  it("pays a refund only to the allocation's sole hold payer (P2: never the worker)", async () => {
    const { db, a, locked } = await funded();
    expect(allocationHoldPayer(db, a)).toBe("del-esc");
    for (const kind of ["sweep_refund", "retry_exhaustion_refund", "settlement_release"] as const) {
      expect(
        refusal(db, { kind, allocationId: a, amount: 1, party: "wrk-esc", description: "x" }),
      ).toBe("not_a_party");
    }
    expect(
      refusal(db, {
        kind: "dispute_delegator",
        allocationId: a,
        amount: 1,
        party: "wrk-esc",
        disputeId: "d",
        description: "x",
      }),
    ).toBe("not_a_party");
    // A second payer makes the refund unroutable.
    creditAccount(db, "co-payer", 10, "deposit", "dep", "d");
    debitAccount(db, "co-payer", 10, "allocation_hold", a, "co-fund");
    expect(
      refusal(db, {
        kind: "sweep_refund",
        allocationId: a,
        amount: 1,
        party: "del-esc",
        description: "x",
      }),
    ).toBe("unroutable");
    expect(allocationHeld(db, a)).toBe(locked + 10);
  });

  it("pays the worker leg only to the allocation's worker, and stamps every row", async () => {
    const { db, a, t } = await funded();
    dispute(db, "d1", a, t);
    const m = {
      kind: "dispute_worker",
      allocationId: a,
      amount: 5,
      disputeId: "d1",
      description: "x",
    } as const;
    expect(refusal(db, { ...m, party: "del-esc" })).toBe("not_a_party");
    expect(refusal(db, { ...m, party: "wrk-esc" })).toBe("moved");
    const row = db
      .prepare(
        "SELECT allocation_id, allocation_kind FROM relay_transactions WHERE reference_id = 'd1'",
      )
      .get() as { allocation_id: string; allocation_kind: string };
    expect(row).toEqual({ allocation_id: a, allocation_kind: "dispute_worker" });
  });

  it("settles: the fee is journaled and bounded, the credit goes to the SIGNED payee only", async () => {
    const { db, a, t, locked } = await funded();
    expect(
      refusal(db, {
        kind: "settlement_fee",
        allocationId: a,
        amount: 7,
        settlement: settlementRow(a, t, "s1", 8),
      }),
    ).toBe("invalid_amount");
    expect(
      refusal(db, {
        kind: "settlement_fee",
        allocationId: a,
        amount: 50,
        settlement: settlementRow("other", t, "s1", 50),
      }),
    ).toBe("not_a_party");
    expect(
      refusal(db, {
        kind: "settlement_fee",
        allocationId: a,
        amount: 50,
        settlement: { ...settlementRow(a, t, "s1", 50), settlement_mode: "p2p" },
      }),
    ).toBe("not_a_party");
    expect(
      refusal(db, {
        kind: "settlement_fee",
        allocationId: a,
        amount: 50,
        settlement: settlementRow(a, t, "s1", 50, "signer"),
      }),
    ).toBe("moved");
    expect(allocationHeld(db, a)).toBe(locked - 50);
    const credit = {
      kind: "settlement_credit",
      allocationId: a,
      amount: 1000,
      description: "x",
    } as const;
    expect(refusal(db, { ...credit, party: "wrk-esc", settlementId: "s1" })).toBe("not_a_party");
    expect(refusal(db, { ...credit, party: "signer", settlementId: "nope" })).toBe("not_a_party");
    expect(refusal(db, { ...credit, party: "signer", settlementId: "s1" })).toBe("moved");
    expect(allocationHeld(db, a)).toBe(locked - 1050);
    // Retention truncation of the settlement record changes no held: the fee
    // is journaled, the credit stamped.
    db.prepare("DELETE FROM relay_settlements WHERE settlement_id = 's1'").run();
    expect(allocationHeld(db, a)).toBe(locked - 1050);
  });

  it("records a free task's settlement (gross 0) without an allocation", async () => {
    const { db, t } = await funded();
    expect(
      refusal(db, {
        kind: "settlement_fee",
        allocationId: "free-x",
        amount: 0,
        settlement: settlementRow("free-x", t, "s0", 0),
      }),
    ).toBe("moved");
    expect(
      db.prepare("SELECT 1 FROM relay_settlements WHERE settlement_id = 's0'").get(),
    ).toBeDefined();
  });

  it("claws back only what this allocation paid the account, and refuses a short balance", async () => {
    const { db, a, t } = await funded();
    moveAllocationMoney(db, {
      kind: "settlement_fee",
      allocationId: a,
      amount: 0,
      settlement: settlementRow(a, t, "s2", 0),
    });
    moveAllocationMoney(db, {
      kind: "settlement_credit",
      allocationId: a,
      amount: 1000,
      party: "wrk-esc",
      settlementId: "s2",
      description: "x",
    });
    const claw = {
      kind: "dispute_clawback",
      allocationId: a,
      disputeId: "d2",
      description: "x",
    } as const;
    expect(refusal(db, { ...claw, amount: 1001, party: "wrk-esc" })).toBe("not_a_party");
    expect(refusal(db, { ...claw, amount: 1, party: "stranger" })).toBe("not_a_party");
    expect(refusal(db, { ...claw, amount: 0, party: "wrk-esc" })).toBe("moved");
    debitAccount(db, "wrk-esc", 900, "withdrawal", "wd", "withdrew");
    expect(refusal(db, { ...claw, amount: 500, party: "wrk-esc" })).toBe("insufficient_balance");
    expect(refusal(db, { ...claw, amount: 100, party: "wrk-esc" })).toBe("moved");
    // What remains claw-able is net of the claw-back already taken.
    creditAccount(db, "wrk-esc", 5000, "deposit", "dep2", "d");
    expect(refusal(db, { ...claw, amount: 901, party: "wrk-esc" })).toBe("not_a_party");
  });

  it("refuses dispute legs on an allocation under operator review", async () => {
    const { db, a } = await funded();
    db.prepare(
      "UPDATE relay_allocations SET review_reason = 'legacy_cross_allocation_dispute' WHERE allocation_id = ?",
    ).run(a);
    const m = { allocationId: a, amount: 1, disputeId: "d", description: "x" };
    expect(refusal(db, { kind: "dispute_worker", ...m, party: "wrk-esc" })).toBe("under_review");
    expect(refusal(db, { kind: "dispute_delegator", ...m, party: "del-esc" })).toBe("under_review");
    expect(refusal(db, { kind: "dispute_clawback", ...m, party: "wrk-esc" })).toBe("under_review");
    // Non-dispute movements still follow held.
    expect(
      refusal(db, {
        kind: "sweep_refund",
        allocationId: a,
        amount: 1,
        party: "del-esc",
        description: "x",
      }),
    ).toBe("moved");
  });

  it("refuses a hold the payer cannot fund", async () => {
    const { db, a } = await funded();
    expect(
      refusal(db, {
        kind: "hold",
        allocationId: a,
        amount: 10_000_000,
        party: "broke",
        description: "x",
      }),
    ).toBe("insufficient_balance");
    expect(
      refusal(db, { kind: "hold", allocationId: a, amount: 0, party: "broke", description: "x" }),
    ).toBe("moved");
  });
});

describe("forward lifecycle", () => {
  function forward(
    a: string,
    t: string,
    id: string,
    gross: number,
    downstream: string | null = "peer",
  ) {
    return {
      kind: "federated_forward" as const,
      allocationId: a,
      amount: gross,
      forward: {
        settlement_id: id,
        task_id: t,
        upstream_relay_id: "self",
        downstream_relay_id: downstream,
        agent_id: null,
        gross_amount: gross,
        fee_amount: 0,
        net_amount: gross,
        fee_rate: 0,
        settled_at: Date.now(),
        receipt_hash: "rh",
        receipt_signature: "sig-esc",
      },
    };
  }

  it("pending and delivered count as moved; failed returns to escrow; only a pending forward can fail", async () => {
    const { db, a, t, locked } = await funded();
    claim(db, t);
    expect(refusal(db, forward(a, t, "f0", locked + 1))).toBe("exceeds_held");
    expect(refusal(db, { ...forward(a, t, "f0", 10), amount: 11 })).toBe("invalid_amount");
    expect(refusal(db, forward(a, t, "f0", 10, null))).toBe("not_a_party");
    expect(refusal(db, forward(a, t, "f1", locked))).toBe("moved");
    expect(forwardOf(db, "f1")?.status).toBe("pending");
    expect(allocationHeld(db, a)).toBe(0);
    expect(
      refusal(db, {
        kind: "forward_return",
        allocationId: a,
        amount: locked - 1,
        settlementId: "f1",
      }),
    ).toBe("invalid_amount");
    expect(
      refusal(db, { kind: "forward_return", allocationId: a, amount: locked, settlementId: "f1" }),
    ).toBe("moved");
    expect(forwardOf(db, "f1")?.status).toBe("failed");
    expect(allocationHeld(db, a)).toBe(locked);
    expect(
      refusal(db, { kind: "forward_return", allocationId: a, amount: locked, settlementId: "f1" }),
    ).toBe("forward_not_pending");
    markForwardDelivered(db, "f1"); // failed stays failed
    expect(forwardOf(db, "f1")?.status).toBe("failed");
  });

  it("forwardOriginSettlement: delivered on ack, queued (pending) on failure, refused without escrow", async () => {
    const { db, a, t, locked } = await funded();
    db.prepare(
      `INSERT INTO relay_peers (peer_relay_id, public_key, endpoint_url, state) VALUES ('peer-x', 'aa', 'http://peer-x.test', 'active')`,
    ).run();
    let ack = false;
    vi.stubGlobal("fetch", async () => {
      if (!ack) throw new Error("down");
      return new Response("{}", { status: 200 });
    });
    claim(db, t);
    const args = {
      taskId: t,
      receiptSignature: "sig-esc",
      peerRelayId: "peer-x",
      grossAmount: locked,
      platformFeeRate: 0.05,
      receiptHash: "rh",
      x402TxHash: null,
      x402Network: null,
    };
    expect(
      await forwardOriginSettlement(db, identity(relay), { ...args, taskId: "no-escrow" }),
    ).toBe("refused");
    expect(
      await forwardOriginSettlement(db, identity(relay), { ...args, grossAmount: locked + 1 }),
    ).toBe("refused");
    expect(await forwardOriginSettlement(db, identity(relay), args)).toBe("queued");
    const fwd = db
      .prepare(
        "SELECT settlement_id, status, allocation_id FROM relay_federation_settlements WHERE task_id = ?",
      )
      .get(t) as { settlement_id: string; status: string; allocation_id: string };
    expect(fwd.status).toBe("pending");
    expect(fwd.allocation_id).toBe(a);
    // The retry loop delivers it: pending → delivered, the retry completed.
    ack = true;
    db.prepare("UPDATE relay_settlement_retries SET next_retry_at = 0").run();
    await processSettlementRetries(db, identity(relay));
    expect(forwardOf(db, fwd.settlement_id)?.status).toBe("delivered");
    expect(allocationHeld(db, a)).toBe(0);
  });

  it("an immediate ack marks the forward delivered", async () => {
    const { db, t, locked } = await funded();
    db.prepare(
      `INSERT INTO relay_peers (peer_relay_id, public_key, endpoint_url, state) VALUES ('peer-y', 'aa', 'http://peer-y.test', 'active')`,
    ).run();
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
    claim(db, t);
    const r = await forwardOriginSettlement(db, identity(relay), {
      taskId: t,
      receiptSignature: "sig-esc",
      peerRelayId: "peer-y",
      grossAmount: locked,
      platformFeeRate: 0.05,
      receiptHash: "rh",
      x402TxHash: null,
      x402Network: null,
    });
    expect(r).toBe("delivered");
  });

  it("exhaustion (or a vanished peer) fails the forward and refunds the HOLD PAYER in one transaction (C1/P2)", async () => {
    const { db, a, t, locked } = await funded();
    vi.stubGlobal("fetch", async () => {
      throw new Error("down");
    });
    // The task queue lost the entry (P2): the payee still comes from the ledger.
    claim(db, t);
    // No peer row: the forward is queued and the retry loop finds the peer gone.
    expect(
      await forwardOriginSettlement(db, identity(relay), {
        taskId: t,
        receiptSignature: "sig-esc",
        peerRelayId: "gone",
        grossAmount: locked,
        platformFeeRate: 0.05,
        receiptHash: "rh",
        x402TxHash: null,
        x402Network: null,
      }),
    ).toBe("queued");
    db.prepare("UPDATE relay_settlement_retries SET next_retry_at = 0").run();
    await processSettlementRetries(db, identity(relay), (retry) => {
      refundExhaustedForward(db, retry);
    });
    expect(getAccountBalance(db, "del-esc")?.balance).toBe(locked);
    expect(getAccountBalance(db, "wrk-esc")?.balance ?? 0).toBe(0);
    const alloc = db
      .prepare("SELECT status FROM relay_allocations WHERE allocation_id = ?")
      .get(a) as {
      status: string;
    };
    expect(alloc.status).toBe("released");
    expect(allocationHeld(db, a)).toBe(0);
  });

  it("refundExhaustedForward: no allocation, disputed escrow, and an unroutable payer", async () => {
    const { db, a, t, locked } = await funded();
    expect(refundExhaustedForward(db, { retry_id: "r", settlement_id: "x", task_id: "none" })).toBe(
      "skipped",
    );
    claim(db, t);
    moveAllocationMoney(db, {
      kind: "federated_forward",
      allocationId: a,
      amount: locked,
      forward: {
        settlement_id: "fx",
        task_id: t,
        upstream_relay_id: "self",
        downstream_relay_id: "peer",
        agent_id: null,
        gross_amount: locked,
        fee_amount: 0,
        net_amount: locked,
        fee_rate: 0,
        settled_at: Date.now(),
        receipt_hash: "rh",
        receipt_signature: "sig-esc",
      },
    });
    db.prepare("UPDATE relay_allocations SET status = 'disputed' WHERE allocation_id = ?").run(a);
    // Under dispute: the forward returns to escrow, the dispute distributes it.
    expect(refundExhaustedForward(db, { retry_id: "r", settlement_id: "fx", task_id: t })).toBe(
      "returned",
    );
    expect(allocationHeld(db, a)).toBe(locked);
    expect(getAccountBalance(db, "del-esc")?.balance ?? 0).toBe(0);
    // Two hold payers: nothing routable — flagged, not paid, not retired.
    db.prepare("UPDATE relay_allocations SET status = 'locked' WHERE allocation_id = ?").run(a);
    creditAccount(db, "co", 10, "deposit", "dep", "d");
    debitAccount(db, "co", 10, "allocation_hold", a, "co-fund");
    expect(refundExhaustedForward(db, { retry_id: "r", settlement_id: "fx", task_id: t })).toBe(
      "skipped",
    );
    const row = db
      .prepare("SELECT status, review_reason FROM relay_allocations WHERE allocation_id = ?")
      .get(a) as {
      status: string;
      review_reason: string;
    };
    expect(row).toEqual({ status: "locked", review_reason: "unroutable_refund" });
  });
});

describe("the stale sweep", () => {
  it("never retires an allocation holding money it cannot route — it flags it", async () => {
    const { db, a } = await funded();
    creditAccount(db, "co", 10, "deposit", "dep", "d");
    debitAccount(db, "co", 10, "allocation_hold", a, "co-fund");
    expect(releaseStaleAllocations(db, Date.now() + 1000, 0, () => "del-esc")).toBe(0);
    const row = db
      .prepare("SELECT status, review_reason FROM relay_allocations WHERE allocation_id = ?")
      .get(a) as {
      status: string;
      review_reason: string;
    };
    expect(row).toEqual({ status: "locked", review_reason: "unroutable_refund" });
  });
});

describe("the database guard", () => {
  it("aborts a raw stamped credit, fee or forward that would overdraw the allocation", async () => {
    const { db, a, locked } = await funded();
    const raw = (sql: string, ...args: unknown[]): string => {
      try {
        db.prepare(sql).run(...(args as never[]));
        return "written";
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    };
    expect(
      raw(
        `INSERT INTO relay_transactions (transaction_id, motebit_id, type, amount, balance_after, reference_id, description, created_at, allocation_id, allocation_kind)
         VALUES ('t1', 'x', 'allocation_release', ?, 0, ?, 'raw', 0, ?, 'sweep_refund')`,
        locked + 1,
        a,
        a,
      ),
    ).toMatch(/allocation escrow overdrawn/);
    expect(
      raw(
        `INSERT INTO relay_settlements (settlement_id, allocation_id, task_id, motebit_id, receipt_hash, amount_settled, platform_fee, platform_fee_rate, status, settled_at, settlement_mode)
         VALUES ('s9', ?, 'unq-s9', 'w', '', 0, ?, 0.05, 'completed', 0, 'relay')`,
        a,
        locked + 1,
      ),
    ).toMatch(/allocation escrow overdrawn/);
    expect(
      raw(
        `INSERT INTO relay_federation_settlements (settlement_id, task_id, upstream_relay_id, downstream_relay_id, gross_amount, fee_amount, net_amount, fee_rate, settled_at, receipt_hash, allocation_id, status)
         VALUES ('f9', 'unq-f9', 'u', 'd', ?, 0, 0, 0, 0, '', ?, 'pending')`,
        locked + 1,
        a,
      ),
    ).toMatch(/allocation escrow overdrawn/);
    expect(allocationHeldRaw(db, a)).toBe(locked);
  });
});

describe("non-allocation writers of the same tables", () => {
  it("records a P2P audit row only in p2p mode, with an allowlisted column set", async () => {
    const { db, a, t } = await funded();
    expect(() => recordP2pSettlementAudit(db, settlementRow(a, t, "p1", 0))).toThrow(
      /p2p rows only/,
    );
    const row = { ...settlementRow(`p2p-${t}`, t, "p1", 5), settlement_mode: "p2p" };
    expect(recordP2pSettlementAudit(db, row)).toBe(1);
    expect(() =>
      recordP2pSettlementAudit(db, { ...row, settlement_id: "p2", task_id: "unq-p2", bogus: 1 }),
    ).toThrow(/not allowed/);
  });

  it("records an inbound federated settlement once, and never for a task holding local escrow", async () => {
    const { db, t } = await funded();
    const row = {
      settlement_id: "in1",
      task_id: "remote-task",
      upstream_relay_id: "origin",
      downstream_relay_id: null,
      agent_id: "wrk-in",
      gross_amount: 100,
      fee_amount: 5,
      net_amount: 95,
      fee_rate: 0.05,
      settled_at: Date.now(),
      receipt_hash: "rh",
    };
    const credit = { worker: "wrk-in", amount: 95, description: "x" };
    expect(recordInboundFederatedSettlement(db, row, credit)).toBe(true);
    expect(recordInboundFederatedSettlement(db, row, credit)).toBe(false);
    expect(getAccountBalance(db, "wrk-in")?.balance).toBe(95);
    expect(() =>
      recordInboundFederatedSettlement(db, { ...row, downstream_relay_id: "x" }, credit),
    ).toThrow(/no downstream/);
    expect(() =>
      recordInboundFederatedSettlement(db, { ...row, settlement_id: "in2", task_id: t }, credit),
    ).toThrow(/holds local escrow/);
  });
});

describe("upgrade backfill", () => {
  it("derives forward status from retries, journals fees, stamps credits, flags a failed-forward strand", async () => {
    const { db, a, t, locked } = await funded();
    // A pre-lifecycle forward (status defaults 'delivered') whose retry failed.
    claim(db, t);
    db.prepare(
      `INSERT INTO relay_federation_settlements (settlement_id, task_id, upstream_relay_id, downstream_relay_id, gross_amount, fee_amount, net_amount, fee_rate, settled_at, receipt_hash, receipt_signature)
       VALUES ('legacy-f', ?, 'self', 'peer', ?, 0, ?, 0, 0, '', 'sig-esc')`,
    ).run(t, locked, locked);
    db.prepare(
      `INSERT INTO relay_settlement_retries (retry_id, settlement_id, task_id, peer_relay_id, payload_json, attempts, max_attempts, next_retry_at, status, created_at)
       VALUES ('rr', 'legacy-f', ?, 'peer', '{}', 8, 8, 0, 'failed', 0)`,
    ).run(t);
    // The pre-fix exhaustion read 0 and retired the allocation.
    db.prepare("UPDATE relay_allocations SET status = 'released' WHERE allocation_id = ?").run(a);
    // A pre-journal settlement + credit on another allocation.
    const t2 = seedX402PaidTask(relay, {
      workerId: "w2",
      delegatorId: "d2",
      prompt: "p",
      unitCostUsd: 1,
    });
    const a2 = `x402-${t2}`;
    db.prepare(
      `INSERT INTO relay_settlements (settlement_id, allocation_id, task_id, motebit_id, receipt_hash, amount_settled, platform_fee, platform_fee_rate, status, settled_at, settlement_mode)
       VALUES ('legacy-s', ?, 'unq-legacy-s', 'w2', '', 900, 50, 0.05, 'completed', 0, 'relay')`,
    ).run(a2);
    creditAccount(db, "w2", 900, "settlement_credit", "legacy-s", "legacy");

    const res = backfillAllocationEscrow(db);
    expect(res.forwards).toBe(1);
    expect(forwardOf(db, "legacy-f")).toMatchObject({ status: "failed", allocation_id: a });
    expect(allocationHeld(db, a)).toBe(locked);
    expect(
      (
        db
          .prepare("SELECT review_reason FROM relay_allocations WHERE allocation_id = ?")
          .get(a) as {
          review_reason: string;
        }
      ).review_reason,
    ).toBe("failed_forward_unrefunded");
    const heldBefore = allocationHeld(db, a2);
    db.prepare("DELETE FROM relay_settlements WHERE settlement_id = 'legacy-s'").run();
    expect(allocationHeld(db, a2)).toBe(heldBefore);
    // Idempotent.
    expect(backfillAllocationEscrow(db).flagged).toBe(0);
  });
});
