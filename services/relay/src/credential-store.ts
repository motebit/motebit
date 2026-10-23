/**
 * The credential store: the ONE module that touches `relay_credentials`
 * (GHSA-7pgw-2976-r236).
 *
 * The table is EVIDENCE, not a trust source. A row stored before the verifier
 * bound a credential's issuer to its proof's signer can name an issuer that
 * never signed it; v59 removes such rows unless they are already anchored,
 * because removing an anchored leaf would break the inclusion proofs of the
 * honest credentials in its batch.
 *
 * Every SQL statement against the table lives here (the schema migrations in
 * `migrations.ts` aside), as a named function of one of two kinds:
 *
 * - EVIDENCE functions (`...Evidence...`) return or write raw rows and confer
 *   nothing: the anchoring stream (batches, counts, inclusion proofs attest
 *   that a row was RECORDED, never that its issuer signed it), the writers,
 *   submit idempotency, revoke authority (revoking a stored forgery confers
 *   nothing), and the migration export's count of what it excluded.
 * - BOUND / VERIFIED functions (`...Bound...`, `...Verified...`) are what a
 *   consumer that presents, counts or weighs a credential AS ISSUED BY ITS
 *   ISSUER reads: routing, discovery's hardware badge, the departure
 *   attestation's count, the relay's signed presentation and the migration
 *   export. The owner's own list (`listOwnerCredentialsWithBoundStatus`) shows
 *   every row, each with its `issuer_bound` status, instead of hiding any.
 *
 * What "bound" establishes, and what it does not:
 * - The issuer a credential names IS the key that signed it
 *   (`proof.verificationMethod` before `#` equals the issuer DID). This is
 *   AUTHENTICITY of attribution, not validity and not authority.
 * - The signature itself was verified when the row was written. Every writer
 *   is here: `credentials/submit` verifies before it stores
 *   (`insertSubmittedCredential`, filed under a `BoundIdentity`, #850), and
 *   the relay's own reputation issuance (tasks.ts, federation-callbacks.ts,
 *   `insertRelayIssuedCredentialEvidence`) signs with the relay key. Nothing
 *   else inserts into the table, and the boundary test registers every caller
 *   of every writer.
 * - Revocation, freshness and issuer trust are NOT applied here. The deciding
 *   consumer applies them (the routing aggregators: `checkRevoked`,
 *   freshness, issuer trust).
 * - The verified reads re-verify each credential in full (signature,
 *   binding, validity window) for outputs the relay vouches for: its signed
 *   presentation and the migration export.
 *
 * `__tests__/credential-store-boundary.test.ts` fails when any other relay
 * source mentions the table, and when a bound read here skips the binding
 * predicate before its LIMIT.
 */
import {
  canonicalJson,
  verifyVerifiableCredential,
  type VerifiableCredential,
} from "@motebit/encryption";
import { boundIssuerDid } from "@motebit/market";
import type { DatabaseDriver } from "@motebit/persistence";
import { unwrapBound, type BoundIdentity } from "./identity-binding.js";

/**
 * The table's name, for the operator's retention declaration
 * (`transparency.ts`), which must name it and must not spell it.
 */
export const CREDENTIAL_STORE_TABLE = "relay_credentials";

// === The binding rule ===

/** The issuer DID a stored credential names, in SQL (`issuer`, or `issuer.id`). */
const ISSUER_SQL = `CASE json_type(credential_json, '$.issuer')
  WHEN 'text' THEN json_extract(credential_json, '$.issuer')
  WHEN 'object' THEN CASE json_type(credential_json, '$.issuer.id')
    WHEN 'text' THEN json_extract(credential_json, '$.issuer.id') END
END`;
const VM_SQL = `json_extract(credential_json, '$.proof.verificationMethod')`;

/**
 * The binding rule as a SQL predicate over a stored row, for a WHERE clause,
 * so a LIMIT applies to bound rows only. It mirrors `boundIssuerDid` and v59's
 * triggers; `readBoundCredentials` re-applies the TypeScript rule to whatever
 * it returns, and a row must pass both.
 */
