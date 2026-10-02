/**
 * Dispute filing authority — spec/dispute-v1.md §4.1 / §4.3 / §4.4.
 *
 * "Filing party must be a direct party to the referenced task." The filing
 * route verified the DisputeRequest signature against `filed_by`'s OWN key —
 * which proves only that `filed_by` signed it, not that `filed_by` is a party.
 * Any registered agent could therefore file against any allocation: the
 * allocation flipped to `disputed` (so the worker's settlement can no longer
 * claim it), `filer_role` defaulted to `delegator`, and on a pre-settlement
 * dispute the escrow refund is credited to `filed_by` — the stranger.
 *
 * These tests drive the REAL route over the state a real x402-paid submission
 * leaves behind (`seedX402PaidTask`: delegator's `allocation_hold` debit +
 * the worker's locked allocation), and a real-shaped p2p settlement row.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import { generateKeypair, bytesToHex, signDisputeRequest } from "@motebit/encryption";
import { creditAccount, debitAccount } from "../accounts.js";
import { releaseStaleAllocations } from "../index.js";
import { AUTH_HEADER, createTestRelay, seedX402PaidTask } from "./test-helpers.js";

type Keypair = { publicKey: Uint8Array; privateKey: Uint8Array };

describe("Dispute filing authority (dispute-v1 §4.4)", () => {
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

  async function file(args: {
    allocationId: string;
    taskId: string;
    filedBy: string;
    respondent: string;
  }) {
    counter += 1;
    const signed = await signDisputeRequest(
      {
        dispute_id: `dsp-auth-${Date.now().toString(36)}-${counter}`,
        task_id: args.taskId,
        allocation_id: args.allocationId,
        filed_by: args.filedBy,
        respondent: args.respondent,
        category: "quality",
        description: "Work quality was inadequate",
        evidence_refs: ["receipt-123"],
        filed_at: Date.now(),
      },
      keys.get(args.filedBy)!.privateKey,
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

  function disputeCount(): number {
    return (
      relay.moteDb.db.prepare("SELECT COUNT(*) AS n FROM relay_disputes").get() as { n: number }
    ).n;
  }

  let taskId: string;
  let allocationId: string;

  beforeEach(async () => {
    keys.clear();
    relay = await createTestRelay({ enableDeviceAuth: false });
    await register("del-auth");
    await register("wrk-auth");
    await register("mallory");
    taskId = seedX402PaidTask(relay, {
      workerId: "wrk-auth",
      delegatorId: "del-auth",
      prompt: "search for something",
      unitCostUsd: 1.0,
    });
    allocationId = `x402-${taskId}`;
  });

  afterEach(async () => {
    await relay.close();
  });

  it("rejects a dispute filed by a registered non-party, leaving the allocation untouched", async () => {
    const res = await file({ allocationId, taskId, filedBy: "mallory", respondent: "wrk-auth" });
    expect(res.status).toBe(403);
    expect(allocationStatus(allocationId)).toBe("locked");
    expect(disputeCount()).toBe(0);
  });

  it("rejects a non-party even when it names the delegator as respondent", async () => {
    const res = await file({ allocationId, taskId, filedBy: "mallory", respondent: "del-auth" });
    expect(res.status).toBe(403);
    expect(allocationStatus(allocationId)).toBe("locked");
  });

  it("rejects a party whose respondent is not the other party (escrow-redirect vector)", async () => {
    // Pre-settlement fund action pays the worker share to `respondent` when
    // the delegator filed — so an unchecked respondent redirects escrow.
    const res = await file({ allocationId, taskId, filedBy: "del-auth", respondent: "mallory" });
    expect(res.status).toBe(403);
    expect(allocationStatus(allocationId)).toBe("locked");
  });

  it("rejects a task_id that does not match the allocation's task", async () => {
    const res = await file({
      allocationId,
      taskId: "some-other-task",
      filedBy: "del-auth",
      respondent: "wrk-auth",
    });
    expect(res.status).toBe(400);
    expect(allocationStatus(allocationId)).toBe("locked");
  });

  it("accepts the delegator, recording filer_role=delegator", async () => {
    const res = await file({ allocationId, taskId, filedBy: "del-auth", respondent: "wrk-auth" });
    expect(res.status).toBe(200);
    const { dispute_id } = (await res.json()) as { dispute_id: string };
    const row = relay.moteDb.db
      .prepare("SELECT filer_role FROM relay_disputes WHERE dispute_id = ?")
      .get(dispute_id) as { filer_role: string };
    expect(row.filer_role).toBe("delegator");
    expect(allocationStatus(allocationId)).toBe("disputed");
  });

  it("accepts the worker, recording filer_role=worker", async () => {
    const res = await file({ allocationId, taskId, filedBy: "wrk-auth", respondent: "del-auth" });
    expect(res.status).toBe(200);
    const { dispute_id } = (await res.json()) as { dispute_id: string };
    const row = relay.moteDb.db
      .prepare("SELECT filer_role FROM relay_disputes WHERE dispute_id = ?")
      .get(dispute_id) as { filer_role: string };
    expect(row.filer_role).toBe("worker");
  });

  // Each party guard is a distinct, live refusal — a mutation that drops any
  // one of them turns a 403 here into a 200 (or a different refusal).
  describe("party guards (each one live)", () => {
    it("rejects the worker naming a stranger as respondent", async () => {
      const res = await file({ allocationId, taskId, filedBy: "wrk-auth", respondent: "mallory" });
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("Respondent must be the other party");
      expect(allocationStatus(allocationId)).toBe("locked");
    });

    it("rejects a self-delegated task (no counterparty)", async () => {
      const selfTask = seedX402PaidTask(relay, {
        workerId: "wrk-auth",
        delegatorId: "wrk-auth",
        prompt: "self",
        unitCostUsd: 1.0,
      });
      const res = await file({
        allocationId: `x402-${selfTask}`,
        taskId: selfTask,
        filedBy: "wrk-auth",
        respondent: "wrk-auth",
      });
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("self-delegated");
      expect(allocationStatus(`x402-${selfTask}`)).toBe("locked");
    });

    it("fails closed when no ledger record names the delegator", async () => {
      // An allocation with neither a settlement row nor an allocation_hold
      // debit (the never-debited best-effort shape).
      relay.moteDb.db
        .prepare(
          `INSERT INTO relay_allocations (allocation_id, task_id, motebit_id, amount_locked, status, created_at)
           VALUES ('alloc-nohold', 'task-nohold', 'wrk-auth', 1000, 'locked', ?)`,
        )
        .run(Date.now());
      for (const respondent of ["del-auth", "mallory"]) {
        const res = await file({
          allocationId: "alloc-nohold",
          taskId: "task-nohold",
          filedBy: "wrk-auth",
          respondent,
        });
        expect(res.status).toBe(403);
        expect(await res.text()).toContain("cannot be established");
      }
      expect(allocationStatus("alloc-nohold")).toBe("locked");
    });

    it("fails closed when more than one payer held funds for the allocation", async () => {
      creditAccount(relay.moteDb.db, "mallory", 10, "deposit", "dep-m", "deposit");
      debitAccount(relay.moteDb.db, "mallory", 10, "allocation_hold", allocationId, "second hold");
      for (const filedBy of ["del-auth", "mallory"]) {
        const res = await file({ allocationId, taskId, filedBy, respondent: "wrk-auth" });
        expect(res.status).toBe(403);
        expect(await res.text()).toContain("cannot be established");
      }
      expect(allocationStatus(allocationId)).toBe("locked");
    });

    it("reads the delegator from the settlement row when one exists", async () => {
      // Settled allocation whose ledger carries no hold row: only the
      // settlement's delegator_id names the delegator. (Fee 0: a fee out of an
      // escrow that holds nothing is refused by the escrow guard trigger.)
      const db = relay.moteDb.db;
      db.prepare(
        `INSERT INTO relay_allocations (allocation_id, task_id, motebit_id, amount_locked, status, created_at)
         VALUES ('alloc-stl', 'task-stl', 'wrk-auth', 1000, 'settled', ?)`,
      ).run(Date.now());
      db.prepare(
        `INSERT INTO relay_settlements
         (settlement_id, allocation_id, task_id, motebit_id, receipt_hash, amount_settled,
          platform_fee, platform_fee_rate, status, settled_at, settlement_mode, delegator_id)
         VALUES ('stl-1', 'alloc-stl', 'task-stl', 'wrk-auth', '', 950, 0, 0.05, 'completed', ?, 'relay', 'del-auth')`,
      ).run(Date.now());
      const res = await file({
        allocationId: "alloc-stl",
        taskId: "task-stl",
        filedBy: "del-auth",
        respondent: "wrk-auth",
      });
      expect(res.status).toBe(200);
      expect(allocationStatus("alloc-stl")).toBe("disputed");
    });
  });

  // §7.1: only an allocation still holding its funds can be disputed, and an
  // allocation carries at most one non-expired dispute.
  describe("allocation state at filing", () => {
    it("rejects a dispute on a released (refunded) allocation", async () => {
      expect(releaseStaleAllocations(relay.moteDb.db, Date.now() + 1000, 0, () => "del-auth")).toBe(
        1,
      );
      const res = await file({ allocationId, taskId, filedBy: "del-auth", respondent: "wrk-auth" });
      expect(res.status).toBe(409);
      expect(allocationStatus(allocationId)).toBe("released");
      expect(disputeCount()).toBe(0);
    });

    it("rejects a second dispute on an allocation already under dispute, from either party", async () => {
      const first = await file({
        allocationId,
        taskId,
        filedBy: "del-auth",
        respondent: "wrk-auth",
      });
      expect(first.status).toBe(200);
      for (const [filedBy, respondent] of [
        ["del-auth", "wrk-auth"],
        ["wrk-auth", "del-auth"],
      ] as const) {
        const again = await file({ allocationId, taskId, filedBy, respondent });
        expect(again.status).toBe(409);
      }
      expect(disputeCount()).toBe(1);
    });

    it("the one-dispute-per-task index refuses a second live row even past the route", () => {
      const db = relay.moteDb.db;
      const insert = (id: string) =>
        db
          .prepare(
            `INSERT INTO relay_disputes
             (dispute_id, task_id, allocation_id, filed_by, respondent, category, description, state, filed_at, evidence_deadline)
             VALUES (?, ?, ?, 'del-auth', 'wrk-auth', 'quality', 'x', 'evidence', 0, 0)`,
          )
          .run(id, taskId, allocationId);
      insert("dsp-direct-1");
      expect(() => insert("dsp-direct-2")).toThrow(/UNIQUE/);
    });
  });

  describe("p2p trust-layer disputes", () => {
    beforeEach(() => {
      relay.moteDb.db
        .prepare(
          `INSERT INTO relay_settlements
           (settlement_id, allocation_id, task_id, motebit_id, receipt_hash,
            amount_settled, platform_fee, platform_fee_rate, status, settled_at,
            settlement_mode, p2p_tx_hash, payment_verification_status, delegator_id)
           VALUES ('stl-p2p-auth', 'p2p-task-auth', 'task-p2p-auth', 'wrk-auth', '',
                   0, 0, 0, 'completed', ?, 'p2p', 'fakeTxHash', 'pending', 'del-auth')`,
        )
        .run(Date.now());
    });

    it("rejects a non-party filing against a p2p settlement", async () => {
      const res = await file({
        allocationId: "p2p-task-auth",
        taskId: "task-p2p-auth",
        filedBy: "mallory",
        respondent: "wrk-auth",
      });
      expect(res.status).toBe(403);
      expect(disputeCount()).toBe(0);
    });

    it("accepts the p2p delegator", async () => {
      const res = await file({
        allocationId: "p2p-task-auth",
        taskId: "task-p2p-auth",
        filedBy: "del-auth",
        respondent: "wrk-auth",
      });
      expect(res.status).toBe(200);
    });
  });
});
