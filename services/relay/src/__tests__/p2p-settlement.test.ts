/**
 * P2P settlement tests — "relay until trust, then p2p".
 *
 * Tests the policy-based settlement mode selection, payment proof
 * validation, receipt ingestion for p2p tasks, and trust-layer disputes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import { generateKeypair, bytesToHex, signDisputeRequest } from "@motebit/encryption";
import { SOLANA_MAINNET_CAIP2 } from "@motebit/wallet-solana";
import { evaluateSettlementEligibility } from "../task-routing.js";
import { getListingUnitCost } from "../tasks.js";
import { deriveSovereignMotebitId } from "@motebit/crypto";
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

  // Arc 3 of the off-ramp arc made eligibility disjunctive: established
  // pair OR new pair with delegator acknowledgment. P2P is the only path;
  // the gate is delegation-eligibility, not settlement-routing. The
  // result type is the disjunctive `SettlementEligibility` (allowed
  // implies mode: "p2p"; disallowed has no mode field).

  it("allows established pair via trust + interactions branch (no acknowledgment needed)", async () => {
    setTrust(relay.moteDb.db, "del-elig", "wrk-elig", "verified", 10);

    const result = await evaluateSettlementEligibility(relay.moteDb.db, "del-elig", "wrk-elig");
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.mode).toBe("p2p");
      expect(result.reason).toContain("Established pair");
    }
  });

  it("allows new pair via delegator-acknowledgment branch (Arc 3 bootstrap)", async () => {
    // No trust history. The acknowledgment unlocks the new-pair branch.
    const result = await evaluateSettlementEligibility(
      relay.moteDb.db,
      "del-elig",
      "wrk-elig",
      true /* delegatorAcknowledgesNoHistoryRisk */,
    );
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.mode).toBe("p2p");
      expect(result.reason).toContain("New pair");
    }
  });

  it("rejects when worker has no settlement address (both branches)", async () => {
    const kp = await generateKeypair();
    await registerAgent(relay, "wrk-noaddr", bytesToHex(kp.publicKey), {
      settlementModes: "relay,p2p",
    });
    setTrust(relay.moteDb.db, "del-elig", "wrk-noaddr", "trusted", 20);

    const result = await evaluateSettlementEligibility(relay.moteDb.db, "del-elig", "wrk-noaddr");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("settlement address");

    // Even acknowledgment can't unlock — no destination exists.
    const withAck = await evaluateSettlementEligibility(
      relay.moteDb.db,
      "del-elig",
      "wrk-noaddr",
      true,
    );
    expect(withAck.allowed).toBe(false);
    expect(withAck.reason).toContain("settlement address");
  });

  it("rejects when trust + interactions below threshold AND no acknowledgment", async () => {
    setTrust(relay.moteDb.db, "del-elig", "wrk-elig", "first_contact", 2);

    const result = await evaluateSettlementEligibility(relay.moteDb.db, "del-elig", "wrk-elig");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("did not acknowledge");
  });

  it("rejects when interaction count below threshold AND no acknowledgment", async () => {
    setTrust(relay.moteDb.db, "del-elig", "wrk-elig", "verified", 3);

    const result = await evaluateSettlementEligibility(relay.moteDb.db, "del-elig", "wrk-elig");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("did not acknowledge");
  });

  it("unlocks below-threshold pair when delegator acknowledges (Arc 3 bootstrap)", async () => {
    setTrust(relay.moteDb.db, "del-elig", "wrk-elig", "first_contact", 2);

    const result = await evaluateSettlementEligibility(
      relay.moteDb.db,
      "del-elig",
      "wrk-elig",
      true,
    );
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.mode).toBe("p2p");
    }
  });

  it("rejects when worker is blocked (acknowledgment cannot unlock)", async () => {
    setTrust(relay.moteDb.db, "del-elig", "wrk-elig", "blocked", 10);

    const noAck = await evaluateSettlementEligibility(relay.moteDb.db, "del-elig", "wrk-elig");
    expect(noAck.allowed).toBe(false);
    expect(noAck.reason).toContain("blocked");

    const withAck = await evaluateSettlementEligibility(
      relay.moteDb.db,
      "del-elig",
      "wrk-elig",
      true,
    );
    expect(withAck.allowed).toBe(false);
    expect(withAck.reason).toContain("blocked");
  });

  it("rejects when active dispute exists between pair (both branches)", async () => {
    setTrust(relay.moteDb.db, "del-elig", "wrk-elig", "trusted", 20);

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

    const noAck = await evaluateSettlementEligibility(relay.moteDb.db, "del-elig", "wrk-elig");
    expect(noAck.allowed).toBe(false);
    expect(noAck.reason).toContain("Active dispute");

    // Active dispute blocks even the acknowledgment branch.
    const withAck = await evaluateSettlementEligibility(
      relay.moteDb.db,
      "del-elig",
      "wrk-elig",
      true,
    );
    expect(withAck.allowed).toBe(false);
    expect(withAck.reason).toContain("Active dispute");
  });

  it("rejects when no trust history AND no acknowledgment", async () => {
    const result = await evaluateSettlementEligibility(relay.moteDb.db, "del-elig", "wrk-elig");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("No trust history");
  });

  it("sovereign-bound worker qualifies at the reduced cold-start bar (additive)", async () => {
    const kp = await generateKeypair();
    const pubKeyHex = bytesToHex(kp.publicKey);
    const sovereignId = await deriveSovereignMotebitId(pubKeyHex);
    await registerAgent(relay, sovereignId, pubKeyHex, {
      settlementAddress: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv",
      settlementModes: "relay,p2p",
    });
    // first_contact (0.3) + 2 interactions: below the strict 0.6/5 bar. An
    // unbound worker with this exact footprint is rejected (see the strict
    // "below threshold" test above) — sovereignty is the only thing that flips
    // it, which is precisely what makes the branch additive, never a gate.
    setTrust(relay.moteDb.db, "del-elig", sovereignId, "first_contact", 2);

    const result = await evaluateSettlementEligibility(relay.moteDb.db, "del-elig", sovereignId);
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.mode).toBe("p2p");
      expect(result.reason).toContain("Sovereign-bound");
    }
  });

  it("sovereign binding does not fabricate trust — below the reduced floor still rejects", async () => {
    const kp = await generateKeypair();
    const pubKeyHex = bytesToHex(kp.publicKey);
    const sovereignId = await deriveSovereignMotebitId(pubKeyHex);
    await registerAgent(relay, sovereignId, pubKeyHex, {
      settlementAddress: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv",
      settlementModes: "relay,p2p",
    });
    // Only 1 interaction — below even the sovereign floor of 2. No free pass:
    // sovereignty relaxes the cold-start bar, it does not remove the need for
    // real history with this specific worker.
    setTrust(relay.moteDb.db, "del-elig", sovereignId, "first_contact", 1);

    const result = await evaluateSettlementEligibility(relay.moteDb.db, "del-elig", sovereignId);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("did not acknowledge");
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
          network: SOLANA_MAINNET_CAIP2,
          to_address: "9xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgBBB",
          amount_micro: 500000,
          // Arc 2 of off-ramp arc: fee fields required for validation
          // to proceed past completeness check. Placeholder address +
          // amount; this test targets the eligibility-failure path so
          // exact values don't matter — they just need to be present.
          fee_to_address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgFFF",
          fee_amount_micro: 26316,
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
          network: SOLANA_MAINNET_CAIP2,
          to_address: "2xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgCCC",
          amount_micro: 500000,
          fee_to_address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgFFF",
          fee_amount_micro: 26316,
        },
      }),
    });
    expect(res.status).toBe(400);
  });

  // === Arc 2 fee-leg completeness (runtime contract) ===
  //
  // After the v1.x additive-shape change, `P2pPaymentProof.fee_to_address`
  // and `fee_amount_micro` are optional at the type level. The contract
  // moves to runtime — `tasks.ts:1658` throws TASK_INVALID_INPUT (HTTP
  // 400, "Incomplete payment_proof fields …") when either is absent.
  // These two cases lock that runtime enforcement against drift, since
  // the type system no longer catches missing fields at the boundary.

  it("rejects when payment_proof omits fee_to_address (Arc 2 runtime check)", async () => {
    const res = await relay.app.request(`/agent/wrk-p2p/task`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "idem-p2p-no-fee-addr",
        ...AUTH_HEADER,
      },
      body: JSON.stringify({
        prompt: "Test p2p task",
        submitted_by: "del-p2p",
        target_agent: "wrk-p2p",
        payment_proof: {
          tx_hash: "4vERYvaLiDsLaNaTransaCtiNSignaTuReHashThatis88charsLng1234567891abcDEFghijk",
          chain: "solana",
          network: SOLANA_MAINNET_CAIP2,
          to_address: "9xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgBBB",
          amount_micro: 500000,
          // fee_to_address intentionally omitted
          fee_amount_micro: 26316,
        },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error ?? "").toMatch(/Incomplete payment_proof fields/);
  });

  it("rejects when payment_proof omits fee_amount_micro (Arc 2 runtime check)", async () => {
    const res = await relay.app.request(`/agent/wrk-p2p/task`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "idem-p2p-no-fee-amount",
        ...AUTH_HEADER,
      },
      body: JSON.stringify({
        prompt: "Test p2p task",
        submitted_by: "del-p2p",
        target_agent: "wrk-p2p",
        payment_proof: {
          tx_hash: "4vERYvaLiDsLaNaTransaCtiNSignaTuReHashThatis88charsLng1234567891abcDEFghijk",
          chain: "solana",
          network: SOLANA_MAINNET_CAIP2,
          to_address: "9xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgBBB",
          amount_micro: 500000,
          fee_to_address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgFFF",
          // fee_amount_micro intentionally omitted
        },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error ?? "").toMatch(/Incomplete payment_proof fields/);
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
  let delDspKp: { publicKey: Uint8Array; privateKey: Uint8Array };

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
    delDspKp = await generateKeypair();
    const kp2 = await generateKeypair();
    await registerAgent(relay, "del-dsp", bytesToHex(delDspKp.publicKey));
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
    const signed = await signDisputeRequest(
      {
        dispute_id: `dsp-p2p-${crypto.randomUUID()}`,
        task_id: "task-p2p-1",
        allocation_id: "p2p-alloc-1",
        filed_by: "del-dsp",
        respondent: "wrk-dsp",
        category: "quality",
        description: "P2P task output was inadequate",
        evidence_refs: ["receipt-p2p-1"],
        filed_at: Date.now(),
      },
      delDspKp.privateKey,
    );
    const res = await relay.app.request(`/api/v1/allocations/p2p-alloc-1/dispute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(signed),
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
    const signed = await signDisputeRequest(
      {
        dispute_id: `dsp-p2p-${crypto.randomUUID()}`,
        task_id: "task-nonexistent",
        allocation_id: "nonexistent",
        filed_by: "del-dsp",
        respondent: "wrk-dsp",
        category: "quality",
        description: "No task",
        evidence_refs: ["ref-1"],
        filed_at: Date.now(),
      },
      delDspKp.privateKey,
    );
    const res = await relay.app.request(`/api/v1/allocations/nonexistent/dispute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(signed),
    });
    expect(res.status).toBe(404);
  });
});

