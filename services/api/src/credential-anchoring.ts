/**
 * Credential batch anchoring — Merkle root computation, batch cutting, proof serving.
 *
 * Implements motebit/credential-anchor@1.0. Batches unanchored credentials
 * into a Merkle tree, signs the batch with the relay's Ed25519 key, and
 * optionally submits the root onchain for non-repudiability.
 *
 * Mirrors the settlement anchoring pattern (anchoring.ts / relay-federation-v1.md §7.6)
 * but operates on the credential stream instead of the settlement stream.
 */

import type { DatabaseDriver } from "@motebit/persistence";
import type {
  CredentialAnchorBatch,
  CredentialAnchorProof,
  ChainAnchorSubmitter,
} from "@motebit/sdk";
import {
  buildMerkleTree,
  getMerkleProof,
  canonicalJson,
  sign,
  bytesToHex,
} from "@motebit/encryption";
import type { RelayIdentity } from "./federation.js";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "relay", module: "credential-anchoring" });

// === Configuration ===

export interface CredentialAnchoringConfig {
  /** Batch trigger: max credentials per batch. Default: 50. */
  batchMaxSize?: number;
  /** Batch trigger: max time between batches in ms. Default: 3_600_000 (1 hour). */
  batchIntervalMs?: number;
  /** Chain anchor submitter. If unset, batches are signed but not submitted onchain. */
  submitter?: ChainAnchorSubmitter;
}

const DEFAULT_BATCH_MAX_SIZE = 50;
const DEFAULT_BATCH_INTERVAL_MS = 3_600_000; // 1 hour

// === Database Schema ===

