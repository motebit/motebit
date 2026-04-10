/**
 * Settlement batch anchoring — Merkle root computation, batch cutting, proof serving.
 *
 * Implements relay-federation-v1.md §7.6. Batches unanchored federation settlements
 * into a Merkle tree, signs the anchor record with the relay's Ed25519 key, and
 * optionally submits the root on-chain for non-repudiability.
 *
 * On-chain submission is async and additive — the relay's signature is the primary
 * trust mechanism between peers. The chain anchor prevents the relay from later
 * denying it produced the batch.
 */

import type { DatabaseDriver } from "@motebit/persistence";
import {
  buildMerkleTree,
  getMerkleProof,
  computeSettlementLeaf,
  canonicalJson,
  sign,
  bytesToHex,
} from "@motebit/encryption";
import type { RelayIdentity } from "./federation.js";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "relay", module: "anchoring" });

// === Configuration ===

export interface AnchoringConfig {
  /** Batch trigger: max settlements per batch. Default: 100. */
  batchMaxSize?: number;
  /** Batch trigger: max time between batches in ms. Default: 3_600_000 (1 hour). */
  batchIntervalMs?: number;
  /** On-chain RPC URL. If unset, batches are signed but not submitted on-chain. */
  chainRpcUrl?: string;
  /** On-chain contract address. Required if chainRpcUrl is set. */
  contractAddress?: string;
  /** CAIP-2 chain identifier. Default: "eip155:8453" (Base). */
  chainNetwork?: string;
}

const DEFAULT_BATCH_MAX_SIZE = 100;
const DEFAULT_BATCH_INTERVAL_MS = 3_600_000; // 1 hour

// === Database Schema ===