export const BOUND_ISSUER_SQL = `(json_valid(credential_json) = 1
  AND json_type(credential_json, '$.proof.verificationMethod') = 'text'
  AND COALESCE((${ISSUER_SQL}) <> '', 0)
  AND (CASE WHEN instr(${VM_SQL}, '#') > 0
        THEN substr(${VM_SQL}, 1, instr(${VM_SQL}, '#') - 1)
        ELSE ${VM_SQL} END) = (${ISSUER_SQL})
  AND issuer_did = (${ISSUER_SQL}))`;

/** The parsed credential, or null when the stored text is ambiguous or not an object. */
function parseCanonical(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  // Every writer stores JSON.stringify output. Text that does not round-trip
  // (duplicate keys, which SQLite's json_extract and JSON.parse resolve
  // differently) is ambiguous, and fails closed.
  if (JSON.stringify(parsed) !== text) return null;
  return parsed as Record<string, unknown>;
}

/** Whether a stored row's credential names, as issuer, the key that signed it. */
export function isBoundRow(row: { credential_json: string }): boolean {
  const vc = parseCanonical(row.credential_json);
  if (vc == null) return false;
  const proof = vc.proof as { verificationMethod?: unknown } | undefined;
  return boundIssuerDid({ issuer: vc.issuer, proof }) !== undefined;
}

/** Rows whose stored credential's proof signer IS its named issuer. */
export function boundCredentialRows<T extends { credential_json: string }>(
  rows: readonly T[],
): T[] {
  return rows.filter(isBoundRow);
}

type ReadDb = Pick<DatabaseDriver, "prepare">;

/**
 * A bound read: `sql` must include `BOUND_ISSUER_SQL` in its WHERE clause
 * (before any LIMIT); the rows are filtered again in TypeScript. Module-private:
 * callers use the named bound functions below.
 */
function readBoundCredentials<T extends { credential_json: string }>(
  db: ReadDb,
  sql: string,
  ...params: unknown[]
): T[] {
  return boundCredentialRows(db.prepare(sql).all(...params) as T[]);
}

/**
 * A verified read, for outputs the relay vouches for: bound rows whose
 * credential's signature and issuer binding verify.
 *
 * `validity`:
 * - "current" (the relay's signed presentation): the credential must also be
 *   within its validity window now. An expired credential would make the
 *   presentation fail verification.
 * - "history" (the migration export): the validity window is NOT applied.
 *   Expired credentials are the agent's history, and spec/migration-v1.md
 *   §6.2 forbids withholding credentials issued to the agent. The check runs
 *   as of the credential's own `validFrom`, so only signature and binding
 *   decide.
 */
async function readVerifiedCredentials<T extends { credential_json: string }>(
  validity: "current" | "history",
  db: ReadDb,
  sql: string,
  ...params: unknown[]
): Promise<T[]> {
  const out: T[] = [];
  for (const row of readBoundCredentials<T>(db, sql, ...params)) {
    const vc = JSON.parse(row.credential_json) as VerifiableCredential;
    const asOf =
      validity === "history" && typeof vc.validFrom === "string"
        ? Date.parse(vc.validFrom)
        : undefined;
    const now = asOf !== undefined && Number.isFinite(asOf) ? asOf : undefined;
    if (await verifyVerifiableCredential(vc, now !== undefined ? { now } : undefined)) {
      out.push(row);
    }
  }
  return out;
}

// === Bound / verified reads (consumers that confer trust) ===

/**
 * Routing: the candidate's most recent 50 `AgentReputationCredential`s whose
 * named issuer signed them (the binding applies before the LIMIT).
 */
export function readBoundReputationCredentialsForRouting(
  db: ReadDb,
  subjectMotebitId: string,
): Array<{ credential_json: string }> {
  return readBoundCredentials<{ credential_json: string }>(
    db,
    `SELECT credential_json FROM relay_credentials
           WHERE subject_motebit_id = ? AND credential_type = 'AgentReputationCredential'
             AND ${BOUND_ISSUER_SQL}
           ORDER BY issued_at DESC LIMIT 50`,
    subjectMotebitId,
  );
}

/**
 * Routing: the candidate's most recent 50 `AgentTrustCredential`s (the
 * hardware-attestation dimension) whose named issuer signed them.
 */
