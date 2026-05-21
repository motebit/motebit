/**
 * Identity-transparency log anchoring — makes the log root non-equivocable.
 *
 * Snapshots the current `motebit_id → key` binding set, builds the Merkle root,
 * signs it with the relay's key, and submits it on-chain via the same
 * `ChainAnchorSubmitter` used for settlement/credential anchoring. Once a root is
 * confirmed on-chain, the operator cannot serve a verifier a different binding
 * set without an on-chain-detectable mismatch — this is the non-equivocation the
 * `anchored` rung depends on (`docs/doctrine/identity-binding-verification.md`).
 *
 * Unlike settlement anchoring (incremental batches), each identity anchor is a
 * full snapshot of the current bindings. The `/identity` endpoint serves proofs
 * against the latest confirmed root (`getLatestAnchoredRoot`); the verifier then
 * cross-checks that root on-chain.
 *
 * Mirrors `anchoring.ts` (the settlement/credential anchoring it parallels).
 */

import type { DatabaseDriver } from "@motebit/persistence";
import type { ChainAnchorSubmitter } from "@motebit/sdk";
import { canonicalJson, sign, bytesToHex } from "@motebit/encryption";
import type { RelayIdentity } from "./federation.js";
import { createLogger } from "./logger.js";
import { buildIdentityLog } from "./identity-log.js";
import { readIdentityBindings } from "./identity-transparency.js";

const logger = createLogger({ service: "relay", module: "identity-log-anchoring" });

/** Create the identity-log anchor table. Call from createFederationTables(). */
export function createIdentityLogAnchorTables(db: DatabaseDriver): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_identity_log_anchors (
      anchor_id    TEXT PRIMARY KEY,
      relay_id     TEXT NOT NULL,
      merkle_root  TEXT NOT NULL,
      leaf_count   INTEGER NOT NULL,
      signature    TEXT NOT NULL,
      tx_hash      TEXT,
      network      TEXT,
      anchored_at  INTEGER,
      status       TEXT NOT NULL DEFAULT 'signed',
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_identity_anchors_status
      ON relay_identity_log_anchors(status) WHERE status != 'confirmed';
  `);
}

export interface IdentityLogAnchorRecord {
  anchor_id: string;
  merkle_root: string;
  leaf_count: number;
  relay_id: string;
  signature: string;
  tx_hash: string | null;
  network: string | null;
  anchored_at: number | null;
}

/**
 * Snapshot the current binding set, build + sign its Merkle root, and persist a
 * `signed` anchor record. Returns `null` when there are no bindings (nothing to
 * anchor). Submission on-chain is a separate step (`submitIdentityLogAnchorOnChain`).
 */
export async function anchorIdentityLog(
  db: DatabaseDriver,
  relayIdentity: RelayIdentity,
): Promise<IdentityLogAnchorRecord | null> {
  const log = await buildIdentityLog(readIdentityBindings(db));
  if (log.motebitCount === 0) return null;

  const anchorId = crypto.randomUUID();
  const payload = {
    anchor_id: anchorId,
    merkle_root: log.root,
    leaf_count: log.motebitCount,
    relay_id: relayIdentity.relayMotebitId,
  };
  const signature = bytesToHex(
    await sign(new TextEncoder().encode(canonicalJson(payload)), relayIdentity.privateKey),
  );

  db.prepare(
    `INSERT INTO relay_identity_log_anchors
       (anchor_id, relay_id, merkle_root, leaf_count, signature, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'signed', ?)`,
  ).run(anchorId, relayIdentity.relayMotebitId, log.root, log.motebitCount, signature, Date.now());

  logger.info("identity_log.anchor_cut", {
    anchor_id: anchorId,
    leaf_count: log.motebitCount,
    merkle_root: log.root,
  });

  return {
    anchor_id: anchorId,
    merkle_root: log.root,
    leaf_count: log.motebitCount,
    relay_id: relayIdentity.relayMotebitId,
    signature,
    tx_hash: null,
    network: null,
    anchored_at: null,
  };
}

/**
 * Submit a signed identity-log anchor's root on-chain. Updates the record to
 * `confirmed` with tx_hash/network on success. Returns false on failure (retry).
 * Mirrors `submitAnchorOnChain`.
 */
export async function submitIdentityLogAnchorOnChain(
  db: DatabaseDriver,
  anchorId: string,
  submitter: ChainAnchorSubmitter,
): Promise<boolean> {
  const anchor = db
    .prepare(
      "SELECT merkle_root, relay_id, leaf_count FROM relay_identity_log_anchors WHERE anchor_id = ? AND status = 'signed'",
    )
    .get(anchorId) as { merkle_root: string; relay_id: string; leaf_count: number } | undefined;
  if (!anchor) return true; // already submitted or doesn't exist

  try {
    const result = await submitter.submitMerkleRoot(
      anchor.merkle_root,
      anchor.relay_id,
      anchor.leaf_count,
    );
    db.prepare(
      "UPDATE relay_identity_log_anchors SET tx_hash = ?, network = ?, anchored_at = ?, status = 'confirmed' WHERE anchor_id = ?",
    ).run(result.txHash, submitter.network, Date.now(), anchorId);

    logger.info("identity_log.anchor_confirmed", {
      anchor_id: anchorId,
      tx_hash: result.txHash,
      chain: submitter.chain,
      network: submitter.network,
    });
    return true;
  } catch (err: unknown) {
    logger.warn("identity_log.anchor_submit_error", {
      anchor_id: anchorId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * The latest confirmed (on-chain) identity-log root. The `/identity` endpoint
 * serves proofs against this root; a verifier cross-checks `tx_hash` on-chain
 * before trusting the `anchored` rung. `null` if nothing has been anchored yet.
 */
export function getLatestAnchoredRoot(
  db: DatabaseDriver,
): { merkle_root: string; tx_hash: string; network: string } | null {
  const row = db
    .prepare(
      "SELECT merkle_root, tx_hash, network FROM relay_identity_log_anchors WHERE status = 'confirmed' AND tx_hash IS NOT NULL ORDER BY anchored_at DESC LIMIT 1",
    )
    .get() as { merkle_root: string; tx_hash: string; network: string } | undefined;
  return row ?? null;
}
