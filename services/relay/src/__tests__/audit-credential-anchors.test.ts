/**
 * The read-only credential anchor audit (`scripts/audit-credential-anchors.ts`,
 * logic in `credential-anchor-audit.ts`).
 *
 * Fixtures are real relay databases on disk: the persistence schema, the
 * relay's schema + migrations, credentials issued and signed by their issuer,
 * and batches cut by `cutCredentialBatch`. Each outcome is produced by
 * corrupting a COPY of the clean fixture the way a pre-#1135 batch could have
 * been (stranded member, overwritten membership) or a record could be
 * tampered (root, signature), and the audit must classify it — reading only,
 * proven by the snapshot's hash before and after.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { createMotebitDatabase } from "@motebit/persistence";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import { generateKeypair, bytesToHex, issueReputationCredential } from "@motebit/encryption";
import { createFederationTables, type RelayIdentity } from "../federation.js";
import { createPairingTables } from "../pairing.js";
import { runMigrations, relayMigrations } from "../migrations.js";
import { createCredentialAnchoringTables, cutCredentialBatch } from "../credential-anchoring.js";
import {
  SnapshotRefused,
  auditCredentialAnchors,
  auditExitCode,
  formatAuditReport,
  openSnapshotReadOnly,
  type AuditReport,
} from "../credential-anchor-audit.js";

const RELAY_ROOT = join(__dirname, "..", "..");
const SCRIPT = join(RELAY_ROOT, "scripts", "audit-credential-anchors.ts");
const MODULE = join(RELAY_ROOT, "src", "credential-anchor-audit.ts");
const TSX = join(RELAY_ROOT, "node_modules", ".bin", "tsx");
const run = promisify(execFile);

/** A writable better-sqlite3 connection, for building and corrupting fixtures (no package types). */
interface RawDb {
  prepare(sql: string): { run(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] };
  exec(sql: string): void;
  pragma(sql: string, opts?: { simple: boolean }): unknown;
  close(): void;
}
const Database = createRequire(import.meta.url)("better-sqlite3") as new (path: string) => RawDb;

let dir: string;
let clean: string;
let wal: string;
let batchIds: string[]; // oldest first
let membersOf: Map<string, string[]>;

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function makeRelayIdentity(): Promise<RelayIdentity> {
  const kp = await generateKeypair();
  return {
    relayMotebitId: `relay-${crypto.randomUUID()}`,
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
    publicKeyHex: bytesToHex(kp.publicKey),
    did: `did:key:z${bytesToHex(kp.publicKey).slice(0, 16)}`,
  };
}

/** A real relay database file with three batches (v2, v2, v1) of credentials. */
async function buildFixture(path: string): Promise<void> {
  const mote = createMotebitDatabase(path);
  const db = mote.db;
  createFederationTables(db);
  createPairingTables(db);
  runMigrations(db, relayMigrations);
  createCredentialAnchoringTables(db);

  const relay = await makeRelayIdentity();
  db.prepare(
    `INSERT INTO relay_identity (relay_motebit_id, public_key, private_key_hex, did, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(relay.relayMotebitId, relay.publicKeyHex, bytesToHex(relay.privateKey), relay.did, 1);

  const issuer = await generateKeypair();
  let issuedAt = 1_700_000_000_000;
  for (const [count, version] of [
    [3, "merkle-sha256-rfc6962-v2"],
    [2, "merkle-sha256-rfc6962-v2"],
    [3, "merkle-sha256-plain-v1"],
  ] as const) {
    for (let i = 0; i < count; i++) {
      const subject = `did:key:zSubject${crypto.randomUUID().slice(0, 8)}`;
      const vc = await issueReputationCredential(
        {
          success_rate: 0.9,
          avg_latency_ms: 100,
          task_count: 10 + i,
          trust_score: 0.7,
          availability: 0.99,
          measured_at: issuedAt,
        },
        issuer.privateKey,
        issuer.publicKey,
        subject,
      );
      db.prepare(
        `INSERT INTO relay_credentials
           (credential_id, subject_motebit_id, issuer_did, credential_type, credential_json, issued_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        `cred-${issuedAt}`,
        "agent-1",
        vc.issuer,
        "AgentReputationCredential",
        JSON.stringify(vc),
        issuedAt++,
      );
    }
    const batch = await cutCredentialBatch(db, relay, count, version);
    expect(batch?.leaf_count).toBe(count);
  }
  mote.close();
}

