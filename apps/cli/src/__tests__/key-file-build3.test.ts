// Key-file durability build 3 (docs/proposals/key-file-durability-v1.md),
// CLI half: the rules at every door the inventory named in lane A.
//
//  - item 3  lost update: a stale snapshot never reverts a committed key
//  - item 4  a damaged key file is narrowed on load, before the refusal
//  - item 6  a dangling symlink is damage, never absence
//  - item 7  hasPendingRotation is ENOENT-only
//  - item 16 the config directory is created 0700
//  - the config lock shared with create-motebit
//  - item 1  the CLI bootstrap adapter: one atomic write, tri-state probe
//
// CONFIG_DIR is captured at module load, so the env is set before import.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "motebit-kf3-"));
const tmpDir = path.join(root, "cfg"); // NOT created: saveFullConfig creates it
const savedDir = process.env["MOTEBIT_CONFIG_DIR"];
process.env["MOTEBIT_CONFIG_DIR"] = tmpDir;

type ConfigModule = typeof import("../config.js");
let mod: ConfigModule;
let pending: typeof import("../pending-rotation.js");
const CONFIG = path.join(tmpDir, "config.json");

beforeAll(async () => {
  mod = await import("../config.js");
  pending = await import("../pending-rotation.js");
  expect(mod.CONFIG_DIR).toBe(tmpDir);
});

beforeEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(() => {
  if (savedDir !== undefined) process.env["MOTEBIT_CONFIG_DIR"] = savedDir;
  else delete process.env["MOTEBIT_CONFIG_DIR"];
  fs.rmSync(root, { recursive: true, force: true });
});

const KEY_A = { ciphertext: "aa", nonce: "01", tag: "02", salt: "03" };
const KEY_B = { ciphertext: "bb", nonce: "04", tag: "05", salt: "06" };
const mode = (p: string) => fs.statSync(p).mode & 0o777;
const kept = () => fs.readdirSync(tmpDir).filter((f) => f.startsWith("config.json.clobbered-"));
const onDisk = () => JSON.parse(fs.readFileSync(CONFIG, "utf-8")) as Record<string, unknown>;

function seed(config: Record<string, unknown>): void {
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(config), { mode: 0o600 });
}

describe("item 16 — the config directory is created owner-only", () => {
  it("saveFullConfig creates CONFIG_DIR 0700", () => {
    mod.saveFullConfig({ name: "x" });
    expect(mode(tmpDir)).toBe(0o700);
  });
});