describe("getListingUnitCost — capability-aware pricing (the multi-hop sub-hop fix)", () => {
  let relay: SyncRelay;
  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
  });
  afterEach(async () => {
    await relay.close();
  });

  function seedListing(
    motebitId: string,
    pricing: Array<{ capability: string; unit_cost: number }>,
  ) {
    relay.moteDb.db
      .prepare(
        `INSERT INTO relay_service_listings
         (listing_id, motebit_id, capabilities, pricing, sla_max_latency_ms, sla_availability, description, pay_to_address, regulatory_risk, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `lst-${motebitId}`,
        motebitId,
        JSON.stringify(pricing.map((p) => p.capability)),
        JSON.stringify(pricing),
        5000,
        0.99,
        "",
        null,
        null,
        Date.now(),
      );
  }

  it("prices the SPECIFIC capability, not the SUM of a multi-capability agent's listings", () => {
    // A web-search+read-url atom: summing (the pre-fix bug) would price a
    // read_url hop at 0.005, not 0.002.
    seedListing("atom", [
      { capability: "web_search", unit_cost: 0.003 },
      { capability: "read_url", unit_cost: 0.002 },
    ]);
    expect(getListingUnitCost(relay.moteDb, "atom", "read_url")).toBe(0.002);
    expect(getListingUnitCost(relay.moteDb, "atom", "web_search")).toBe(0.003);
    // No capability ⇒ legacy sum (correct only for single-capability agents).
    expect(getListingUnitCost(relay.moteDb, "atom")).toBeCloseTo(0.005, 6);
  });

  it("prices the WORKER's capability, never the delegator's — a $0.25 researcher paying a $0.003 atom is $0.003", () => {
    // The bug: a P2P sub-hop was priced against the URL agent (the DELEGATOR),
    // so a $0.25 researcher paying a $0.003 atom was checked against $0.25.
    seedListing("researcher", [{ capability: "research", unit_cost: 0.25 }]);
    seedListing("atom", [
      { capability: "web_search", unit_cost: 0.003 },
      { capability: "read_url", unit_cost: 0.002 },
    ]);
    // Pricing the WORKER (atom) for the pinned capability — NOT the delegator's $0.25.
    expect(getListingUnitCost(relay.moteDb, "atom", "web_search")).toBe(0.003);
    expect(getListingUnitCost(relay.moteDb, "researcher", "research")).toBe(0.25);
  });

  it("returns 0 for an unknown agent or a capability the agent does not list", () => {
    seedListing("atom", [{ capability: "web_search", unit_cost: 0.003 }]);
    expect(getListingUnitCost(relay.moteDb, "atom", "read_url")).toBe(0); // not listed
    expect(getListingUnitCost(relay.moteDb, "ghost", "web_search")).toBe(0); // no listing
  });
});