export function readBoundTrustCredentialsForRouting(
  db: ReadDb,
  subjectMotebitId: string,
): Array<{ credential_json: string }> {
  return readBoundCredentials<{ credential_json: string }>(
    db,
    `SELECT credential_json FROM relay_credentials
           WHERE subject_motebit_id = ? AND credential_type = 'AgentTrustCredential'
             AND ${BOUND_ISSUER_SQL}
           ORDER BY issued_at DESC LIMIT 50`,
    subjectMotebitId,
  );
}

/**
 * Discovery's hardware-attestation badge: every bound `AgentTrustCredential`
 * about any of `subjectMotebitIds`, most recent first.
 */
export function readBoundTrustCredentialsForSubjects(
  db: ReadDb,
  subjectMotebitIds: readonly string[],
): Array<{
  credential_id: string;
  subject_motebit_id: string;
  credential_json: string;
  issued_at: number;
}> {
  if (subjectMotebitIds.length === 0) return [];
  const placeholders = subjectMotebitIds.map(() => "?").join(",");
  return readBoundCredentials<{
    credential_id: string;
    subject_motebit_id: string;
    credential_json: string;
    issued_at: number;
  }>(
    db,
    `SELECT credential_id, subject_motebit_id, credential_json, issued_at
       FROM relay_credentials
       WHERE credential_type = 'AgentTrustCredential'
         AND subject_motebit_id IN (${placeholders})
         AND ${BOUND_ISSUER_SQL}
       ORDER BY issued_at DESC`,
    ...subjectMotebitIds,
  );
}

/** The departure attestation: how many stored credentials about the subject are bound. */
export function countBoundCredentialsForSubject(db: ReadDb, subjectMotebitId: string): number {
  return readBoundCredentials<{ credential_json: string }>(
    db,
    `SELECT credential_json FROM relay_credentials WHERE subject_motebit_id = ? AND ${BOUND_ISSUER_SQL}`,
    subjectMotebitId,
  ).length;
}

/**
 * The relay's signed presentation: the subject's most recent `limit`
 * credentials (of `credentialType`, when given) that verify in full NOW
 * (signature, issuer binding, validity window).
 */
export function readVerifiedCredentialsForPresentation(
  db: ReadDb,
  subjectMotebitId: string,
  credentialType: string | undefined,
  limit: number,
): Promise<Array<{ credential_json: string }>> {
  if (credentialType) {
    return readVerifiedCredentials<{ credential_json: string }>(
      "current",
      db,
      `SELECT credential_json FROM relay_credentials WHERE subject_motebit_id = ? AND credential_type = ? AND ${BOUND_ISSUER_SQL} ORDER BY issued_at DESC LIMIT ?`,
      subjectMotebitId,
      credentialType,
      limit,
    );
  }
  return readVerifiedCredentials<{ credential_json: string }>(
    "current",
    db,
    `SELECT credential_json FROM relay_credentials WHERE subject_motebit_id = ? AND ${BOUND_ISSUER_SQL} ORDER BY issued_at DESC LIMIT ?`,
    subjectMotebitId,
    limit,
  );
}

/**
 * The migration export: every credential about the subject whose signature
 * and issuer binding verify, expired ones included (spec/migration-v1.md
 * §6.2), oldest first.
 */
export function readVerifiedCredentialsForExport(
  db: ReadDb,
  subjectMotebitId: string,
): Promise<Array<{ credential_id: string; credential_json: string }>> {
  return readVerifiedCredentials<{ credential_id: string; credential_json: string }>(
    "history",
    db,
    `SELECT credential_id, credential_json FROM relay_credentials WHERE subject_motebit_id = ? AND ${BOUND_ISSUER_SQL} ORDER BY issued_at ASC`,
    subjectMotebitId,
  );
}

/**
 * The owner's own list: EVERY credential stored under its id, most recent
 * `limit` (of `credentialType`, when given), each with `issuer_bound` — a
 * row stored before the issuer binding is shown, never hidden, and marked.
 */
