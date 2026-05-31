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
  getAgentAnchorBatch,
  getAgentSettlementProof,
  getSettlementProof,
  isAgentSettlementPendingBatch,
  isSettlementPendingBatch,
} from "../anchoring.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct sign access
import { signSettlement, signFederationSettlement, canonicalJson } from "@motebit/encryption";
import {
  verifyAgentSettlementAnchor,
  computeAgentSettlementLeaf,
  verifyFederationSettlementAnchor,
} from "@motebit/crypto";
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

// Insert a federation settlement carrying the verbatim signed record_json the
// §9.1 convergence requires (the relay signs its own copy; the anchor leaf is
// SHA-256 of canonicalJson(record)). Mirrors federation-callbacks.ts. Returns
// the settlement id (callers must `await` — signing is async).
async function insertSettlement(
  db: DatabaseDriver,
  opts: {
    settlementId?: string;
    taskId?: string;
    settledAt?: number;
    grossAmount?: number;
  } = {},
): Promise<string> {
  const id = opts.settlementId ?? crypto.randomUUID();
  const taskId = opts.taskId ?? `task-${crypto.randomUUID()}`;
  const settledAt = opts.settledAt ?? Date.now();
  const grossAmount = opts.grossAmount ?? 1.0;
  const receiptHash = `receipt-${crypto.randomUUID()}`;
  const signedRecord = await signFederationSettlement(
    {
      settlement_id: id,
      task_id: taskId,
      upstream_relay_id: "relay-upstream",
      downstream_relay_id: "relay-downstream",
      agent_id: "agent-1",
      gross_amount: grossAmount,
      fee_amount: 0.05,
      net_amount: 0.95,
      fee_rate: 0.05,
      receipt_hash: receiptHash,
      settled_at: settledAt,
      issuer_relay_id: relayIdentity.relayMotebitId,
    },
    relayIdentity.privateKey,
  );
  db.prepare(
    `INSERT INTO relay_federation_settlements
       (settlement_id, task_id, upstream_relay_id, downstream_relay_id, agent_id,
        gross_amount, fee_amount, net_amount, fee_rate, settled_at, receipt_hash, record_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    taskId,
    "relay-upstream",
    "relay-downstream",
    "agent-1",
    grossAmount,
    0.05,
    0.95,
    0.05,
    settledAt,
    receiptHash,
    canonicalJson(signedRecord),
  );
  return id;
}

beforeEach(async () => {
  const moteDb = await openMotebitDatabase(":memory:");
  db = moteDb.db;
  createFederationTables(db);
  relayIdentity = await makeRelayIdentity();
  // The proof-serve path resolves the relay's public key from relay_identity
  // (so a peer's `verifyFederationSettlementAnchor` can check the batch
  // signature). Seed it with the test identity's real key.
  db.prepare(
    `INSERT INTO relay_identity (relay_motebit_id, public_key, private_key_hex, did, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    relayIdentity.relayMotebitId,
    relayIdentity.publicKeyHex,
    bytesToHex(relayIdentity.privateKey),
    relayIdentity.did,
    Date.now(),
  );
});

// === cutBatch ===

