/**
 * Dispute filing clock — spec/dispute-v1.md §4.3 / §4.4 / §4.5 (#1153).
 *
 * The filing route anchored the dispute's evidence deadline on the filer's
 * own signed `filed_at`, which nothing bounded: a filing dated ten years
 * ahead put the deadline (and so the lock on the counterparty's escrow or
 * §7.5 hold) ten years out. It also admitted a dispute of a settlement filed
 * after the 24 h dispute window, re-locking funds the worker could already
 * withdraw. The relay now owns the clock: `filed_at` must sit within
 * `FILED_AT_SKEW_MS` of its receive time, every deadline is anchored on that
 * receive time, and a settlement is disputable only inside the window.
 *
 * Every refusal is asserted to change nothing: no dispute row, the
 * allocation in the state it was in.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import { generateKeypair, bytesToHex, signDisputeRequest } from "@motebit/encryption";
import { DISPUTE_WINDOW_MS } from "@motebit/virtual-accounts";
import { FILED_AT_SKEW_MS } from "../disputes.js";
import { AUTH_HEADER, createTestRelay, seedX402PaidTask } from "./test-helpers.js";

type Keypair = { publicKey: Uint8Array; privateKey: Uint8Array };

const HOUR = 3600_000;
const EVIDENCE_WINDOW_MS = 48 * HOUR;

describe("Dispute filing clock (dispute-v1 §4.4/§4.5, #1153)", () => {
  let relay: SyncRelay;
  const keys = new Map<string, Keypair>();
  let counter = 0;

  async function register(motebitId: string): Promise<void> {
    const kp = await generateKeypair();
    keys.set(motebitId, kp);
    const res = await relay.app.request(`/api/v1/agents/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        motebit_id: motebitId,
        endpoint_url: "http://localhost:9999/mcp",
        capabilities: ["web_search"],
        public_key: bytesToHex(kp.publicKey),
      }),
    });
    expect(res.status).toBe(200);
  }

  async function file(args: { allocationId: string; taskId: string; filedAt: number }) {
    counter += 1;
    const signed = await signDisputeRequest(
      {
        dispute_id: `dsp-clock-${Date.now().toString(36)}-${counter}`,
        task_id: args.taskId,
        allocation_id: args.allocationId,
        filed_by: "del-clk",
        respondent: "wrk-clk",
        category: "quality",
        description: "Work quality was inadequate",
        evidence_refs: ["receipt-123"],
        filed_at: args.filedAt,
      },
      keys.get("del-clk")!.privateKey,
    );
    return relay.app.request(`/api/v1/allocations/${args.allocationId}/dispute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(signed),
    });
  }

  function allocationStatus(allocationId: string): string {
    return (
      relay.moteDb.db
        .prepare("SELECT status FROM relay_allocations WHERE allocation_id = ?")
        .get(allocationId) as { status: string }
    ).status;
  }

  function disputeRows(): Array<{ filed_at: number; evidence_deadline: number }> {
    return relay.moteDb.db
      .prepare("SELECT filed_at, evidence_deadline FROM relay_disputes")
      .all() as Array<{ filed_at: number; evidence_deadline: number }>;
  }

  /** A settled relay-custody allocation whose settlement landed `ageMs` ago. */
  function seedSettled(ageMs: number): { allocationId: string; taskId: string } {
    const db = relay.moteDb.db;
    counter += 1;
    const allocationId = `alloc-clk-${counter}`;
    const taskId = `task-clk-${counter}`;
    db.prepare(
      `INSERT INTO relay_allocations (allocation_id, task_id, motebit_id, amount_locked, status, created_at)
       VALUES (?, ?, 'wrk-clk', 1000, 'settled', ?)`,
    ).run(allocationId, taskId, Date.now() - ageMs);
    db.prepare(
      `INSERT INTO relay_settlements
       (settlement_id, allocation_id, task_id, motebit_id, receipt_hash, amount_settled,
        platform_fee, platform_fee_rate, status, settled_at, settlement_mode, delegator_id)
       VALUES (?, ?, ?, 'wrk-clk', '', 950, 0, 0.05, 'completed', ?, 'relay', 'del-clk')`,
    ).run(`stl-clk-${counter}`, allocationId, taskId, Date.now() - ageMs);
    return { allocationId, taskId };
  }

  /** A p2p settlement (trust-layer dispute; no allocation) `ageMs` old. */
  function seedP2p(ageMs: number): { allocationId: string; taskId: string } {
    counter += 1;
    const taskId = `task-p2p-clk-${counter}`;
    relay.moteDb.db
      .prepare(
        `INSERT INTO relay_settlements
         (settlement_id, allocation_id, task_id, motebit_id, receipt_hash,
          amount_settled, platform_fee, platform_fee_rate, status, settled_at,
          settlement_mode, p2p_tx_hash, payment_verification_status, delegator_id)
         VALUES (?, ?, ?, 'wrk-clk', '', 0, 0, 0, 'completed', ?, 'p2p', 'fakeTxHash', 'pending', 'del-clk')`,
      )
      .run(`stl-p2p-clk-${counter}`, `p2p-${taskId}`, taskId, Date.now() - ageMs);
    return { allocationId: `p2p-${taskId}`, taskId };
  }

  let lockedTask: string;
  let lockedAlloc: string;

  beforeEach(async () => {
    keys.clear();
    relay = await createTestRelay({ enableDeviceAuth: false });
    await register("del-clk");
    await register("wrk-clk");
    lockedTask = seedX402PaidTask(relay, {
      workerId: "wrk-clk",
      delegatorId: "del-clk",
      prompt: "search for something",
      unitCostUsd: 1.0,
    });
    lockedAlloc = `x402-${lockedTask}`;
  });

  afterEach(async () => {
    await relay.close();
  });

  describe("filed_at is a claim, never the clock", () => {
    it("refuses a filing dated ten years ahead and writes nothing", async () => {
      const res = await file({
        allocationId: lockedAlloc,
        taskId: lockedTask,
        filedAt: Date.now() + 10 * 365 * 24 * HOUR,
      });
      expect(res.status).toBe(400);
      expect(disputeRows()).toHaveLength(0);
      expect(allocationStatus(lockedAlloc)).toBe("locked");
    });

    it("refuses a filing back-dated past the skew", async () => {
      const res = await file({
        allocationId: lockedAlloc,
        taskId: lockedTask,
        filedAt: Date.now() - FILED_AT_SKEW_MS - 60_000,
      });
      expect(res.status).toBe(400);
      expect(disputeRows()).toHaveLength(0);
      expect(allocationStatus(lockedAlloc)).toBe("locked");
    });

    it("anchors the evidence deadline on the relay's receive time, not filed_at", async () => {
      // Inside the skew, but back-dated: the deadline must still be a full
      // window from when the relay received it, and the signed claim is kept.
      const filedAt = Date.now() - FILED_AT_SKEW_MS + 60_000;
      const before = Date.now();
      const res = await file({ allocationId: lockedAlloc, taskId: lockedTask, filedAt });
      const after = Date.now();
      expect(res.status).toBe(200);
      const [row] = disputeRows();
      expect(row!.filed_at).toBe(filedAt);
      expect(row!.evidence_deadline).toBeGreaterThanOrEqual(before + EVIDENCE_WINDOW_MS);
      expect(row!.evidence_deadline).toBeLessThanOrEqual(after + EVIDENCE_WINDOW_MS);
    });
  });

  describe("a settlement is disputable only inside the dispute window (§4.5)", () => {
    it("refuses a relay-custody settlement past the window and leaves it settled", async () => {
      const { allocationId, taskId } = seedSettled(DISPUTE_WINDOW_MS + HOUR);
      const res = await file({ allocationId, taskId, filedAt: Date.now() });
      expect(res.status).toBe(409);
      expect(disputeRows()).toHaveLength(0);
      expect(allocationStatus(allocationId)).toBe("settled");
    });

    it("accepts a relay-custody settlement inside the window", async () => {
      const { allocationId, taskId } = seedSettled(DISPUTE_WINDOW_MS - HOUR);
      const res = await file({ allocationId, taskId, filedAt: Date.now() });
      expect(res.status).toBe(200);
      expect(allocationStatus(allocationId)).toBe("disputed");
    });

    it("refuses a p2p settlement past the window", async () => {
      const { allocationId, taskId } = seedP2p(DISPUTE_WINDOW_MS + HOUR);
      const res = await file({ allocationId, taskId, filedAt: Date.now() });
      expect(res.status).toBe(409);
      expect(disputeRows()).toHaveLength(0);
    });

    it("accepts a p2p settlement inside the window", async () => {
      const { allocationId, taskId } = seedP2p(DISPUTE_WINDOW_MS - HOUR);
      const res = await file({ allocationId, taskId, filedAt: Date.now() });
      expect(res.status).toBe(200);
    });
  });
});