/** Create credential anchoring tables. */
export function createCredentialAnchoringTables(db: DatabaseDriver): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_credential_anchor_batches (
      batch_id         TEXT PRIMARY KEY,
      relay_id         TEXT NOT NULL,
      merkle_root      TEXT NOT NULL,
      leaf_count       INTEGER NOT NULL,
      first_issued_at  INTEGER NOT NULL,
      last_issued_at   INTEGER NOT NULL,
      signature        TEXT NOT NULL,
      tx_hash          TEXT,
      network          TEXT,
      chain            TEXT,
      anchored_at      INTEGER,
      status           TEXT NOT NULL DEFAULT 'signed',
      created_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cred_anchor_batches_status
      ON relay_credential_anchor_batches(status) WHERE status != 'confirmed';
  `);

  // Migration: add anchor_batch_id to relay_credentials
  try {
    db.exec("ALTER TABLE relay_credentials ADD COLUMN anchor_batch_id TEXT");
  } catch {
    /* column already exists */
  }
}

// === Leaf Hash ===

/** SHA-256 of raw bytes. */
async function sha256Bytes(data: Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return new Uint8Array(buf);
}

/** Hex-encode a Uint8Array. */
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Compute credential leaf hash from the full VC JSON string.
 * Re-parses and re-serializes via canonicalJson for determinism.
 */
async function computeCredentialLeafFromJson(credentialJson: string): Promise<string> {
  const vc = JSON.parse(credentialJson) as Record<string, unknown>;
  const canonical = canonicalJson(vc);
  const hash = await sha256Bytes(new TextEncoder().encode(canonical));
  return toHex(hash);
}

// === Batch Record ===

export interface CredentialAnchorRecord {
  batch_id: string;
  merkle_root: string;
  leaf_count: number;
  first_issued_at: number;
  last_issued_at: number;
  relay_id: string;
  signature: string;
  tx_hash: string | null;
  network: string | null;
  chain: string | null;
  anchored_at: number | null;
}

// === Batch Cutting ===

interface CredentialRow {
  credential_id: string;
  credential_json: string;
  issued_at: number;
}

/**
 * Cut a batch from unanchored credentials.
 * Returns null if no credentials are pending.
 */
export async function cutCredentialBatch(
  db: DatabaseDriver,
  relayIdentity: RelayIdentity,
  maxSize: number = DEFAULT_BATCH_MAX_SIZE,
): Promise<CredentialAnchorRecord | null> {
  // Fetch unanchored credentials, sorted deterministically
  const rows = db
    .prepare(
      `SELECT credential_id, credential_json, issued_at
       FROM relay_credentials
       WHERE anchor_batch_id IS NULL
       ORDER BY issued_at ASC, credential_id ASC
       LIMIT ?`,
    )
    .all(maxSize) as CredentialRow[];

  if (rows.length === 0) return null;

  // Compute leaf hashes
  const leaves: string[] = [];
  for (const row of rows) {
    const leaf = await computeCredentialLeafFromJson(row.credential_json);
    leaves.push(leaf);
  }

  // Build Merkle tree
  const tree = await buildMerkleTree(leaves);

  // Sign the batch
  const batchId = crypto.randomUUID();
  const firstIssuedAt = rows[0]!.issued_at;
  const lastIssuedAt = rows[rows.length - 1]!.issued_at;

  const batchPayload = {
    batch_id: batchId,
    merkle_root: tree.root,
    leaf_count: rows.length,
    first_issued_at: firstIssuedAt,
    last_issued_at: lastIssuedAt,
    relay_id: relayIdentity.relayMotebitId,
  };
  const sigBytes = new TextEncoder().encode(canonicalJson(batchPayload));
  const sig = await sign(sigBytes, relayIdentity.privateKey);
  const signature = bytesToHex(sig);

  // Persist atomically: create batch + assign all credentials
  const now = Date.now();
  db.prepare(
    `INSERT INTO relay_credential_anchor_batches
       (batch_id, relay_id, merkle_root, leaf_count, first_issued_at, last_issued_at,
        signature, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'signed', ?)`,
  ).run(
    batchId,
    relayIdentity.relayMotebitId,
    tree.root,
    rows.length,
    firstIssuedAt,
    lastIssuedAt,
    signature,
    now,
  );

  const assignStmt = db.prepare(
    "UPDATE relay_credentials SET anchor_batch_id = ? WHERE credential_id = ?",
  );
  for (const row of rows) {
    assignStmt.run(batchId, row.credential_id);
  }

  logger.info("credential_anchoring.batch_cut", {
    batch_id: batchId,
    leaf_count: rows.length,
    merkle_root: tree.root,
  });

  return {
    batch_id: batchId,
    merkle_root: tree.root,
    leaf_count: rows.length,
    first_issued_at: firstIssuedAt,
    last_issued_at: lastIssuedAt,
    relay_id: relayIdentity.relayMotebitId,
    signature,
    tx_hash: null,
    network: null,
    chain: null,
    anchored_at: null,
  };
}

// === Chain Submission ===

/**
 * Submit a batch's Merkle root onchain via the configured ChainAnchorSubmitter.
 * Updates the batch record with tx_hash, chain, network, anchored_at on success.
 */
export async function submitCredentialAnchorOnChain(
  db: DatabaseDriver,
  batchId: string,
  submitter: ChainAnchorSubmitter,
): Promise<boolean> {
  const batch = db
    .prepare(
      "SELECT merkle_root, relay_id, leaf_count FROM relay_credential_anchor_batches WHERE batch_id = ? AND status = 'signed'",
    )
    .get(batchId) as { merkle_root: string; relay_id: string; leaf_count: number } | undefined;

  if (!batch) return true; // already submitted or doesn't exist

  try {
    const result = await submitter.submitMerkleRoot(
      batch.merkle_root,
      batch.relay_id,
      batch.leaf_count,
    );
    const now = Date.now();

    db.prepare(
      `UPDATE relay_credential_anchor_batches
       SET tx_hash = ?, chain = ?, network = ?, anchored_at = ?, status = 'confirmed'
       WHERE batch_id = ?`,
    ).run(result.txHash, submitter.chain, submitter.network, now, batchId);

    logger.info("credential_anchoring.chain_confirmed", {
      batch_id: batchId,
      tx_hash: result.txHash,
      chain: submitter.chain,
      network: submitter.network,
    });

    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("credential_anchoring.chain_submit_error", { batch_id: batchId, error: message });
    return false;
  }
}

// === Batch Anchor Loop ===

/**
 * Periodic loop: check if batch triggers are met and cut credential batches.
 * Two triggers: count ≥ maxSize OR time ≥ intervalMs since oldest unanchored credential.
 */
export function startCredentialAnchorLoop(
  db: DatabaseDriver,
  relayIdentity: RelayIdentity,
  config: CredentialAnchoringConfig = {},
  isFrozen?: () => boolean,
): ReturnType<typeof setInterval> {
  const maxSize = config.batchMaxSize ?? DEFAULT_BATCH_MAX_SIZE;
  const intervalMs = config.batchIntervalMs ?? DEFAULT_BATCH_INTERVAL_MS;
  const submitter = config.submitter;
  const checkIntervalMs = Math.min(60_000, intervalMs);

  return setInterval(() => {
    if (isFrozen?.()) return;

    void (async () => {
      try {
        // Count unanchored credentials
        const countRow = db
          .prepare("SELECT COUNT(*) as cnt FROM relay_credentials WHERE anchor_batch_id IS NULL")
          .get() as { cnt: number };

        if (countRow.cnt === 0) return;

        // Trigger 1: count threshold
        let batch: CredentialAnchorRecord | null = null;
        if (countRow.cnt >= maxSize) {
          batch = await cutCredentialBatch(db, relayIdentity, maxSize);
        } else {
          // Trigger 2: time threshold
          const oldest = db
            .prepare(
              "SELECT MIN(issued_at) as oldest FROM relay_credentials WHERE anchor_batch_id IS NULL",
            )
            .get() as { oldest: number | null };

          if (oldest.oldest != null && Date.now() - oldest.oldest >= intervalMs) {
            batch = await cutCredentialBatch(db, relayIdentity, maxSize);
          }
        }

        // Submit newly cut batch onchain
        if (batch && submitter) {
          await submitCredentialAnchorOnChain(db, batch.batch_id, submitter);
        }

        // Retry previously failed submissions
        if (submitter) {
          const failedBatches = db
            .prepare(
              "SELECT batch_id FROM relay_credential_anchor_batches WHERE status = 'signed' AND tx_hash IS NULL",
            )
            .all() as { batch_id: string }[];

          for (const fb of failedBatches) {
            await submitCredentialAnchorOnChain(db, fb.batch_id, submitter);
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("credential_anchoring.loop_error", { error: message });
      }
    })();
  }, checkIntervalMs);
}

// === Proof Serving ===

/**
 * Generate a Merkle inclusion proof for a specific credential.
 * Returns null if the credential is not yet batched or doesn't exist.
 */
export async function getCredentialAnchorProof(
  db: DatabaseDriver,
  credentialId: string,
): Promise<CredentialAnchorProof | null> {
  // Find the credential and its batch
  const credential = db
    .prepare(
      `SELECT credential_id, credential_json, issued_at, anchor_batch_id
       FROM relay_credentials
       WHERE credential_id = ?`,
    )
    .get(credentialId) as (CredentialRow & { anchor_batch_id: string | null }) | undefined;

  if (!credential || !credential.anchor_batch_id) return null;

  const batchId = credential.anchor_batch_id;

  // Load batch record
  const batch = db
    .prepare("SELECT * FROM relay_credential_anchor_batches WHERE batch_id = ?")
    .get(batchId) as
    | {
        batch_id: string;
        relay_id: string;
        merkle_root: string;
        leaf_count: number;
        first_issued_at: number;
        last_issued_at: number;
        signature: string;
        tx_hash: string | null;
        network: string | null;
        chain: string | null;
        anchored_at: number | null;
      }
    | undefined;

  if (!batch) return null;

  // Reconstruct the tree from all credentials in this batch (same sort order as batch cutting)
  const batchCredentials = db
    .prepare(
      `SELECT credential_id, credential_json, issued_at
       FROM relay_credentials
       WHERE anchor_batch_id = ?
       ORDER BY issued_at ASC, credential_id ASC`,
    )
    .all(batchId) as CredentialRow[];

  // Compute all leaves
  const leaves: string[] = [];
  let targetIndex = -1;
  for (let i = 0; i < batchCredentials.length; i++) {
    const row = batchCredentials[i]!;
    const leaf = await computeCredentialLeafFromJson(row.credential_json);
    leaves.push(leaf);
    if (row.credential_id === credentialId) {
      targetIndex = i;
    }
  }

  if (targetIndex === -1) return null;

  const tree = await buildMerkleTree(leaves);
  const proof = getMerkleProof(tree, targetIndex);

  // Resolve relay public key for self-verification
  const relayPubKeyHex = bytesToHex(relayIdentity_publicKeyFromDb(db, batch.relay_id));

  return {
    credential_id: credentialId,
    credential_hash: proof.leaf,
    batch_id: batchId,
    merkle_root: tree.root,
    leaf_index: proof.index,
    siblings: proof.siblings,
    layer_sizes: proof.layerSizes,
    relay_id: batch.relay_id,
    relay_public_key: relayPubKeyHex,
    batch_signature: batch.signature,
    anchor: batch.tx_hash
      ? {
          chain: batch.chain!,
          network: batch.network!,
          tx_hash: batch.tx_hash,
          anchored_at: batch.anchored_at!,
        }
      : null,
  };
}

/** Resolve relay public key from the relay_identity table. */
function relayIdentity_publicKeyFromDb(db: DatabaseDriver, relayId: string): Uint8Array {
  const row = db
    .prepare("SELECT public_key FROM relay_identity WHERE relay_motebit_id = ?")
    .get(relayId) as { public_key: string } | undefined;

  if (!row) {
    throw new Error(`Relay identity not found for ${relayId}`);
  }

  // public_key is hex-encoded
  const hex = row.public_key;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Check if a credential exists but is not yet batched.
 * Used to return HTTP 202 with Retry-After header.
 */
export function isCredentialPendingBatch(db: DatabaseDriver, credentialId: string): boolean {
  const row = db
    .prepare("SELECT anchor_batch_id FROM relay_credentials WHERE credential_id = ?")
    .get(credentialId) as { anchor_batch_id: string | null } | undefined;

  return row != null && row.anchor_batch_id == null;
}

/**
 * List all credential anchor batches, most recent first.
 */
export function listCredentialAnchorBatches(
  db: DatabaseDriver,
  limit: number = 50,
): CredentialAnchorBatch[] {
  const rows = db
    .prepare(
      `SELECT * FROM relay_credential_anchor_batches
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{
    batch_id: string;
    relay_id: string;
    merkle_root: string;
    leaf_count: number;
    first_issued_at: number;
    last_issued_at: number;
    signature: string;
    tx_hash: string | null;
    network: string | null;
    chain: string | null;
    anchored_at: number | null;
  }>;

  return rows.map((row) => ({
    batch_id: row.batch_id,
    relay_id: row.relay_id,
    merkle_root: row.merkle_root,
    leaf_count: row.leaf_count,
    first_issued_at: row.first_issued_at,
    last_issued_at: row.last_issued_at,
    signature: row.signature,
    anchor: row.tx_hash
      ? {
          chain: row.chain!,
          network: row.network!,
          tx_hash: row.tx_hash,
          anchored_at: row.anchored_at!,
        }
      : null,
  }));
}