describe("cutBatch", () => {
  it("returns null when no settlements exist", async () => {
    const result = await cutBatch(db, relayIdentity);
    expect(result).toBeNull();
  });

  it("cuts a batch from unanchored settlements", async () => {
    await insertSettlement(db);
    await insertSettlement(db);
    await insertSettlement(db);

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
    const id1 = await insertSettlement(db);
    const id2 = await insertSettlement(db);

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
    await insertSettlement(db);
    await insertSettlement(db);

    const batch1 = await cutBatch(db, relayIdentity);
    expect(batch1).not.toBeNull();

    // No new settlements → nothing to batch
    const batch2 = await cutBatch(db, relayIdentity);
    expect(batch2).toBeNull();
  });

  it("respects maxSize limit", async () => {
    for (let i = 0; i < 5; i++) await insertSettlement(db);

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
    await insertSettlement(db);
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
    // Same signed record_json in both DBs — the leaf is SHA-256 of these exact
    // bytes, and signing is deterministic for a fixed key + input, so the two
    // roots must match. (Insert the identical canonical bytes into both.)
    const signedRecord = await signFederationSettlement(
      {
        settlement_id: "s1",
        task_id: "task-1",
        upstream_relay_id: "relay-up",
        downstream_relay_id: "relay-down",
        agent_id: "agent",
        gross_amount: 1.0,
        fee_amount: 0.05,
        net_amount: 0.95,
        fee_rate: 0.05,
        receipt_hash: "receipt-1",
        settled_at: now,
        issuer_relay_id: relayIdentity.relayMotebitId,
      },
      relayIdentity.privateKey,
    );
    const recordJson = canonicalJson(signedRecord);
    const insertSql = `INSERT INTO relay_federation_settlements
         (settlement_id, task_id, upstream_relay_id, downstream_relay_id, agent_id,
          gross_amount, fee_amount, net_amount, fee_rate, settled_at, receipt_hash, record_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const args = [
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
      recordJson,
    ] as const;
    db.prepare(insertSql).run(...args);
    moteDb2.db.prepare(insertSql).run(...args);

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
    const id = await insertSettlement(db);
    const proof = await getSettlementProof(db, id);
    expect(proof).toBeNull();
  });

  it("returns valid proof for batched settlement", async () => {
    const id = await insertSettlement(db);
    await cutBatch(db, relayIdentity);

    const result = await getSettlementProof(db, id);
    expect(result).not.toBeNull();
    const { proof, record } = result!;
    expect(proof.settlement_id).toBe(id);
    expect(proof.settlement_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(proof.merkle_root).toMatch(/^[0-9a-f]{64}$/);
    expect(proof.relay_id).toBe(relayIdentity.relayMotebitId);
    // The producer emits v2 (the §9.1 convergence flips federation to RFC 6962).
    expect(proof.tree_hash_version).toBe("merkle-sha256-rfc6962-v2");
    // The served record is the exact artifact the leaf commits.
    expect(record.settlement_id).toBe(id);
    expect(record.issuer_relay_id).toBe(relayIdentity.relayMotebitId);
  });

  it("proof self-verifies offline via verifyFederationSettlementAnchor", async () => {
    for (let i = 0; i < 7; i++) await insertSettlement(db, { settledAt: 1711000000000 + i * 1000 });

    const settlements = db
      .prepare("SELECT settlement_id FROM relay_federation_settlements ORDER BY settled_at ASC")
      .all() as { settlement_id: string }[];

    await cutBatch(db, relayIdentity);

    // Each peer reconstructs the leaf from the held record and walks the Merkle
    // path to the relay-signed root — fully offline, with only @motebit/crypto.
    for (const s of settlements) {
      const result = await getSettlementProof(db, s.settlement_id);
      expect(result).not.toBeNull();
      const { proof, record } = result!;
      const verdict = await verifyFederationSettlementAnchor(
        record as unknown as Record<string, unknown>,
        proof,
      );
      expect(verdict.valid).toBe(true);
      expect(verdict.steps.hash_valid).toBe(true);
      expect(verdict.steps.merkle_valid).toBe(true);
      expect(verdict.steps.relay_signature_valid).toBe(true);
    }
  });

  it("rejects a tampered record (leaf no longer reproduces)", async () => {
    const id = await insertSettlement(db);
    await cutBatch(db, relayIdentity);

    const result = await getSettlementProof(db, id);
    expect(result).not.toBeNull();
    const { proof, record } = result!;
    // Mutate the held record — the recomputed leaf diverges from the anchored one.
    const tampered = { ...record, gross_amount: record.gross_amount + 1 };
    const verdict = await verifyFederationSettlementAnchor(
      tampered as unknown as Record<string, unknown>,
      proof,
    );
    expect(verdict.valid).toBe(false);
    expect(verdict.steps.hash_valid).toBe(false);
  });

  it("proof for multi-batch: each settlement links to correct batch", async () => {
    const id1 = await insertSettlement(db, { settledAt: 1711000000000 });
    const id2 = await insertSettlement(db, { settledAt: 1711000001000 });

    // Cut first batch with maxSize=1
    await cutBatch(db, relayIdentity, 1);

    const id3 = await insertSettlement(db, { settledAt: 1711000002000 });

    // Cut second batch
    await cutBatch(db, relayIdentity, 10);

    const proof1 = await getSettlementProof(db, id1);
    const proof2 = await getSettlementProof(db, id2);
    const proof3 = await getSettlementProof(db, id3);

    // id1 and id2+id3 should be in different batches (id1 alone, id2+id3 together)
    expect(proof1!.proof.batch_id).not.toBe(proof2!.proof.batch_id);
    expect(proof2!.proof.batch_id).toBe(proof3!.proof.batch_id);
  });
});

// === isSettlementPendingBatch ===

describe("isSettlementPendingBatch", () => {
  it("returns false for non-existent settlement", () => {
    expect(isSettlementPendingBatch(db, "nonexistent")).toBe(false);
  });

  it("returns true for unbatched settlement", async () => {
    const id = await insertSettlement(db);
    expect(isSettlementPendingBatch(db, id)).toBe(true);
  });

  it("returns false after settlement is batched", async () => {
    const id = await insertSettlement(db);
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

/**
 * Spin up a test relay and reuse its real on-disk relay_identity for
 * batch signing. The proof-serve path looks up the relay's public key
 * from the relay_identity table; using the test relay's actual key here
 * means the round-trip (sign batch → serve proof → verify signature)
 * tests the production wiring instead of a synthetic shortcut.
 */
async function setupAgentTestRelay(): Promise<void> {
  agentRelay = await createTestRelay();
  agentDb = agentRelay.moteDb.db;
  const row = agentDb.prepare("SELECT * FROM relay_identity").get() as {
    relay_motebit_id: string;
    public_key: string;
    private_key_hex: string;
    did: string;
  };
  const pubBytes = new Uint8Array(row.public_key.length / 2);
  for (let i = 0; i < row.public_key.length; i += 2) {
    pubBytes[i / 2] = parseInt(row.public_key.slice(i, i + 2), 16);
  }
  const privBytes = new Uint8Array(row.private_key_hex.length / 2);
  for (let i = 0; i < row.private_key_hex.length; i += 2) {
    privBytes[i / 2] = parseInt(row.private_key_hex.slice(i, i + 2), 16);
  }
  agentRelayIdentity = {
    relayMotebitId: row.relay_motebit_id,
    publicKey: pubBytes,
    privateKey: privBytes,
    publicKeyHex: row.public_key,
    did: row.did,
  };
}

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
      motebit_id: motebitId as never,
      receipt_hash: receiptHash,
      ledger_hash: null,
      amount_settled: opts.amount ?? 950_000,
      platform_fee: opts.fee ?? 50_000,
      platform_fee_rate: 0.05,
      settlement_mode: "relay",
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
        settlement_mode, issuer_relay_id, suite, signature, record_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      signed.settlement_mode,
      signed.issuer_relay_id,
      signed.suite,
      signed.signature,
      canonicalJson(signed),
    );
  return id;
}

describe("cutAgentSettlementBatch", () => {
  beforeEach(async () => {
    await setupAgentTestRelay();
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
    await setupAgentTestRelay();
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
    expect(proof!.settlement_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(proof!.siblings.length).toBeGreaterThan(0);
    expect(proof!.layer_sizes.length).toBeGreaterThan(0);
    expect(proof!.leaf_index).toBe(2);
    expect(proof!.relay_id).toBe(agentRelayIdentity.relayMotebitId);
    expect(proof!.relay_public_key).toBe(agentRelayIdentity.publicKeyHex);
    expect(proof!.suite).toBe("motebit-jcs-ed25519-hex-v1");
    expect(proof!.batch_signature).toMatch(/^[0-9a-f]+$/);
    expect(proof!.anchor).toBeNull(); // not yet onchain
  });

  it("returns null for a non-existent settlement", async () => {
    const proof = await getAgentSettlementProof(agentDb, "nonexistent");
    expect(proof).toBeNull();
  });
});

describe("isAgentSettlementPendingBatch", () => {
  beforeEach(async () => {
    await setupAgentTestRelay();
  });

  it("returns false for a non-existent settlement", () => {
    expect(isAgentSettlementPendingBatch(agentDb, "nonexistent")).toBe(false);
  });

  it("returns true for a signed unbatched settlement", async () => {
    const id = await insertSignedAgentSettlement({});
    expect(isAgentSettlementPendingBatch(agentDb, id)).toBe(true);
  });

  it("returns false after the settlement is batched", async () => {
    const id = await insertSignedAgentSettlement({});
    await cutAgentSettlementBatch(agentDb, agentRelayIdentity);
    expect(isAgentSettlementPendingBatch(agentDb, id)).toBe(false);
  });

  it("returns false for an unsigned legacy row (cannot be batched)", async () => {
    agentDb
      .prepare(
        `INSERT INTO relay_settlements
           (settlement_id, allocation_id, task_id, motebit_id, receipt_hash, ledger_hash,
            amount_settled, platform_fee, platform_fee_rate, status, settled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "legacy-2",
        "alloc-legacy-2",
        "task-legacy-2",
        "mote-legacy-2",
        "rh",
        null,
        0,
        0,
        0,
        "completed",
        1,
      );
    expect(isAgentSettlementPendingBatch(agentDb, "legacy-2")).toBe(false);
  });
});

