/**
 * Disaster recovery for the relay's identity key — the trust root.
 *
 * The relay's Ed25519 identity key signs every credential anchor, the
 * federation handshake, the operator-transparency declaration at
 * `/.well-known/motebit-transparency.json`, and every signed state-export
 * bundle (`X-Motebit-Content-Manifest`). Third parties pin THIS public key
 * from the transparency declaration to verify all of it offline, with no
 * relay contact. Lose the key and you don't just lose uptime — minting a
 * fresh one invalidates every signature ever issued and breaks the
 * transparency-anchor chain (see `initRelayIdentity` in `federation.ts`).
 *
 * Yet the private key lives in exactly one place: the `relay_identity` row
 * in the SQLite DB on the Fly volume. This module makes it survivable.
 *
 * **The private key never crosses the network.** Backup/restore is an
 * operator-run command against the local DB (`cli.ts`), never an HTTP
 * surface — serving the trust root over the wire, even admin-gated, would
 * itself be the vulnerability. This file is the pure codec + verifier
 * (no DB, no I/O); `key-backup-store.ts` does the DB read/write and
 * `cli.ts` wires env + files.
 *
 * The backup artifact:
 *   - encrypts the private key under a SEPARATE backup passphrase
 *     (independent of `MOTEBIT_RELAY_KEY_PASSPHRASE`), reusing the relay's
 *     AES-256-GCM + PBKDF2-600K at-rest primitive — so the artifact is
 *     safe to store in a password manager, print, or hold offsite;
 *   - carries `public_key_hex` / `did` / `relay_motebit_id` IN THE CLEAR
 *     so an operator can cross-check the artifact against the published
 *     transparency declaration WITHOUT decrypting;
 *   - carries a SHA-256 `checksum` over the rest for tamper-evidence.
 *
 * `verifyRelayKeyBackup` is the tested-restore-path-that-touches-nothing:
 * decrypt, re-derive the public key from the private key, assert it equals
 * the cleartext `public_key_hex` (and recompute the `did`). Run it on a
 * schedule to prove a backup is restorable and still matches what
 * verifiers pin — without going near the live DB.
 */

import { createHash } from "node:crypto";

import {
  bytesToHex,
  hexToBytes,
  canonicalJson,
  getPublicKeyBySuite,
  publicKeyToDidKey,
} from "@motebit/encryption";

import { encryptPrivateKey, decryptPrivateKey } from "./federation.js";

/** Discriminator + version on every backup artifact. Bump the version on a breaking format change. */
export const RELAY_KEY_BACKUP_KIND = "motebit-relay-key-backup" as const;
export const RELAY_KEY_BACKUP_VERSION = 1 as const;

/**
 * The relay's signing suite. Public-key derivation is identical across
 * every Ed25519 suite arm (all call the same primitive), so this choice
 * only documents intent — it matches `FEDERATION_SUITE` in `federation.ts`.
 */
const RELAY_SUITE = "motebit-concat-ed25519-hex-v1" as const;

/**
 * Portable, encrypted, self-verifying backup of the relay identity key.
 * Serialized as JSON; safe to store offsite. The private key is encrypted;
 * everything else is cleartext for offline cross-checking.
 */
export interface RelayKeyBackup {
  readonly kind: typeof RELAY_KEY_BACKUP_KIND;
  readonly version: typeof RELAY_KEY_BACKUP_VERSION;
  readonly relay_motebit_id: string;
  readonly public_key_hex: string;
  readonly did: string;
  /** AES-256-GCM `{salt}:{iv}:{ciphertext+authTag}` of the hex private key under the BACKUP passphrase. */
  readonly encrypted_private_key: string;
  readonly created_at: number;
  /** SHA-256 (hex) over `canonicalJson` of every field except this one. */
  readonly checksum: string;
}

/** The decrypted identity material a backup carries. */
export interface RelayIdentityMaterial {
  readonly relayMotebitId: string;
  readonly publicKeyHex: string;
  readonly did: string;
  readonly privateKeyHex: string;
}

/** Compute the integrity checksum over a backup's fields (everything but `checksum`). */
function computeChecksum(fields: Omit<RelayKeyBackup, "checksum">): string {
  return createHash("sha256").update(canonicalJson(fields), "utf8").digest("hex");
}

/**
 * Build a backup artifact from decrypted identity material, encrypting the
 * private key under `backupPassphrase`. Pure — no DB, no clock dependency
 * beyond `now` (injectable for deterministic tests).
 */
