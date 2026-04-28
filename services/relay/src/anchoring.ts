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
 *
 * Chain submission is pluggable via ChainAnchorSubmitter (same adapter used by
 * credential anchoring). Default: Solana Memo when SOLANA_RPC_URL is set.
 * Legacy: EVM contract via EvmContractSubmitter when chainRpcUrl + contractAddress are set.
 */

import type { DatabaseDriver } from "@motebit/persistence";
import type { ChainAnchorSubmitter } from "@motebit/sdk";
import type {
  AgentSettlementAnchorBatch,
  AgentSettlementAnchorProof,
  AgentSettlementChainAnchor,
} from "@motebit/protocol";
import {
  buildMerkleTree,
  getMerkleProof,
  computeSettlementLeaf,
  canonicalJson,
  sha256,
  sign,
  bytesToHex,
} from "@motebit/encryption";
import type { RelayIdentity } from "./federation.js";
import { createLogger } from "./logger.js";

/** Cryptosuite for the per-agent settlement anchor batch + proof artifacts.
 *  Matches spec/agent-settlement-anchor-v1.md §4.1 / §5.1 — JCS canonicalization,
 *  Ed25519 primitive, hex signature encoding, hex public-key encoding. */
const AGENT_SETTLEMENT_ANCHOR_SUITE = "motebit-jcs-ed25519-hex-v1" as const;

const logger = createLogger({ service: "relay", module: "anchoring" });

// === Configuration ===

export interface AnchoringConfig {
  /** Batch trigger: max settlements per batch. Default: 100. */
  batchMaxSize?: number;
  /** Batch trigger: max time between batches in ms. Default: 3_600_000 (1 hour). */
  batchIntervalMs?: number;
  /** Chain anchor submitter. If unset, batches are signed but not submitted on-chain. */
  submitter?: ChainAnchorSubmitter;
  // --- Legacy EVM config (use submitter instead) ---
  /**
   * @deprecated Pass a configured {@link ChainAnchorSubmitter} via `submitter` instead.
   *
   * Reason: submitter-based anchoring generalizes across chains
   * (Solana memo, EVM contract, future rails) and owns its own RPC wiring.
   * The three flat `chain*` fields only ever made sense for the EVM path.
   */
  chainRpcUrl?: string;
  /**
   * @deprecated Pass a configured {@link ChainAnchorSubmitter} via `submitter` instead.
   *
   * Reason: paired with {@link chainRpcUrl} — EVM-specific, superseded by
   * the submitter interface.
   */
  contractAddress?: string;
  /**
   * @deprecated Pass a configured {@link ChainAnchorSubmitter} via `submitter` instead.
   *
   * Reason: paired with {@link chainRpcUrl} — EVM-specific, superseded by
   * the submitter interface. Default was `"eip155:8453"` (Base).
   */
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
 * Submit a batch's Merkle root on-chain via ChainAnchorSubmitter.
 * Updates the batch record with tx_hash, network, anchored_at on success.
 * Returns false if submission fails (caller should retry).
 */
export async function submitAnchorOnChain(
  db: DatabaseDriver,
  batchId: string,
  submitter: ChainAnchorSubmitter,
): Promise<boolean> {
  const batch = db
    .prepare(
      "SELECT merkle_root, relay_id, leaf_count FROM relay_anchor_batches WHERE batch_id = ? AND status = 'signed'",
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
      "UPDATE relay_anchor_batches SET tx_hash = ?, network = ?, anchored_at = ?, status = 'confirmed' WHERE batch_id = ?",
    ).run(result.txHash, submitter.network, now, batchId);

    logger.info("anchoring.chain_confirmed", {
      batch_id: batchId,
      tx_hash: result.txHash,
      chain: submitter.chain,
      network: submitter.network,
    });

    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("anchoring.chain_submit_error", { batch_id: batchId, error: message });
    return false;
  }
}

// === Legacy EVM Contract Submitter ===

/**
 * EVM contract submitter for SettlementAnchor.sol.
 *
 * @deprecated Use {@link SolanaMemoSubmitter} instead.
 *
 * Reason: the Solana submitter signs with the relay's native Ed25519
 * identity key — no separate secp256k1 key management, no deployed
 * contract address to track, no EVM gas economics. EVM anchoring added
 * operational overhead motebit never needed. Retained through 2.0.0 for
 * operators who specifically want Base/EVM anchoring continuity.
 *
 * Requires: chainRpcUrl with an unlocked account or signing proxy.
 */
