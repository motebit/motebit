// A committed key rotation invalidates the previous seed backup, on the CLI:
// the REAL `performRotation` against the REAL config writer
// (`saveFullConfig` under a temp MOTEBIT_CONFIG_DIR), then the REAL posture
// reader every CLI surface uses (`seedBackupStatus` — the startup nudge,
// `motebit doctor`, `motebit seed`, `motebit keychain`). The acknowledgment
// names the key it covers (`seed_backed_up_key`); a committed rotation moves
// `device_public_key`, so it reads "not backed up" on every commit path —
// and nothing a rotation does destroys the old acknowledgment or the
// retired key the old paper seed still recovers.
//
// CONFIG_DIR is captured at module load, so the env is set before import.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { generate } from "@motebit/identity-file";
import {
  bytesToHex,
  deriveSovereignMotebitId,
  generateKeypair,
  signKeySuccession,
} from "@motebit/encryption";
import type { KeyPair } from "@motebit/encryption";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "motebit-seed-rotation-"));
const tmpDir = path.join(root, "cfg");
const savedDir = process.env["MOTEBIT_CONFIG_DIR"];
process.env["MOTEBIT_CONFIG_DIR"] = tmpDir;

type ConfigModule = typeof import("../config.js");
let cfg: ConfigModule;
let pending: typeof import("../pending-rotation.js");
let rotation: typeof import("../rotation.js");
let seed: typeof import("../subcommands/seed.js");
let identity: typeof import("../identity.js");

const PASS = "correct horse";
const hex = (kp: KeyPair) => bytesToHex(kp.publicKey);
const EMPTY_WALLET = async () => ({ solLamports: 0n, tokens: [] });

beforeAll(async () => {
  cfg = await import("../config.js");
  pending = await import("../pending-rotation.js");
  rotation = await import("../rotation.js");
  seed = await import("../subcommands/seed.js");
  identity = await import("../identity.js");
  expect(cfg.CONFIG_DIR).toBe(tmpDir);
});

beforeEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
});

afterAll(() => {
  if (savedDir !== undefined) process.env["MOTEBIT_CONFIG_DIR"] = savedDir;
  else delete process.env["MOTEBIT_CONFIG_DIR"];
  fs.rmSync(root, { recursive: true, force: true });
});

const identityPath = () => path.join(tmpDir, "motebit.md");

/**
 * A local sovereign identity on key `a`, its seed acknowledged the way
 * `motebit seed reveal` / `motebit restore` now records it: bound to the
 * key the seed derives.
 */
async function identityWithBackup(opts: { bound?: boolean } = {}) {
  const a = await generateKeypair();
  const mid = await deriveSovereignMotebitId(hex(a));
  fs.writeFileSync(
    identityPath(),
    await generate({ motebitId: mid, ownerId: "owner", publicKeyHex: hex(a) }, a.privateKey),
  );
  const config: Record<string, unknown> = {
    motebit_id: mid,
    device_id: `${mid}-laptop`,
    device_public_key: hex(a),
    cli_encrypted_key: (await identity.encryptPrivateKey(bytesToHex(a.privateKey), PASS))!,
    seed_backed_up_at: 1_000,
  };
  if (opts.bound !== false) {
    config["seed_backed_up_key"] = await seed.seedPublicKeyHex(bytesToHex(a.privateKey));
  }
  fs.writeFileSync(cfg.CONFIG_PATH, JSON.stringify(config), { mode: 0o600 });
  return { a, mid };
}

function deps(over: Partial<import("../rotation.js").RotationDeps> = {}) {
  return {
    identityPath: identityPath(),
    loadConfig: cfg.loadFullConfig,
    saveConfig: cfg.saveFullConfig,
    pending: {
      load: (mid: string, key: string) => pending.loadPendingRotation(mid, key, tmpDir),
      loadAny: () => pending.loadAnyPendingRotation(tmpDir),
      save: (p: import("../pending-rotation.js").PendingRotation) =>
        pending.savePendingRotation(p, tmpDir),
      clear: () => pending.clearPendingRotation(tmpDir),
      setAside: () => pending.setAsidePendingRotation(tmpDir),
      path: pending.pendingRotationPath(tmpDir),
    },
    passphrase: PASS,
    // No relay configured: the kit's no-relay branch, relay "none" — the
    // branch on which the CLI keeps the retired key.
    syncUrl: "",
    readWalletHoldings: EMPTY_WALLET,
    ...over,
  };
}

