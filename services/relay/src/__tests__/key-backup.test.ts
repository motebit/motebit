/**
 * Relay trust-root disaster recovery — codec, store, and CLI.
 *
 * The relay identity key is the trust root; these tests pin that a backup
 * round-trips an identity intact, that every corruption/wrong-passphrase/
 * mismatch path fails closed before touching the DB, and that restore
 * refuses to silently replace a DIFFERENT identity.
 */

import { describe, it, expect } from "vitest";
import { openMotebitDatabase } from "@motebit/persistence";
import type { DatabaseDriver } from "@motebit/persistence";
import { bytesToHex, generateKeypair, publicKeyToDidKey } from "@motebit/encryption";

import { createFederationTables, initRelayIdentity } from "../federation.js";
import {
  createRelayKeyBackup,
  parseRelayKeyBackup,
  serializeRelayKeyBackup,
  verifyRelayKeyBackup,
} from "../key-backup.js";
import { exportRelayKeyBackup, importRelayKeyBackup } from "../key-backup-store.js";
import { parseArgs, runRelayKeyCli, type CliIo } from "../cli.js";

const BACKUP_PASS = "correct horse battery staple";
const AT_REST_PASS = "at-rest-passphrase-xyz";

async function freshDb(): Promise<DatabaseDriver> {
  const moteDb = await openMotebitDatabase(":memory:");
  createFederationTables(moteDb.db);
  return moteDb.db;
}

function readRow(db: DatabaseDriver): {
  relay_motebit_id: string;
  public_key: string;
  private_key_hex: string;
  did: string;
} {
  return db.prepare("SELECT * FROM relay_identity LIMIT 1").get() as never;
}

describe("relay key backup — codec", () => {
  it("round-trips identity material through create → serialize → parse → verify", async () => {
    const kp = await generateKeypair();
    const material = {
      relayMotebitId: "relay-test-1",
      publicKeyHex: bytesToHex(kp.publicKey),
      did: publicKeyToDidKey(kp.publicKey),
      privateKeyHex: bytesToHex(kp.privateKey),
    };
    const backup = createRelayKeyBackup(material, BACKUP_PASS, () => 1_700_000_000_000);
    const parsed = parseRelayKeyBackup(serializeRelayKeyBackup(backup));
    expect(parsed.relay_motebit_id).toBe("relay-test-1");
    expect(parsed.public_key_hex).toBe(material.publicKeyHex);

    const v = await verifyRelayKeyBackup(parsed, BACKUP_PASS);
    expect(v.privateKeyHex).toBe(material.privateKeyHex);
    expect(v.derivedPublicKeyHex).toBe(material.publicKeyHex);
    expect(v.derivedDid).toBe(material.did);
  });

  it("rejects an empty backup passphrase at create time", async () => {
    const kp = await generateKeypair();
    expect(() =>
      createRelayKeyBackup(
        {
          relayMotebitId: "relay-x",
          publicKeyHex: bytesToHex(kp.publicKey),
          did: publicKeyToDidKey(kp.publicKey),
          privateKeyHex: bytesToHex(kp.privateKey),
        },
        "",
      ),
    ).toThrow(/must not be empty/);
  });

  it("verify fails closed on the wrong backup passphrase", async () => {
    const kp = await generateKeypair();
    const backup = createRelayKeyBackup(
      {
        relayMotebitId: "relay-2",
        publicKeyHex: bytesToHex(kp.publicKey),
        did: publicKeyToDidKey(kp.publicKey),
        privateKeyHex: bytesToHex(kp.privateKey),
      },
      BACKUP_PASS,
    );
    await expect(verifyRelayKeyBackup(backup, "wrong-passphrase")).rejects.toThrow(
      /wrong backup passphrase|corrupt/,
    );
  });

  it("parse rejects a tampered checksum", async () => {
    const kp = await generateKeypair();
    const backup = createRelayKeyBackup(
      {
        relayMotebitId: "relay-3",
        publicKeyHex: bytesToHex(kp.publicKey),
        did: publicKeyToDidKey(kp.publicKey),
        privateKeyHex: bytesToHex(kp.privateKey),
      },
      BACKUP_PASS,
    );
    // Mutate a field without recomputing the checksum.
    const tampered = { ...backup, relay_motebit_id: "relay-EVIL" };
    expect(() => parseRelayKeyBackup(JSON.stringify(tampered))).toThrow(/checksum mismatch/);
  });

  it("parse rejects wrong kind, bad version, and missing fields", () => {
    expect(() => parseRelayKeyBackup("not json")).toThrow(/not valid JSON/);
    expect(() => parseRelayKeyBackup(JSON.stringify({ kind: "something-else" }))).toThrow(
      /not a relay key backup/,
    );
    expect(() =>
      parseRelayKeyBackup(JSON.stringify({ kind: "motebit-relay-key-backup", version: 99 })),
    ).toThrow(/unsupported backup version/);
    expect(() =>
      parseRelayKeyBackup(
        JSON.stringify({ kind: "motebit-relay-key-backup", version: 1, created_at: 1 }),
      ),
    ).toThrow(/must be a non-empty string/);
  });

  it("verify catches a backup whose private key does not match its claimed public key", async () => {
    const real = await generateKeypair();
    const other = await generateKeypair();
    // Claim `other`'s public key but encrypt `real`'s private key — a
    // corrupt/forged artifact. The checksum is valid (we build it through
    // createRelayKeyBackup), so only the crypto re-derivation catches it.
    const forged = createRelayKeyBackup(
      {
        relayMotebitId: "relay-forged",
        publicKeyHex: bytesToHex(other.publicKey),
        did: publicKeyToDidKey(other.publicKey),
        privateKeyHex: bytesToHex(real.privateKey),
      },
      BACKUP_PASS,
    );
    const parsed = parseRelayKeyBackup(serializeRelayKeyBackup(forged));
    await expect(verifyRelayKeyBackup(parsed, BACKUP_PASS)).rejects.toThrow(/integrity failure/);
  });
});