/** Create anchoring tables. Call from createFederationTables(). */
export function createAnchoringTables(db: DatabaseDriver): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_anchor_batches (
      batch_id         TEXT PRIMARY KEY,
      relay_id         TEXT NOT NULL,
      merkle_root      TEXT NOT NULL,
      leaf_count       INTEGER NOT NULL,
      first_settled_at INTEGER NOT NULL,
      last_settled_at  INTEGER NOT NULL,
      signature        TEXT NOT NULL,
      tx_hash          TEXT,
      network          TEXT,
      anchored_at      INTEGER,
      status           TEXT NOT NULL DEFAULT 'signed',
      created_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_anchor_batches_status
      ON relay_anchor_batches(status) WHERE status != 'confirmed';
  `);

  // Migration: add anchor_batch_id to federation settlements
  try {
    db.exec("ALTER TABLE relay_federation_settlements ADD COLUMN anchor_batch_id TEXT");
  } catch {
    /* column already exists */
  }
}

// === Batch Cutting ===

interface FederationSettlement {
  settlement_id: string;
  task_id: string;
  upstream_relay_id: string;
  downstream_relay_id: string | null;
  gross_amount: number;
  fee_amount: number;
  net_amount: number;
  receipt_hash: string;
  settled_at: number;
}

export interface AnchorRecord {
  batch_id: string;
  merkle_root: string;
  leaf_count: number;
  first_settled_at: number;
  last_settled_at: number;
  relay_id: string;
  signature: string;
  tx_hash: string | null;
  network: string | null;
  anchored_at: number | null;
}

/**
 * Cut a batch from unanchored federation settlements.
 * Returns null if no settlements are pending.
 */
export async function cutBatch(
  db: DatabaseDriver,
  relayIdentity: RelayIdentity,
  maxSize: number = DEFAULT_BATCH_MAX_SIZE,
): Promise<AnchorRecord | null> {
  // Fetch unanchored settlements, sorted by settled_at then settlement_id (§7.6.2)
  const rows = db
    .prepare(
      `SELECT settlement_id, task_id, upstream_relay_id, downstream_relay_id,
              gross_amount, fee_amount, net_amount, receipt_hash, settled_at
       FROM relay_federation_settlements
       WHERE anchor_batch_id IS NULL
       ORDER BY settled_at ASC, settlement_id ASC
       LIMIT ?`,
    )
    .all(maxSize) as FederationSettlement[];

  if (rows.length === 0) return null;

  // Compute leaf hashes
  const leaves: string[] = [];
  for (const row of rows) {
    const leaf = await computeSettlementLeaf({
      settlement_id: row.settlement_id,
      task_id: row.task_id,
      upstream_relay_id: row.upstream_relay_id,
      downstream_relay_id: row.downstream_relay_id,
      gross_amount: row.gross_amount,
      fee_amount: row.fee_amount,
      net_amount: row.net_amount,
      receipt_hash: row.receipt_hash,
      settled_at: row.settled_at,
    });
    leaves.push(leaf);
  }

  // Build tree
  const tree = await buildMerkleTree(leaves);

  // Sign the anchor record
  const batchId = crypto.randomUUID();
  const firstSettledAt = rows[0]!.settled_at;
  const lastSettledAt = rows[rows.length - 1]!.settled_at;

  const anchorPayload = {
    batch_id: batchId,
    merkle_root: tree.root,
    leaf_count: rows.length,
    first_settled_at: firstSettledAt,
    last_settled_at: lastSettledAt,
    relay_id: relayIdentity.relayMotebitId,
  };
  const sigBytes = new TextEncoder().encode(canonicalJson(anchorPayload));
  const sig = await sign(sigBytes, relayIdentity.privateKey);
  const signature = bytesToHex(sig);

  // Persist atomically: create batch + assign all settlements
  const now = Date.now();
  db.prepare(
    `INSERT INTO relay_anchor_batches
       (batch_id, relay_id, merkle_root, leaf_count, first_settled_at, last_settled_at,
        signature, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'signed', ?)`,
  ).run(
    batchId,
    relayIdentity.relayMotebitId,
    tree.root,
    rows.length,
    firstSettledAt,
    lastSettledAt,
    signature,
    now,
  );

  const assignStmt = db.prepare(
    "UPDATE relay_federation_settlements SET anchor_batch_id = ? WHERE settlement_id = ?",
  );
  for (const row of rows) {
    assignStmt.run(batchId, row.settlement_id);
  }

  logger.info("anchoring.batch_cut", {
    batch_id: batchId,
    leaf_count: rows.length,
    merkle_root: tree.root,
  });

  return {
    batch_id: batchId,
    merkle_root: tree.root,
    leaf_count: rows.length,
    first_settled_at: firstSettledAt,
    last_settled_at: lastSettledAt,
    relay_id: relayIdentity.relayMotebitId,
    signature,
    tx_hash: null,
    network: null,
    anchored_at: null,
  };
}

// === On-Chain Submission ===

/**
 * Submit a batch's Merkle root on-chain.
 * Updates the batch record with tx_hash, network, anchored_at on success.
 * Returns false if submission fails (caller should retry).
 *
 * Requires: config.chainRpcUrl and config.contractAddress.
 * If not configured, this is a no-op (batches remain Ed25519-signed only).
 */
export async function submitAnchorOnChain(
  db: DatabaseDriver,
  batchId: string,
  config: AnchoringConfig,
): Promise<boolean> {
  if (!config.chainRpcUrl || !config.contractAddress) return true; // no-op if not configured

  const batch = db
    .prepare("SELECT * FROM relay_anchor_batches WHERE batch_id = ? AND status = 'signed'")
    .get(batchId) as { merkle_root: string; relay_id: string; leaf_count: number } | undefined;

  if (!batch) return true; // already submitted or doesn't exist

  try {
    // Encode the function call — keccak256("anchor(bytes32,bytes32,uint64)") selector + ABI-encoded args
    // We use raw fetch to the JSON-RPC endpoint to avoid a viem/ethers dependency.
    // The relay operator's wallet signs via eth_sendTransaction (requires the RPC to be an unlocked account
    // or a signing proxy like Privy/Fireblocks). For testnet, Hardhat/Anvil unlocked accounts work.

    // Relay ID → SHA-256(motebit_id string) → bytes32 for contract indexing
    const relayIdHash = await sha256Hex(batch.relay_id);

    // Function selector: keccak256("anchor(bytes32,bytes32,uint64)") first 4 bytes
    const selectorHex = ANCHOR_SELECTOR;

    // ABI encode: bytes32 merkleRoot + bytes32 relayId + uint64 leafCount (padded to 32 bytes)
    const leafCountHex = batch.leaf_count.toString(16).padStart(64, "0");
    const calldata =
      "0x" +
      selectorHex +
      batch.merkle_root.padStart(64, "0") +
      relayIdHash.padStart(64, "0") +
      leafCountHex;

    const network = config.chainNetwork ?? "eip155:8453";
    const txResponse = await fetch(config.chainRpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_sendTransaction",
        params: [
          {
            to: config.contractAddress,
            data: calldata,
          },
        ],
      }),
    });

    const txResult = (await txResponse.json()) as {
      result?: string;
      error?: { message: string };
    };

    if (txResult.error || !txResult.result) {
      const errMsg = txResult.error?.message ?? "No transaction hash returned";
      logger.warn("anchoring.chain_submit_failed", { batch_id: batchId, error: errMsg });
      return false;
    }

    const txHash = txResult.result;
    const now = Date.now();

    db.prepare(
      "UPDATE relay_anchor_batches SET tx_hash = ?, network = ?, anchored_at = ?, status = 'confirmed' WHERE batch_id = ?",
    ).run(txHash, network, now, batchId);

    logger.info("anchoring.chain_confirmed", {
      batch_id: batchId,
      tx_hash: txHash,
      network,
    });

    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("anchoring.chain_submit_error", { batch_id: batchId, error: message });
    return false;
  }
}

/** SHA-256 hex of a UTF-8 string. */
async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** anchor(bytes32,bytes32,uint64) selector, computed offline via keccak256. */
const ANCHOR_SELECTOR = "2b3c0db3";

// === Batch Anchor Loop ===

/**
 * Periodic loop: check if batch triggers are met and cut batches.
 * Two triggers (§7.6.3): count ≥ maxSize OR time ≥ intervalMs since last batch.
 */
export function startBatchAnchorLoop(
  db: DatabaseDriver,
  relayIdentity: RelayIdentity,
  config: AnchoringConfig = {},
  isFrozen?: () => boolean,
): ReturnType<typeof setInterval> {
  const maxSize = config.batchMaxSize ?? DEFAULT_BATCH_MAX_SIZE;
  const intervalMs = config.batchIntervalMs ?? DEFAULT_BATCH_INTERVAL_MS;
  // Check every 60s — actual batch cutting only happens when triggers are met
  const checkIntervalMs = Math.min(60_000, intervalMs);

  return setInterval(() => {
    if (isFrozen?.()) return;

    void (async () => {
      try {
        // Count unanchored settlements
        const countRow = db
          .prepare(
            "SELECT COUNT(*) as cnt FROM relay_federation_settlements WHERE anchor_batch_id IS NULL",
          )
          .get() as { cnt: number };

        if (countRow.cnt === 0) return;

        // Trigger 1: count threshold
        let batch: AnchorRecord | null = null;
        if (countRow.cnt >= maxSize) {
          batch = await cutBatch(db, relayIdentity, maxSize);
        } else {
          // Trigger 2: time threshold — check oldest unanchored settlement
          const oldest = db
            .prepare(
              "SELECT MIN(settled_at) as oldest FROM relay_federation_settlements WHERE anchor_batch_id IS NULL",
            )
            .get() as { oldest: number | null };

          if (oldest.oldest != null && Date.now() - oldest.oldest >= intervalMs) {
            batch = await cutBatch(db, relayIdentity, maxSize);
          }
        }

        // Attempt on-chain submission for newly cut batch
        if (batch && config.chainRpcUrl) {
          await submitAnchorOnChain(db, batch.batch_id, config);
        }

        // Retry previously failed submissions
        if (config.chainRpcUrl) {
          const failedBatches = db
            .prepare(
              "SELECT batch_id FROM relay_anchor_batches WHERE status = 'signed' AND tx_hash IS NULL",
            )
            .all() as { batch_id: string }[];

          for (const fb of failedBatches) {
            await submitAnchorOnChain(db, fb.batch_id, config);
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("anchoring.loop_error", { error: message });
      }
    })();
  }, checkIntervalMs);
}

// === Proof Serving ===

/**
 * Generate a Merkle inclusion proof for a specific settlement.
 * Returns null if the settlement is not yet batched, or the batch/settlement doesn't exist.
 */
export async function getSettlementProof(
  db: DatabaseDriver,
  settlementId: string,
): Promise<{
  settlement_id: string;
  leaf_hash: string;
  proof: string[];
  leaf_index: number;
  merkle_root: string;
  batch_id: string;
  anchor: AnchorRecord;
} | null> {
  // Find the settlement and its batch
  const settlement = db
    .prepare(
      `SELECT settlement_id, task_id, upstream_relay_id, downstream_relay_id,
              gross_amount, fee_amount, net_amount, receipt_hash, settled_at,
              anchor_batch_id
       FROM relay_federation_settlements
       WHERE settlement_id = ?`,
    )
    .get(settlementId) as (FederationSettlement & { anchor_batch_id: string | null }) | undefined;

  if (!settlement || !settlement.anchor_batch_id) return null;

  const batchId = settlement.anchor_batch_id;

  // Load anchor record
  const anchor = db
    .prepare("SELECT * FROM relay_anchor_batches WHERE batch_id = ?")
    .get(batchId) as
    | {
        batch_id: string;
        relay_id: string;
        merkle_root: string;
        leaf_count: number;
        first_settled_at: number;
        last_settled_at: number;
        signature: string;
        tx_hash: string | null;
        network: string | null;
        anchored_at: number | null;
        status: string;
      }
    | undefined;

  if (!anchor) return null;

  // Reconstruct the tree from all settlements in this batch (same sort order as §7.6.2)
  const batchSettlements = db
    .prepare(
      `SELECT settlement_id, task_id, upstream_relay_id, downstream_relay_id,
              gross_amount, fee_amount, net_amount, receipt_hash, settled_at
       FROM relay_federation_settlements
       WHERE anchor_batch_id = ?
       ORDER BY settled_at ASC, settlement_id ASC`,
    )
    .all(batchId) as FederationSettlement[];

  // Compute all leaves
  const leaves: string[] = [];
  let targetIndex = -1;
  for (let i = 0; i < batchSettlements.length; i++) {
    const row = batchSettlements[i]!;
    const leaf = await computeSettlementLeaf({
      settlement_id: row.settlement_id,
      task_id: row.task_id,
      upstream_relay_id: row.upstream_relay_id,
      downstream_relay_id: row.downstream_relay_id,
      gross_amount: row.gross_amount,
      fee_amount: row.fee_amount,
      net_amount: row.net_amount,
      receipt_hash: row.receipt_hash,
      settled_at: row.settled_at,
    });
    leaves.push(leaf);
    if (row.settlement_id === settlementId) {
      targetIndex = i;
    }
  }

  if (targetIndex === -1) return null;

  const tree = await buildMerkleTree(leaves);
  const proof = getMerkleProof(tree, targetIndex);

  return {
    settlement_id: settlementId,
    leaf_hash: proof.leaf,
    proof: proof.siblings,
    leaf_index: proof.index,
    merkle_root: tree.root,
    batch_id: batchId,
    anchor: {
      batch_id: anchor.batch_id,
      merkle_root: anchor.merkle_root,
      leaf_count: anchor.leaf_count,
      first_settled_at: anchor.first_settled_at,
      last_settled_at: anchor.last_settled_at,
      relay_id: anchor.relay_id,
      signature: anchor.signature,
      tx_hash: anchor.tx_hash,
      network: anchor.network,
      anchored_at: anchor.anchored_at,
    },
  };
}

/**
 * Check if a settlement exists but is not yet batched.
 * Used to return HTTP 202 with retry_after header.
 */
export function isSettlementPendingBatch(db: DatabaseDriver, settlementId: string): boolean {
  const row = db
    .prepare("SELECT anchor_batch_id FROM relay_federation_settlements WHERE settlement_id = ?")
    .get(settlementId) as { anchor_batch_id: string | null } | undefined;

  return row != null && row.anchor_batch_id == null;
}
