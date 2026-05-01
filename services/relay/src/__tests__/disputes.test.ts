/**
 * Dispute endpoint tests — motebit/dispute@1.0.
 *
 * Per spec/dispute-v1.md §4.2 + §5.2 + §8.2 every inbound dispute body is
 * a signed wire artifact. Helpers below register an agent's keypair, then
 * sign DisputeRequest / DisputeEvidence / DisputeAppeal on its behalf so
 * tests read like the relay's eligibility logic and not like crypto setup.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import {
  generateKeypair,
  bytesToHex,
  signDisputeRequest,
  signDisputeEvidence,
  signDisputeAppeal,
} from "@motebit/encryption";
import type {
  DisputeAppeal,
  DisputeCategory,
  DisputeEvidence,
  DisputeEvidenceType,
  DisputeRequest,
} from "@motebit/protocol";
import { AUTH_HEADER, createTestRelay } from "./test-helpers.js";

// === Test keystore ===
//
// Per-relay map of motebit_id → keypair so dispute helpers can sign on
// behalf of named agents. Cleared implicitly when the relay closes (the
// next createTestRelay produces a fresh SyncRelay key).
type Keypair = { publicKey: Uint8Array; privateKey: Uint8Array };
const keystore = new WeakMap<SyncRelay, Map<string, Keypair>>();

function keysFor(relay: SyncRelay): Map<string, Keypair> {
  let m = keystore.get(relay);
  if (!m) {
    m = new Map();
    keystore.set(relay, m);
  }
  return m;
}

function keyFor(relay: SyncRelay, motebitId: string): Keypair {
  const kp = keysFor(relay).get(motebitId);
  if (!kp) throw new Error(`no test keypair for ${motebitId}`);
  return kp;
}

// === Helpers ===

async function registerAgent(relay: SyncRelay, motebitId: string): Promise<Keypair> {
  const kp = await generateKeypair();
  keysFor(relay).set(motebitId, kp);
  await relay.app.request(`/api/v1/agents/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({
      motebit_id: motebitId,
      endpoint_url: "http://localhost:9999/mcp",
      capabilities: ["web_search"],
      public_key: bytesToHex(kp.publicKey),
    }),
  });
  return kp;
}

/**
 * Inject a dispute row directly into `relay_disputes`, bypassing the
 * filing endpoint and its signature requirement. Used by the self-
 * adjudication tests, where the relay's own identity key is internal
 * to `createSyncRelay` (not exposed on the test's `SyncRelay` shape).
 * The point of those tests is the resolve handler's refusal, not the
 * filing path — the filing path is exercised across the rest of this
 * suite under signed bodies.
 */
function injectDispute(
  relay: SyncRelay,
  args: {
    dispute_id: string;
    task_id: string;
    allocation_id: string;
    filed_by: string;
    respondent: string;
    amount_locked?: number;
  },
): void {
  const filed_at = Date.now();
  relay.moteDb.db
    .prepare(
      `INSERT INTO relay_disputes
         (dispute_id, task_id, allocation_id, filed_by, respondent, category, description, state, amount_locked, filing_fee, filed_at, evidence_deadline)
       VALUES (?, ?, ?, ?, ?, 'quality', 'Injected for self-adjudication test', 'evidence', ?, 0, ?, ?)`,
    )
    .run(
      args.dispute_id,
      args.task_id,
      args.allocation_id,
      args.filed_by,
      args.respondent,
      args.amount_locked ?? 100000,
      filed_at,
      filed_at + 48 * 60 * 60 * 1000,
    );
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

let disputeIdCounter = 0;
function nextDisputeId(): string {
  disputeIdCounter += 1;
  return `dsp-test-${Date.now().toString(36)}-${disputeIdCounter.toString(36).padStart(4, "0")}`;
}

async function openDispute(
  relay: SyncRelay,
  allocationId: string,
  filedBy: string,
  respondent: string,
  taskId = "task-1",
  overrides: Partial<{
    evidence_refs: string[];
    category: DisputeCategory;
    description: string;
    dispute_id: string;
    filed_at: number;
  }> = {},
) {
  const filerKey = keyFor(relay, filedBy);
  const signed = await signDisputeRequest(
    {
      dispute_id: overrides.dispute_id ?? nextDisputeId(),
      task_id: taskId,
      allocation_id: allocationId,
      filed_by: filedBy,
      respondent,
      category: overrides.category ?? "quality",
      description: overrides.description ?? "Work quality was inadequate",
      evidence_refs: overrides.evidence_refs ?? ["receipt-123"],
      filed_at: overrides.filed_at ?? Date.now(),
    },
    filerKey.privateKey,
  );
  return relay.app.request(`/api/v1/allocations/${allocationId}/dispute`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify(signed),
  });
}