const status = () => seed.seedBackupStatus(cfg.loadFullConfig());
const keptConfigs = () =>
  fs.readdirSync(tmpDir).filter((f) => f.startsWith(`config.json${cfg.CONFIG_BACKUP_INFIX}`));

describe("seedBackupPostureOf / seedBackupStatus — the CLI reader", () => {
  it("a bound acknowledgment for the current key reads backed up", async () => {
    await identityWithBackup();
    expect(status()).toBe("backed_up");
  });

  it("an old backup presented as current (bound to another key) reads not backed up", async () => {
    await identityWithBackup();
    const other = await generateKeypair();
    const c = cfg.loadFullConfig();
    c.seed_backed_up_key = hex(other);
    fs.writeFileSync(cfg.CONFIG_PATH, JSON.stringify(c));
    expect(status()).toBe("not_backed_up");
    expect(seed.seedBackupPostureOf(cfg.loadFullConfig())).toMatchObject({
      status: "not_backed_up",
      reason: "retired_key",
      coveredPublicKeyHex: hex(other),
    });
  });

  it("seedPublicKeyHex: the acknowledgment binds the key the seed derives", async () => {
    const a = await generateKeypair();
    expect(await seed.seedPublicKeyHex(bytesToHex(a.privateKey))).toBe(hex(a));
  });
});