describe("relay key backup — store (DB export/import)", () => {
  it("export → import into a fresh DB preserves the identity (plaintext at rest)", async () => {
    const src = await freshDb();
    const identity = await initRelayIdentity(src);
    const backup = exportRelayKeyBackup(src, { backupPassphrase: BACKUP_PASS });

    const dst = await freshDb();
    const result = await importRelayKeyBackup(dst, backup, { backupPassphrase: BACKUP_PASS });
    expect(result.action).toBe("restored");

    const restored = await initRelayIdentity(dst);
    expect(restored.relayMotebitId).toBe(identity.relayMotebitId);
    expect(restored.publicKeyHex).toBe(identity.publicKeyHex);
    expect(restored.did).toBe(identity.did);
  });

  it("round-trips an encrypted-at-rest key and re-encrypts on restore", async () => {
    const src = await freshDb();
    const identity = await initRelayIdentity(src, AT_REST_PASS);
    const backup = exportRelayKeyBackup(src, {
      atRestPassphrase: AT_REST_PASS,
      backupPassphrase: BACKUP_PASS,
    });

    const dst = await freshDb();
    await importRelayKeyBackup(dst, backup, {
      backupPassphrase: BACKUP_PASS,
      atRestPassphrase: AT_REST_PASS,
    });
    // Stored encrypted (not the raw hex), and the boot path decrypts to the same identity.
    expect(readRow(dst).private_key_hex).not.toBe(bytesToHex(identity.privateKey));
    const restored = await initRelayIdentity(dst, AT_REST_PASS);
    expect(restored.publicKeyHex).toBe(identity.publicKeyHex);
  });

  it("export throws when there is no identity to back up", async () => {
    const db = await freshDb();
    expect(() => exportRelayKeyBackup(db, { backupPassphrase: BACKUP_PASS })).toThrow(
      /no relay identity/,
    );
  });

  it("export of an encrypted key without the at-rest passphrase fails closed", async () => {
    const db = await freshDb();
    await initRelayIdentity(db, AT_REST_PASS);
    expect(() => exportRelayKeyBackup(db, { backupPassphrase: BACKUP_PASS })).toThrow(
      /encrypted at rest but no at-rest passphrase/,
    );
  });

  it("re-importing the SAME identity is idempotent", async () => {
    const src = await freshDb();
    await initRelayIdentity(src);
    const backup = exportRelayKeyBackup(src, { backupPassphrase: BACKUP_PASS });
    const result = await importRelayKeyBackup(src, backup, { backupPassphrase: BACKUP_PASS });
    expect(result.action).toBe("reimported_same");
  });

  it("refuses to replace a DIFFERENT identity without forceReplace, allows it with", async () => {
    const src = await freshDb();
    await initRelayIdentity(src);
    const backup = exportRelayKeyBackup(src, { backupPassphrase: BACKUP_PASS });

    const other = await freshDb();
    const otherIdentity = await initRelayIdentity(other); // different identity already present

    await expect(
      importRelayKeyBackup(other, backup, { backupPassphrase: BACKUP_PASS }),
    ).rejects.toThrow(/refusing to replace a DIFFERENT relay identity/);

    const forced = await importRelayKeyBackup(other, backup, {
      backupPassphrase: BACKUP_PASS,
      forceReplace: true,
    });
    expect(forced.action).toBe("replaced");
    expect(readRow(other).relay_motebit_id).not.toBe(otherIdentity.relayMotebitId);
  });
});