describe("item 3 — a stale snapshot never reverts a committed key (lost update)", () => {
  it("a REPL-lifetime snapshot saved after another process rotated keeps the ROTATED key", () => {
    seed({ motebit_id: "m-1", device_public_key: "A", cli_encrypted_key: KEY_A });
    const repl = mod.loadFullConfig(); // `motebit` opens; snapshot holds key A
    // `motebit rotate` in another terminal commits key B (declared change).
    const other = mod.loadFullConfig();
    other.cli_encrypted_key = KEY_B;
    other.device_public_key = "B";
    mod.saveFullConfig(other, { identityChange: "retire-relay-accepted" });
    // `/model` in the REPL writes its snapshot back.
    repl.default_model = "some-model";
    mod.saveFullConfig(repl);
    const after = onDisk();
    expect(after["cli_encrypted_key"]).toEqual(KEY_B);
    expect(after["device_public_key"]).toBe("B");
    expect(after["default_model"]).toBe("some-model");
  });

  it("the same through an object spread (`motebit up`'s `{...config, ...changes}`)", () => {
    seed({ motebit_id: "m-1", device_public_key: "A", cli_encrypted_key: KEY_A });
    const snapshot = mod.loadFullConfig();
    const other = mod.loadFullConfig();
    other.cli_encrypted_key = KEY_B;
    mod.saveFullConfig(other, { identityChange: "retire-relay-accepted" });
    mod.saveFullConfig({ ...snapshot, name: "renamed" });
    expect(onDisk()["cli_encrypted_key"]).toEqual(KEY_B);
  });

  it("a DECLARED identity change decided on a state that no longer exists is refused, nothing written", () => {
    seed({ motebit_id: "m-1", device_public_key: "A", cli_encrypted_key: KEY_A });
    const decided = mod.loadFullConfig(); // e.g. migrate-keyring before its prompt
    const other = mod.loadFullConfig();
    other.cli_encrypted_key = KEY_B;
    mod.saveFullConfig(other, { identityChange: "retire-relay-accepted" });
    decided.cli_encrypted_key = { ciphertext: "cc", nonce: "0", tag: "0", salt: "0" };
    expect(() => mod.saveFullConfig(decided, { identityChange: "preserve-replaced" })).toThrow(
      mod.ConfigIdentityChangedError,
    );
    expect(onDisk()["cli_encrypted_key"]).toEqual(KEY_B);
  });

  it("a declared `preserve-replaced` change keeps the replaced key, byte for byte, owner-only", () => {
    seed({ motebit_id: "m-1", device_public_key: "A", cli_encrypted_key: KEY_A });
    const before = fs.readFileSync(CONFIG, "utf-8");
    const c = mod.loadFullConfig();
    c.cli_encrypted_key = KEY_B;
    const keptAt = mod.saveFullConfig(c, { identityChange: "preserve-replaced" });
    expect(keptAt).not.toBeNull();
    expect(fs.readFileSync(keptAt!, "utf-8")).toBe(before);
    expect(mode(keptAt!)).toBe(0o600);
  });

  it("`retire-relay-accepted` does not keep the retired key (the founder's ruling)", () => {
    seed({ motebit_id: "m-1", device_public_key: "A", cli_encrypted_key: KEY_A });
    const c = mod.loadFullConfig();
    c.cli_encrypted_key = KEY_B;
    expect(mod.saveFullConfig(c, { identityChange: "retire-relay-accepted" })).toBeNull();
    expect(kept()).toEqual([]);
  });

  it("a config deleted since it was read is written back as the caller holds it (never emptied of its identity)", () => {
    seed({ motebit_id: "m-1", device_public_key: "A", cli_encrypted_key: KEY_A });
    const snapshot = mod.loadFullConfig();
    fs.rmSync(CONFIG);
    mod.saveFullConfig(snapshot);
    expect(onDisk()["cli_encrypted_key"]).toEqual(KEY_A);
  });

  it("an identity-changing save that replaces only the BINDING (no key in the config) keeps the old binding", () => {
    seed({ motebit_id: "m-1", device_id: "d-1", device_public_key: "A" });
    const c = mod.loadFullConfig();
    c.motebit_id = "m-2";
    c.device_public_key = "B";
    const keptAt = mod.saveFullConfig(c, { identityChange: "preserve-replaced" });
    expect(keptAt).not.toBeNull();
    expect(JSON.parse(fs.readFileSync(keptAt!, "utf-8")).motebit_id).toBe("m-1");
  });

  it("a config built WITHOUT a read that replaces a key keeps the replaced key", () => {
    seed({ motebit_id: "m-1", cli_encrypted_key: KEY_A });
    const keptAt = mod.saveFullConfig({ motebit_id: "m-2", cli_encrypted_key: KEY_B });
    expect(keptAt).not.toBeNull();
    expect(JSON.parse(fs.readFileSync(keptAt!, "utf-8")).cli_encrypted_key).toEqual(KEY_A);
  });
});

describe("item 4 — a damaged key file is narrowed on load, before the refusal", () => {
  it.each(["{ torn", "null", "[]"])(
    "damaged %j at 0644 is 0600 after the (refused) load",
    (body) => {
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(CONFIG, body, { mode: 0o644 });
      fs.chmodSync(CONFIG, 0o644);
      expect(() => mod.loadFullConfig()).toThrow(mod.ConfigDamagedError);
      expect(mode(CONFIG)).toBe(0o600);
    },
  );

  it("a damaged write-ahead at 0644 is 0600 after the load that calls it unreadable", () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    const p = pending.pendingRotationPath(tmpDir);
    fs.writeFileSync(p, "{ torn");
    fs.chmodSync(p, 0o644);
    expect(pending.loadAnyPendingRotation(tmpDir)).toBe("unreadable");
    expect(mode(p)).toBe(0o600);
  });
});

