/**
 * Read-only audit of credential anchor batches in a relay database SNAPSHOT.
 *
 * The CLI is `services/relay/scripts/audit-credential-anchors.ts`; the founder
 * procedure lives there and in `docs/ops/RUNBOOK.md` §"Credential anchor audit".
 *
 * What it reads, and nothing else: the credential anchor batches, the
 * credential evidence rows (through the credential store), and the relay's
 * PUBLIC key. A snapshot also holds the relay keypair and user data; no
 * statement here names any other column of the relay identity row.
 *
 * Every check goes through the relay's own code or the portable verifier:
 *   - batches: `listCredentialAnchorBatches` (credential-anchoring.ts)
 *   - members: `listCredentialEvidenceInBatch` (credential-store.ts)
 *   - served proofs: `getCredentialAnchorProof`, each verified offline with
 *     `verifyCredentialAnchor` (@motebit/crypto, no chain verifier)
 *   - stored-root signature: `verifyBySuite` over the canonical batch payload
 *     exactly as `cutCredentialBatch` signs it, built from the STORED fields
 *   - recomputed root: `computeCredentialLeaf` + `buildMerkleTree` under the
 *     batch's stored `tree_hash_version` (NULL ⇒ v1)
 *
 * Historical batches are never rebuilt or re-signed: a discrepancy is
 * recorded for investigation, nothing else.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseDriver, PreparedStatement } from "@motebit/persistence";
import type { MerkleTreeVersion } from "@motebit/protocol";
import {
  canonicalJson,
  computeCredentialLeaf,
  hexToBytes,
  resolveTreeHashVersion,
  verifyBySuite,
  verifyCredentialAnchor,
} from "@motebit/crypto";
import { buildMerkleTree } from "@motebit/encryption";
import { getCredentialAnchorProof, listCredentialAnchorBatches } from "./credential-anchoring.js";
import {
  listCredentialEvidenceAnchorBatchIds,
  listCredentialEvidenceInBatch,
} from "./credential-store.js";

/** The suite every credential anchor batch is signed under (credential-anchor-v1.md). */
const BATCH_SUITE = "motebit-jcs-ed25519-hex-v1";

export const AUDIT_OUTCOMES = [
  "PASS",
  "LEAF_COUNT_MISMATCH",
  "ROOT_MISMATCH",
  "SIGNATURE_FAILURE",
  "PROOF_FAILURE",
  "VERIFICATION_INCOMPLETE",
] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/** Outcomes that are evidence of a discrepancy (exit 2). */
const DISCREPANCIES: ReadonlySet<AuditOutcome> = new Set([
  "LEAF_COUNT_MISMATCH",
  "ROOT_MISMATCH",
  "SIGNATURE_FAILURE",
  "PROOF_FAILURE",
]);

export interface BatchAudit {
  batch_id: string;
  relay_id: string;
  outcomes: AuditOutcome[];
  declared_leaf_count: number;
  member_count: number;
  stored_merkle_root: string;
  recomputed_merkle_root: string | null;
  tree_hash_version: string;
  anchored_tx_hash: string | null;
  /** Members whose served inclusion proof failed verifyCredentialAnchor, with the failing steps. */
  proof_failures: Array<{ credential_id: string; errors: string[] }>;
  /** Why the batch could not be fully verified (not evidence of corruption). */
  incomplete_reasons: string[];
}

export interface DanglingBatchReference {
  anchor_batch_id: string;
  credential_ids: string[];
}

export interface AuditReport {
  snapshot_path: string;
  snapshot_mtime: string;
  script_commit: string | null;
  audit_started_at: string;
  batch_count: number;
  counts: Record<AuditOutcome, number>;
  dangling_batch_references: DanglingBatchReference[];
  batches: BatchAudit[];
}

// === Read-only driver ===

/** Thrown when a snapshot is refused before any read; `repair` is the exact fix. */
export class SnapshotRefused extends Error {
  constructor(
    message: string,
    readonly repair: string,
  ) {
    super(message);
    this.name = "SnapshotRefused";
  }
}