describe("relay key backup — CLI", () => {
  it("parseArgs handles each command and flags, rejects unknowns", () => {
    expect(parseArgs(["export", "--out", "/tmp/b.json"])).toMatchObject({
      command: "export",
      out: "/tmp/b.json",
    });
    expect(parseArgs(["import", "--in", "/tmp/b.json", "--force-replace"])).toMatchObject({
      command: "import",
      in: "/tmp/b.json",
      forceReplace: true,
    });
    expect(() => parseArgs(["bogus"])).toThrow(/unknown command/);
    expect(() => parseArgs(["verify", "--nope"])).toThrow(/unknown flag/);
  });

  it("export → verify → import round-trips through the CLI surface", async () => {
    const files = new Map<string, string>();
    const logs: string[] = [];
    const src = await freshDb();
    const identity = await initRelayIdentity(src);

    const envMap: Record<string, string> = {
      MOTEBIT_DB_PATH: "db",
      MOTEBIT_RELAY_BACKUP_PASSPHRASE: BACKUP_PASS,
    };
    const makeIo = (db: DatabaseDriver): CliIo => ({
      env: (n) => envMap[n],
      readFile: (p) => {
        const f = files.get(p);
        if (f === undefined) throw new Error(`no file ${p}`);
        return f;
      },
      writeFile: (p, c) => void files.set(p, c),
      log: (l) => void logs.push(l),
      err: (l) => void logs.push(`ERR ${l}`),
      openDb: () => db,
    });

    expect(await runRelayKeyCli(["export", "--out", "backup.json"], makeIo(src))).toBe(0);
    expect(files.has("backup.json")).toBe(true);

    expect(await runRelayKeyCli(["verify", "--in", "backup.json"], makeIo(src))).toBe(0);

    const dst = await freshDb();
    expect(await runRelayKeyCli(["import", "--in", "backup.json"], makeIo(dst))).toBe(0);
    const restored = await initRelayIdentity(dst);
    expect(restored.publicKeyHex).toBe(identity.publicKeyHex);
  });

  it("CLI returns exit code 1 and reports when required env is missing", async () => {
    const errs: string[] = [];
    const io: CliIo = {
      env: () => undefined,
      readFile: () => "",
      writeFile: () => {},
      log: () => {},
      err: (l) => void errs.push(l),
      openDb: () => {
        throw new Error("should not open db");
      },
    };
    expect(await runRelayKeyCli(["export", "--out", "x"], io)).toBe(1);
    expect(errs.join("\n")).toMatch(/MOTEBIT_DB_PATH must be set/);
  });
});