export function listOwnerCredentialsWithBoundStatus(
  db: ReadDb,
  subjectMotebitId: string,
  credentialType: string | undefined,
  limit: number,
): Array<{
  credential_id: string;
  credential_type: string;
  credential_json: string;
  issued_at: number;
  issuer_bound: boolean;
}> {
  type Row = {
    credential_id: string;
    credential_type: string;
    credential_json: string;
    issued_at: number;
  };
  const rows: Row[] = credentialType
    ? (db
        .prepare(
          "SELECT credential_id, credential_type, credential_json, issued_at FROM relay_credentials WHERE subject_motebit_id = ? AND credential_type = ? ORDER BY issued_at DESC LIMIT ?",
        )
        .all(subjectMotebitId, credentialType, limit) as Row[])
    : (db
        .prepare(
          "SELECT credential_id, credential_type, credential_json, issued_at FROM relay_credentials WHERE subject_motebit_id = ? ORDER BY issued_at DESC LIMIT ?",
        )
        .all(subjectMotebitId, limit) as Row[]);
  return rows.map((r) => ({ ...r, issuer_bound: isBoundRow(r) }));
}

// === Evidence: writes ===

export interface CredentialEvidenceRow {
  credentialId: string;
  subjectMotebitId: string;
  issuerDid: string;
  credentialType: string;
  credentialJson: string;
  issuedAt: number;
}

/**
 * Store a reputation credential the RELAY issued and signed (tasks.ts,
 * federation-callbacks.ts). Throws on a held `credential_id`, and v59's
 * triggers refuse a row whose proof signer is not its named issuer.
 */
