#!/usr/bin/env node
/**
 * `relay-key` — operator CLI for relay trust-root disaster recovery.
 *
 * The relay's identity key signs every credential anchor, the transparency
 * declaration, and every state-export bundle, and lives in exactly one
 * place (the `relay_identity` row in the Fly-volume SQLite DB). This CLI is
 * how an operator backs it up offsite and restores it after a volume loss —
 * run on the box via `fly ssh console`, against the live DB. The private
 * key NEVER leaves over the network; this is a local-DB tool by design.
 *
 * Usage (env: MOTEBIT_DB_PATH, MOTEBIT_RELAY_KEY_PASSPHRASE [at-rest],
 *        MOTEBIT_RELAY_BACKUP_PASSPHRASE [the artifact's own passphrase]):
 *
 *   relay-key export  --out <file>          # write an encrypted backup
 *   relay-key verify  --in  <file>          # prove a backup is restorable (touches no DB)
 *   relay-key import  --in  <file> [--force-replace]   # restore into the DB
 *
 * See services/relay/RUNBOOK-key-recovery.md for the full procedure.
 */

import { readFileSync, writeFileSync } from "node:fs";

import { createMotebitDatabase } from "@motebit/persistence";
import type { DatabaseDriver } from "@motebit/persistence";

import { exportRelayKeyBackup, importRelayKeyBackup } from "./key-backup-store.js";
import {
  parseRelayKeyBackup,
  serializeRelayKeyBackup,
  verifyRelayKeyBackup,
} from "./key-backup.js";

type Command = "export" | "verify" | "import";

interface ParsedArgs {
  command: Command;
  in?: string;
  out?: string;
  forceReplace: boolean;
}

/** Injectable IO seam — real implementations in `defaultIo`, fakes in tests. */
export interface CliIo {
  env(name: string): string | undefined;
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  log(line: string): void;
  err(line: string): void;
  openDb(path: string): DatabaseDriver;
}

const defaultIo: CliIo = {
  env: (name) => process.env[name],
  readFile: (path) => readFileSync(path, "utf8"),
  writeFile: (path, content) => writeFileSync(path, content, { mode: 0o600 }),
  log: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  openDb: (path) => createMotebitDatabase(path).db,
};

const USAGE = [
  "relay-key — relay trust-root backup & restore",
  "",
  "  relay-key export  --out <file>                 write an encrypted backup of the relay identity",
  "  relay-key verify  --in  <file>                 verify a backup is restorable (no DB writes)",
  "  relay-key import  --in  <file> [--force-replace]   restore the relay identity from a backup",
  "",
  "Environment:",
  "  MOTEBIT_DB_PATH                 path to the relay SQLite DB (required for export/import)",
  "  MOTEBIT_RELAY_KEY_PASSPHRASE    at-rest key passphrase (required if the stored key is encrypted)",
  "  MOTEBIT_RELAY_BACKUP_PASSPHRASE passphrase protecting the backup artifact itself (required)",
].join("\n");

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (command !== "export" && command !== "verify" && command !== "import") {
    throw new Error(`unknown command "${String(command)}"\n\n${USAGE}`);
  }
  const parsed: ParsedArgs = { command, forceReplace: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    switch (arg) {
      case "--in":
        parsed.in = rest[++i];
        break;
      case "--out":
        parsed.out = rest[++i];
        break;
      case "--force-replace":
        parsed.forceReplace = true;
        break;
      default:
        throw new Error(`unknown flag "${arg}"\n\n${USAGE}`);
    }
  }
  return parsed;
}

function requireEnv(io: CliIo, name: string, why: string): string {
  const v = io.env(name);
  if (v === undefined || v.length === 0) throw new Error(`${name} must be set (${why})`);
  return v;
}

/**
 * Run the CLI. Returns a process exit code (0 ok, 1 error) rather than
 * calling `process.exit`, so tests can assert on it.
 */
export async function runRelayKeyCli(
  argv: readonly string[],
  io: CliIo = defaultIo,
): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err: unknown) {
    io.err(err instanceof Error ? err.message : String(err));
    return 1;
  }

  try {
    switch (args.command) {
      case "export": {
        const dbPath = requireEnv(io, "MOTEBIT_DB_PATH", "path to the relay DB to read");
        const backupPassphrase = requireEnv(
          io,
          "MOTEBIT_RELAY_BACKUP_PASSPHRASE",
          "the passphrase that will protect the backup",
        );
        const db = io.openDb(dbPath);
        const backup = exportRelayKeyBackup(db, {
          atRestPassphrase: io.env("MOTEBIT_RELAY_KEY_PASSPHRASE"),
          backupPassphrase,
        });
        const serialized = serializeRelayKeyBackup(backup);
        if (args.out !== undefined) {
          io.writeFile(args.out, serialized);
          io.log(`Backed up relay identity ${backup.relay_motebit_id} → ${args.out}`);
          io.log(`  public key: ${backup.public_key_hex}`);
          io.log(`  did:        ${backup.did}`);
          io.log("Store this file offsite. Verify it with: relay-key verify --in <file>");
        } else {
          io.log(serialized);
        }
        return 0;
      }

      case "verify": {
        if (args.in === undefined) throw new Error("verify requires --in <file>");
        const backupPassphrase = requireEnv(
          io,
          "MOTEBIT_RELAY_BACKUP_PASSPHRASE",
          "the passphrase that protects the backup",
        );
        const backup = parseRelayKeyBackup(io.readFile(args.in));
        const v = await verifyRelayKeyBackup(backup, backupPassphrase);
        io.log("Backup is valid and restorable.");
        io.log(`  relay_motebit_id: ${backup.relay_motebit_id}`);
        io.log(`  public key:       ${v.derivedPublicKeyHex}`);
        io.log(`  did:              ${v.derivedDid}`);
        io.log("Cross-check the public key against /.well-known/motebit-transparency.json.");
        return 0;
      }

      case "import": {
        if (args.in === undefined) throw new Error("import requires --in <file>");
        const dbPath = requireEnv(io, "MOTEBIT_DB_PATH", "path to the relay DB to restore into");
        const backupPassphrase = requireEnv(
          io,
          "MOTEBIT_RELAY_BACKUP_PASSPHRASE",
          "the passphrase that protects the backup",
        );
        const backup = parseRelayKeyBackup(io.readFile(args.in));
        const db = io.openDb(dbPath);
        const result = await importRelayKeyBackup(db, backup, {
          backupPassphrase,
          atRestPassphrase: io.env("MOTEBIT_RELAY_KEY_PASSPHRASE"),
          forceReplace: args.forceReplace,
        });
        const verb =
          result.action === "restored"
            ? "Restored"
            : result.action === "reimported_same"
              ? "Re-imported (identity unchanged)"
              : "REPLACED the previous identity with";
        io.log(`${verb} relay identity ${result.relayMotebitId}`);
        io.log(`  public key: ${result.publicKeyHex}`);
        if (result.action === "replaced") {
          io.log(
            "WARNING: the previous identity's signatures are now unverifiable against this relay. " +
              "Ensure the transparency declaration is re-published for the restored key.",
          );
        }
        return 0;
      }
    }
  } catch (err: unknown) {
    io.err(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

// Entrypoint guard — only runs when invoked directly, not when imported by tests.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  runRelayKeyCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
