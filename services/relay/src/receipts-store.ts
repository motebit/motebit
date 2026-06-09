/**
 * Durable archive of the full signed ExecutionReceipt tree.
 *
 * relay_settlements keeps only `receipt_hash`; this module keeps the
 * byte-identical canonical JSON so an auditor can reconstruct the
 * chain and re-verify every signature without relay contact. Close
 * companion to the operator-transparency declaration, which names
 * `relay_receipts` under the Operational retention layer.
 *
 * Storage is a relay implementation concern, not protocol (spec
 * §11.1 Storage is explicitly non-binding). The wire format lives
 * in `@motebit/protocol`; the cryptographic primitive (JCS +
 * Ed25519) lives in `@motebit/encryption`. Only this projection —
 * SQLite rows keyed by (motebit_id, task_id) — is local to the
 * reference relay.
 */

import type { DatabaseDriver } from "@motebit/persistence";
import type { ExecutionReceipt } from "@motebit/sdk";
/* eslint-disable-next-line no-restricted-imports -- relay archives canonical bytes */
import { canonicalJson } from "@motebit/encryption";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "receipts-store" });

/**
 * Matches MAX_SETTLEMENT_DEPTH in tasks.ts. Chains deeper than this
 * are truncated at the persistence layer for the same reason
 * settlement drops them: a pathological tree is adversarial, not a
 * normal workload.
 */
const MAX_RECEIPT_DEPTH = 10;

const INSERT_SQL = `
  INSERT OR IGNORE INTO relay_receipts (
    motebit_id, task_id, parent_task_id, depth, status,
    suite, public_key, signature, invocation_origin,
    receipt_json, received_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/**
 * Stable identifier for a receipt row. The wire field
 * `relay_task_id` (§11.6) is the authoritative key when present; a
 * receipt without it is either a p2p or synthetic delegation and
 * uses the agent's own `task_id`. Both forms are unique per
 * (motebit_id, task_id).
 */
function receiptTaskId(r: ExecutionReceipt): string {
  return r.relay_task_id != null && r.relay_task_id.length > 0 ? r.relay_task_id : r.task_id;
}

/**
 * Persist a receipt tree. Recurses over `delegation_receipts` so a
 * single call archives the entire chain. Composite PK
 * (motebit_id, task_id) + INSERT OR IGNORE make re-submission
 * idempotent — mirrors the duplicate-settlement short-circuit in
 * handleReceiptIngestion.
 *
 * Not wrapped in a transaction: each insert is its own commit so a
 * partial chain is still durable. The composite PK makes partial
 * retries safe.
 *
 * Returns whether the ROOT receipt row was newly inserted. `false`
 * means this exact (motebit_id, task_id) was archived by a previous
 * request — the caller uses this to make side effects that must be
 * exactly-once per receipt (trust updates, credential issuance)
 * replay-proof, independently of whether a settlement row exists.
 * Settlement itself stays retryable on resubmission by design.
 */
export function persistReceiptChain(
  db: DatabaseDriver,
  receipt: ExecutionReceipt,
  parentTaskId: string | null = null,
  depth = 0,
  receivedAt: number = Date.now(),
): boolean {
  if (depth > MAX_RECEIPT_DEPTH) {
    logger.warn("receipt.persist.depth_limit_exceeded", {
      motebitId: receipt.motebit_id,
      taskId: receiptTaskId(receipt),
      depth,
      maxDepth: MAX_RECEIPT_DEPTH,
    });
    return false;
  }

  const taskId = receiptTaskId(receipt);

  // canonicalJson is deterministic JCS: re-canonicalizing a parsed
  // receipt produces bytes identical to what the signer signed. The
  // auditor strips `signature`, re-canonicalizes the body, and
  // verifies against `public_key` — offline, no relay required.
  const receiptJson = canonicalJson(receipt);

  const info = db
    .prepare(INSERT_SQL)
    .run(
      receipt.motebit_id,
      taskId,
      parentTaskId,
      depth,
      receipt.status,
      receipt.suite,
      receipt.public_key ?? "",
      receipt.signature,
      receipt.invocation_origin ?? null,
      receiptJson,
      receivedAt,
    );

  const children = receipt.delegation_receipts ?? [];
  for (const child of children) {
    persistReceiptChain(db, child, taskId, depth + 1, receivedAt);
  }
  return info.changes > 0;
}

/**
 * Fetch a stored receipt's canonical JSON. Returns null if no row
 * matches. The caller is responsible for auth — this module does
 * not know about audiences or bearer tokens.
 */
export function getStoredReceiptJson(
  db: DatabaseDriver,
  motebitId: string,
  taskId: string,
): string | null {
  const row = db
    .prepare("SELECT receipt_json FROM relay_receipts WHERE motebit_id = ? AND task_id = ?")
    .get(motebitId, taskId) as { receipt_json: string } | undefined;
  return row?.receipt_json ?? null;
}

/** A row in a motebit's own receipt history. `receipt_json` is the
 *  byte-identical canonical JSON (rule 11) — return it verbatim so the
 *  caller can re-verify the signature offline. */
export interface StoredReceiptSummary {
  readonly task_id: string;
  readonly status: string;
  readonly invocation_origin: string | null;
  readonly received_at: number;
  readonly receipt_json: string;
}

/**
 * List a motebit's OWN top-level execution receipts (depth 0 — each is
 * a task; nested delegations are reachable inside each receipt's own
 * `delegation_receipts`). Newest first, hard-capped. Caller enforces
 * auth (the route gates on a `receipts:read` device token for this
 * `motebitId`); this module only reads rows.
 */
export function listStoredReceipts(
  db: DatabaseDriver,
  motebitId: string,
  limit = 50,
): StoredReceiptSummary[] {
  const capped = Math.max(1, Math.min(limit, 200));
  return db
    .prepare(
      `SELECT task_id, status, invocation_origin, received_at, receipt_json
         FROM relay_receipts
        WHERE motebit_id = ? AND depth = 0
        ORDER BY received_at DESC
        LIMIT ?`,
    )
    .all(motebitId, capped) as StoredReceiptSummary[];
}