describe("getAgentAnchorBatch", () => {
  beforeEach(async () => {
    await setupAgentTestRelay();
  });

  it("returns null for an unknown batch_id", () => {
    expect(getAgentAnchorBatch(agentDb, "nonexistent")).toBeNull();
  });

  it("returns the batch metadata after cut", async () => {
    await insertSignedAgentSettlement({});
    await insertSignedAgentSettlement({});
    const cut = await cutAgentSettlementBatch(agentDb, agentRelayIdentity);
    expect(cut).not.toBeNull();
    const batch = getAgentAnchorBatch(agentDb, cut!.batch_id);
    expect(batch).not.toBeNull();
    expect(batch!.batch_id).toBe(cut!.batch_id);
    expect(batch!.merkle_root).toBe(cut!.merkle_root);
    expect(batch!.relay_id).toBe(agentRelayIdentity.relayMotebitId);
    expect(batch!.suite).toBe("motebit-jcs-ed25519-hex-v1");
    expect(batch!.signature).toMatch(/^[0-9a-f]+$/);
    expect(batch!.anchor).toBeNull(); // not yet onchain
  });
});

// ===========================================================================
// The SCITT / RFC 6962 round-trip: a third party who holds ONLY the signed
// SettlementRecord, the inclusion proof, and the relay's public key (carried
// in the proof) verifies offline that the relay anchored exactly that record.
// This is the proof the architecture actually closes the self-attesting loop
// — not just that the proof has the right shape. It exercises the REAL
// producer (cutAgentSettlementBatch + getAgentSettlementProof) against the
// REAL portable verifier (@motebit/crypto verifyAgentSettlementAnchor).
// ===========================================================================