async function submitEvidence(
  relay: SyncRelay,
  disputeId: string,
  submittedBy: string,
  overrides: Partial<{
    evidence_type: DisputeEvidenceType;
    evidence_data: Record<string, unknown>;
    description: string;
    submitted_at: number;
  }> = {},
  signWith?: Keypair,
) {
  const submitterKey = signWith ?? keyFor(relay, submittedBy);
  const signed = await signDisputeEvidence(
    {
      dispute_id: disputeId,
      submitted_by: submittedBy,
      evidence_type: overrides.evidence_type ?? "execution_receipt",
      evidence_data: overrides.evidence_data ?? { receipt_id: "rcpt-1", result: "success" },
      description: overrides.description ?? "Evidence",
      submitted_at: overrides.submitted_at ?? Date.now(),
    },
    submitterKey.privateKey,
  );
  return relay.app.request(`/api/v1/disputes/${disputeId}/evidence`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify(signed),
  });
}

async function fileAppeal(
  relay: SyncRelay,
  disputeId: string,
  appealedBy: string,
  overrides: Partial<{
    reason: string;
    additional_evidence: string[];
    appealed_at: number;
  }> = {},
) {
  const appealerKey = keyFor(relay, appealedBy);
  const body: Omit<DisputeAppeal, "signature" | "suite"> = {
    dispute_id: disputeId,
    appealed_by: appealedBy,
    reason: overrides.reason ?? "Appeal reason",
    appealed_at: overrides.appealed_at ?? Date.now(),
  };
  if (overrides.additional_evidence !== undefined) {
    body.additional_evidence = overrides.additional_evidence;
  }
  const signed = await signDisputeAppeal(body, appealerKey.privateKey);
  return relay.app.request(`/api/v1/disputes/${disputeId}/appeal`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify(signed),
  });
}

// Type-only barrel — quiet "value imported but never used" once strict tests
// reference these types in inline overrides. Erased at compile time.
export type { DisputeRequest, DisputeEvidence, DisputeAppeal };

// === Tests ===