describe("item 6 — a dangling symlink is damage, never absence", () => {
  it("config.json → a missing target: load refuses, save refuses, the link survives", () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.symlinkSync(path.join(root, "unmounted", "config.json"), CONFIG);
    expect(() => mod.loadFullConfig()).toThrow(/symlink whose target is missing/);
    expect(() => mod.saveFullConfig({ name: "x" })).toThrow();
    expect(fs.lstatSync(CONFIG).isSymbolicLink()).toBe(true);
  });

  it("pending-rotation.json → a missing target reads as unreadable, and is 'present'", () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.symlinkSync(path.join(root, "gone.json"), pending.pendingRotationPath(tmpDir));
    expect(pending.loadAnyPendingRotation(tmpDir)).toBe("unreadable");
    expect(pending.hasPendingRotation(tmpDir)).toBe(true); // item 7: existsSync said false
  });
});

describe("the rotation write-ahead's preserve verb", () => {
  it("setAside MOVES it (one rename): bytes kept 0600 under .clobbered-, the slot is free", () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    const p = pending.pendingRotationPath(tmpDir);
    fs.writeFileSync(p, '{"a":1}', { mode: 0o600 });
    const ino = fs.statSync(p).ino;
    const keptAt = pending.setAsidePendingRotation(tmpDir)!;
    expect(fs.readFileSync(keptAt, "utf-8")).toBe('{"a":1}');
    expect(fs.statSync(keptAt).ino).toBe(ino); // renamed, not copied-then-unlinked
    expect(pending.hasPendingRotation(tmpDir)).toBe(false);
    expect(pending.setAsidePendingRotation(tmpDir)).toBeNull();
  });
});