/**
 * Get credential anchoring stats for the admin dashboard.
 */
export function getCredentialAnchoringStats(db: DatabaseDriver): {
  total_batches: number;
  confirmed_batches: number;
  total_credentials_anchored: number;
  pending_credentials: number;
} {
  const batchStats = db
    .prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) as confirmed,
         SUM(leaf_count) as total_leaves
       FROM relay_credential_anchor_batches`,
    )
    .get() as { total: number; confirmed: number; total_leaves: number | null };

  const pendingRow = db
    .prepare("SELECT COUNT(*) as cnt FROM relay_credentials WHERE anchor_batch_id IS NULL")
    .get() as { cnt: number };

  return {
    total_batches: batchStats.total,
    confirmed_batches: batchStats.confirmed,
    total_credentials_anchored: batchStats.total_leaves ?? 0,
    pending_credentials: pendingRow.cnt,
  };
}

/**
 * Get batch metadata by batch ID.
 */
export function getCredentialAnchorBatch(
  db: DatabaseDriver,
  batchId: string,
): CredentialAnchorBatch | null {
  const row = db
    .prepare("SELECT * FROM relay_credential_anchor_batches WHERE batch_id = ?")
    .get(batchId) as
    | {
        batch_id: string;
        relay_id: string;
        merkle_root: string;
        leaf_count: number;
        first_issued_at: number;
        last_issued_at: number;
        signature: string;
        tx_hash: string | null;
        network: string | null;
        chain: string | null;
        anchored_at: number | null;
      }
    | undefined;

  if (!row) return null;

  return {
    batch_id: row.batch_id,
    relay_id: row.relay_id,
    merkle_root: row.merkle_root,
    leaf_count: row.leaf_count,
    first_issued_at: row.first_issued_at,
    last_issued_at: row.last_issued_at,
    signature: row.signature,
    anchor: row.tx_hash
      ? {
          chain: row.chain!,
          network: row.network!,
          tx_hash: row.tx_hash,
          anchored_at: row.anchored_at!,
        }
      : null,
  };
}
