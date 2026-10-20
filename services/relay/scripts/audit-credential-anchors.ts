/**
 * Read-only audit of credential anchor batches in a LOCAL SNAPSHOT of the
 * production relay database.
 *
 *   npx tsx services/relay/scripts/audit-credential-anchors.ts <snapshot.db> [--json out.json]
 *
 * Why: batches cut before #1135 may have stranded or overwritten membership.
 * This reports, per batch: PASS, LEAF_COUNT_MISMATCH, ROOT_MISMATCH,
 * SIGNATURE_FAILURE, PROOF_FAILURE (with credential ids) or
 * VERIFICATION_INCOMPLETE (not evidence of corruption), plus credentials whose
 * anchor_batch_id names no batch. Logic: `src/credential-anchor-audit.ts`.
 *
 * Exit: 0 every batch PASSes; 2 any discrepancy; 3 only VERIFICATION_INCOMPLETE;
 * 1 the snapshot was refused or the audit could not run.
 *
 * It opens the file read-only (better-sqlite3 `readonly`, `fileMustExist`)
 * behind a driver whose exec / pragma / transaction / run throw, runs no app
 * init and no migrations, and reads only credential and credential-anchor-batch
 * data plus the relay's PUBLIC key. It never reads the relay's secret key and
 * decrypts nothing. A WAL-mode snapshot is refused with the exact repair line.
 *
 * FOUNDER PROCEDURE (also docs/ops/RUNBOOK.md §"Credential anchor audit"):
 *  1. On the NEW encrypted machine (FileVault on), with the repo at the commit
 *     you will run: `pnpm install && pnpm build`.
 *  2. `fly status -a motebit-sync` — exactly one machine.
 *     `fly ssh console -a motebit-sync -C 'df -h /data'` — room for a copy.
 *  3. `fly ssh console -a motebit-sync` then
 *     `sqlite3 /data/motebit.db ".backup /data/audit-snapshot.db"`.
 *     Record the snapshot time (UTC) and the deployed commit
 *     (`fly releases -a motebit-sync` / `fly status`).
 *  4. `fly ssh sftp get /data/audit-snapshot.db ./audit-snapshot.db -a motebit-sync`
 *  5. DELETE the copy on the volume: `fly ssh console -a motebit-sync -C 'rm /data/audit-snapshot.db'`.
 *  6. `chmod 600 ./audit-snapshot.db` — keep it only on the FileVault disk.
 *  7. If the script refuses a WAL-mode file, run the repair line it prints on
 *     the LOCAL copy (never on the volume).
 *  8. `npx tsx services/relay/scripts/audit-credential-anchors.ts ./audit-snapshot.db --json audit-report.json > audit-report.txt`
 *  9. Keep the report with the snapshot time and deployed commit; then delete
 *     the snapshot. Never upload the snapshot anywhere — no cloud agents, no chat.
 * Historical batches are never rebuilt or re-signed: discrepancies are
 * recorded and investigated.
 */

import { execFileSync } from "node:child_process";
import { statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SnapshotRefused,
  auditCredentialAnchors,
  auditExitCode,
  formatAuditReport,
  openSnapshotReadOnly,
} from "../src/credential-anchor-audit.js";

const USAGE =
  "usage: npx tsx services/relay/scripts/audit-credential-anchors.ts <snapshot.db> [--json out.json]";

function scriptCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dirname(fileURLToPath(import.meta.url)),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

async function main(argv: string[]): Promise<number> {
  let jsonOut: string | null = null;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") {
      const next = argv[++i];
      if (next === undefined) {
        console.error(USAGE);
        return 1;
      }
      jsonOut = resolve(next);
    } else if (arg.startsWith("-")) {
      console.error(USAGE);
      return 1;
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 1) {
    console.error(USAGE);
    return 1;
  }
  const snapshotPath = resolve(positional[0]!);
  if (jsonOut === snapshotPath) {
    console.error("refused: --json would overwrite the snapshot");
    return 1;
  }
  const startedAt = new Date();

  let db;
  try {
    db = openSnapshotReadOnly(snapshotPath);
  } catch (err: unknown) {
    if (err instanceof SnapshotRefused) {
      console.error(`refused: ${err.message}`);
      console.error(`repair:  ${err.repair}`);
      return 1;
    }
    throw err;
  }

  try {
    const report = await auditCredentialAnchors(db, {
      snapshotPath,
      snapshotMtime: statSync(snapshotPath).mtime,
      scriptCommit: scriptCommit(),
      startedAt,
    });
    console.log(formatAuditReport(report));
    if (jsonOut !== null) writeFileSync(jsonOut, JSON.stringify(report, null, 2) + "\n");
    return auditExitCode(report);
  } finally {
    db.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`audit failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