describe("motebit rotate — a committed rotation invalidates the previous seed backup", () => {
  it("rotate ⇒ not backed up; the old acknowledgment and the retired key are both still there", async () => {
    const { a } = await identityWithBackup();
    expect(status()).toBe("backed_up");
    const o = await rotation.performRotation(deps());
    expect(o.kind).toBe("rotated");
    if (o.kind !== "rotated") return;

    expect(status()).toBe("not_backed_up");
    const after = cfg.loadFullConfig();
    expect(after.device_public_key).toBe(o.newPublicKeyHex);
    // Stale, never destroyed: the record of which retired key the paper seed recovers.
    expect(after.seed_backed_up_at).toBe(1_000);
    expect(after.seed_backed_up_key).toBe(hex(a));

    // Retired-key material preserved: relay "none" ⇒ the old config is kept,
    // and its key still opens to the retired private key.
    expect(o.retiredKeyKeptAt).not.toBeNull();
    const kept = keptConfigs();
    expect(kept.length).toBeGreaterThan(0);
    const keptCfg = JSON.parse(fs.readFileSync(path.join(tmpDir, kept[0]!), "utf-8")) as {
      cli_encrypted_key: Parameters<typeof identity.decryptPrivateKey>[0];
      device_public_key: string;
    };
    expect(keptCfg.device_public_key).toBe(hex(a));
    expect(await identity.decryptPrivateKey(keptCfg.cli_encrypted_key, PASS)).toBe(
      bytesToHex(a.privateKey),
    );
  });

  it("abandoned rotation (funds stop, nothing moves) ⇒ still backed up", async () => {
    await identityWithBackup();
    const o = await rotation.performRotation(
      deps({ readWalletHoldings: async () => ({ solLamports: 9_000_000n, tokens: [] }) }),
    );
    expect(o).toMatchObject({ kind: "stopped", state: "funds-at-risk" });
    expect(status()).toBe("backed_up");
  });

  it("commit interrupted between its writes, finished on the next run ⇒ invalidated, and stays so", async () => {
    const { a, mid } = await identityWithBackup();
    const b = await generateKeypair();
    const record = await signKeySuccession(a.privateKey, b.privateKey, b.publicKey, a.publicKey);
    // The write-ahead, then the commit's FIRST write (config on b) — and the
    // process died before motebit.md was re-signed.
    pending.savePendingRotation(
      {
        motebit_id: mid,
        old_public_key: hex(a),
        new_public_key: hex(b),
        record,
        encrypted_new_key: (await identity.encryptPrivateKey(bytesToHex(b.privateKey), PASS))!,
        written_at: Date.now(),
      },
      tmpDir,
    );
    const c = cfg.loadFullConfig();
    c.cli_encrypted_key = (await identity.encryptPrivateKey(bytesToHex(b.privateKey), PASS))!;
    c.device_public_key = hex(b);
    cfg.saveFullConfig(c, { identityChange: "preserve-replaced" });
    // Already invalidated: the new key is committed in the config.
    expect(status()).toBe("not_backed_up");

    const o = await rotation.performRotation(deps());
    expect(o).toMatchObject({ kind: "rotated", newPublicKeyHex: hex(b) });
    expect(o.notes).toContainEqual({
      kind: "interrupted-commit-finished",
      newPublicKeyHex: hex(b),
    });
    // The finished (idempotent) commit never re-marks the identity backed up.
    expect(status()).toBe("not_backed_up");
    expect(cfg.loadFullConfig().seed_backed_up_key).toBe(hex(a));
  });

  it("restore (acknowledgment bound to the seed's key) then rotate ⇒ invalidated", async () => {
    // `motebit restore` records `seed_backed_up_key = publicKeyHex` — the key
    // the entered seed derives — which is what identityWithBackup writes.
    await identityWithBackup();
    expect(status()).toBe("backed_up");
    expect((await rotation.performRotation(deps())).kind).toBe("rotated");
    expect(status()).toBe("not_backed_up");
  });

  it("a legacy (unbound) acknowledgment reads not backed up — before a rotation and after it", async () => {
    await identityWithBackup({ bound: false });
    // Never honoured: one re-confirmation, by design.
    expect(status()).toBe("not_backed_up");
    expect((await rotation.performRotation(deps())).kind).toBe("rotated");
    expect(status()).toBe("not_backed_up");
  });

  it("a second rotation after re-backing up the middle key invalidates that backup too", async () => {
    await identityWithBackup();
    const first = await rotation.performRotation(deps());
    if (first.kind !== "rotated") throw new Error("expected rotated");
    const c = cfg.loadFullConfig();
    c.seed_backed_up_at = 2_000;
    c.seed_backed_up_key = first.newPublicKeyHex;
    cfg.saveFullConfig(c);
    expect(status()).toBe("backed_up");
    expect((await rotation.performRotation(deps())).kind).toBe("rotated");
    expect(status()).toBe("not_backed_up");
  });
});

/** A legacy (random, UUIDv7) motebit_id: never the sovereign commitment to any key. */
const LEGACY_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

/** A config with an acknowledgment from before the binding (unbound), on key `a`. */
async function unboundAck(motebitId: string, a: KeyPair, opts: { withFile: boolean }) {
  if (opts.withFile) {
    fs.writeFileSync(
      identityPath(),
      await generate(
        {
          motebitId,
          ownerId: "owner",
          publicKeyHex: hex(a),
          createdAt: "2020-01-01T00:00:00.000Z",
        },
        a.privateKey,
      ),
    );
  }
  fs.writeFileSync(
    cfg.CONFIG_PATH,
    JSON.stringify({
      motebit_id: motebitId,
      device_id: "laptop",
      device_public_key: hex(a),
      cli_encrypted_key: (await identity.encryptPrivateKey(bytesToHex(a.privateKey), PASS))!,
      seed_backed_up_at: Date.parse("2026-06-01T00:00:00.000Z"),
    }),
    { mode: 0o600 },
  );
}