export class EvmContractSubmitter implements ChainAnchorSubmitter {
  readonly chain = "eip155" as const;
  readonly network: string;
  private readonly rpcUrl: string;
  private readonly contractAddress: string;

  constructor(config: { chainRpcUrl: string; contractAddress: string; chainNetwork?: string }) {
    this.rpcUrl = config.chainRpcUrl;
    this.contractAddress = config.contractAddress;
    this.network = config.chainNetwork ?? "eip155:8453";
  }

  async submitMerkleRoot(
    root: string,
    relayId: string,
    leafCount: number,
  ): Promise<{ txHash: string }> {
    const relayIdHash = await sha256Hex(relayId);
    const leafCountHex = leafCount.toString(16).padStart(64, "0");
    const calldata =
      "0x" +
      ANCHOR_SELECTOR +
      root.padStart(64, "0") +
      relayIdHash.padStart(64, "0") +
      leafCountHex;

    const txResponse = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_sendTransaction",
        params: [{ to: this.contractAddress, data: calldata }],
      }),
    });

    const txResult = (await txResponse.json()) as {
      result?: string;
      error?: { message: string };
    };

    if (txResult.error || !txResult.result) {
      throw new Error(txResult.error?.message ?? "No transaction hash returned");
    }

    return { txHash: txResult.result };
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      const data = (await res.json()) as { result?: string };
      return !!data.result;
    } catch {
      return false;
    }
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

  // Resolve submitter: explicit submitter > legacy EVM config > none
  const submitter =
    config.submitter ??
    (config.chainRpcUrl && config.contractAddress
      ? new EvmContractSubmitter({
          chainRpcUrl: config.chainRpcUrl,
          contractAddress: config.contractAddress,
          chainNetwork: config.chainNetwork,
        })
      : undefined);

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
        if (batch && submitter) {
          await submitAnchorOnChain(db, batch.batch_id, submitter);
        }

        // Retry previously failed submissions
        if (submitter) {
          const failedBatches = db
            .prepare(
              "SELECT batch_id FROM relay_anchor_batches WHERE status = 'signed' AND tx_hash IS NULL",
            )
            .all() as { batch_id: string }[];

          for (const fb of failedBatches) {
            await submitAnchorOnChain(db, fb.batch_id, submitter);
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

// ===========================================================================
// Per-agent settlement Merkle anchoring (the "ceiling" alongside the
// signing "floor" landed in migration v13).
//
// Federation settlements (above) get batched + anchored onchain so peer
// relays can verify cross-relay settlement amounts without trusting each
// other. Per-agent settlements get the same treatment so a worker can
// verify they were paid the right amount WITHOUT contacting the relay
// — just by holding their signed SettlementRecord, the inclusion proof,
// and the chain transaction reference.
//
// Self-attesting trust pyramid for agent settlements:
//   1. Signature  (commits the relay to its claimed amounts; replaces
//      "trust the relay's word" with "trust the relay's commitment")
//   2. Anchor     (commits the relay to its claimed history; even an
//      issuer-key compromise cannot retroactively rewrite anchored
//      records because the chain transaction is immutable)
//
// Stored separately from federation batches (relay_agent_anchor_batches)
// because the audiences differ — federation = peer audit, per-agent =
// worker audit. Same Merkle primitive, different aggregation.
// ===========================================================================

interface AgentSettlementRow {
  settlement_id: string;
  motebit_id: string;
  receipt_hash: string;
  ledger_hash: string | null;
  amount_settled: number;
  platform_fee: number;
  platform_fee_rate: number;
  status: string;
  settled_at: number;
  issuer_relay_id: string;
  suite: string;
  signature: string;
}

/**
 * Compute the leaf hash for a per-agent settlement: SHA-256 over the
 * canonical-JSON of the signed record fields. Identical to the bytes
 * the relay signed over (minus signature itself? — no, including
 * signature: the leaf commits the WHOLE signed artifact).
 *
 * External verifiers reconstruct this by canonicalizing the
 * SettlementRecord they hold and hashing — no relay code needed.
 */
async function computeAgentSettlementLeaf(row: AgentSettlementRow): Promise<string> {
  const canonical = canonicalJson({
    settlement_id: row.settlement_id,
    motebit_id: row.motebit_id,
    receipt_hash: row.receipt_hash,
    ledger_hash: row.ledger_hash,
    amount_settled: row.amount_settled,
    platform_fee: row.platform_fee,
    platform_fee_rate: row.platform_fee_rate,
    status: row.status,
    settled_at: row.settled_at,
    issuer_relay_id: row.issuer_relay_id,
    suite: row.suite,
    signature: row.signature,
  });
  const h = await sha256(new TextEncoder().encode(canonical));
  return bytesToHex(h);
}

/**
 * Cut a batch from unanchored per-agent settlements. Returns null if
 * none are pending. Mirrors `cutBatch` (federation) but selects from
 * `relay_settlements` and writes to `relay_agent_anchor_batches`.
 *
 * Selection: only signed rows (`signature IS NOT NULL`). Pre-signing-
 * migration legacy rows are skipped — they cannot be anchored because
 * the leaf would not match what the relay signed (it didn't).
 */
export async function cutAgentSettlementBatch(
  db: DatabaseDriver,
  relayIdentity: RelayIdentity,
  maxSize: number = DEFAULT_BATCH_MAX_SIZE,
): Promise<AnchorRecord | null> {
  const rows = db
    .prepare(
      `SELECT settlement_id, motebit_id, receipt_hash, ledger_hash,
              amount_settled, platform_fee, platform_fee_rate, status,
              settled_at, issuer_relay_id, suite, signature
       FROM relay_settlements
       WHERE anchor_batch_id IS NULL AND signature IS NOT NULL
       ORDER BY settled_at ASC, settlement_id ASC
       LIMIT ?`,
    )
    .all(maxSize) as AgentSettlementRow[];

  if (rows.length === 0) return null;

  const leaves: string[] = [];
  for (const row of rows) {
    leaves.push(await computeAgentSettlementLeaf(row));
  }

  const tree = await buildMerkleTree(leaves);

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

  const now = Date.now();
  db.prepare(
    `INSERT INTO relay_agent_anchor_batches
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
    "UPDATE relay_settlements SET anchor_batch_id = ? WHERE settlement_id = ?",
  );
  for (const row of rows) {
    assignStmt.run(batchId, row.settlement_id);
  }

  logger.info("anchoring.agent_batch_cut", {
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

/**
 * Submit an agent-settlement batch's Merkle root onchain. Mirrors
 * `submitAnchorOnChain` for federation batches — same submitter
 * abstraction (ChainAnchorSubmitter), same idempotency semantics
 * (only acts on `status = 'signed'` batches).
 */
export async function submitAgentAnchorOnChain(
  db: DatabaseDriver,
  batchId: string,
  submitter: ChainAnchorSubmitter,
): Promise<boolean> {
  const batch = db
    .prepare(
      "SELECT merkle_root, relay_id, leaf_count FROM relay_agent_anchor_batches WHERE batch_id = ? AND status = 'signed'",
    )
    .get(batchId) as { merkle_root: string; relay_id: string; leaf_count: number } | undefined;

  if (!batch) return true;

  try {
    const result = await submitter.submitMerkleRoot(
      batch.merkle_root,
      batch.relay_id,
      batch.leaf_count,
    );
    const now = Date.now();

    db.prepare(
      "UPDATE relay_agent_anchor_batches SET tx_hash = ?, network = ?, anchored_at = ?, status = 'confirmed' WHERE batch_id = ?",
    ).run(result.txHash, submitter.network, now, batchId);

    logger.info("anchoring.agent_chain_confirmed", {
      batch_id: batchId,
      tx_hash: result.txHash,
      chain: submitter.chain,
      network: submitter.network,
    });

    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("anchoring.agent_chain_submit_error", { batch_id: batchId, error: message });
    return false;
  }
}

/**
 * True iff a per-agent settlement exists, was signed, and has NOT yet
 * been included in an anchor batch. Used to return HTTP 202 with
 * Retry-After on the proof endpoint — the batching loop will pick it
 * up on the next tick.
 *
 * Returns false for legacy unsigned rows because they cannot be
 * batched (the leaf wouldn't match what the relay signed, since it
 * didn't sign it). For unsigned rows the proof endpoint returns 404.
 */
export function isAgentSettlementPendingBatch(db: DatabaseDriver, settlementId: string): boolean {
  const row = db
    .prepare("SELECT anchor_batch_id, signature FROM relay_settlements WHERE settlement_id = ?")
    .get(settlementId) as { anchor_batch_id: string | null; signature: string | null } | undefined;

  if (row == null) return false;
  if (row.signature == null) return false;
  return row.anchor_batch_id == null;
}

/**
 * Fetch a per-agent anchor batch by id. Returns the spec'd
 * `AgentSettlementAnchorBatch` (spec/agent-settlement-anchor-v1.md §4.1)
 * for external auditors who want to verify the batch independently —
 * the Merkle root + signature are what get committed onchain.
 */
export function getAgentAnchorBatch(
  db: DatabaseDriver,
  batchId: string,
): AgentSettlementAnchorBatch | null {
  const row = db
    .prepare("SELECT * FROM relay_agent_anchor_batches WHERE batch_id = ?")
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
      }
    | undefined;

  if (!row) return null;
  return {
    batch_id: row.batch_id,
    relay_id: row.relay_id,
    merkle_root: row.merkle_root,
    leaf_count: row.leaf_count,
    first_settled_at: row.first_settled_at,
    last_settled_at: row.last_settled_at,
    suite: AGENT_SETTLEMENT_ANCHOR_SUITE,
    signature: row.signature,
    anchor: chainAnchorFromRow(row),
  };
}

/** Resolve relay public key (hex) from the relay_identity table. Mirrors
 *  the helper used by credential-anchoring.ts so the per-agent proof endpoint
 *  is self-contained for the verifier. */
function getRelayPublicKeyHex(db: DatabaseDriver, relayId: string): string {
  const row = db
    .prepare("SELECT public_key FROM relay_identity WHERE relay_motebit_id = ?")
    .get(relayId) as { public_key: string } | undefined;
  if (!row) {
    throw new Error(`Relay identity not found for ${relayId}`);
  }
  return row.public_key;
}

/** Build a CAIP-2-derived `AgentSettlementChainAnchor` from the batch row, or
 *  null if the batch hasn't been submitted onchain yet. Chain is the prefix of
 *  the CAIP-2 network (e.g. `eip155:8453` → chain `eip155`) per CAIP-2 §1. */
function chainAnchorFromRow(row: {
  tx_hash: string | null;
  network: string | null;
  anchored_at: number | null;
}): AgentSettlementChainAnchor | null {
  if (row.tx_hash == null || row.network == null || row.anchored_at == null) {
    return null;
  }
  const chain = row.network.split(":")[0] ?? row.network;
  return {
    chain,
    network: row.network,
    tx_hash: row.tx_hash,
    anchored_at: row.anchored_at,
  };
}

/**
 * Periodic batching loop for per-agent settlements. Same trigger
 * semantics as `startBatchAnchorLoop` (federation): cut a batch when
 * either the count threshold or the time threshold fires; submit the
 * Merkle root onchain when a submitter is configured; retry previously
 * failed submissions on each tick.
 *
 * Returns the setInterval handle so the caller can clearInterval on
 * shutdown.
 */
export function startAgentSettlementAnchorLoop(
  db: DatabaseDriver,
  relayIdentity: RelayIdentity,
  config: AnchoringConfig = {},
  isFrozen?: () => boolean,
): ReturnType<typeof setInterval> {
  const maxSize = config.batchMaxSize ?? DEFAULT_BATCH_MAX_SIZE;
  const intervalMs = config.batchIntervalMs ?? DEFAULT_BATCH_INTERVAL_MS;
  const checkIntervalMs = Math.min(60_000, intervalMs);

  // Same submitter-resolution logic as the federation loop. Both loops
  // share the same ChainAnchorSubmitter abstraction; configure once at
  // startup and inject into both.
  const submitter =
    config.submitter ??
    (config.chainRpcUrl && config.contractAddress
      ? new EvmContractSubmitter({
          chainRpcUrl: config.chainRpcUrl,
          contractAddress: config.contractAddress,
          chainNetwork: config.chainNetwork,
        })
      : undefined);

  return setInterval(() => {
    if (isFrozen?.()) return;

    void (async () => {
      try {
        // Count unanchored signed settlements. Filter on
        // signature IS NOT NULL — pre-v13 unsigned legacy rows are not
        // batchable (their leaf wouldn't match what the relay signed,
        // because it didn't).
        const countRow = db
          .prepare(
            "SELECT COUNT(*) as cnt FROM relay_settlements WHERE anchor_batch_id IS NULL AND signature IS NOT NULL",
          )
          .get() as { cnt: number };

        if (countRow.cnt === 0) return;

        let batch: AnchorRecord | null = null;
        if (countRow.cnt >= maxSize) {
          // Trigger 1: count threshold
          batch = await cutAgentSettlementBatch(db, relayIdentity, maxSize);
        } else {
          // Trigger 2: time threshold — check oldest unanchored signed settlement
          const oldest = db
            .prepare(
              "SELECT MIN(settled_at) as oldest FROM relay_settlements WHERE anchor_batch_id IS NULL AND signature IS NOT NULL",
            )
            .get() as { oldest: number | null };

          if (oldest.oldest != null && Date.now() - oldest.oldest >= intervalMs) {
            batch = await cutAgentSettlementBatch(db, relayIdentity, maxSize);
          }
        }

        // Attempt onchain submission for newly cut batch
        if (batch && submitter) {
          await submitAgentAnchorOnChain(db, batch.batch_id, submitter);
        }

        // Retry previously failed submissions
        if (submitter) {
          const failedBatches = db
            .prepare(
              "SELECT batch_id FROM relay_agent_anchor_batches WHERE status = 'signed' AND tx_hash IS NULL",
            )
            .all() as { batch_id: string }[];

          for (const fb of failedBatches) {
            await submitAgentAnchorOnChain(db, fb.batch_id, submitter);
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("anchoring.agent_loop_error", { error: message });
      }
    })();
  }, checkIntervalMs);
}

/**
 * Fetch the inclusion proof for a per-agent settlement, if anchored.
 * Returns null if the settlement is unbatched, or if no row matches.
 *
 * Mirrors `getSettlementProof` (federation) but reads from
 * `relay_settlements` + `relay_agent_anchor_batches`.
 *
 * The returned proof is sufficient for an external verifier to:
 *   1. Recompute the leaf hash from the SettlementRecord they hold
 *   2. Walk the Merkle path with `proof.siblings` + `leaf_index`
 *   3. Compare the reconstructed root to `merkle_root` (and, if
 *      `anchor.tx_hash` is non-null, to the value committed onchain)
 *
 * No relay contact required for any step beyond initially fetching
 * the proof itself.
 */
export async function getAgentSettlementProof(
  db: DatabaseDriver,
  settlementId: string,
): Promise<AgentSettlementAnchorProof | null> {
  const settlement = db
    .prepare(
      `SELECT settlement_id, motebit_id, receipt_hash, ledger_hash,
              amount_settled, platform_fee, platform_fee_rate, status,
              settled_at, issuer_relay_id, suite, signature, anchor_batch_id
       FROM relay_settlements
       WHERE settlement_id = ?`,
    )
    .get(settlementId) as (AgentSettlementRow & { anchor_batch_id: string | null }) | undefined;

  if (!settlement || !settlement.anchor_batch_id) return null;

  const batchId = settlement.anchor_batch_id;

  const anchor = db
    .prepare("SELECT * FROM relay_agent_anchor_batches WHERE batch_id = ?")
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

  // Reconstruct tree in the same sort order cutAgentSettlementBatch used.
  const batchSettlements = db
    .prepare(
      `SELECT settlement_id, motebit_id, receipt_hash, ledger_hash,
              amount_settled, platform_fee, platform_fee_rate, status,
              settled_at, issuer_relay_id, suite, signature
       FROM relay_settlements
       WHERE anchor_batch_id = ?
       ORDER BY settled_at ASC, settlement_id ASC`,
    )
    .all(batchId) as AgentSettlementRow[];

  const leaves: string[] = [];
  let targetIndex = -1;
  for (let i = 0; i < batchSettlements.length; i++) {
    const row = batchSettlements[i]!;
    leaves.push(await computeAgentSettlementLeaf(row));
    if (row.settlement_id === settlementId) {
      targetIndex = i;
    }
  }

  if (targetIndex === -1) return null;

  const tree = await buildMerkleTree(leaves);
  const proof = getMerkleProof(tree, targetIndex);

  return {
    settlement_id: settlementId,
    settlement_hash: proof.leaf,
    batch_id: batchId,
    merkle_root: tree.root,
    leaf_count: anchor.leaf_count,
    first_settled_at: anchor.first_settled_at,
    last_settled_at: anchor.last_settled_at,
    leaf_index: proof.index,
    siblings: proof.siblings,
    layer_sizes: proof.layerSizes,
    relay_id: anchor.relay_id,
    relay_public_key: getRelayPublicKeyHex(db, anchor.relay_id),
    suite: AGENT_SETTLEMENT_ANCHOR_SUITE,
    batch_signature: anchor.signature,
    anchor: chainAnchorFromRow(anchor),
  };
}
