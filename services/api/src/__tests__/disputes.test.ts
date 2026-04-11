/**
 * Dispute endpoint tests — motebit/dispute@1.0.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import { AUTH_HEADER, createTestRelay } from "./test-helpers.js";

// === Helpers ===

async function registerAgent(relay: SyncRelay, motebitId: string, publicKeyHex: string) {
  await relay.app.request(`/api/v1/agents/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({
      motebit_id: motebitId,
      endpoint_url: "http://localhost:9999/mcp",
      capabilities: ["web_search"],
      public_key: publicKeyHex,
    }),
  });
}

function createAllocation(
  relay: SyncRelay,
  allocationId: string,
  taskId: string,
  motebitId: string,
) {
  relay.moteDb.db
    .prepare(
      "INSERT OR IGNORE INTO relay_allocations (allocation_id, task_id, motebit_id, amount_locked, status, created_at) VALUES (?, ?, ?, ?, 'settled', ?)",
    )
    .run(allocationId, taskId, motebitId, 100000, Date.now());
}

async function openDispute(
  relay: SyncRelay,
  allocationId: string,
  filedBy: string,
  respondent: string,
  taskId = "task-1",
) {
  const res = await relay.app.request(`/api/v1/allocations/${allocationId}/dispute`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({
      task_id: taskId,
      filed_by: filedBy,
      respondent,
      category: "quality",
      description: "Work quality was inadequate",
      evidence_refs: ["receipt-123"],
    }),
  });
  return res;
}

// === Tests ===

describe("Dispute: POST /api/v1/allocations/:allocationId/dispute", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
    const kp1 = await generateKeypair();
    const kp2 = await generateKeypair();
    await registerAgent(relay, "delegator-1", bytesToHex(kp1.publicKey));
    await registerAgent(relay, "worker-1", bytesToHex(kp2.publicKey));
  });

  afterEach(async () => {
    await relay.close();
  });

  it("opens a dispute and locks funds", async () => {
    createAllocation(relay, "alloc-1", "task-1", "delegator-1");

    const res = await openDispute(relay, "alloc-1", "delegator-1", "worker-1");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      ok: boolean;
      dispute_id: string;
      state: string;
      amount_locked: number;
    };
    expect(body.ok).toBe(true);
    expect(body.dispute_id).toBeTruthy();
    expect(body.state).toBe("evidence");
    expect(body.amount_locked).toBe(100000);
  });

  it("rejects dispute without evidence refs", async () => {
    createAllocation(relay, "alloc-2", "task-2", "delegator-1");

    const res = await relay.app.request(`/api/v1/allocations/alloc-2/dispute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        task_id: "task-2",
        filed_by: "delegator-1",
        respondent: "worker-1",
        category: "quality",
        description: "Bad work",
        evidence_refs: [],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects dispute on nonexistent allocation", async () => {
    const res = await openDispute(relay, "nonexistent-alloc", "delegator-1", "worker-1");
    expect(res.status).toBe(404);
  });
});

describe("Dispute: evidence + resolve", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
    const kp1 = await generateKeypair();
    const kp2 = await generateKeypair();
    await registerAgent(relay, "del-ev", bytesToHex(kp1.publicKey));
    await registerAgent(relay, "wrk-ev", bytesToHex(kp2.publicKey));
    createAllocation(relay, "alloc-ev", "task-ev", "del-ev");
  });

  afterEach(async () => {
    await relay.close();
  });

  it("submits evidence in an open dispute", async () => {
    const openRes = await openDispute(relay, "alloc-ev", "del-ev", "wrk-ev", "task-ev");
    const { dispute_id } = (await openRes.json()) as { dispute_id: string };

    const evidenceRes = await relay.app.request(`/api/v1/disputes/${dispute_id}/evidence`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        submitted_by: "wrk-ev",
        evidence_type: "execution_receipt",
        evidence_data: { receipt_id: "rcpt-1", result: "success" },
        description: "Task was completed successfully",
      }),
    });
    expect(evidenceRes.status).toBe(200);

    const body = (await evidenceRes.json()) as { ok: boolean; evidence_id: string };
    expect(body.ok).toBe(true);
    expect(body.evidence_id).toBeTruthy();
  });

  it("rejects evidence from non-party", async () => {
    const openRes = await openDispute(relay, "alloc-ev", "del-ev", "wrk-ev", "task-ev");
    const { dispute_id } = (await openRes.json()) as { dispute_id: string };

    const evidenceRes = await relay.app.request(`/api/v1/disputes/${dispute_id}/evidence`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        submitted_by: "random-agent",
        evidence_type: "attestation",
        evidence_data: { claim: "I witnessed it" },
        description: "Third party attestation",
      }),
    });
    expect(evidenceRes.status).toBe(403);
  });

  it("resolves a dispute with rationale", async () => {
    const openRes = await openDispute(relay, "alloc-ev", "del-ev", "wrk-ev", "task-ev");
    const { dispute_id } = (await openRes.json()) as { dispute_id: string };

    const resolveRes = await relay.app.request(`/api/v1/disputes/${dispute_id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        resolution: "upheld",
        rationale: "Evidence shows work was inadequate",
        fund_action: "refund_to_delegator",
      }),
    });
    expect(resolveRes.status).toBe(200);

    const body = (await resolveRes.json()) as {
      ok: boolean;
      state: string;
      resolution: string;
      fund_action: string;
    };
    expect(body.state).toBe("resolved");
    expect(body.resolution).toBe("upheld");
    expect(body.fund_action).toBe("refund_to_delegator");
  });

  it("rejects resolution without rationale (§6.5)", async () => {
    const openRes = await openDispute(relay, "alloc-ev", "del-ev", "wrk-ev", "task-ev");
    const { dispute_id } = (await openRes.json()) as { dispute_id: string };

    const resolveRes = await relay.app.request(`/api/v1/disputes/${dispute_id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        resolution: "upheld",
        rationale: "",
        fund_action: "refund_to_delegator",
      }),
    });
    expect(resolveRes.status).toBe(400);
  });
});

describe("Dispute: appeal", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
    const kp1 = await generateKeypair();
    const kp2 = await generateKeypair();
    await registerAgent(relay, "del-ap", bytesToHex(kp1.publicKey));
    await registerAgent(relay, "wrk-ap", bytesToHex(kp2.publicKey));
    createAllocation(relay, "alloc-ap", "task-ap", "del-ap");
  });

  afterEach(async () => {
    await relay.close();
  });

  it("files appeal against resolved dispute", async () => {
    const openRes = await openDispute(relay, "alloc-ap", "del-ap", "wrk-ap", "task-ap");
    const { dispute_id } = (await openRes.json()) as { dispute_id: string };

    // Resolve first
    await relay.app.request(`/api/v1/disputes/${dispute_id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        resolution: "overturned",
        rationale: "Original settlement was correct",
        fund_action: "release_to_worker",
      }),
    });

    // Appeal
    const appealRes = await relay.app.request(`/api/v1/disputes/${dispute_id}/appeal`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        appealed_by: "del-ap",
        reason: "New evidence contradicts resolution",
      }),
    });
    expect(appealRes.status).toBe(200);

    const body = (await appealRes.json()) as { ok: boolean; state: string };
    expect(body.state).toBe("appealed");
  });

  it("rejects second appeal (§8.4)", async () => {
    const openRes = await openDispute(relay, "alloc-ap", "del-ap", "wrk-ap", "task-ap");
    const { dispute_id } = (await openRes.json()) as { dispute_id: string };

    await relay.app.request(`/api/v1/disputes/${dispute_id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        resolution: "overturned",
        rationale: "Reason",
        fund_action: "release_to_worker",
      }),
    });

    // First appeal — OK
    await relay.app.request(`/api/v1/disputes/${dispute_id}/appeal`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ appealed_by: "del-ap", reason: "Appeal 1" }),
    });

    // Resolve appeal to get back to resolved
    await relay.app.request(`/api/v1/disputes/${dispute_id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        resolution: "split",
        rationale: "Fair split after review",
        fund_action: "split",
        split_ratio: 0.5,
      }),
    });

    // Second appeal — should be rejected (appealed_at already set)
    const appeal2 = await relay.app.request(`/api/v1/disputes/${dispute_id}/appeal`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ appealed_by: "wrk-ap", reason: "Appeal 2" }),
    });
    // State is not "resolved" anymore so should fail
    expect(appeal2.status).not.toBe(200);
  });
});

describe("Dispute: GET status + admin", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
    const kp = await generateKeypair();
    await registerAgent(relay, "del-get", bytesToHex(kp.publicKey));
    createAllocation(relay, "alloc-get", "task-get", "del-get");
  });

  afterEach(async () => {
    await relay.close();
  });

  it("returns dispute status with evidence", async () => {
    const openRes = await openDispute(relay, "alloc-get", "del-get", "wrk-get", "task-get");
    const { dispute_id } = (await openRes.json()) as { dispute_id: string };

    const res = await relay.app.request(`/api/v1/disputes/${dispute_id}`, {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      dispute_id: string;
      state: string;
      evidence: unknown[];
    };
    expect(body.dispute_id).toBe(dispute_id);
    expect(body.state).toBe("evidence");
    expect(Array.isArray(body.evidence)).toBe(true);
  });

  it("returns 404 for nonexistent dispute", async () => {
    const res = await relay.app.request(`/api/v1/disputes/nonexistent`, {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(404);
  });

  it("admin endpoint returns disputes with stats", async () => {
    await openDispute(relay, "alloc-get", "del-get", "wrk-get", "task-get");

    const res = await relay.app.request(`/api/v1/admin/disputes`, {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      disputes: unknown[];
      stats: { total: number; evidence: number };
    };
    expect(body.disputes.length).toBeGreaterThanOrEqual(1);
    expect(body.stats.total).toBeGreaterThanOrEqual(1);
  });
});