describe("an unbound (legacy) acknowledgment is never honoured — one re-confirmation, never false text", () => {
  it("a never-rotated legacy id with its own zero-succession motebit.md reads re-confirm", async () => {
    const a = await generateKeypair();
    await unboundAck(LEGACY_ID, a, { withFile: true });
    expect(seed.seedBackupPostureOf(cfg.loadFullConfig())).toEqual({
      status: "not_backed_up",
      reason: "unconfirmed",
    });
  });

  it("main-shaped carry: X's unbound acknowledgment beside Y's v8 id reads re-confirm", async () => {
    const y = await generateKeypair();
    await unboundAck(await deriveSovereignMotebitId(hex(y)), y, { withFile: true });
    expect(seed.seedBackupPostureOf(cfg.loadFullConfig())).toEqual({
      status: "not_backed_up",
      reason: "unconfirmed",
    });
  });

  it("unknown coverage is worded 're-confirm' everywhere, and nothing says 'retired'", async () => {
    const a = await generateKeypair();
    await unboundAck(LEGACY_ID, a, { withFile: false });
    const words = seed.seedBackupWording(seed.seedBackupPostureOf(cfg.loadFullConfig()));
    for (const line of [words.nudge, words.doctor, words.detail, words.keychain]) {
      expect(line.toLowerCase()).toContain("re-confirm your recovery seed");
      expect(line).not.toMatch(/retired/i);
    }
  });

  it("a bound acknowledgment for another key of this identity says 'retired key'", async () => {
    const { mid } = await identityWithBackup();
    const other = await generateKeypair();
    const c = cfg.loadFullConfig();
    c.seed_backed_up_key = hex(other);
    c.seed_backed_up_motebit_id = mid;
    fs.writeFileSync(cfg.CONFIG_PATH, JSON.stringify(c));
    const words = seed.seedBackupWording(seed.seedBackupPostureOf(cfg.loadFullConfig()));
    expect(words.detail).toContain("retired key");
    expect(words.doctor).toContain("retired key");
    expect(words.keychain).toContain("not backed up for the current key");
  });

  it("a bound acknowledgment for another identity says 'not backed up for this identity', never 'retired'", async () => {
    const { a } = await identityWithBackup();
    const c = cfg.loadFullConfig();
    c.seed_backed_up_key = hex(a);
    c.seed_backed_up_motebit_id = "someone-else";
    fs.writeFileSync(cfg.CONFIG_PATH, JSON.stringify(c));
    const posture = seed.seedBackupPostureOf(cfg.loadFullConfig());
    expect(posture).toEqual({ status: "not_backed_up", reason: "other_identity" });
    const words = seed.seedBackupWording(posture);
    expect(words.nudge).toContain("not backed up for this identity");
    for (const line of [words.nudge, words.doctor, words.detail, words.keychain]) {
      expect(line).not.toMatch(/retired/i);
    }
  });
});

describe("motebit seed reveal — the acknowledgment is for what was shown", () => {
  it("records the seed's key and the identity it was shown for; reads backed up", async () => {
    const { a, mid } = await identityWithBackup();
    const c = cfg.loadFullConfig();
    delete c.seed_backed_up_at;
    delete c.seed_backed_up_key;
    fs.writeFileSync(cfg.CONFIG_PATH, JSON.stringify(c));
    const shown = cfg.loadFullConfig();
    const r = await seed.recordSeedAcknowledgment({
      shown: { motebitId: shown.motebit_id, publicKeyHex: shown.device_public_key },
      seedHex: bytesToHex(a.privateKey),
    });
    expect(r).toEqual({ recorded: true });
    const after = cfg.loadFullConfig();
    expect(after.seed_backed_up_key).toBe(hex(a));
    expect(after.seed_backed_up_motebit_id).toBe(mid);
    expect(status()).toBe("backed_up");
  });

  it("a rotation while the seed was on screen ⇒ nothing recorded, with the reason", async () => {
    const { a } = await identityWithBackup();
    const c0 = cfg.loadFullConfig();
    delete c0.seed_backed_up_at;
    delete c0.seed_backed_up_key;
    fs.writeFileSync(cfg.CONFIG_PATH, JSON.stringify(c0));
    const shown = cfg.loadFullConfig();
    // Another process commits a rotation between the reveal and the "y".
    expect((await rotation.performRotation(deps())).kind).toBe("rotated");
    const r = await seed.recordSeedAcknowledgment({
      shown: { motebitId: shown.motebit_id, publicKeyHex: shown.device_public_key },
      seedHex: bytesToHex(a.privateKey),
    });
    expect(r.recorded).toBe(false);
    if (!r.recorded) expect(r.reason).toContain("changed while the seed was on screen");
    expect(cfg.loadFullConfig().seed_backed_up_at).toBeUndefined();
    expect(status()).toBe("not_backed_up");
  });

  it("an identity switch while the seed was on screen ⇒ nothing recorded", async () => {
    const { a } = await identityWithBackup();
    const shown = cfg.loadFullConfig();
    const c = cfg.loadFullConfig();
    c.motebit_id = "another-identity";
    cfg.saveFullConfig(c, { identityChange: "preserve-replaced" });
    const r = await seed.recordSeedAcknowledgment({
      shown: { motebitId: shown.motebit_id, publicKeyHex: shown.device_public_key },
      seedHex: bytesToHex(a.privateKey),
    });
    expect(r.recorded).toBe(false);
  });
});