function refuseWrite(what: string): never {
  throw new Error(`audit driver is read-only: ${what} refused`);
}

/** The slice of a better-sqlite3 connection the audit uses (the package ships no types). */
export interface SqliteConnection {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  close(): void;
}

type SqliteConstructor = new (
  path: string,
  options: { readonly: boolean; fileMustExist: boolean },
) => SqliteConnection;

/**
 * A DatabaseDriver over a read-only connection. Only SELECT statements may be
 * prepared; exec, pragma and transaction throw. The connection itself is
 * opened `readonly`, so SQLite refuses any write that got past this layer.
 */
export function readOnlyDriver(raw: SqliteConnection): DatabaseDriver {
  return {
    driverName: "audit-readonly",
    exec: () => refuseWrite("exec"),
    pragma: () => refuseWrite("pragma"),
    transaction: () => refuseWrite("transaction"),
    close: () => raw.close(),
    prepare(sql: string): PreparedStatement {
      if (!/^\s*SELECT\b/i.test(sql)) refuseWrite(`non-SELECT statement`);
      const stmt = raw.prepare(sql);
      return {
        run: () => refuseWrite("run"),
        all: (...params: unknown[]) => stmt.all(...params),
        get: (...params: unknown[]) => stmt.get(...params),
      };
    },
  };
}

/** SQLite header bytes 18/19 are 2 for a WAL-mode database (file format §1.3). */
function isWalModeFile(path: string): boolean {
  const header = Buffer.alloc(20);
  const fd = openSync(path, "r");
  try {
    if (readSync(fd, header, 0, 20, 0) < 20) return false;
  } finally {
    closeSync(fd);
  }
  return header.toString("latin1", 0, 15) === "SQLite format 3" && header[18] === 2;
}

/**
 * Open a snapshot read-only. A WAL-mode file is refused: SQLite opens one
 * read-only only by creating `-wal`/`-shm` files beside it, and this audit
 * writes nothing. The repair converts the founder's local COPY to rollback mode.
 */
export function openSnapshotReadOnly(path: string): DatabaseDriver {
  try {
    statSync(path);
  } catch {
    throw new SnapshotRefused(`snapshot not found: ${path}`, "pass the path of the local copy");
  }
  if (isWalModeFile(path)) {
    throw new SnapshotRefused(
      `snapshot is in WAL mode; opening it read-only would create ${path}-wal / ${path}-shm beside it`,
      `sqlite3 '${path}' 'PRAGMA journal_mode=DELETE'   # on your local COPY only, never the volume`,
    );
  }
  const Database = createRequire(import.meta.url)("better-sqlite3") as SqliteConstructor;
  const raw = new Database(path, { readonly: true, fileMustExist: true });
  return readOnlyDriver(raw);
}

// === Audit ===

function hasTable(db: DatabaseDriver, name: string): boolean {
  return (
    db
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  );
}

/** The relay's PUBLIC key for `relayId`, or a reason it is unavailable. */
function relayPublicKey(db: DatabaseDriver, relayId: string): { hex: string } | { reason: string } {
  if (!hasTable(db, "relay_identity")) return { reason: "relay identity table absent" };
  const row = db
    .prepare("SELECT public_key FROM relay_identity WHERE relay_motebit_id = ?")
    .get(relayId) as { public_key: unknown } | undefined;
  if (!row) return { reason: `relay public key unavailable for ${relayId}` };
  if (typeof row.public_key !== "string" || !/^[0-9a-fA-F]{64}$/.test(row.public_key)) {
    return { reason: `relay public key for ${relayId} is not 32-byte hex` };
  }
  return { hex: row.public_key };
}

/** Stored tree_hash_version per batch (NULL ⇒ v1). */
function storedTreeHashVersions(db: DatabaseDriver): Map<string, string | null> {
  const rows = db
    .prepare("SELECT batch_id, tree_hash_version FROM relay_credential_anchor_batches")
    .all() as Array<{ batch_id: string; tree_hash_version: string | null }>;
  return new Map(rows.map((r) => [r.batch_id, r.tree_hash_version]));
}