describe("Dispute: POST /api/v1/allocations/:allocationId/dispute", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
    await registerAgent(relay, "delegator-1");
    await registerAgent(relay, "worker-1");
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

    // Schema enforces evidence_refs.min(1); the relay rejects at parse
    // before any signature work (the body is still well-signed, but the
    // shape is invalid).
    const res = await openDispute(relay, "alloc-2", "delegator-1", "worker-1", "task-2", {
      evidence_refs: [],
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
    await registerAgent(relay, "del-ev");
    await registerAgent(relay, "wrk-ev");
    createAllocation(relay, "alloc-ev", "task-ev", "del-ev");
  });

  afterEach(async () => {
    await relay.close();
  });

  it("submits evidence in an open dispute", async () => {
    const openRes = await openDispute(relay, "alloc-ev", "del-ev", "wrk-ev", "task-ev");
    const { dispute_id } = (await openRes.json()) as { dispute_id: string };

    const evidenceRes = await submitEvidence(relay, dispute_id, "wrk-ev", {
      description: "Task was completed successfully",
    });
    expect(evidenceRes.status).toBe(200);

    const body = (await evidenceRes.json()) as { ok: boolean; evidence_id: string };
    expect(body.ok).toBe(true);
    expect(body.evidence_id).toBeTruthy();
  });

  it("rejects evidence from non-party", async () => {
    const openRes = await openDispute(relay, "alloc-ev", "del-ev", "wrk-ev", "task-ev");
    const { dispute_id } = (await openRes.json()) as { dispute_id: string };

    // Sign with a fresh keypair we never registered — the body parses
    // cleanly because it carries a valid signature, but the relay's
    // party-membership check fires before signature verification (a
    // stranger doesn't even reach the keystore lookup).
    const stranger = await generateKeypair();
    const evidenceRes = await submitEvidence(
      relay,
      dispute_id,
      "random-agent",
      {
        evidence_type: "attestation",
        evidence_data: { claim: "I witnessed it" },
        description: "Third party attestation",
      },
      stranger,
    );
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

  // Spec/dispute-v1.md §6.3 + §6.5 Foundation Law: "A relay must not
  // self-adjudicate when it is the defendant. Violation is a
  // federation-level trust event." Also §6.2(1): "no single relay has
  // complete jurisdiction" when the relay is a party. The relay
  // refuses to sign a single-relay resolution in either direction
  // (as defendant or as filer). Federation orchestration is deferred;
  // until then these disputes remain unresolved and the agent's
  // onchain evidence stands independently (§6.3, §10).
  it("refuses to self-adjudicate when relay is the respondent (§6.5)", async () => {
    const relayMotebitId = relay.relayIdentity.relayMotebitId;
    createAllocation(relay, "alloc-defendant", "task-defendant", "del-ev");
    const dispute_id = nextDisputeId();
    injectDispute(relay, {
      dispute_id,
      task_id: "task-defendant",
      allocation_id: "alloc-defendant",
      filed_by: "del-ev",
      respondent: relayMotebitId,
    });

    const resolveRes = await relay.app.request(`/api/v1/disputes/${dispute_id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        resolution: "overturned",
        rationale: "Relay tries to exonerate itself",
        fund_action: "refund_to_delegator",
      }),
    });
    // Phase 6.2: the prior 409 self-adjudication guard is replaced by
    // the federation orchestrator. Test relay has no peers, so the
    // orchestrator's quorum-floor check fails fast → 503
    // `insufficient_federation_peers`. The §6.5 self-adjudication
    // property still holds — the relay does NOT produce a single-relay
    // resolution when it's a party. With ≥3 active peers the
    // orchestrator would fan out votes; that path is exercised in
    // federation-orchestrator.test.ts.
    expect(resolveRes.status).toBe(503);
    // Relay's global error handler (middleware.ts:496-498) emits
    // {error: <message>, status}; my orchestrator's HTTPException
    // message is a JSON-encoded {error_code, message} blob, so the
    // wire response is {error: '{"error_code":"...","message":"..."}', status: 503}.
    // Parsing errBody.error gives us the spec-compliant code.
    const errBody = (await resolveRes.json()) as { error: string };
    const errPayload = JSON.parse(errBody.error) as { error_code: string };
    expect(errPayload.error_code).toBe("insufficient_federation_peers");
  });

  it("refuses to self-adjudicate when relay is the filer (§6.2)", async () => {
    const relayMotebitId = relay.relayIdentity.relayMotebitId;
    createAllocation(relay, "alloc-filer", "task-filer", relayMotebitId);
    const dispute_id = nextDisputeId();
    injectDispute(relay, {
      dispute_id,
      task_id: "task-filer",
      allocation_id: "alloc-filer",
      filed_by: relayMotebitId,
      respondent: "wrk-ev",
    });

    const resolveRes = await relay.app.request(`/api/v1/disputes/${dispute_id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        resolution: "upheld",
        rationale: "Relay rules in its own favor",
        fund_action: "refund_to_delegator",
      }),
    });
    // Phase 6.2: same shape as the respondent test above — federation
    // orchestrator's quorum-floor check fails fast for a peerless test
    // relay; §6.5 self-adjudication property is preserved.
    expect(resolveRes.status).toBe(503);
    // Relay's global error handler (middleware.ts:496-498) emits
    // {error: <message>, status}; my orchestrator's HTTPException
    // message is a JSON-encoded {error_code, message} blob, so the
    // wire response is {error: '{"error_code":"...","message":"..."}', status: 503}.
    // Parsing errBody.error gives us the spec-compliant code.
    const errBody = (await resolveRes.json()) as { error: string };
    const errPayload = JSON.parse(errBody.error) as { error_code: string };
    expect(errPayload.error_code).toBe("insufficient_federation_peers");
  });

  it("resolution signature is verifiable with the relay's public key (single-relay path)", async () => {
    const { verifyDisputeResolution } = await import("@motebit/encryption");
    const { hexToBytes } = await import("@motebit/encryption");
    const openRes = await openDispute(relay, "alloc-ev", "del-ev", "wrk-ev", "task-ev");
    const { dispute_id } = (await openRes.json()) as { dispute_id: string };

    await relay.app.request(`/api/v1/disputes/${dispute_id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        resolution: "split",
        rationale: "Evidence supports both positions",
        fund_action: "split",
      }),
    });

    // Reconstruct the signed resolution from the stored row and verify
    // under the relay's public key — proves the new `signDisputeResolution`
    // call site produces what `verifyDisputeResolution` accepts.
    const row = relay.moteDb.db
      .prepare(
        "SELECT dispute_id, resolution, rationale, fund_action, split_ratio, adjudicator, adjudicator_votes, resolved_at, signature FROM relay_dispute_resolutions WHERE dispute_id = ?",
      )
      .get(dispute_id) as {
      dispute_id: string;
      resolution: "upheld" | "overturned" | "split";
      rationale: string;
      fund_action: "release_to_worker" | "refund_to_delegator" | "split";
      split_ratio: number;
      adjudicator: string;
      adjudicator_votes: string;
      resolved_at: number;
      signature: string;
    };

    const resolutionToVerify = {
      dispute_id: row.dispute_id,
      resolution: row.resolution,
      rationale: row.rationale,
      fund_action: row.fund_action,
      split_ratio: row.split_ratio,
      adjudicator: row.adjudicator,
      adjudicator_votes: JSON.parse(row.adjudicator_votes) as never[],
      resolved_at: row.resolved_at,
      suite: "motebit-jcs-ed25519-b64-v1" as const,
      signature: row.signature,
    };

    const valid = await verifyDisputeResolution(
      resolutionToVerify,
      hexToBytes(relay.relayIdentity.publicKeyHex),
    );
    expect(valid).toBe(true);
  });
});

describe("Dispute: appeal", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
    await registerAgent(relay, "del-ap");
    await registerAgent(relay, "wrk-ap");
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

    const appealRes = await fileAppeal(relay, dispute_id, "del-ap", {
      reason: "New evidence contradicts resolution",
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
    await fileAppeal(relay, dispute_id, "del-ap", { reason: "Appeal 1" });

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
    const appeal2 = await fileAppeal(relay, dispute_id, "wrk-ap", { reason: "Appeal 2" });
    // State is not "resolved" anymore so should fail
    expect(appeal2.status).not.toBe(200);
  });
});

describe("Dispute: GET status + admin", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
    await registerAgent(relay, "del-get");
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

describe("Dispute: fund execution integrity", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
    await registerAgent(relay, "del-fund");
    await registerAgent(relay, "wrk-fund");
    createAllocation(relay, "alloc-fund", "task-fund", "del-fund");
  });

  afterEach(async () => {
    await relay.close();
  });

  it("refund credits relay_accounts, not virtual_accounts", async () => {
    const openRes = await openDispute(relay, "alloc-fund", "del-fund", "wrk-fund", "task-fund");
    const { dispute_id } = (await openRes.json()) as { dispute_id: string };

    // Check balance before
    const beforeRow = relay.moteDb.db
      .prepare("SELECT balance FROM relay_accounts WHERE motebit_id = ?")
      .get("del-fund") as { balance: number } | undefined;
    const balanceBefore = beforeRow?.balance ?? 0;

    // Resolve with refund
    const resolveRes = await relay.app.request(`/api/v1/disputes/${dispute_id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        resolution: "upheld",
        rationale: "Work was inadequate",
        fund_action: "refund_to_delegator",
      }),
    });
    expect(resolveRes.status).toBe(200);

    // Verify relay_accounts balance increased
    const afterRow = relay.moteDb.db
      .prepare("SELECT balance FROM relay_accounts WHERE motebit_id = ?")
      .get("del-fund") as { balance: number } | undefined;
    const balanceAfter = afterRow?.balance ?? 0;
    expect(balanceAfter).toBe(balanceBefore + 100000);

    // Verify relay_transactions audit trail exists
    const txns = relay.moteDb.db
      .prepare(
        "SELECT * FROM relay_transactions WHERE motebit_id = ? AND type = 'settlement_credit' AND reference_id = ?",
      )
      .all("del-fund", dispute_id) as Array<Record<string, unknown>>;
    expect(txns.length).toBe(1);
    expect(txns[0]!.amount).toBe(100000);
  });

  it("split distributes to both parties with integer arithmetic", async () => {
    const openRes = await openDispute(relay, "alloc-fund", "del-fund", "wrk-fund", "task-fund");
    const { dispute_id } = (await openRes.json()) as { dispute_id: string };

    const resolveRes = await relay.app.request(`/api/v1/disputes/${dispute_id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        resolution: "split",
        rationale: "Partial quality issues",
        fund_action: "split",
        split_ratio: 0.7,
      }),
    });
    expect(resolveRes.status).toBe(200);

    // Worker gets floor(100000 * 0.7) = 70000
    const workerTxn = relay.moteDb.db
      .prepare(
        "SELECT amount FROM relay_transactions WHERE motebit_id = ? AND type = 'settlement_credit' AND reference_id = ?",
      )
      .get("wrk-fund", dispute_id) as { amount: number } | undefined;
    expect(workerTxn?.amount).toBe(70000);

    // Delegator gets 100000 - 70000 = 30000
    const delTxn = relay.moteDb.db
      .prepare(
        "SELECT amount FROM relay_transactions WHERE motebit_id = ? AND type = 'settlement_credit' AND reference_id = ?",
      )
      .get("del-fund", dispute_id) as { amount: number } | undefined;
    expect(delTxn?.amount).toBe(30000);
  });

  it("release_to_worker credits the respondent", async () => {
    const openRes = await openDispute(relay, "alloc-fund", "del-fund", "wrk-fund", "task-fund");
    const { dispute_id } = (await openRes.json()) as { dispute_id: string };

    const resolveRes = await relay.app.request(`/api/v1/disputes/${dispute_id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        resolution: "overturned",
        rationale: "Work was actually fine",
        fund_action: "release_to_worker",
      }),
    });
    expect(resolveRes.status).toBe(200);

    const workerTxn = relay.moteDb.db
      .prepare(
        "SELECT amount FROM relay_transactions WHERE motebit_id = ? AND type = 'settlement_credit' AND reference_id = ?",
      )
      .get("wrk-fund", dispute_id) as { amount: number } | undefined;
    expect(workerTxn?.amount).toBe(100000);
  });
});