export function insertRelayIssuedCredentialEvidence(db: ReadDb, row: CredentialEvidenceRow): void {
  db.prepare(
    `INSERT INTO relay_credentials (credential_id, subject_motebit_id, issuer_did, credential_type, credential_json, issued_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    row.credentialId,
    row.subjectMotebitId,
    row.issuerDid,
    row.credentialType,
    row.credentialJson,
    row.issuedAt,
  );
}

/**
 * File a submitted credential under its bound subject (#850). `owner` is the
 * identity `bindCredentialSubject` proved the credential is about; it is
 * read only through `unwrapBound`. Idempotent: `true` when the row is new or
 * is this exact credential under this owner already; `false` when the
 * `credential_id` is held by a different credential or another identity —
 * the caller refuses it rather than report a silent no-op as accepted.
 */
export function insertSubmittedCredential(
  db: ReadDb,
  owner: BoundIdentity,
  row: { credentialId: string; issuerDid: string; credentialType: string; credentialJson: string },
): boolean {
  const subject = unwrapBound(owner);
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO relay_credentials
       (credential_id, subject_motebit_id, issuer_did, credential_type, credential_json, issued_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.credentialId,
      subject,
      row.issuerDid,
      row.credentialType,
      row.credentialJson,
      Date.now(),
    );
  if (result.changes > 0) return true;
  const held = getCredentialEvidenceHolding(db, row.credentialId);
  // The SAME credential re-submitted is idempotent even when its keys arrive
  // in another order (spec §7.1 step 6): compare the JCS canonical forms, not
  // the stored bytes.
  if (held === undefined || held.subject_motebit_id !== subject) return false;
  try {
    return (
      canonicalJson(JSON.parse(held.credential_json)) ===
      canonicalJson(JSON.parse(row.credentialJson))
    );
  } catch {
    return false;
  }
}

// === Evidence: reads by id ===

/** Submit idempotency: the stored subject and bytes under `credentialId`. */
export function getCredentialEvidenceHolding(
  db: ReadDb,
  credentialId: string,
): { subject_motebit_id: string; credential_json: string } | undefined {
  return db
    .prepare(
      "SELECT subject_motebit_id, credential_json FROM relay_credentials WHERE credential_id = ?",
    )
    .get(credentialId) as { subject_motebit_id: string; credential_json: string } | undefined;
}

/** Revoke authority: the stored subject and issuer column under `credentialId`. */
export function getCredentialEvidenceParties(
  db: ReadDb,
  credentialId: string,
): { subject_motebit_id: string; issuer_did: string } | undefined {
  return db
    .prepare("SELECT subject_motebit_id, issuer_did FROM relay_credentials WHERE credential_id = ?")
    .get(credentialId) as { subject_motebit_id: string; issuer_did: string } | undefined;
}

/** The migration export's accounting: every stored credential about the subject. */
export function countCredentialEvidenceForSubject(db: ReadDb, subjectMotebitId: string): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM relay_credentials WHERE subject_motebit_id = ?")
      .get(subjectMotebitId) as { n: number }
  ).n;
}

// === Evidence: the anchoring stream ===

export interface CredentialEvidenceLeaf {
  credential_id: string;
  credential_json: string;
  issued_at: number;
}

/** Schema: add `anchor_batch_id` (credential-anchor-v1.md §7); a no-op when present. */
export function addCredentialEvidenceAnchorColumn(db: Pick<DatabaseDriver, "exec">): void {
  try {
    db.exec("ALTER TABLE relay_credentials ADD COLUMN anchor_batch_id TEXT");
  } catch {
    /* column already exists */
  }
}

/** Up to `limit` unanchored rows, in the deterministic leaf order. */
export function listUnanchoredCredentialEvidence(
  db: ReadDb,
  limit: number,
): CredentialEvidenceLeaf[] {
  return db
    .prepare(
      `SELECT credential_id, credential_json, issued_at
       FROM relay_credentials
       WHERE anchor_batch_id IS NULL
       ORDER BY issued_at ASC, credential_id ASC
       LIMIT ?`,
    )
    .all(limit) as CredentialEvidenceLeaf[];
}

/**
 * Stamp each row cut into `batchId`, only while it is unanchored: a credential
 * is anchored in at most one batch. Returns how many rows it stamped; the cut
 * (in its transaction) refuses a count short of its leaves.
 */
export function assignCredentialEvidenceToBatch(
  db: ReadDb,
  batchId: string,
  credentialIds: readonly string[],
): number {
  const assignStmt = db.prepare(
    "UPDATE relay_credentials SET anchor_batch_id = ? WHERE credential_id = ? AND anchor_batch_id IS NULL",
  );
  let assigned = 0;
  for (const credentialId of credentialIds) {
    assigned += assignStmt.run(batchId, credentialId).changes;
  }
  return assigned;
}

/** How many rows await a batch. */
export function countUnanchoredCredentialEvidence(db: ReadDb): number {
  return (
    db
      .prepare("SELECT COUNT(*) as cnt FROM relay_credentials WHERE anchor_batch_id IS NULL")
      .get() as { cnt: number }
  ).cnt;
}

/** The oldest unanchored row's `issued_at`, or null. */
export function oldestUnanchoredCredentialEvidenceIssuedAt(db: ReadDb): number | null {
  return (
    db
      .prepare(
        "SELECT MIN(issued_at) as oldest FROM relay_credentials WHERE anchor_batch_id IS NULL",
      )
      .get() as { oldest: number | null }
  ).oldest;
}

/** A row and its batch, for an inclusion proof. */
export function getCredentialEvidenceWithBatch(
  db: ReadDb,
  credentialId: string,
): (CredentialEvidenceLeaf & { anchor_batch_id: string | null }) | undefined {
  return db
    .prepare(
      `SELECT credential_id, credential_json, issued_at, anchor_batch_id
       FROM relay_credentials
       WHERE credential_id = ?`,
    )
    .get(credentialId) as (CredentialEvidenceLeaf & { anchor_batch_id: string | null }) | undefined;
}

/** Every row in `batchId`, in the order the batch was cut. */
export function listCredentialEvidenceInBatch(
  db: ReadDb,
  batchId: string,
): CredentialEvidenceLeaf[] {
  return db
    .prepare(
      `SELECT credential_id, credential_json, issued_at
       FROM relay_credentials
       WHERE anchor_batch_id = ?
       ORDER BY issued_at ASC, credential_id ASC`,
    )
    .all(batchId) as CredentialEvidenceLeaf[];
}

/** The row's batch id; undefined when no row is held. */
export function getCredentialEvidenceBatchId(
  db: ReadDb,
  credentialId: string,
): { anchor_batch_id: string | null } | undefined {
  return db
    .prepare("SELECT anchor_batch_id FROM relay_credentials WHERE credential_id = ?")
    .get(credentialId) as { anchor_batch_id: string | null } | undefined;
}
