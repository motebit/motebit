/**
 * P2P settlement tests — "relay until trust, then p2p".
 *
 * Tests the policy-based settlement mode selection, payment proof
 * validation, receipt ingestion for p2p tasks, and trust-layer disputes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import { evaluateSettlementEligibility } from "../task-routing.js";
import { AUTH_HEADER, createTestRelay } from "./test-helpers.js";

// === Helpers ===

async function registerAgent(
  relay: SyncRelay,
  motebitId: string,
  publicKeyHex: string,
  opts?: { settlementAddress?: string; settlementModes?: string },
) {
  await relay.app.request(`/api/v1/agents/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({
      motebit_id: motebitId,
      endpoint_url: "http://localhost:9999/mcp",
      capabilities: ["web_search"],
      public_key: publicKeyHex,
      settlement_address: opts?.settlementAddress ?? null,
      settlement_modes: opts?.settlementModes ?? "relay",
    }),
  });
}

function setTrust(
  db: import("@motebit/persistence").DatabaseDriver,
  fromId: string,
  toId: string,
  trustLevel: string,
  interactionCount: number,
) {
  db.prepare(
    `INSERT OR REPLACE INTO agent_trust
     (motebit_id, remote_motebit_id, trust_level, interaction_count, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(fromId, toId, trustLevel, interactionCount, Date.now(), Date.now());
}

// === evaluateSettlementEligibility ===

describe("evaluateSettlementEligibility", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
    const kp1 = await generateKeypair();
    const kp2 = await generateKeypair();
    await registerAgent(relay, "del-elig", bytesToHex(kp1.publicKey), {
      settlementModes: "relay,p2p",
    });
    await registerAgent(relay, "wrk-elig", bytesToHex(kp2.publicKey), {
      settlementAddress: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv",
      settlementModes: "relay,p2p",
    });
  });

  afterEach(async () => {
    await relay.close();
  });

  it("allows p2p when both parties opt in and trust is sufficient", () => {
    setTrust(relay.moteDb.db, "del-elig", "wrk-elig", "verified", 10);

    const result = evaluateSettlementEligibility(relay.moteDb.db, "del-elig", "wrk-elig");
    expect(result.allowed).toBe(true);
    expect(result.mode).toBe("p2p");
  });

  it("rejects when worker has no settlement address", async () => {
    const kp = await generateKeypair();
    await registerAgent(relay, "wrk-noaddr", bytesToHex(kp.publicKey), {
      settlementModes: "relay,p2p",
    });
    setTrust(relay.moteDb.db, "del-elig", "wrk-noaddr", "trusted", 20);

    const result = evaluateSettlementEligibility(relay.moteDb.db, "del-elig", "wrk-noaddr");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("settlement address");
  });

  it("rejects when worker does not support p2p", async () => {
    const kp = await generateKeypair();
    await registerAgent(relay, "wrk-relay-only", bytesToHex(kp.publicKey), {
      settlementAddress: "3xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsm",
      settlementModes: "relay",
    });
    setTrust(relay.moteDb.db, "del-elig", "wrk-relay-only", "trusted", 20);

    const result = evaluateSettlementEligibility(relay.moteDb.db, "del-elig", "wrk-relay-only");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("does not support p2p");
  });

  it("rejects when trust is too low", () => {
    setTrust(relay.moteDb.db, "del-elig", "wrk-elig", "first_contact", 2);

    const result = evaluateSettlementEligibility(relay.moteDb.db, "del-elig", "wrk-elig");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Trust score");
  });

  it("rejects when interaction count is too low", () => {
    setTrust(relay.moteDb.db, "del-elig", "wrk-elig", "verified", 3);

    const result = evaluateSettlementEligibility(relay.moteDb.db, "del-elig", "wrk-elig");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Interaction count");
  });

  it("rejects when active dispute exists between pair", () => {
    setTrust(relay.moteDb.db, "del-elig", "wrk-elig", "trusted", 20);

    // Create an active dispute between them
    relay.moteDb.db
      .prepare(
        `INSERT INTO relay_disputes
         (dispute_id, task_id, allocation_id, filed_by, respondent, category, description, state, amount_locked, filing_fee, filed_at, evidence_deadline)
         VALUES (?, ?, ?, ?, ?, 'quality', 'test', 'evidence', 0, 0, ?, ?)`,
      )
      .run(
        "dsp-block",
        "task-x",
        "alloc-x",
        "del-elig",
        "wrk-elig",
        Date.now(),
        Date.now() + 86400000,
      );

    const result = evaluateSettlementEligibility(relay.moteDb.db, "del-elig", "wrk-elig");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Active dispute");
  });

  it("rejects when no trust history exists", () => {
    const result = evaluateSettlementEligibility(relay.moteDb.db, "del-elig", "wrk-elig");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("No trust history");
  });
});

// === P2P task submission ===

describe("P2P task submission", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
    const kp1 = await generateKeypair();
    const kp2 = await generateKeypair();
    await registerAgent(relay, "del-p2p", bytesToHex(kp1.publicKey), {
      settlementModes: "relay,p2p",
    });
    await registerAgent(relay, "wrk-p2p", bytesToHex(kp2.publicKey), {
      settlementAddress: "9xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgBBB",
      settlementModes: "relay,p2p",
    });
    setTrust(relay.moteDb.db, "del-p2p", "wrk-p2p", "verified", 10);
  });

  afterEach(async () => {
    await relay.close();
  });

  it("rejects p2p when eligibility fails (403)", async () => {
    // Lower trust so eligibility fails
    setTrust(relay.moteDb.db, "del-p2p", "wrk-p2p", "first_contact", 1);

    const res = await relay.app.request(`/agent/wrk-p2p/task`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "idem-p2p-1",
        ...AUTH_HEADER,
      },
      body: JSON.stringify({
        prompt: "Test p2p task",
        submitted_by: "del-p2p",
        target_agent: "wrk-p2p",
        payment_proof: {
          tx_hash: "4vERYvaLiDsLaNaTransaCtiNSignaTuReHashThatis88charsLng1234567891abcDEFghijk",
          chain: "solana",
          network: "solana:mainnet",
          to_address: "9xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgBBB",
          amount_micro: 500000,
        },
      }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects when payment address does not match worker settlement address", async () => {
    const res = await relay.app.request(`/agent/wrk-p2p/task`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "idem-p2p-2",
        ...AUTH_HEADER,
      },
      body: JSON.stringify({
        prompt: "Test p2p task",
        submitted_by: "del-p2p",
        target_agent: "wrk-p2p",
        payment_proof: {
          tx_hash: "4vERYvaLiDsLaNaTransaCtiNSignaTuReHashThatis88charsLng1234567891abcDEFghijk",
          chain: "solana",
          network: "solana:mainnet",
          to_address: "2xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgCCC",
          amount_micro: 500000,
        },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("submits task without payment_proof — falls back to relay mode", async () => {
    const res = await relay.app.request(`/agent/wrk-p2p/task`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "idem-p2p-3",
        ...AUTH_HEADER,
      },
      body: JSON.stringify({
        prompt: "Normal relay task",
        submitted_by: "del-p2p",
      }),
    });
    // Should succeed as a normal relay task (may fail routing but won't be 403)
    expect(res.status).not.toBe(403);
  });
});

// === P2P disputes (trust-layer) ===

describe("P2P disputes (trust-layer)", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
    const kp1 = await generateKeypair();
    const kp2 = await generateKeypair();
    await registerAgent(relay, "del-dsp", bytesToHex(kp1.publicKey));
    await registerAgent(relay, "wrk-dsp", bytesToHex(kp2.publicKey));

    // Create a p2p settlement record (simulating a completed p2p task)
    relay.moteDb.db
      .prepare(
        `INSERT INTO relay_settlements
         (settlement_id, allocation_id, task_id, motebit_id, receipt_hash,
          amount_settled, platform_fee, platform_fee_rate, status, settled_at,
          settlement_mode, p2p_tx_hash, payment_verification_status)
         VALUES (?, ?, ?, ?, '', 0, 0, 0, 'completed', ?, 'p2p', ?, 'pending')`,
      )
      .run("stl-p2p-1", "p2p-task-1", "task-p2p-1", "wrk-dsp", Date.now(), "fakeTxHash123");
  });

  afterEach(async () => {
    await relay.close();
  });

  it("opens a trust-layer dispute on a p2p task", async () => {
    const res = await relay.app.request(`/api/v1/allocations/p2p-alloc-1/dispute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        task_id: "task-p2p-1",
        filed_by: "del-dsp",
        respondent: "wrk-dsp",
        category: "quality",
        description: "P2P task output was inadequate",
        evidence_refs: ["receipt-p2p-1"],
      }),
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      ok: boolean;
      dispute_id: string;
      amount_locked: number;
      p2p_dispute: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.amount_locked).toBe(0);
    expect(body.p2p_dispute).toBe(true);
  });

  it("returns 404 when neither allocation nor p2p settlement exists", async () => {
    const res = await relay.app.request(`/api/v1/allocations/nonexistent/dispute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        task_id: "task-nonexistent",
        filed_by: "del-dsp",
        respondent: "wrk-dsp",
        category: "quality",
        description: "No task",
        evidence_refs: ["ref-1"],
      }),
    });
    expect(res.status).toBe(404);
  });
});