/** Corrupt a copy of the clean fixture with raw SQL; returns its path. */
function corrupt(name: string, sql: string, ...params: unknown[]): string {
  const path = join(dir, `${name}.db`);
  copyFileSync(clean, path);
  const raw = new Database(path);
  raw.prepare(sql).run(...params);
  raw.close();
  return path;
}

async function audit(path: string): Promise<AuditReport> {
  const db = openSnapshotReadOnly(path);
  try {
    return await auditCredentialAnchors(db, {
      snapshotPath: path,
      snapshotMtime: new Date(0),
      scriptCommit: null,
      startedAt: new Date(0),
    });
  } finally {
    db.close();
  }
}

function outcomesOf(report: AuditReport, batchId: string): string[] {
  return report.batches.find((b) => b.batch_id === batchId)!.outcomes;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "audit-cred-anchors-"));
  wal = join(dir, "wal.db");
  await buildFixture(wal); // createMotebitDatabase leaves the file in WAL mode
  clean = join(dir, "clean.db");
  copyFileSync(wal, clean);
  const raw = new Database(clean);
  expect(raw.pragma("journal_mode = DELETE", { simple: true })).toBe("delete");
  batchIds = (
    raw.prepare("SELECT batch_id FROM relay_credential_anchor_batches ORDER BY rowid").all() as {
      batch_id: string;
    }[]
  ).map((r) => r.batch_id);
  membersOf = new Map(
    batchIds.map((id) => [
      id,
      (
        raw
          .prepare(
            "SELECT credential_id FROM relay_credentials WHERE anchor_batch_id = ? ORDER BY issued_at",
          )
          .all(id) as { credential_id: string }[]
      ).map((r) => r.credential_id),
    ]),
  );
  raw.close();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("credential anchor audit", () => {
  it("a clean snapshot: every batch PASSes, exit 0, and the file is unchanged", async () => {
    const before = sha256(clean);
    const listing = readdirSync(dir).sort();
    const report = await audit(clean);
    expect(report.batch_count).toBe(3);
    expect(report.batches.map((b) => b.outcomes)).toEqual([["PASS"], ["PASS"], ["PASS"]]);
    expect(report.batches.map((b) => b.batch_id)).toEqual(batchIds);
    expect(report.batches[2]!.tree_hash_version).toMatch(/plain-v1/);
    expect(report.counts.PASS).toBe(3);
    expect(report.dangling_batch_references).toEqual([]);
    expect(auditExitCode(report)).toBe(0);
    expect(formatAuditReport(report)).toContain("3 of 3 batch(es) PASS.");
    expect(sha256(clean)).toBe(before);
    expect(readdirSync(dir).sort()).toEqual(listing); // no -wal / -shm / journal beside it
  });

  it("a member stranded out of its batch: LEAF_COUNT_MISMATCH + ROOT_MISMATCH + PROOF_FAILURE", async () => {
    const [b0] = batchIds;
    const stranded = membersOf.get(b0!)![1]!;
    const path = corrupt(
      "stranded",
      "UPDATE relay_credentials SET anchor_batch_id = NULL WHERE credential_id = ?",
      stranded,
    );
    const report = await audit(path);
    expect(outcomesOf(report, b0!)).toEqual([
      "LEAF_COUNT_MISMATCH",
      "ROOT_MISMATCH",
      "PROOF_FAILURE",
    ]);
    const b = report.batches.find((x) => x.batch_id === b0)!;
    expect(b.member_count).toBe(2);
    expect(b.proof_failures.map((f) => f.credential_id).sort()).toEqual(
      membersOf
        .get(b0!)!
        .filter((id) => id !== stranded)
        .sort(),
    );
    expect(outcomesOf(report, batchIds[1]!)).toEqual(["PASS"]);
    expect(auditExitCode(report)).toBe(2);
  });

  it("a member moved to another batch: both batches mismatch", async () => {
    const [b0, b1] = batchIds;
    const moved = membersOf.get(b0!)![0]!;
    const path = corrupt(
      "moved",
      "UPDATE relay_credentials SET anchor_batch_id = ? WHERE credential_id = ?",
      b1,
      moved,
    );
    const report = await audit(path);
    for (const id of [b0!, b1!]) {
      expect(outcomesOf(report, id)).toEqual([
        "LEAF_COUNT_MISMATCH",
        "ROOT_MISMATCH",
        "PROOF_FAILURE",
      ]);
    }
    expect(outcomesOf(report, batchIds[2]!)).toEqual(["PASS"]);
    expect(auditExitCode(report)).toBe(2);
  });

  it("an edited stored merkle_root: ROOT_MISMATCH + SIGNATURE_FAILURE", async () => {
    const [b0] = batchIds;
    const path = corrupt(
      "root",
      "UPDATE relay_credential_anchor_batches SET merkle_root = ? WHERE batch_id = ?",
      "ab".repeat(32),
      b0,
    );
    const report = await audit(path);
    expect(outcomesOf(report, b0!)).toEqual(["ROOT_MISMATCH", "SIGNATURE_FAILURE"]);
    expect(auditExitCode(report)).toBe(2);
  });

  it("a corrupted signature: SIGNATURE_FAILURE + PROOF_FAILURE", async () => {
    const [, b1] = batchIds;
    const path = corrupt(
      "sig",
      "UPDATE relay_credential_anchor_batches SET signature = ? WHERE batch_id = ?",
      "00".repeat(64),
      b1,
    );
    const report = await audit(path);
    expect(outcomesOf(report, b1!)).toEqual(["SIGNATURE_FAILURE", "PROOF_FAILURE"]);
    expect(report.batches.find((b) => b.batch_id === b1)!.proof_failures).toHaveLength(2);
    expect(auditExitCode(report)).toBe(2);
  });

  it("no relay public key: VERIFICATION_INCOMPLETE only, exit 3", async () => {
    const path = corrupt("nokey", "DELETE FROM relay_identity");
    const report = await audit(path);
    expect(report.batches.map((b) => b.outcomes)).toEqual([
      ["VERIFICATION_INCOMPLETE"],
      ["VERIFICATION_INCOMPLETE"],
      ["VERIFICATION_INCOMPLETE"],
    ]);
    expect(report.batches[0]!.incomplete_reasons[0]).toMatch(/relay public key unavailable/);
    expect(auditExitCode(report)).toBe(3);
  });

  it("an unparseable member credential: VERIFICATION_INCOMPLETE, not corruption", async () => {
    const [b0] = batchIds;
    const path = join(dir, "unparseable.db");
    copyFileSync(clean, path);
    const raw = new Database(path);
    // v59's issuer-binding trigger guards credential_json; drop it on this copy only.
    raw.exec("DROP TRIGGER IF EXISTS relay_credentials_signer_is_issuer_update");
    raw
      .prepare("UPDATE relay_credentials SET credential_json = '{' WHERE credential_id = ?")
      .run(membersOf.get(b0!)![0]);
    raw.close();
    const report = await audit(path);
    expect(outcomesOf(report, b0!)).toEqual(["VERIFICATION_INCOMPLETE"]);
    expect(auditExitCode(report)).toBe(3);
  });

  it("a credential naming a batch that does not exist is reported, exit 2", async () => {
    const path = corrupt(
      "dangling",
      "UPDATE relay_credentials SET anchor_batch_id = 'ghost-batch' WHERE credential_id = ?",
      membersOf.get(batchIds[2]!)![0],
    );
    const report = await audit(path);
    expect(report.dangling_batch_references).toEqual([
      { anchor_batch_id: "ghost-batch", credential_ids: [membersOf.get(batchIds[2]!)![0]] },
    ]);
    expect(auditExitCode(report)).toBe(2);
  });

  it("a WAL-mode snapshot is refused with the repair line, and nothing is written", () => {
    const before = sha256(wal);
    const listing = readdirSync(dir).sort();
    let refused: unknown;
    try {
      openSnapshotReadOnly(wal);
    } catch (err) {
      refused = err;
    }
    expect(refused).toBeInstanceOf(SnapshotRefused);
    expect((refused as SnapshotRefused).repair).toContain(
      `sqlite3 '${wal}' 'PRAGMA journal_mode=DELETE'`,
    );
    expect(sha256(wal)).toBe(before);
    expect(readdirSync(dir).sort()).toEqual(listing);
  });

  it("the driver refuses every write path", () => {
    const db = openSnapshotReadOnly(clean);
    try {
      expect(() => db.exec("DELETE FROM relay_identity")).toThrow(/read-only/);
      expect(() => db.pragma("journal_mode = WAL")).toThrow(/read-only/);
      expect(() => db.transaction(() => 1)).toThrow(/read-only/);
      expect(() => db.prepare("DELETE FROM relay_identity")).toThrow(/read-only/);
      expect(() => db.prepare("SELECT 1").run()).toThrow(/read-only/);
    } finally {
      db.close();
    }
  });

  it("the CLI: exit codes, header, --json, and the snapshot hash unchanged", async () => {
    const before = sha256(clean);
    const out = join(dir, "report.json");
    const ok = await run(TSX, [SCRIPT, clean, "--json", out], { cwd: RELAY_ROOT });
    expect(ok.stdout).toContain(`snapshot:        ${clean}`);
    expect(ok.stdout).toMatch(/script commit: {3}[0-9a-f]{40}|script commit: {3}\(unavailable\)/);
    expect(ok.stdout).toMatch(/PASS: +3/);
    const json = JSON.parse(readFileSync(out, "utf8")) as AuditReport;
    expect(json.counts.PASS).toBe(3);
    expect(sha256(clean)).toBe(before);

    const stranded = corrupt(
      "cli-stranded",
      "UPDATE relay_credentials SET anchor_batch_id = NULL WHERE credential_id = ?",
      membersOf.get(batchIds[0]!)![0],
    );
    await expect(run(TSX, [SCRIPT, stranded], { cwd: RELAY_ROOT })).rejects.toMatchObject({
      code: 2,
    });
    const nokey = corrupt("cli-nokey", "DELETE FROM relay_identity");
    await expect(run(TSX, [SCRIPT, nokey], { cwd: RELAY_ROOT })).rejects.toMatchObject({
      code: 3,
    });
    const walBefore = sha256(wal);
    await expect(run(TSX, [SCRIPT, wal], { cwd: RELAY_ROOT })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("PRAGMA journal_mode=DELETE"),
    });
    expect(sha256(wal)).toBe(walBefore);
  }, 60_000);

  it("the audit source never names the relay's secret key column or decrypts", () => {
    for (const path of [SCRIPT, MODULE]) {
      const src = readFileSync(path, "utf8");
      expect(src, path).not.toMatch(/private_key/i);
      expect(src, path).not.toMatch(/privateKey/);
      expect(src, path).not.toMatch(/decrypt\w*\s*\(/i);
      expect(src, path).not.toMatch(/SELECT\s+\*\s+FROM\s+relay_identity/i);
    }
  });
});