function countBatches(db: DatabaseDriver): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM relay_credential_anchor_batches").get() as { n: number }
  ).n;
}

function parseCredential(json: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export interface AuditMeta {
  snapshotPath: string;
  snapshotMtime: Date;
  scriptCommit: string | null;
  startedAt: Date;
}

export async function auditCredentialAnchors(
  db: DatabaseDriver,
  meta: AuditMeta,
): Promise<AuditReport> {
  const counts = Object.fromEntries(AUDIT_OUTCOMES.map((o) => [o, 0])) as Record<
    AuditOutcome,
    number
  >;
  const total = countBatches(db);
  const batches = listCredentialAnchorBatches(db, Math.max(total, 1));
  if (batches.length !== total) {
    throw new Error(`listed ${batches.length} batches of ${total}`);
  }
  const versions = storedTreeHashVersions(db);
  const audits: BatchAudit[] = [];

  // Oldest first in the report.
  for (const batch of [...batches].reverse()) {
    const outcomes = new Set<AuditOutcome>();
    const incomplete: string[] = [];
    const members = listCredentialEvidenceInBatch(db, batch.batch_id);
    const storedVersion = versions.get(batch.batch_id) ?? null;
    const version: MerkleTreeVersion | null = resolveTreeHashVersion(storedVersion ?? undefined);

    if (members.length !== batch.leaf_count) outcomes.add("LEAF_COUNT_MISMATCH");

    // Root recomputed from the current members under the stored version.
    let recomputed: string | null = null;
    if (version === null) {
      incomplete.push(`unknown tree_hash_version "${String(storedVersion)}"`);
    } else {
      const leaves: string[] = [];
      for (const m of members) {
        const vc = parseCredential(m.credential_json);
        if (vc === null) {
          incomplete.push(`unparseable credential ${m.credential_id}`);
          continue;
        }
        leaves.push(await computeCredentialLeaf(vc, version));
      }
      if (leaves.length === members.length) {
        recomputed = members.length === 0 ? "" : (await buildMerkleTree(leaves, version)).root;
        if (recomputed !== batch.merkle_root) outcomes.add("ROOT_MISMATCH");
      }
    }

    // Relay signature over the STORED payload, exactly as cutCredentialBatch signs it.
    const key = relayPublicKey(db, batch.relay_id);
    if (batch.suite !== BATCH_SUITE) {
      incomplete.push(`unknown suite "${String(batch.suite)}"`);
    } else if ("reason" in key) {
      incomplete.push(key.reason);
    } else {
      const payload = canonicalJson({
        batch_id: batch.batch_id,
        merkle_root: batch.merkle_root,
        leaf_count: batch.leaf_count,
        first_issued_at: batch.first_issued_at,
        last_issued_at: batch.last_issued_at,
        relay_id: batch.relay_id,
        suite: batch.suite,
      });
      let ok = false;
      try {
        ok = await verifyBySuite(
          batch.suite,
          new TextEncoder().encode(payload),
          hexToBytes(batch.signature),
          hexToBytes(key.hex),
        );
      } catch {
        ok = false;
      }
      if (!ok) outcomes.add("SIGNATURE_FAILURE");
    }

    // Each member's inclusion proof, as the relay serves it, verified offline.
    const proofFailures: BatchAudit["proof_failures"] = [];
    if (!("reason" in key) && version !== null) {
      for (const m of members) {
        const vc = parseCredential(m.credential_json);
        if (vc === null) continue; // already INCOMPLETE
        let proof;
        try {
          proof = await getCredentialAnchorProof(db, m.credential_id);
        } catch (err: unknown) {
          incomplete.push(
            `proof for ${m.credential_id} unavailable: ${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }
        if (proof === null) {
          proofFailures.push({ credential_id: m.credential_id, errors: ["no proof served"] });
          continue;
        }
        const result = await verifyCredentialAnchor(vc, proof);
        if (!result.valid) {
          proofFailures.push({ credential_id: m.credential_id, errors: result.errors });
        }
      }
    }
    if (proofFailures.length > 0) outcomes.add("PROOF_FAILURE");
    if (incomplete.length > 0) outcomes.add("VERIFICATION_INCOMPLETE");
    if (outcomes.size === 0) outcomes.add("PASS");

    const ordered = AUDIT_OUTCOMES.filter((o) => outcomes.has(o));
    for (const o of ordered) counts[o] += 1;
    audits.push({
      batch_id: batch.batch_id,
      relay_id: batch.relay_id,
      outcomes: ordered,
      declared_leaf_count: batch.leaf_count,
      member_count: members.length,
      stored_merkle_root: batch.merkle_root,
      recomputed_merkle_root: recomputed,
      tree_hash_version: storedVersion ?? "merkle-sha256-plain-v1 (NULL)",
      anchored_tx_hash: batch.anchor?.tx_hash ?? null,
      proof_failures: proofFailures,
      incomplete_reasons: incomplete,
    });
  }

  const known = new Set(batches.map((b) => b.batch_id));
  const dangling: DanglingBatchReference[] = listCredentialEvidenceAnchorBatchIds(db)
    .filter((id) => !known.has(id))
    .map((id) => ({
      anchor_batch_id: id,
      credential_ids: listCredentialEvidenceInBatch(db, id).map((m) => m.credential_id),
    }));

  return {
    snapshot_path: meta.snapshotPath,
    snapshot_mtime: meta.snapshotMtime.toISOString(),
    script_commit: meta.scriptCommit,
    audit_started_at: meta.startedAt.toISOString(),
    batch_count: audits.length,
    counts,
    dangling_batch_references: dangling,
    batches: audits,
  };
}

/** 0 every batch PASSes; 2 any discrepancy; 3 only VERIFICATION_INCOMPLETE. */
export function auditExitCode(report: AuditReport): 0 | 2 | 3 {
  const discrepancy =
    report.dangling_batch_references.length > 0 ||
    report.batches.some((b) => b.outcomes.some((o) => DISCREPANCIES.has(o)));
  if (discrepancy) return 2;
  if (report.counts.VERIFICATION_INCOMPLETE > 0) return 3;
  return 0;
}

export function formatAuditReport(report: AuditReport): string {
  const lines: string[] = [
    "Credential anchor audit (read-only)",
    `  snapshot:        ${report.snapshot_path}`,
    `  snapshot mtime:  ${report.snapshot_mtime}`,
    `  script commit:   ${report.script_commit ?? "(unavailable)"}`,
    `  audit started:   ${report.audit_started_at}`,
    `  batches:         ${report.batch_count}`,
    ...AUDIT_OUTCOMES.map((o) => `  ${(o + ":").padEnd(25)}${report.counts[o]}`),
    `  dangling anchor_batch_id references: ${report.dangling_batch_references.length}`,
    "",
  ];
  for (const b of report.batches) {
    if (b.outcomes.length === 1 && b.outcomes[0] === "PASS") continue;
    lines.push(`batch ${b.batch_id}  [${b.outcomes.join(", ")}]`);
    lines.push(
      `  relay ${b.relay_id}  tree ${b.tree_hash_version}  tx ${b.anchored_tx_hash ?? "-"}`,
    );
    lines.push(`  leaf_count declared ${b.declared_leaf_count}, members now ${b.member_count}`);
    lines.push(`  stored root     ${b.stored_merkle_root}`);
    lines.push(`  recomputed root ${b.recomputed_merkle_root ?? "(not computed)"}`);
    for (const f of b.proof_failures) {
      lines.push(`  proof failure ${f.credential_id}: ${f.errors.join("; ")}`);
    }
    for (const r of b.incomplete_reasons) lines.push(`  incomplete: ${r}`);
  }
  for (const d of report.dangling_batch_references) {
    lines.push(
      `dangling anchor_batch_id ${d.anchor_batch_id} (no such batch): ${d.credential_ids.join(", ")}`,
    );
  }
  const passing = report.batches.filter((b) => b.outcomes[0] === "PASS").length;
  lines.push(`${passing} of ${report.batch_count} batch(es) PASS.`);
  return lines.join("\n");
}
