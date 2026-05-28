/**
 * DB-touching half of relay trust-root disaster recovery — reads the
 * `relay_identity` row to produce a backup, and writes it back to restore
 * one. Pure codec + verification lives in `key-backup.ts`; the operator
 * CLI that wires env + files lives in `cli.ts`.
 *
 * Restore safety is the load-bearing concern here. The relay identity is
 * the trust root; replacing it with a DIFFERENT key invalidates every
 * signature ever issued and breaks the transparency-anchor chain. So:
 *   - re-importing the SAME identity is idempotent (safe);
 *   - restoring into an empty DB is the normal recovery path;
 *   - replacing a DIFFERENT existing identity is BLOCKED unless the caller
 *     explicitly opts in (`forceReplace`) — the CLI gates that behind a
 *     typed confirmation and a loud warning.
 */

import type { DatabaseDriver } from "@motebit/persistence";

import {
  createFederationTables,
  decryptPrivateKey,
  encryptPrivateKey,
  isEncryptedFormat,
} from "./federation.js";
import { createRelayKeyBackup, verifyRelayKeyBackup, type RelayKeyBackup } from "./key-backup.js";

interface RelayIdentityRow {
  readonly relay_motebit_id: string;
  readonly public_key: string;
  readonly private_key_hex: string;
  readonly did: string;
  readonly created_at: number;
}

function readIdentityRow(db: DatabaseDriver): RelayIdentityRow | undefined {
  return db.prepare("SELECT * FROM relay_identity LIMIT 1").get() as RelayIdentityRow | undefined;
}

/**
 * Read the relay identity from the DB and produce an encrypted backup
 * artifact. `atRestPassphrase` is required iff the stored key is encrypted
 * (it is in production); `backupPassphrase` encrypts the artifact itself.
 *
 * Throws if there is no identity to back up — export never mints a key
 * (that's `initRelayIdentity`'s job at boot); an absent identity is an
 * operator error worth surfacing, not silently papering over.
 */
export function exportRelayKeyBackup(
  db: DatabaseDriver,
  args: { atRestPassphrase?: string; backupPassphrase: string },
  now: () => number = Date.now,
): RelayKeyBackup {
  createFederationTables(db);
  const row = readIdentityRow(db);
  if (row === undefined) {
    throw new Error(
      "no relay identity found in this database — nothing to back up (is MOTEBIT_DB_PATH pointing at the live relay DB?)",
    );
  }

  let privateKeyHex: string;
  if (isEncryptedFormat(row.private_key_hex)) {
    if (args.atRestPassphrase === undefined || args.atRestPassphrase.length === 0) {
      throw new Error(
        "stored relay key is encrypted at rest but no at-rest passphrase was provided (set MOTEBIT_RELAY_KEY_PASSPHRASE)",
      );
    }
    try {
      privateKeyHex = decryptPrivateKey(row.private_key_hex, args.atRestPassphrase);
    } catch (err: unknown) {
      throw new Error(
        "failed to decrypt the stored relay key — check MOTEBIT_RELAY_KEY_PASSPHRASE",
        {
          cause: err,
        },
      );
    }
  } else {
    privateKeyHex = row.private_key_hex;
  }

  return createRelayKeyBackup(
    {
      relayMotebitId: row.relay_motebit_id,
      publicKeyHex: row.public_key,
      did: row.did,
      privateKeyHex,
    },
    args.backupPassphrase,
    now,
  );
}

/** What an import did, for the CLI to report honestly. */
export type ImportAction = "restored" | "reimported_same" | "replaced";

export interface ImportResult {
  readonly action: ImportAction;
  readonly relayMotebitId: string;
  readonly publicKeyHex: string;
}

/**
 * Restore a relay identity from a verified backup into the DB. Verifies
 * the backup cryptographically first (decrypt + re-derive public key) so a
 * corrupt or wrong-passphrase artifact never reaches the DB.
 *
 * `atRestPassphrase` re-encrypts the key at rest on write (matching the
 * boot path); omit it only for dev/plaintext relays. `forceReplace` is
 * required to overwrite a DIFFERENT existing identity — see the file
 * header for why that is the dangerous case.
 */
export async function importRelayKeyBackup(
  db: DatabaseDriver,
  backup: RelayKeyBackup,
  args: { backupPassphrase: string; atRestPassphrase?: string; forceReplace?: boolean },
): Promise<ImportResult> {
  createFederationTables(db);
  const verification = await verifyRelayKeyBackup(backup, args.backupPassphrase);

  const existing = readIdentityRow(db);
  let action: ImportAction;
  if (existing === undefined) {
    action = "restored";
  } else if (existing.public_key === backup.public_key_hex) {
    action = "reimported_same";
  } else {
    if (args.forceReplace !== true) {
      throw new Error(
        `refusing to replace a DIFFERENT relay identity: the DB holds ${existing.relay_motebit_id} ` +
          `(public key ${existing.public_key}) but the backup is ${backup.relay_motebit_id} ` +
          `(public key ${backup.public_key_hex}). Replacing it invalidates every signature the current ` +
          `identity issued and breaks the transparency-anchor chain. Pass forceReplace only if you are ` +
          `certain this DB should adopt the backup's identity.`,
      );
    }
    action = "replaced";
  }

  const storedPriv =
    args.atRestPassphrase !== undefined && args.atRestPassphrase.length > 0
      ? encryptPrivateKey(verification.privateKeyHex, args.atRestPassphrase)
      : verification.privateKeyHex;

  // Single-row identity table: atomically clear any existing identity and
  // write the backup's. The transaction guarantees we never end up with
  // zero identities (delete committed, insert lost) or two.
  db.transaction(() => {
    db.prepare("DELETE FROM relay_identity").run();
    db.prepare(
      `INSERT INTO relay_identity (relay_motebit_id, public_key, private_key_hex, did, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      backup.relay_motebit_id,
      backup.public_key_hex,
      storedPriv,
      backup.did,
      backup.created_at,
    );
  });

  return {
    action,
    relayMotebitId: backup.relay_motebit_id,
    publicKeyHex: backup.public_key_hex,
  };
}