export function createRelayKeyBackup(
  material: RelayIdentityMaterial,
  backupPassphrase: string,
  now: () => number = Date.now,
): RelayKeyBackup {
  if (backupPassphrase.length === 0) {
    throw new Error("backup passphrase must not be empty");
  }
  const fields: Omit<RelayKeyBackup, "checksum"> = {
    kind: RELAY_KEY_BACKUP_KIND,
    version: RELAY_KEY_BACKUP_VERSION,
    relay_motebit_id: material.relayMotebitId,
    public_key_hex: material.publicKeyHex,
    did: material.did,
    encrypted_private_key: encryptPrivateKey(material.privateKeyHex, backupPassphrase),
    created_at: now(),
  };
  return { ...fields, checksum: computeChecksum(fields) };
}

/** Serialize a backup to its on-disk JSON form (pretty-printed for human-readable offsite storage). */
export function serializeRelayKeyBackup(backup: RelayKeyBackup): string {
  return `${JSON.stringify(backup, null, 2)}\n`;
}

/**
 * Parse + structurally validate a backup artifact, and verify its
 * integrity checksum. Throws on any structural or checksum failure
 * (fail-closed — a malformed backup is never silently accepted). Does NOT
 * decrypt; cryptographic match is `verifyRelayKeyBackup`.
 */
export function parseRelayKeyBackup(json: string): RelayKeyBackup {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err: unknown) {
    throw new Error(
      `backup is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (raw === null || typeof raw !== "object") {
    throw new Error("backup must be a JSON object");
  }
  const o = raw as Record<string, unknown>;
  if (o.kind !== RELAY_KEY_BACKUP_KIND) {
    throw new Error(`not a relay key backup (kind: ${String(o.kind)})`);
  }
  if (o.version !== RELAY_KEY_BACKUP_VERSION) {
    throw new Error(
      `unsupported backup version: ${String(o.version)} (expected ${RELAY_KEY_BACKUP_VERSION})`,
    );
  }
  const str = (k: string): string => {
    const v = o[k];
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`backup field "${k}" must be a non-empty string`);
    }
    return v;
  };
  if (typeof o.created_at !== "number" || !Number.isFinite(o.created_at)) {
    throw new Error('backup field "created_at" must be a finite number');
  }
  const checksum = str("checksum");
  const backup: RelayKeyBackup = {
    kind: RELAY_KEY_BACKUP_KIND,
    version: RELAY_KEY_BACKUP_VERSION,
    relay_motebit_id: str("relay_motebit_id"),
    public_key_hex: str("public_key_hex"),
    did: str("did"),
    encrypted_private_key: str("encrypted_private_key"),
    created_at: o.created_at,
    checksum,
  };
  const { checksum: _omit, ...fields } = backup;
  const expected = computeChecksum(fields);
  if (expected !== checksum) {
    throw new Error("backup checksum mismatch — the artifact is corrupt or was tampered with");
  }
  return backup;
}

/** Outcome of a cryptographic backup verification. */
export interface RelayKeyBackupVerification {
  /** The decrypted hex private key — only present when `ok`. */
  readonly privateKeyHex: string;
  /** Public key re-derived from the decrypted private key. */
  readonly derivedPublicKeyHex: string;
  /** `did:key` re-derived from the derived public key. */
  readonly derivedDid: string;
}

/**
 * The tested restore path that writes nothing. Decrypt the private key
 * with `backupPassphrase`, re-derive the public key from it, and assert it
 * matches the artifact's cleartext `public_key_hex` and `did`. A mismatch
 * means the backup would NOT restore the identity verifiers expect — throw
 * rather than hand back a key that doesn't match what's published.
 *
 * Pass an already-`parseRelayKeyBackup`'d artifact (checksum verified).
 */
export async function verifyRelayKeyBackup(
  backup: RelayKeyBackup,
  backupPassphrase: string,
): Promise<RelayKeyBackupVerification> {
  let privateKeyHex: string;
  try {
    privateKeyHex = decryptPrivateKey(backup.encrypted_private_key, backupPassphrase);
  } catch (err: unknown) {
    throw new Error(
      "failed to decrypt backup — wrong backup passphrase, or the artifact is corrupt",
      { cause: err },
    );
  }
  const derivedPublicKey = await getPublicKeyBySuite(hexToBytes(privateKeyHex), RELAY_SUITE);
  const derivedPublicKeyHex = bytesToHex(derivedPublicKey);
  const derivedDid = publicKeyToDidKey(derivedPublicKey);
  if (derivedPublicKeyHex !== backup.public_key_hex) {
    throw new Error(
      `backup integrity failure: private key derives public key ${derivedPublicKeyHex} but the artifact claims ${backup.public_key_hex}`,
    );
  }
  if (derivedDid !== backup.did) {
    throw new Error(
      `backup integrity failure: derived did ${derivedDid} does not match the artifact's did ${backup.did}`,
    );
  }
  return { privateKeyHex, derivedPublicKeyHex, derivedDid };
}
