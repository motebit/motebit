// --- `motebit restore` over a damaged config — BOTH of its reads ---
//
// Restore is where `doctor` sends a user whose config cannot be read, so it
// must survive that config and rebuild it — while keeping the damaged bytes.
// It reads config twice: once to plan (reset / fresh / replace) and once,
// after the passphrase prompts, to commit. An earlier fix guarded only one of
// the two. Each read is exercised here on its own: damage present from the
// start (the plan's read), and damage that appears while the user types (the
// commit's read).

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "motebit-cli-restore-damage-"));
const savedDir = process.env["MOTEBIT_CONFIG_DIR"];
process.env["MOTEBIT_CONFIG_DIR"] = tmpDir;

const SEED = "4f".repeat(32);
const PASS = "correct horse battery staple";
const CONFIG = path.join(tmpDir, "config.json");

// Prompts in order: seed, new passphrase, confirmation. `onPassphrase` runs at
// the first passphrase prompt — i.e. between restore's two config reads.
let onPassphrase: (() => void) | null = null;
let promptCall = 0; // reset per test, so each run starts at the seed prompt
vi.mock("../identity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../identity.js")>();
  return {
    ...actual,
    promptPassphrase: vi.fn(async () => {
      promptCall++;
      if (promptCall === 1) return SEED;
      if (promptCall === 2) onPassphrase?.();
      return PASS;
    }),
  };
});

// The REPLACE confirmation reads a visible line through node:readline.
let replaceAnswer = "REPLACE IDENTITY";
vi.mock("node:readline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:readline")>();
  return {
    ...actual,
    createInterface: () => ({
      question: (_q: string, cb: (a: string) => void) => cb(replaceAnswer),
      close: () => {},
    }),
  };
});

class Exit extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

type RestoreModule = typeof import("../subcommands/restore.js");
let restore: RestoreModule;

beforeAll(async () => {
  restore = await import("../subcommands/restore.js");
});