describe("an acknowledgment is never carried onto a new identity", () => {
  /** An identity-replacing write: loads the config, writes a new binding over it, carries every other field. */
  async function replaceIdentity(extra: (c: import("../config.js").FullConfig) => void = () => {}) {
    const b = await generateKeypair();
    const newMid = await deriveSovereignMotebitId(hex(b));
    const c = cfg.loadFullConfig();
    c.motebit_id = newMid;
    c.device_id = `${newMid}-laptop`;
    c.device_public_key = hex(b);
    c.cli_encrypted_key = (await identity.encryptPrivateKey(bytesToHex(b.privateKey), PASS))!;
    extra(c);
    cfg.saveFullConfig(c, { identityChange: "preserve-replaced" });
    return { b };
  }

  it("a new identity written over an old acknowledgment reads not backed up; the old one is kept aside", async () => {
    const { mid, a } = await identityWithBackup();
    await replaceIdentity();
    const after = cfg.loadFullConfig();
    expect(after.seed_backed_up_at).toBeUndefined();
    expect(after.seed_backed_up_key).toBeUndefined();
    expect(after.seed_backup_prior).toEqual([{ at: 1_000, key: hex(a), motebit_id: mid }]);
    expect(status()).toBe("not_backed_up");
  });

  it("an unbound (legacy) acknowledgment is set aside the same way — never honoured by the new genesis key", async () => {
    const { mid } = await identityWithBackup({ bound: false });
    await replaceIdentity();
    expect(cfg.loadFullConfig().seed_backup_prior).toEqual([
      { at: 1_000, key: null, motebit_id: mid },
    ]);
    expect(status()).toBe("not_backed_up");
  });

  it("a restore that records a fresh acknowledgment keeps it current, and keeps the replaced one aside", async () => {
    const { mid, a } = await identityWithBackup();
    let newKey = "";
    await replaceIdentity((c) => {
      newKey = c.device_public_key!;
      c.seed_backed_up_at = 5_000;
      c.seed_backed_up_key = newKey;
    });
    const after = cfg.loadFullConfig();
    expect(after.seed_backed_up_key).toBe(newKey);
    expect(after.seed_backup_prior).toEqual([{ at: 1_000, key: hex(a), motebit_id: mid }]);
    expect(status()).toBe("backed_up");
  });

  it("a rotation (same identity) moves nothing aside: the acknowledgment stays, bound to the retired key", async () => {
    const { a } = await identityWithBackup();
    expect((await rotation.performRotation(deps())).kind).toBe("rotated");
    const after = cfg.loadFullConfig();
    expect(after.seed_backed_up_key).toBe(hex(a));
    expect(after.seed_backup_prior).toBeUndefined();
  });

  it("a stale snapshot saved after the identity was replaced never carries the old acknowledgment back", async () => {
    await identityWithBackup();
    const stale = cfg.loadFullConfig(); // still holds the old acknowledgment
    await replaceIdentity();
    stale.default_model = "some-model";
    cfg.saveFullConfig(stale);
    const after = cfg.loadFullConfig();
    expect(after.default_model).toBe("some-model");
    expect(after.seed_backed_up_at).toBeUndefined();
    expect(after.seed_backup_prior).toHaveLength(1);
    expect(status()).toBe("not_backed_up");
  });
});