describe("the config lock (shared with create-motebit)", () => {
  it("saveFullConfig ITSELF takes the lock: with another live process holding it, the save waits, refuses, and changes nothing", () => {
    seed({ name: "before" });
    // Held by a LIVE process that is not this one (our parent), exactly as
    // another motebit process or create-motebit would hold it. Nothing in
    // this process holds it: the only lock taken is saveFullConfig's own.
    fs.writeFileSync(`${CONFIG}.lock`, String(process.ppid));
    const started = Date.now();
    expect(() => mod.saveFullConfig({ name: "after" })).toThrow(
      /locked by another motebit process/,
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_000); // it WAITED (5 s budget)
    expect(onDisk()["name"]).toBe("before");
    expect(fs.readFileSync(`${CONFIG}.lock`, "utf-8")).toBe(String(process.ppid)); // not broken
    fs.rmSync(`${CONFIG}.lock`);
  }, 15_000);

  it("breaking a stale lock never deletes a FRESH lock another waiter took at the same name", async () => {
    const durable = await import("../durable-file.js");
    fs.mkdirSync(tmpDir, { recursive: true });
    const lock = `${CONFIG}.lock`;
    fs.writeFileSync(lock, "2147483646 aa"); // stale: dead pid
    const staleToken = fs.readFileSync(lock, "utf-8");
    // Waiter A breaks it and takes a fresh lock before waiter B acts on its
    // (now outdated) judgement. On Linux the fresh file may REUSE the stale
    // one's inode — which is why the judgement is content, not inode (CI).
    fs.unlinkSync(lock);
    fs.writeFileSync(lock, "A-fresh");
    durable.breakStaleLock(lock, staleToken); // waiter B
    expect(fs.readFileSync(lock, "utf-8")).toBe("A-fresh");
    expect(fs.readdirSync(tmpDir).filter((f) => f.includes(".stale-"))).toEqual([]);
    // And the judged-stale inode itself IS broken.
    fs.rmSync(lock);
    fs.writeFileSync(lock, "2147483646 aa");
    durable.breakStaleLock(lock, "2147483646 aa");
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("a holder releases only ITS lock — a lock another process put at the name stands", async () => {
    const durable = await import("../durable-file.js");
    fs.mkdirSync(tmpDir, { recursive: true });
    const lock = `${CONFIG}.lock`;
    durable.withFileLock(CONFIG, () => {
      // Someone else's lock replaces ours while we hold it (a racing breaker).
      fs.writeFileSync(lock, "999999 someone-else");
    });
    expect(fs.readFileSync(lock, "utf-8")).toBe("999999 someone-else");
    fs.rmSync(lock);
  });

  it("two concurrent waiters over a stale lock never hold it at the same time", async () => {
    const { spawn } = await import("node:child_process");
    fs.mkdirSync(tmpDir, { recursive: true });
    const log = path.join(root, "lock-log.txt");
    fs.writeFileSync(log, "");
    fs.writeFileSync(`${CONFIG}.lock`, "2147483646"); // stale from the start: both break it
    const script = path.join(root, "waiter.mts");
    const durablePath = path.resolve(__dirname, "..", "durable-file.ts");
    fs.writeFileSync(
      script,
      `import * as fs from "node:fs";
import { withFileLock } from ${JSON.stringify(durablePath)};
const [target, logFile, id] = process.argv.slice(2);
for (let i = 0; i < 15; i++) {
  withFileLock(target, () => {
    fs.appendFileSync(logFile, "in " + id + "\\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3);
    fs.appendFileSync(logFile, "out " + id + "\\n");
  }, { timeoutMs: 20000 });
}
`,
    );
    const tsx = path.resolve(__dirname, "..", "..", "..", "..", "node_modules", ".bin", "tsx");
    const run = (id: string) =>
      new Promise<number>((resolve) => {
        const p = spawn(tsx, [script, CONFIG, log, id], { stdio: "inherit" });
        p.on("exit", (code) => resolve(code ?? 1));
      });
    const codes = await Promise.all([run("A"), run("B")]);
    expect(codes).toEqual([0, 0]);
    const lines = fs.readFileSync(log, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(60);
    for (let i = 0; i < lines.length; i += 2) {
      // Every "in X" is immediately followed by "out X": no overlap.
      expect(lines[i]!.startsWith("in ")).toBe(true);
      expect(lines[i + 1]).toBe(lines[i]!.replace("in ", "out "));
    }
  }, 60_000);

  it("a lock left by a dead process is broken", () => {
    seed({ name: "before" });
    fs.writeFileSync(`${CONFIG}.lock`, "2147483646"); // no such pid
    mod.saveFullConfig({ name: "after" });
    expect(onDisk()["name"]).toBe("after");
    expect(fs.existsSync(`${CONFIG}.lock`)).toBe(false);
  });
});

describe("item 15 — every kept copy of key material is listed", () => {
  it("lists clobbered configs, create-motebit rotation copies, set-aside write-aheads and stranded .tmp files", () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    const names = [
      "config.json.clobbered-2026-01-01T00-00-00-000Z",
      "config.json.pre-rotation-2026-01-01T00-00-00-000Z",
      "config.json.rotation-next-2026-01-01T00-00-00-000Z",
      "pending-rotation.json.clobbered-2026-01-01T00-00-00-000Z",
      "config.json.123.abcdef.tmp",
      "pending-rotation.json.tmp",
      "dev-keyring.json.migrated-2026-01-01T00-00-00-000Z", // a PLAINTEXT key, kept
      "motebit.md.clobbered-2026-01-01T00-00-00-000Z",
    ];
    for (const n of names) fs.writeFileSync(path.join(tmpDir, n), "x");
    fs.writeFileSync(path.join(tmpDir, "motebit.db"), "x");
    expect(mod.listKeptKeyFiles().sort()).toEqual([...names].sort());
    expect(mod.listConfigBackups()).toEqual(["config.json.clobbered-2026-01-01T00-00-00-000Z"]);
  });
});

describe("item 1 — the CLI's bootstrap adapter", () => {
  it("a DESKTOP-written config (an identity, no CLI key) is REFUSED — never re-minted — and left byte-identical", async () => {
    // What the desktop writes into the shared ~/.motebit/config.json: its
    // key lives in its own store. Minting here overwrote the desktop's
    // identity (review finding (i) on #761).
    seed({
      motebit_id: "desktop-id",
      device_id: "desktop-dev",
      device_public_key: "aa".repeat(32),
    });
    const before = fs.readFileSync(CONFIG, "utf-8");
    await expect(boot(mod.loadFullConfig() as never)).rejects.toMatchObject({
      state: "identity-without-key",
    });
    expect(fs.readFileSync(CONFIG, "utf-8")).toBe(before);
    expect(fs.readdirSync(tmpDir).filter((f) => f !== "config.json")).toEqual([]);
  });

  // The identity key for a fresh identity is written by core-identity via the
  // adapter; the DB is only asked for identity rows.
  async function boot(config: Record<string, unknown>) {
    const { bootstrapIdentity } = await import("../identity.js");
    const { InMemoryIdentityStorage } = await import("@motebit/core-identity");
    const { InMemoryEventStore } = await import("@motebit/event-log");
    const db = {
      identityStorage: new InMemoryIdentityStorage(),
      eventStore: new InMemoryEventStore(),
    } as unknown as Parameters<typeof bootstrapIdentity>[0];
    return bootstrapIdentity(db, config as never, "pass-1");
  }

  it("a config holding a key but NO motebit_id is refused, not minted over; the file is untouched", async () => {
    seed({ cli_private_key: "11".repeat(32) });
    const before = fs.readFileSync(CONFIG, "utf-8");
    await expect(boot(mod.loadFullConfig() as never)).rejects.toMatchObject({
      state: "key-without-identity",
    });
    expect(fs.readFileSync(CONFIG, "utf-8")).toBe(before);
  });

  it("a key that will not open under the passphrase is refused, never minted over", async () => {
    seed({ motebit_id: "m-1", device_public_key: "aa", cli_encrypted_key: KEY_A });
    await expect(boot(mod.loadFullConfig() as never)).rejects.toMatchObject({
      state: "keystore-unreadable",
    });
  });

  it("a first launch writes the key AND its identity in ONE write", async () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    const durable = await import("../durable-file.js");
    const spy = vi.spyOn(durable, "writeFileAtomic");
    const r = await boot({});
    expect(r.isFirstLaunch).toBe(true);
    const writes = spy.mock.calls.filter((c) => c[0] === CONFIG);
    spy.mockRestore();
    expect(writes).toHaveLength(1);
    const after = onDisk();
    expect(after["motebit_id"]).toBe(r.motebitId);
    expect(after["cli_encrypted_key"]).toBeTruthy();
  });

  it("an existing identity whose key derives to its public key loads without a write", async () => {
    const { encryptPrivateKey } = await import("../identity.js");
    const { getPublicKeyBySuite, bytesToHex, hexToBytes } = await import("@motebit/encryption");
    const priv = "22".repeat(32);
    const pub = bytesToHex(
      await getPublicKeyBySuite(hexToBytes(priv), "motebit-jcs-ed25519-hex-v1"),
    );
    seed({
      motebit_id: "m-1",
      device_id: "d-1",
      device_public_key: pub,
      cli_encrypted_key: await encryptPrivateKey(priv, "pass-1"),
    });
    const r = await boot(mod.loadFullConfig() as never);
    expect(r).toMatchObject({ motebitId: "m-1", isFirstLaunch: false });
  });

  it("an existing identity whose key derives to ANOTHER public key is refused", async () => {
    const { encryptPrivateKey } = await import("../identity.js");
    seed({
      motebit_id: "m-1",
      device_id: "d-1",
      device_public_key: "ff".repeat(32),
      cli_encrypted_key: await encryptPrivateKey("22".repeat(32), "pass-1"),
    });
    await expect(boot(mod.loadFullConfig() as never)).rejects.toMatchObject({
      state: "key-mismatch",
    });
  });
});
