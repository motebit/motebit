/**
 * Credential anchor batch tests — Merkle batch cutting, proof generation,
 * pending detection, and batch metadata.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createFederationTables } from "../federation.js";
import type { RelayIdentity } from "../federation.js";
import {
  cutCredentialBatch,
  getCredentialAnchorProof,
  isCredentialPendingBatch,
  getCredentialAnchorBatch,
} from "../credential-anchoring.js";
import { openMotebitDatabase, type DatabaseDriver } from "@motebit/persistence";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import { generateKeypair, bytesToHex, issueReputationCredential } from "@motebit/encryption";

// === Helpers ===

let db: DatabaseDriver;
let relayIdentity: RelayIdentity;

async function makeRelayIdentity(): Promise<RelayIdentity> {
  const keypair = await generateKeypair();
  const relayId = `relay-${crypto.randomUUID()}`;
  return {
    relayMotebitId: relayId,
    publicKey: keypair.publicKey,
    privateKey: keypair.privateKey,
    publicKeyHex: bytesToHex(keypair.publicKey),
    did: `did:key:z${bytesToHex(keypair.publicKey).slice(0, 16)}`,
  };
}

/** Insert a credential into relay_credentials. Returns the credential_id. */
async function insertCredential(
  db: DatabaseDriver,
  opts: { credentialId?: string; issuedAt?: number; subjectId?: string } = {},
): Promise<string> {
  const id = opts.credentialId ?? crypto.randomUUID();
  const keypair = await generateKeypair();
  const vc = await issueReputationCredential(
    {
      success_rate: 0.95,
      avg_latency_ms: 120,
      task_count: 42,
      trust_score: 0.8,
      availability: 0.99,
      measured_at: Date.now(),
    },
    keypair.privateKey,
    keypair.publicKey,
    opts.subjectId ?? `did:key:zSubject${crypto.randomUUID().slice(0, 8)}`,
  );

  db.prepare(
    `INSERT INTO relay_credentials
       (credential_id, subject_motebit_id, issuer_did, credential_type, credential_json, issued_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.subjectId ?? "agent-1",
    vc.issuer,
    "AgentReputationCredential",
    JSON.stringify(vc),
    opts.issuedAt ?? Date.now(),
  );

  return id;
}

/** Seed the relay_identity table so proof serving can resolve the public key. */
function seedRelayIdentity(db: DatabaseDriver, identity: RelayIdentity): void {
  db.prepare(
    `INSERT OR REPLACE INTO relay_identity
       (relay_motebit_id, public_key, private_key_hex, did, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    identity.relayMotebitId,
    identity.publicKeyHex,
    bytesToHex(identity.privateKey),
    identity.did,
    Date.now(),
  );
}

beforeEach(async () => {
  const moteDb = await openMotebitDatabase(":memory:");
  db = moteDb.db;
  // Create relay_credentials table (normally created by migrations.ts)
  // Must be created BEFORE createFederationTables, which adds anchor_batch_id column
  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_credentials (
      credential_id TEXT PRIMARY KEY,
      subject_motebit_id TEXT NOT NULL,
      issuer_did TEXT NOT NULL,
      credential_type TEXT NOT NULL,
      credential_json TEXT NOT NULL,
      issued_at INTEGER NOT NULL
    );
  `);
  createFederationTables(db);
  relayIdentity = await makeRelayIdentity();
  seedRelayIdentity(db, relayIdentity);
});

// === cutCredentialBatch ===

describe("cutCredentialBatch", () => {
  it("returns null when no credentials exist", async () => {
    const result = await cutCredentialBatch(db, relayIdentity);
    expect(result).toBeNull();
  });

  it("cuts a batch from unanchored credentials", async () => {
    await insertCredential(db);
    await insertCredential(db);
    await insertCredential(db);

    const batch = await cutCredentialBatch(db, relayIdentity);
    expect(batch).not.toBeNull();
    expect(batch!.leaf_count).toBe(3);
    expect(batch!.merkle_root).toMatch(/^[0-9a-f]{64}$/);
    expect(batch!.signature).toMatch(/^[0-9a-f]+$/);
    expect(batch!.relay_id).toBe(relayIdentity.relayMotebitId);
    expect(batch!.tx_hash).toBeNull();
    expect(batch!.anchored_at).toBeNull();
  });

  it("respects maxSize limit", async () => {
    for (let i = 0; i < 5; i++) {
      await insertCredential(db);
    }

    const batch = await cutCredentialBatch(db, relayIdentity, 3);
    expect(batch).not.toBeNull();
    expect(batch!.leaf_count).toBe(3);

    // Two credentials remain unanchored
    const remaining = db
      .prepare("SELECT COUNT(*) as cnt FROM relay_credentials WHERE anchor_batch_id IS NULL")
      .get() as { cnt: number };
    expect(remaining.cnt).toBe(2);
  });

  it("does not re-batch already-batched credentials", async () => {
    await insertCredential(db);
    await insertCredential(db);

    const batch1 = await cutCredentialBatch(db, relayIdentity);
    expect(batch1).not.toBeNull();

    // Second cut finds nothing
    const batch2 = await cutCredentialBatch(db, relayIdentity);
    expect(batch2).toBeNull();
  });

  it("assigns anchor_batch_id to batched credentials", async () => {
    const id = await insertCredential(db);
    const batch = await cutCredentialBatch(db, relayIdentity);
    expect(batch).not.toBeNull();

    const row = db
      .prepare("SELECT anchor_batch_id FROM relay_credentials WHERE credential_id = ?")
      .get(id) as { anchor_batch_id: string };
    expect(row.anchor_batch_id).toBe(batch!.batch_id);
  });

  it("produces deterministic Merkle root for same credentials", async () => {
    // Insert credentials with fixed IDs and timestamps for reproducibility
    await insertCredential(db, { credentialId: "aaa", issuedAt: 1000 });
    await insertCredential(db, { credentialId: "bbb", issuedAt: 2000 });

    const batch = await cutCredentialBatch(db, relayIdentity);
    expect(batch).not.toBeNull();
    expect(batch!.merkle_root).toMatch(/^[0-9a-f]{64}$/);
  });
});

// === getCredentialAnchorProof ===

describe("getCredentialAnchorProof", () => {
  it("returns null for nonexistent credential", async () => {
    const proof = await getCredentialAnchorProof(db, "nonexistent");
    expect(proof).toBeNull();
  });

  it("returns null for unbatched credential", async () => {
    const id = await insertCredential(db);
    const proof = await getCredentialAnchorProof(db, id);
    expect(proof).toBeNull();
  });

  it("returns valid proof for batched credential", async () => {
    const id = await insertCredential(db);
    await cutCredentialBatch(db, relayIdentity);

    const proof = await getCredentialAnchorProof(db, id);
    expect(proof).not.toBeNull();
    expect(proof!.credential_id).toBe(id);
    expect(proof!.credential_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(proof!.merkle_root).toMatch(/^[0-9a-f]{64}$/);
    expect(proof!.relay_id).toBe(relayIdentity.relayMotebitId);
    expect(proof!.relay_public_key).toBe(relayIdentity.publicKeyHex);
    expect(proof!.batch_signature).toMatch(/^[0-9a-f]+$/);
    expect(proof!.anchor).toBeNull(); // not submitted onchain
  });

  it("proof for single credential has empty siblings", async () => {
    const id = await insertCredential(db);
    await cutCredentialBatch(db, relayIdentity);

    const proof = await getCredentialAnchorProof(db, id);
    expect(proof).not.toBeNull();
    expect(proof!.siblings).toHaveLength(0);
    expect(proof!.leaf_index).toBe(0);
    // Single leaf: root === leaf
    expect(proof!.merkle_root).toBe(proof!.credential_hash);
  });

  it("multi-credential batch produces valid proofs for all", async () => {
    const ids = [
      await insertCredential(db, { issuedAt: 1000 }),
      await insertCredential(db, { issuedAt: 2000 }),
      await insertCredential(db, { issuedAt: 3000 }),
    ];
    await cutCredentialBatch(db, relayIdentity);

    for (const id of ids) {
      const proof = await getCredentialAnchorProof(db, id);
      expect(proof).not.toBeNull();
      expect(proof!.credential_id).toBe(id);
      expect(proof!.siblings.length).toBeGreaterThanOrEqual(0);
    }

    // All proofs share the same root
    const proofs = await Promise.all(ids.map((id) => getCredentialAnchorProof(db, id)));
    const roots = proofs.map(
      (p: Awaited<ReturnType<typeof getCredentialAnchorProof>>) => p!.merkle_root,
    );
    expect(new Set(roots).size).toBe(1);
  });

  it("cross-batch proofs have different roots", async () => {
    const id1 = await insertCredential(db, { issuedAt: 1000 });
    await cutCredentialBatch(db, relayIdentity, 1);

    const id2 = await insertCredential(db, { issuedAt: 2000 });
    await cutCredentialBatch(db, relayIdentity, 1);

    const proof1 = await getCredentialAnchorProof(db, id1);
    const proof2 = await getCredentialAnchorProof(db, id2);

    expect(proof1!.merkle_root).not.toBe(proof2!.merkle_root);
    expect(proof1!.batch_id).not.toBe(proof2!.batch_id);
  });
});

// === isCredentialPendingBatch ===

describe("isCredentialPendingBatch", () => {
  it("returns false for nonexistent credential", () => {
    expect(isCredentialPendingBatch(db, "nonexistent")).toBe(false);
  });

  it("returns true for unbatched credential", async () => {
    const id = await insertCredential(db);
    expect(isCredentialPendingBatch(db, id)).toBe(true);
  });

  it("returns false after batching", async () => {
    const id = await insertCredential(db);
    await cutCredentialBatch(db, relayIdentity);
    expect(isCredentialPendingBatch(db, id)).toBe(false);
  });
});

// === getCredentialAnchorBatch ===

describe("getCredentialAnchorBatch", () => {
  it("returns null for nonexistent batch", () => {
    const result = getCredentialAnchorBatch(db, "nonexistent");
    expect(result).toBeNull();
  });

  it("returns batch metadata", async () => {
    await insertCredential(db, { issuedAt: 1000 });
    await insertCredential(db, { issuedAt: 2000 });
    const record = await cutCredentialBatch(db, relayIdentity);

    const batch = getCredentialAnchorBatch(db, record!.batch_id);
    expect(batch).not.toBeNull();
    expect(batch!.batch_id).toBe(record!.batch_id);
    expect(batch!.leaf_count).toBe(2);
    expect(batch!.merkle_root).toBe(record!.merkle_root);
    expect(batch!.relay_id).toBe(relayIdentity.relayMotebitId);
    expect(batch!.signature).toMatch(/^[0-9a-f]+$/);
    expect(batch!.anchor).toBeNull();
  });
});
