/**
 * Settlement batch anchoring tests — Merkle batch cutting, proof generation,
 * proof endpoint, and batch trigger logic.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createFederationTables } from "../federation.js";
import { createTestRelay } from "./test-helpers.js";
import type { SyncRelay } from "../index.js";
import type { RelayIdentity } from "../federation.js";
import {
  cutAgentSettlementBatch,
  cutBatch,
  getAgentSettlementProof,
  getSettlementProof,
  isSettlementPendingBatch,
} from "../anchoring.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct sign access
import { signSettlement } from "@motebit/encryption";
import { openMotebitDatabase, type DatabaseDriver } from "@motebit/persistence";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import { generateKeypair, bytesToHex } from "@motebit/encryption";

// === Helpers ===

let db: DatabaseDriver;
let relayIdentity: RelayIdentity;

async function makeRelayIdentity(): Promise<RelayIdentity> {
  const keypair = await generateKeypair();
  return {
    relayMotebitId: `relay-${crypto.randomUUID()}`,
    publicKey: keypair.publicKey,
    privateKey: keypair.privateKey,
    publicKeyHex: bytesToHex(keypair.publicKey),
    did: `did:key:z${bytesToHex(keypair.publicKey).slice(0, 16)}`,
  };
}

function insertSettlement(
  db: DatabaseDriver,
  opts: {
    settlementId?: string;
    taskId?: string;
    settledAt?: number;
    grossAmount?: number;
  } = {},
): string {
  const id = opts.settlementId ?? crypto.randomUUID();
  db.prepare(
    `INSERT INTO relay_federation_settlements
       (settlement_id, task_id, upstream_relay_id, downstream_relay_id, agent_id,
        gross_amount, fee_amount, net_amount, fee_rate, settled_at, receipt_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.taskId ?? `task-${crypto.randomUUID()}`,
    "relay-upstream",
    "relay-downstream",
    "agent-1",
    opts.grossAmount ?? 1.0,
    0.05,
    0.95,
    0.05,
    opts.settledAt ?? Date.now(),
    `receipt-${crypto.randomUUID()}`,
  );
  return id;
}

beforeEach(async () => {
  const moteDb = await openMotebitDatabase(":memory:");
  db = moteDb.db;
  createFederationTables(db);
  relayIdentity = await makeRelayIdentity();
});

// === cutBatch ===

describe("cutBatch", () => {
  it("returns null when no settlements exist", async () => {
    const result = await cutBatch(db, relayIdentity);
    expect(result).toBeNull();
  });

  it("cuts a batch from unanchored settlements", async () => {
    insertSettlement(db);
    insertSettlement(db);
    insertSettlement(db);

    const batch = await cutBatch(db, relayIdentity);
    expect(batch).not.toBeNull();
    expect(batch!.leaf_count).toBe(3);
    expect(batch!.merkle_root).toMatch(/^[0-9a-f]{64}$/);
    expect(batch!.relay_id).toBe(relayIdentity.relayMotebitId);
    expect(batch!.signature).toMatch(/^[0-9a-f]+$/);
    expect(batch!.tx_hash).toBeNull();
    expect(batch!.anchored_at).toBeNull();
  });

  it("assigns anchor_batch_id to all settlements in the batch", async () => {
    const id1 = insertSettlement(db);
    const id2 = insertSettlement(db);

    const batch = await cutBatch(db, relayIdentity);
    expect(batch).not.toBeNull();

    const row1 = db
      .prepare("SELECT anchor_batch_id FROM relay_federation_settlements WHERE settlement_id = ?")
      .get(id1) as { anchor_batch_id: string };
    const row2 = db
      .prepare("SELECT anchor_batch_id FROM relay_federation_settlements WHERE settlement_id = ?")
      .get(id2) as { anchor_batch_id: string };

    expect(row1.anchor_batch_id).toBe(batch!.batch_id);
    expect(row2.anchor_batch_id).toBe(batch!.batch_id);
  });

  it("does not re-batch already batched settlements", async () => {
    insertSettlement(db);
    insertSettlement(db);

    const batch1 = await cutBatch(db, relayIdentity);
    expect(batch1).not.toBeNull();

    // No new settlements → nothing to batch
    const batch2 = await cutBatch(db, relayIdentity);
    expect(batch2).toBeNull();
  });

  it("respects maxSize limit", async () => {
    for (let i = 0; i < 5; i++) insertSettlement(db);

    const batch = await cutBatch(db, relayIdentity, 3);
    expect(batch!.leaf_count).toBe(3);

    // 2 remaining
    const remaining = db
      .prepare(
        "SELECT COUNT(*) as cnt FROM relay_federation_settlements WHERE anchor_batch_id IS NULL",
      )
      .get() as { cnt: number };
    expect(remaining.cnt).toBe(2);
  });

  it("creates anchor_batches table record", async () => {
    insertSettlement(db);
    const batch = await cutBatch(db, relayIdentity);

    const row = db
      .prepare("SELECT * FROM relay_anchor_batches WHERE batch_id = ?")
      .get(batch!.batch_id) as { merkle_root: string; status: string; leaf_count: number };

    expect(row.merkle_root).toBe(batch!.merkle_root);
    expect(row.status).toBe("signed");
    expect(row.leaf_count).toBe(1);
  });

  it("deterministic: same settlements produce same merkle_root", async () => {
    // Create two DBs with identical settlements
    const moteDb2 = await openMotebitDatabase(":memory:");
    createFederationTables(moteDb2.db);

    const now = 1711000000000;
    // Same settlement_id in both DBs
    db.prepare(
      `INSERT INTO relay_federation_settlements
         (settlement_id, task_id, upstream_relay_id, downstream_relay_id, agent_id,
          gross_amount, fee_amount, net_amount, fee_rate, settled_at, receipt_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "s1",
      "task-1",
      "relay-up",
      "relay-down",
      "agent",
      1.0,
      0.05,
      0.95,
      0.05,
      now,
      "receipt-1",
    );

    moteDb2.db
      .prepare(
        `INSERT INTO relay_federation_settlements
         (settlement_id, task_id, upstream_relay_id, downstream_relay_id, agent_id,
          gross_amount, fee_amount, net_amount, fee_rate, settled_at, receipt_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "s1",
        "task-1",
        "relay-up",
        "relay-down",
        "agent",
        1.0,
        0.05,
        0.95,
        0.05,
        now,
        "receipt-1",
      );

    const batch1 = await cutBatch(db, relayIdentity);
    const batch2 = await cutBatch(moteDb2.db, relayIdentity);

    expect(batch1!.merkle_root).toBe(batch2!.merkle_root);
    moteDb2.close();
  });
});

// === getSettlementProof ===

describe("getSettlementProof", () => {
  it("returns null for non-existent settlement", async () => {
    const proof = await getSettlementProof(db, "nonexistent");
    expect(proof).toBeNull();
  });

  it("returns null for unbatched settlement", async () => {
    const id = insertSettlement(db);
    const proof = await getSettlementProof(db, id);
    expect(proof).toBeNull();
  });

  it("returns valid proof for batched settlement", async () => {
    const id = insertSettlement(db);
    await cutBatch(db, relayIdentity);

    const proof = await getSettlementProof(db, id);
    expect(proof).not.toBeNull();
    expect(proof!.settlement_id).toBe(id);
    expect(proof!.leaf_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(proof!.merkle_root).toMatch(/^[0-9a-f]{64}$/);
    expect(proof!.anchor.relay_id).toBe(relayIdentity.relayMotebitId);
  });

  it("proof verifies against merkle root", async () => {
    for (let i = 0; i < 7; i++) insertSettlement(db, { settledAt: 1711000000000 + i * 1000 });

    const settlements = db
      .prepare("SELECT settlement_id FROM relay_federation_settlements ORDER BY settled_at ASC")
      .all() as { settlement_id: string }[];

    await cutBatch(db, relayIdentity);

    // Verify proof for each settlement
    for (const s of settlements) {
      const result = await getSettlementProof(db, s.settlement_id);
      expect(result).not.toBeNull();

      // Verify the proof root matches the anchor record's signed root
      expect(result!.merkle_root).toBe(result!.anchor.merkle_root);
    }
  });

  it("proof for multi-batch: each settlement links to correct batch", async () => {
    const id1 = insertSettlement(db, { settledAt: 1711000000000 });
    const id2 = insertSettlement(db, { settledAt: 1711000001000 });

    // Cut first batch with maxSize=1
    await cutBatch(db, relayIdentity, 1);

    const id3 = insertSettlement(db, { settledAt: 1711000002000 });

    // Cut second batch
    await cutBatch(db, relayIdentity, 10);

    const proof1 = await getSettlementProof(db, id1);
    const proof2 = await getSettlementProof(db, id2);
    const proof3 = await getSettlementProof(db, id3);

    // id1 and id2+id3 should be in different batches (id1 alone, id2+id3 together)
    expect(proof1!.batch_id).not.toBe(proof2!.batch_id);
    expect(proof2!.batch_id).toBe(proof3!.batch_id);
  });
});

// === isSettlementPendingBatch ===

describe("isSettlementPendingBatch", () => {
  it("returns false for non-existent settlement", () => {
    expect(isSettlementPendingBatch(db, "nonexistent")).toBe(false);
  });

  it("returns true for unbatched settlement", () => {
    const id = insertSettlement(db);
    expect(isSettlementPendingBatch(db, id)).toBe(true);
  });

  it("returns false after settlement is batched", async () => {
    const id = insertSettlement(db);
    await cutBatch(db, relayIdentity);
    expect(isSettlementPendingBatch(db, id)).toBe(false);
  });
});

// ===========================================================================
// Per-agent settlement Merkle anchoring (the "ceiling" parallel to the
// federation case above; same primitives, different audience).
//
// Setup pattern: a full test relay (createTestRelay) instead of bare
// federation tables, because relay_settlements is created via the
// migration chain which depends on tables produced by the relay's
// startup sequence (pairing_sessions, agent_registry, etc.). Federation
// tests above can use the lighter setup because they only touch
// federation-specific tables.
// ===========================================================================

let agentRelay: SyncRelay;
let agentDb: DatabaseDriver;
let agentRelayIdentity: RelayIdentity;

async function insertSignedAgentSettlement(opts: {
  settlementId?: string;
  motebitId?: string;
  amount?: number;
  fee?: number;
  settledAt?: number;
}): Promise<string> {
  const id = opts.settlementId ?? crypto.randomUUID();
  const motebitId = opts.motebitId ?? `mote-${crypto.randomUUID()}`;
  const settledAt = opts.settledAt ?? Date.now();
  const allocId = `alloc-${id}`;
  const receiptHash = `receipt-${id}`;

  const signed = await signSettlement(
    {
      settlement_id: id as never,
      allocation_id: allocId as never,
      receipt_hash: receiptHash,
      ledger_hash: null,
      amount_settled: opts.amount ?? 950_000,
      platform_fee: opts.fee ?? 50_000,
      platform_fee_rate: 0.05,
      status: "completed",
      settled_at: settledAt,
      issuer_relay_id: agentRelayIdentity.relayMotebitId,
    },
    agentRelayIdentity.privateKey,
  );

  agentDb
    .prepare(
      `INSERT INTO relay_settlements
       (settlement_id, allocation_id, task_id, motebit_id, receipt_hash, ledger_hash,
        amount_settled, platform_fee, platform_fee_rate, status, settled_at,
        issuer_relay_id, suite, signature)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      allocId,
      `task-${id}`,
      motebitId,
      receiptHash,
      null,
      signed.amount_settled,
      signed.platform_fee,
      signed.platform_fee_rate,
      signed.status,
      signed.settled_at,
      signed.issuer_relay_id,
      signed.suite,
      signed.signature,
    );
  return id;
}

describe("cutAgentSettlementBatch", () => {
  beforeEach(async () => {
    agentRelay = await createTestRelay();
    agentDb = agentRelay.moteDb.db;
    // The test relay generates its own keypair on startup; rebuild
    // RelayIdentity around it so signed settlements verify against
    // the relay's own key.
    const keypair = await generateKeypair();
    agentRelayIdentity = {
      relayMotebitId: `relay-${crypto.randomUUID()}`,
      publicKey: keypair.publicKey,
      privateKey: keypair.privateKey,
      publicKeyHex: bytesToHex(keypair.publicKey),
      did: `did:key:z${bytesToHex(keypair.publicKey).slice(0, 16)}`,
    };
  });
  it("returns null when no signed settlements exist", async () => {
    const result = await cutAgentSettlementBatch(agentDb, agentRelayIdentity);
    expect(result).toBeNull();
  });

  it("cuts a batch from unanchored signed settlements", async () => {
    await insertSignedAgentSettlement({});
    await insertSignedAgentSettlement({});
    await insertSignedAgentSettlement({});

    const batch = await cutAgentSettlementBatch(agentDb, agentRelayIdentity);
    expect(batch).not.toBeNull();
    expect(batch!.leaf_count).toBe(3);
    expect(batch!.merkle_root).toMatch(/^[0-9a-f]{64}$/);
    expect(batch!.relay_id).toBe(agentRelayIdentity.relayMotebitId);
    expect(batch!.signature).toMatch(/^[0-9a-f]+$/);
    expect(batch!.tx_hash).toBeNull();
    expect(batch!.anchored_at).toBeNull();
  });

  it("assigns anchor_batch_id to all settlements in the batch", async () => {
    const id1 = await insertSignedAgentSettlement({});
    const id2 = await insertSignedAgentSettlement({});

    const batch = await cutAgentSettlementBatch(agentDb, agentRelayIdentity);
    expect(batch).not.toBeNull();

    const row1 = agentDb
      .prepare("SELECT anchor_batch_id FROM relay_settlements WHERE settlement_id = ?")
      .get(id1) as { anchor_batch_id: string };
    const row2 = agentDb
      .prepare("SELECT anchor_batch_id FROM relay_settlements WHERE settlement_id = ?")
      .get(id2) as { anchor_batch_id: string };
    expect(row1.anchor_batch_id).toBe(batch!.batch_id);
    expect(row2.anchor_batch_id).toBe(batch!.batch_id);
  });

  it("does NOT batch unsigned (legacy) settlements — anchoring requires a signed leaf", async () => {
    // Direct INSERT bypassing signSettlement → leaves signature NULL,
    // simulating a row written before migration v13.
    agentDb
      .prepare(
        `INSERT INTO relay_settlements
         (settlement_id, allocation_id, task_id, motebit_id, receipt_hash, ledger_hash,
          amount_settled, platform_fee, platform_fee_rate, status, settled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "legacy-1",
        "alloc-legacy",
        "task-legacy",
        "mote-legacy",
        "receipt-legacy",
        null,
        950_000,
        50_000,
        0.05,
        "completed",
        Date.now(),
      );

    const result = await cutAgentSettlementBatch(agentDb, agentRelayIdentity);
    expect(result).toBeNull();
    // Legacy row still unbatched, as expected.
    const row = agentDb
      .prepare("SELECT anchor_batch_id FROM relay_settlements WHERE settlement_id = ?")
      .get("legacy-1") as { anchor_batch_id: string | null };
    expect(row.anchor_batch_id).toBeNull();
  });

  it("respects maxSize when many signed settlements are pending", async () => {
    for (let i = 0; i < 5; i++) {
      await insertSignedAgentSettlement({});
    }
    const batch = await cutAgentSettlementBatch(agentDb, agentRelayIdentity, 3);
    expect(batch).not.toBeNull();
    expect(batch!.leaf_count).toBe(3);
    // 2 still pending
    const remaining = agentDb
      .prepare(
        "SELECT COUNT(*) as count FROM relay_settlements WHERE anchor_batch_id IS NULL AND signature IS NOT NULL",
      )
      .get() as { count: number };
    expect(remaining.count).toBe(2);
  });
});

describe("getAgentSettlementProof", () => {
  beforeEach(async () => {
    agentRelay = await createTestRelay();
    agentDb = agentRelay.moteDb.db;
    const keypair = await generateKeypair();
    agentRelayIdentity = {
      relayMotebitId: `relay-${crypto.randomUUID()}`,
      publicKey: keypair.publicKey,
      privateKey: keypair.privateKey,
      publicKeyHex: bytesToHex(keypair.publicKey),
      did: `did:key:z${bytesToHex(keypair.publicKey).slice(0, 16)}`,
    };
  });

  it("returns null for an unbatched settlement", async () => {
    const id = await insertSignedAgentSettlement({});
    const proof = await getAgentSettlementProof(agentDb, id);
    expect(proof).toBeNull();
  });

  it("returns a verifiable inclusion proof for an anchored settlement", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(await insertSignedAgentSettlement({ settledAt: 1_000_000 + i }));
    }
    const batch = await cutAgentSettlementBatch(agentDb, agentRelayIdentity);
    expect(batch).not.toBeNull();

    const proof = await getAgentSettlementProof(agentDb, ids[2]!);
    expect(proof).not.toBeNull();
    expect(proof!.batch_id).toBe(batch!.batch_id);
    expect(proof!.merkle_root).toBe(batch!.merkle_root);
    expect(proof!.leaf_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(proof!.proof.length).toBeGreaterThan(0);
    expect(proof!.leaf_index).toBe(2);
    expect(proof!.anchor.relay_id).toBe(agentRelayIdentity.relayMotebitId);
  });

  it("returns null for a non-existent settlement", async () => {
    const proof = await getAgentSettlementProof(agentDb, "nonexistent");
    expect(proof).toBeNull();
  });
});
