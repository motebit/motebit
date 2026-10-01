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
