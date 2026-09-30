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

/** Separates a displaced nested child's key from its parent task (#890 r6). */
const NESTED_KEY_SEP = "#nested:";

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

  // A nested child never occupies — or shadows — a top-level key (#890 r6).
  // Children are copied out of ANOTHER task's tree unverified (only the
  // root's signature was checked), so a child claiming (V, X) is archived
  // under its own namespaced key `X#nested:<parent>` — never under (V, X),
  // the key V's own top-level receipt for X is archived and looked up
  // under. It stays readable there (`getStoredReceiptJson` falls back to
  // it for an audit read) and inside its parent's receipt_json. Rows are
  // only ever inserted (rule 12).
  const key = depth === 0 ? taskId : `${taskId}${NESTED_KEY_SEP}${parentTaskId ?? ""}`;
  const info = db
    .prepare(INSERT_SQL)
    .run(
      receipt.motebit_id,
      key,
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
  // An audit read: the bytes are served for the reader to re-verify. The
  // top-level row for (motebitId, taskId) when there is one; else a nested
  // copy archived under `taskId#nested:<parent>` (never verified by the
  // relay on its own). It never DECIDES anything: the archive answer a
  // delegator acts on is `getArchivedReceiptForKeyOwner` (top-level, routed
  // executor only).
  const prefix = `${taskId}${NESTED_KEY_SEP}`;
  const row = db
    .prepare(
      `SELECT receipt_json FROM relay_receipts
        WHERE motebit_id = ?
          AND (task_id = ? OR substr(task_id, 1, ?) = ?)
        ORDER BY depth, received_at
        LIMIT 1`,
    )
    .get(motebitId, taskId, prefix.length, prefix) as { receipt_json: string } | undefined;
  return row?.receipt_json ?? null;
}

/**
 * The archived top-level receipt of a task that one of `motebitId`'s OWN
 * Idempotency-Keys admitted, while that key is still inside the
 * idempotency window (`notBefore` = now − TTL) — or null (#890 r4).
 *
 * The task queue forgets a task minutes after its receipt; the key that
 * admitted it lives 24 h. A delegator re-posting under that key is
 * replayed the task's id and must be able to learn how it ended — a 404
 * there is absence, and absence is never evidence. The key binding is the
 * authorization: a receipt is answered only to the agent whose key
 * admitted the task, and never once the key could admit a new one.
 */
export function getArchivedReceiptForKeyOwner(
  db: DatabaseDriver,
  motebitId: string,
  taskId: string,
  notBefore: number,
): string | null {
  // Only the task's recorded executor answers (#890 r6): the receipt the
  // delegator reads as a signed failure makes it pay for a new task, so it
  // must be the depth-0 receipt of an identity the relay HANDED this task
  // to (`relay_task_routes`, written at every hand-off). The settlement
  // record is no witness — it names the path agent, not the worker. A
  // completed receipt outranks a failed one (one executor delivering is
  // the task's outcome); otherwise the most recent answer.
  const row = db
    .prepare(
      `SELECT r.receipt_json FROM relay_receipts r
        WHERE r.task_id = ? AND r.depth = 0
          AND EXISTS (
            SELECT 1 FROM relay_task_routes t
             WHERE t.task_id = r.task_id AND t.executor_id = r.motebit_id
          )
          AND EXISTS (
            SELECT 1 FROM relay_idempotency_keys k
             WHERE k.task_id = r.task_id AND k.motebit_id = ? AND k.created_at >= ?
          )
        ORDER BY (r.status = 'completed') DESC, r.received_at DESC
        LIMIT 1`,
    )
    .get(taskId, motebitId, notBefore) as { receipt_json: string } | undefined;
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