describe("verifyAgentSettlementAnchor — third-party round-trip", () => {
  beforeEach(async () => {
    await setupAgentTestRelay();
  });

  /** Sign a SettlementRecord and persist it exactly as the relay does
   *  (record_json = the canonical signed bytes). Returns the record the
   *  worker would hold. */
  async function signAndInsert(
    opts: { settlementMode?: "relay" | "p2p"; x402TxHash?: string; x402Network?: string } = {},
  ): Promise<{ id: string; record: Awaited<ReturnType<typeof signSettlement>> }> {
    const id = crypto.randomUUID();
    const record = await signSettlement(
      {
        settlement_id: id as never,
        allocation_id: `alloc-${id}` as never,
        motebit_id: `mote-${id}` as never,
        receipt_hash: `receipt-${id}`,
        ledger_hash: null,
        amount_settled: 950_000,
        platform_fee: 50_000,
        platform_fee_rate: 0.05,
        settlement_mode: opts.settlementMode ?? "relay",
        status: "completed",
        settled_at: Date.now(),
        ...(opts.x402TxHash != null ? { x402_tx_hash: opts.x402TxHash } : {}),
        ...(opts.x402Network != null ? { x402_network: opts.x402Network } : {}),
        issuer_relay_id: agentRelayIdentity.relayMotebitId,
      },
      agentRelayIdentity.privateKey,
    );
    agentDb
      .prepare(
        `INSERT INTO relay_settlements
           (settlement_id, allocation_id, task_id, motebit_id, receipt_hash, ledger_hash,
            amount_settled, platform_fee, platform_fee_rate, status, settled_at,
            settlement_mode, x402_tx_hash, x402_network, issuer_relay_id, suite, signature, record_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.settlement_id,
        record.allocation_id,
        `task-${id}`,
        record.motebit_id,
        record.receipt_hash,
        record.ledger_hash,
        record.amount_settled,
        record.platform_fee,
        record.platform_fee_rate,
        record.status,
        record.settled_at,
        record.settlement_mode,
        record.x402_tx_hash ?? null,
        record.x402_network ?? null,
        record.issuer_relay_id,
        record.suite,
        record.signature,
        canonicalJson(record),
      );
    return { id, record };
  }

  it("verifies with only (record, proof) — proof carries the relay public key", async () => {
    const { id, record } = await signAndInsert();
    // Siblings so the Merkle path is non-trivial (not a single-leaf root).
    await insertSignedAgentSettlement({});
    await insertSignedAgentSettlement({});

    await cutAgentSettlementBatch(agentDb, agentRelayIdentity);
    const proof = await getAgentSettlementProof(agentDb, id);
    expect(proof).not.toBeNull();

    const result = await verifyAgentSettlementAnchor(
      record as unknown as Record<string, unknown>,
      proof!,
    );
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.steps.hash_valid).toBe(true);
    expect(result.steps.merkle_valid).toBe(true);
    expect(result.steps.relay_signature_valid).toBe(true);
  });

  it("rejects a record whose fields were tampered after signing", async () => {
    const { id, record } = await signAndInsert();
    await insertSignedAgentSettlement({});
    await cutAgentSettlementBatch(agentDb, agentRelayIdentity);
    const proof = await getAgentSettlementProof(agentDb, id);

    // A worker who claims they were paid more than the relay signed: the
    // held record no longer hashes to the anchored leaf.
    const tampered = { ...record, amount_settled: 999_999_999 };
    const bad = await verifyAgentSettlementAnchor(
      tampered as unknown as Record<string, unknown>,
      proof!,
    );
    expect(bad.valid).toBe(false);
    expect(bad.steps.hash_valid).toBe(false);
  });

  it("verifies an x402-paid settlement (optional fields are anchored verbatim)", async () => {
    // The old column-projection leaf dropped x402 fields → this case is
    // exactly what would have silently failed before.
    const { id, record } = await signAndInsert({
      settlementMode: "p2p",
      x402TxHash: "0xabc123",
      x402Network: "eip155:8453",
    });
    await insertSignedAgentSettlement({});
    await cutAgentSettlementBatch(agentDb, agentRelayIdentity);
    const proof = await getAgentSettlementProof(agentDb, id);

    expect(record.x402_tx_hash).toBe("0xabc123");
    const result = await verifyAgentSettlementAnchor(
      record as unknown as Record<string, unknown>,
      proof!,
    );
    expect(result.valid).toBe(true);
  });

  // === PR2: agent-settlement is the first v2 producer ===================

  it("stamps tree_hash_version = merkle-sha256-rfc6962-v2 and applies the v2 leaf tag (rule c)", async () => {
    const { id, record } = await signAndInsert();
    await insertSignedAgentSettlement({});
    await insertSignedAgentSettlement({});
    await cutAgentSettlementBatch(agentDb, agentRelayIdentity); // defaults to v2
    const proof = await getAgentSettlementProof(agentDb, id);
    expect(proof).not.toBeNull();

    // A v2 producer MUST emit the field (no "v2 behavior, absent field").
    expect(proof!.tree_hash_version).toBe("merkle-sha256-rfc6962-v2");

    // The anchored leaf carries the RFC 6962 §2.1 `0x00` tag: it equals the
    // worker's v2 leaf and differs from the v1 (untagged) leaf — proof the
    // producer actually applied the tag, not just set a flag.
    const rec = record as unknown as Record<string, unknown>;
    const v2Leaf = await computeAgentSettlementLeaf(rec, "merkle-sha256-rfc6962-v2");
    const v1Leaf = await computeAgentSettlementLeaf(rec, "merkle-sha256-plain-v1");
    expect(proof!.settlement_hash).toBe(v2Leaf);
    expect(v2Leaf).not.toBe(v1Leaf);

    // End-to-end producer/verifier symmetry under the v2 leaf + node tags.
    const result = await verifyAgentSettlementAnchor(rec, proof!);
    expect(result.valid).toBe(true);
    expect(result.steps.merkle_valid).toBe(true);
    expect(result.steps.relay_signature_valid).toBe(true);
  });

  it("a legacy v1 batch (NULL column) omits the field and still verifies (absent ⇒ v1)", async () => {
    const { id, record } = await signAndInsert();
    await insertSignedAgentSettlement({});
    await insertSignedAgentSettlement({});
    // Cut explicitly under v1 — the column stores NULL, exactly the shape a
    // pre-PR2 (migration-backfilled) batch has. Proves the proof endpoint
    // reconstructs each batch under ITS stored version, not a global default.
    await cutAgentSettlementBatch(agentDb, agentRelayIdentity, 100, "merkle-sha256-plain-v1");
    const batchRow = agentDb
      .prepare("SELECT tree_hash_version FROM relay_agent_anchor_batches LIMIT 1")
      .get() as { tree_hash_version: string | null };
    expect(batchRow.tree_hash_version).toBeNull();

    const proof = await getAgentSettlementProof(agentDb, id);
    expect(proof).not.toBeNull();
    // Legacy never re-emits the v1 id — the field is absent (⇒ v1).
    expect(proof!.tree_hash_version).toBeUndefined();

    const result = await verifyAgentSettlementAnchor(
      record as unknown as Record<string, unknown>,
      proof!,
    );
    expect(result.valid).toBe(true);
    expect(result.steps.merkle_valid).toBe(true);
  });
});

// ===========================================================================
// HTTP endpoint integration tests for the per-agent anchor proof routes.
// ===========================================================================

describe("GET /api/v1/settlements/:settlementId/anchor-proof", () => {
  beforeEach(async () => {
    await setupAgentTestRelay();
  });

  it("returns 404 for an unknown settlement", async () => {
    const res = await agentRelay.app.request("/api/v1/settlements/unknown-id/anchor-proof");
    expect(res.status).toBe(404);
  });

  it("returns 202 with Retry-After when settlement is signed but not yet batched", async () => {
    const id = await insertSignedAgentSettlement({});
    const res = await agentRelay.app.request(`/api/v1/settlements/${id}/anchor-proof`);
    expect(res.status).toBe(202);
    expect(res.headers.get("Retry-After")).toBe("60");
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("pending");
  });

  it("returns 200 with the inclusion proof after batching", async () => {
    const id = await insertSignedAgentSettlement({});
    await cutAgentSettlementBatch(agentDb, agentRelayIdentity);

    const res = await agentRelay.app.request(`/api/v1/settlements/${id}/anchor-proof`);
    expect(res.status).toBe(200);
    const proof = (await res.json()) as {
      settlement_id: string;
      settlement_hash: string;
      siblings: string[];
      layer_sizes: number[];
      leaf_index: number;
      merkle_root: string;
      batch_id: string;
      relay_id: string;
      relay_public_key: string;
      suite: string;
      batch_signature: string;
      anchor: unknown;
    };
    // Spec'd shape — spec/agent-settlement-anchor-v1.md §5.1
    expect(proof.settlement_id).toBe(id);
    expect(proof.settlement_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(proof.merkle_root).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof proof.batch_id).toBe("string");
    expect(proof.suite).toBe("motebit-jcs-ed25519-hex-v1");
    expect(proof.relay_public_key).toBe(agentRelayIdentity.publicKeyHex);
    expect(proof.batch_signature).toMatch(/^[0-9a-f]+$/);
    expect(proof.anchor).toBeNull();
  });
});

describe("GET /api/v1/settlement-anchors/:batchId", () => {
  beforeEach(async () => {
    await setupAgentTestRelay();
  });

  it("returns 404 for an unknown batch", async () => {
    const res = await agentRelay.app.request("/api/v1/settlement-anchors/unknown-batch");
    expect(res.status).toBe(404);
  });

  it("returns the batch metadata after a cut", async () => {
    await insertSignedAgentSettlement({});
    const cut = await cutAgentSettlementBatch(agentDb, agentRelayIdentity);
    const res = await agentRelay.app.request(`/api/v1/settlement-anchors/${cut!.batch_id}`);
    expect(res.status).toBe(200);
    const batch = (await res.json()) as {
      batch_id: string;
      merkle_root: string;
      leaf_count: number;
      relay_id: string;
      suite: string;
      signature: string;
      anchor: unknown;
    };
    // Spec'd shape — spec/agent-settlement-anchor-v1.md §4.1
    expect(batch.batch_id).toBe(cut!.batch_id);
    expect(batch.leaf_count).toBe(1);
    expect(batch.relay_id).toBe(agentRelayIdentity.relayMotebitId);
    expect(batch.suite).toBe("motebit-jcs-ed25519-hex-v1");
    expect(batch.signature).toMatch(/^[0-9a-f]+$/);
    expect(batch.anchor).toBeNull(); // not yet onchain
  });
});