beforeEach(() => {
  for (const f of fs.readdirSync(tmpDir)) fs.rmSync(path.join(tmpDir, f), { recursive: true });
  onPassphrase = null;
  promptCall = 0;
  replaceAnswer = "REPLACE IDENTITY";
  vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
    throw new Exit(typeof code === "number" ? code : undefined);
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  if (savedDir !== undefined) process.env["MOTEBIT_CONFIG_DIR"] = savedDir;
  else delete process.env["MOTEBIT_CONFIG_DIR"];
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function runRestore(): Promise<number | undefined> {
  try {
    await restore.handleRestore({ positionals: ["restore"] } as unknown as Parameters<
      RestoreModule["handleRestore"]
    >[0]);
  } catch (err) {
    if (err instanceof Exit) return err.code;
    throw err;
  }
  return undefined;
}

function backups(): string[] {
  return fs.readdirSync(tmpDir).filter((f) => f.startsWith("config.json.clobbered-"));
}

function expectRestoredConfig(): void {
  const cfg = JSON.parse(fs.readFileSync(CONFIG, "utf-8")) as Record<string, unknown>;
  expect(typeof cfg["motebit_id"]).toBe("string");
  expect(cfg["cli_encrypted_key"]).toBeTruthy();
  expect(fs.statSync(CONFIG).mode & 0o777).toBe(0o600);
}

describe("restore over a damaged config", () => {
  it("damage present at the PLAN read: restore completes and keeps the damaged bytes", async () => {
    const damaged = '{ "cli_encrypted_key": { "ciphertext": "ab';
    fs.writeFileSync(CONFIG, damaged, { mode: 0o644 });
    expect(await runRestore()).toBe(0);
    expectRestoredConfig();
    const kept = backups();
    expect(kept).toHaveLength(1);
    expect(fs.readFileSync(path.join(tmpDir, kept[0]!), "utf-8")).toBe(damaged);
  });

  it("damage appearing before the COMMIT read: restore completes and keeps the damaged bytes", async () => {
    // Healthy (absent) at the plan read; damaged by the time of the commit read.
    onPassphrase = () => fs.writeFileSync(CONFIG, "[]");
    expect(await runRestore()).toBe(0);
    expectRestoredConfig();
    const kept = backups();
    expect(kept).toHaveLength(1);
    expect(fs.readFileSync(path.join(tmpDir, kept[0]!), "utf-8")).toBe("[]");
  });

  it("an aborted restore leaves the damaged file exactly where it was", async () => {
    // The plan's read must not move or rewrite anything: the user may stop.
    fs.writeFileSync(CONFIG, "{");
    const mock = (await import("../identity.js")).promptPassphrase as ReturnType<typeof vi.fn>;
    mock.mockImplementationOnce(async () => SEED).mockImplementationOnce(async () => "");
    expect(await runRestore()).toBe(1);
    expect(fs.readFileSync(CONFIG, "utf-8")).toBe("{");
    expect(backups()).toEqual([]);
  });

  it("an unreadable rotation write-ahead is kept aside, never deleted, on a fresh install", async () => {
    // It may be the only copy of a rotated key the relay already accepted.
    const pending = path.join(tmpDir, "pending-rotation.json");
    fs.writeFileSync(pending, '{ "encrypted_new_key": { "ciph');
    expect(await runRestore()).toBe(0);
    expectRestoredConfig();
    const kept = fs
      .readdirSync(tmpDir)
      .filter((f) => f.startsWith("pending-rotation.json.clobbered-"));
    expect(kept).toHaveLength(1);
    expect(fs.readFileSync(path.join(tmpDir, kept[0]!), "utf-8")).toBe(
      '{ "encrypted_new_key": { "ciph',
    );
  });

  it("an unreadable rotation write-ahead blocks a passphrase reset and is left untouched", async () => {
    // First restore installs the seed's identity; the second is then a
    // passphrase reset, where the write-ahead could be THIS identity's.
    expect(await runRestore()).toBe(0);
    const before = fs.readFileSync(CONFIG, "utf-8");
    const pending = path.join(tmpDir, "pending-rotation.json");
    fs.writeFileSync(pending, "{torn");
    promptCall = 0;
    expect(await runRestore()).toBe(1);
    expect(fs.readFileSync(pending, "utf-8")).toBe("{torn");
    expect(fs.readFileSync(CONFIG, "utf-8")).toBe(before);
  });

  // --- #757 round 2, C2: a READABLE write-ahead of the seed's own identity ---

  async function seedIdentity(): Promise<{ pub: string; mid: string }> {
    const { getPublicKeyBySuite, hexToBytes, bytesToHex, deriveSovereignMotebitId } =
      await import("@motebit/encryption");
    const pub = bytesToHex(
      await getPublicKeyBySuite(hexToBytes(SEED), "motebit-jcs-ed25519-hex-v1"),
    );
    return { pub, mid: await deriveSovereignMotebitId(pub) };
  }

  function writeAhead(fields: { motebit_id: string; old_public_key: string }): string {
    const body = JSON.stringify({
      ...fields,
      new_public_key: "ee".repeat(32),
      record: { note: "succession record" },
      encrypted_new_key: { ciphertext: "NEWKEY", nonce: "n", tag: "t", salt: "s" },
      written_at: 1,
    });
    fs.writeFileSync(path.join(tmpDir, "pending-rotation.json"), body, { mode: 0o600 });
    return body;
  }

  /** Every file in the config dir holding the rotated key's bytes. */
  const newKeyHolders = (): string[] =>
    fs
      .readdirSync(tmpDir)
      .filter((f) => fs.readFileSync(path.join(tmpDir, f), "utf-8").includes("NEWKEY"));

  it("REVIEWER'S PROBE: damaged config + this identity's in-flight write-ahead ⇒ NEWKEY survives, in place", async () => {
    const { pub, mid } = await seedIdentity();
    fs.writeFileSync(CONFIG, "{ damaged");
    const body = writeAhead({ motebit_id: mid, old_public_key: pub });
    expect(await runRestore()).toBe(0);
    // Left exactly where `motebit rotate` will look for it.
    expect(fs.readFileSync(path.join(tmpDir, "pending-rotation.json"), "utf-8")).toBe(body);
    expect(newKeyHolders()).toContain("pending-rotation.json");
  });

  it("a write-ahead naming this identity (from another key) is kept aside, never deleted", async () => {
    const { mid } = await seedIdentity();
    writeAhead({ motebit_id: mid, old_public_key: "ab".repeat(32) });
    expect(await runRestore()).toBe(0);
    expect(newKeyHolders().some((f) => f.startsWith("pending-rotation.json.clobbered-"))).toBe(
      true,
    );
  });

  it("a foreign-looking write-ahead is kept aside when the config was damaged (attribution uncertain)", async () => {
    fs.writeFileSync(CONFIG, "[]");
    writeAhead({ motebit_id: "someone-else", old_public_key: "ab".repeat(32) });
    expect(await runRestore()).toBe(0);
    expect(newKeyHolders().some((f) => f.startsWith("pending-rotation.json.clobbered-"))).toBe(
      true,
    );
  });

  it("even a write-ahead POSITIVELY another identity's is kept aside — restore never deletes one", async () => {
    writeAhead({ motebit_id: "someone-else", old_public_key: "ab".repeat(32) });
    expect(await runRestore()).toBe(0);
    expect(newKeyHolders().some((f) => f.startsWith("pending-rotation.json.clobbered-"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(tmpDir, "pending-rotation.json"))).toBe(false); // deactivated
  });

  // --- #759 round 1: a REPLACED identity's key and its in-flight rotation ---

  /** Files (other than the live config) holding `marker`, each asserted 0600. */
  function keptHolding(marker: string): string[] {
    const hits = fs
      .readdirSync(tmpDir)
      .filter((f) => f !== "config.json")
      .filter((f) => fs.readFileSync(path.join(tmpDir, f), "utf-8").includes(marker));
    for (const f of hits) expect(fs.statSync(path.join(tmpDir, f)).mode & 0o777).toBe(0o600);
    return hits;
  }

  function configWith(fields: Record<string, unknown>): void {
    fs.writeFileSync(CONFIG, JSON.stringify(fields), { mode: 0o600 });
  }

  function aRotation(motebit_id: string, oldKey: string, secret: string): void {
    fs.writeFileSync(
      path.join(tmpDir, "pending-rotation.json"),
      JSON.stringify({
        motebit_id,
        old_public_key: oldKey,
        new_public_key: "dd".repeat(32),
        record: { note: "succession" },
        encrypted_new_key: { ciphertext: secret, nonce: "n", tag: "t", salt: "s" },
        written_at: 1,
      }),
      { mode: 0o600 },
    );
  }

  it("REVIEWER'S PROBE: REPLACE over identity A with A's rotation in flight ⇒ KA and KA' both kept, 0600", async () => {
    const KA_PUB = "a1".repeat(32);
    configWith({
      motebit_id: "identity-A",
      device_public_key: KA_PUB,
      cli_encrypted_key: { ciphertext: "KA_SECRET", nonce: "n", tag: "t", salt: "s" },
    });
    aRotation("identity-A", KA_PUB, "KA_PRIME_SECRET");
    expect(await runRestore()).toBe(0);
    expect(keptHolding("KA_SECRET")).toHaveLength(1);
    expect(keptHolding("KA_SECRET")[0]).toMatch(/^config\.json\.clobbered-/);
    expect(keptHolding("KA_PRIME_SECRET")).toHaveLength(1);
    expect(keptHolding("KA_PRIME_SECRET")[0]).toMatch(/^pending-rotation\.json\.clobbered-/);
    expectRestoredConfig();
  });

  it("variant (i): the SAME sovereign id on a rotated key, restored from the genesis seed ⇒ the rotated key is kept", async () => {
    const { mid } = await seedIdentity();
    configWith({
      motebit_id: mid,
      device_public_key: "b2".repeat(32),
      cli_encrypted_key: { ciphertext: "K1_SECRET", nonce: "n", tag: "t", salt: "s" },
    });
    expect(await runRestore()).toBe(0);
    expect(keptHolding("K1_SECRET")).toHaveLength(1);
  });

  it("variant (ii): a key but NO motebit_id (plan fresh_install) ⇒ that key and its own rotation are kept", async () => {
    const KX_PUB = "c3".repeat(32);
    configWith({
      device_public_key: KX_PUB,
      cli_encrypted_key: { ciphertext: "KX_SECRET", nonce: "n", tag: "t", salt: "s" },
    });
    aRotation("identity-X", KX_PUB, "KX_PRIME_SECRET");
    expect(await runRestore()).toBe(0);
    expect(keptHolding("KX_SECRET")).toHaveLength(1);
    expect(keptHolding("KX_PRIME_SECRET")).toHaveLength(1);
  });

  it("an aborted REPLACE keeps nothing aside and changes nothing", async () => {
    configWith({
      motebit_id: "identity-A",
      device_public_key: "a1".repeat(32),
      cli_encrypted_key: { ciphertext: "KA_SECRET", nonce: "n", tag: "t", salt: "s" },
    });
    aRotation("identity-A", "a1".repeat(32), "KA_PRIME_SECRET");
    replaceAnswer = "no";
    expect(await runRestore()).toBe(1);
    expect(fs.readdirSync(tmpDir).sort()).toEqual(["config.json", "pending-rotation.json"]);
  });

  it("every config read in restore goes through the damage-tolerant loader", () => {
    // Structural: the withdrawn fix guarded one of two reads. A third direct
    // read added later would reopen the hole this closes.
    const src = fs.readFileSync(path.join(__dirname, "..", "subcommands", "restore.ts"), "utf-8");
    expect(src.match(/loadFullConfig\(\)/g)).toHaveLength(1); // inside loadConfigForRestore
    expect((src.match(/loadConfigForRestore\(\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
