// --- Config load/save + governance field round-trip ---
//
// The CLI's CONFIG_DIR / CONFIG_PATH are computed once from os.homedir() at
// module load time. We override HOME before the very first import so the
// constants point at a temp dir — no real user config is ever touched.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_GOVERNANCE_CONFIG, type GovernanceConfig } from "@motebit/sdk";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "motebit-cli-config-test-"));
const savedHome = process.env["HOME"];
process.env["HOME"] = tmpHome;

// Dynamic import AFTER env override so CONFIG_DIR picks up tmpHome.
// Pinned to a single import — CONFIG_PATH is captured at module load.
type ConfigModule = typeof import("../config.js");
let mod: ConfigModule;

beforeAll(async () => {
  mod = await import("../config.js");
});

beforeEach(() => {
  // Reset config file between tests
  try {
    fs.rmSync(mod.CONFIG_PATH, { force: true });
  } catch {
    // ignore
  }
});

afterAll(() => {
  if (savedHome !== undefined) process.env["HOME"] = savedHome;
  else delete process.env["HOME"];
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe("FullConfig.governance", () => {
  it("loads as undefined when absent from config.json", () => {
    mod.saveFullConfig({ name: "no-gov" });
    const loaded = mod.loadFullConfig();
    expect(loaded.name).toBe("no-gov");
    expect(loaded.governance).toBeUndefined();
  });

  it("loads a valid governance block verbatim (camelCase pass-through)", () => {
    const gov: GovernanceConfig = {
      approvalPreset: "cautious",
      persistenceThreshold: 0.8,
      rejectSecrets: true,
      maxCallsPerTurn: 3,
      maxMemoriesPerTurn: 2,
    };
    mod.saveFullConfig({ governance: gov });
    const loaded = mod.loadFullConfig();
    expect(loaded.governance).toEqual(gov);
  });

  it("round-trips: save then load preserves governance exactly", () => {
    const cfg = {
      name: "round-trip",
      governance: { ...DEFAULT_GOVERNANCE_CONFIG, approvalPreset: "autonomous" as const },
    };
    mod.saveFullConfig(cfg);
    const loaded = mod.loadFullConfig();
    expect(loaded.governance).toEqual(cfg.governance);
  });

  it("drops a malformed governance blob so runtime defaults apply", () => {
    fs.mkdirSync(mod.CONFIG_DIR, { recursive: true });
    fs.writeFileSync(
      mod.CONFIG_PATH,
      JSON.stringify({
        name: "bad-gov",
        // missing required fields + wrong type on persistenceThreshold
        governance: { approvalPreset: "balanced", persistenceThreshold: "high" },
      }),
      "utf-8",
    );
    const loaded = mod.loadFullConfig();
    expect(loaded.name).toBe("bad-gov");
    expect(loaded.governance).toBeUndefined();
  });
});

// --- Durability, confidentiality, and telling damage from absence (#711) ---
//
// `config.json` holds `cli_encrypted_key` — for a CLI identity, the only
// copy of the private key — and, for anyone who has not migrated, the
// deprecated `cli_private_key` in PLAINTEXT. Three properties follow from
// that, none of which the file had:
//
//  - it is replaced atomically, so an interrupted write cannot truncate
//    the identity away;
//  - it is owner-only;
//  - a file that exists but cannot be read is NOT reported as "no config",
//    because the next save would then overwrite whatever was recoverable
//    with a fresh, nearly-empty one.
describe("config durability", () => {
  it("is written owner-only — it holds key material", () => {
    mod.saveFullConfig({ motebit_id: "m-1" });
    expect(fs.statSync(mod.CONFIG_PATH).mode & 0o777).toBe(0o600);
  });

  it("leaves the previous config intact when a write fails part-way", () => {
    mod.saveFullConfig({ motebit_id: "m-1", device_public_key: "aa".repeat(32) });
    const before = fs.readFileSync(mod.CONFIG_PATH, "utf-8");

    // A write that dies after truncating is the failure this exists to
    // prevent. Block the staging path with a directory so the replacement
    // fails where a full disk would, without mocking the filesystem.
    const staged = `${mod.CONFIG_PATH}.${process.pid}.tmp`;
    fs.mkdirSync(staged, { recursive: true });
    try {
      expect(() => mod.saveFullConfig({ motebit_id: "m-2" })).toThrow();
    } finally {
      fs.rmSync(staged, { recursive: true, force: true });
    }

    expect(fs.readFileSync(mod.CONFIG_PATH, "utf-8")).toBe(before);
    expect(mod.loadFullConfig().device_public_key).toBe("aa".repeat(32));
  });

  it("replaces the file rather than writing through it — a read-only config is still replaceable", () => {
    // The distinguisher between rename-and-replace and write-in-place:
    // replacing needs permission on the DIRECTORY, writing through needs
    // permission on the FILE. A write-in-place implementation fails here.
    mod.saveFullConfig({ motebit_id: "m-1" });
    fs.chmodSync(mod.CONFIG_PATH, 0o400);
    mod.saveFullConfig({ motebit_id: "m-2" });
    expect(mod.loadFullConfig().motebit_id).toBe("m-2");
    expect(fs.statSync(mod.CONFIG_PATH).mode & 0o777).toBe(0o600);
  });

  it("tightens a config that predates the owner-only rule", () => {
    fs.mkdirSync(mod.CONFIG_DIR, { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({ motebit_id: "m-old" }), {
      encoding: "utf-8",
      mode: 0o644,
    });
    expect(fs.statSync(mod.CONFIG_PATH).mode & 0o777).toBe(0o644);
    mod.saveFullConfig(mod.loadFullConfig());
    expect(fs.statSync(mod.CONFIG_PATH).mode & 0o777).toBe(0o600);
  });

  it("refuses a config it cannot read for a reason other than absence", () => {
    // A directory where the file should be: readable path, unreadable
    // contents. Reporting that as "no config" is the same lie as a
    // truncated file.
    fs.rmSync(mod.CONFIG_PATH, { force: true });
    fs.mkdirSync(mod.CONFIG_PATH, { recursive: true });
    try {
      expect(() => mod.loadFullConfig()).toThrow(/damaged|could not be read/i);
    } finally {
      fs.rmSync(mod.CONFIG_PATH, { recursive: true, force: true });
    }
  });

  it("leaves no scratch file behind on success", () => {
    mod.saveFullConfig({ motebit_id: "m-1" });
    const strays = fs
      .readdirSync(mod.CONFIG_DIR)
      .filter((f) => f.startsWith("config.json") && f !== "config.json");
    expect(strays).toEqual([]);
  });

  it("removes the scratch file when the replacement fails after staging it", () => {
    // The staged copy holds the same key material as the target. A failure
    // between staging and replacing must not leave it lying around, since
    // nothing else would ever clean it up.
    fs.rmSync(mod.CONFIG_PATH, { force: true });
    fs.mkdirSync(mod.CONFIG_PATH, { recursive: true });
    fs.writeFileSync(path.join(mod.CONFIG_PATH, "occupied"), "x", "utf-8");
    try {
      expect(() => mod.saveFullConfig({ motebit_id: "m-1" })).toThrow();
      const strays = fs
        .readdirSync(mod.CONFIG_DIR)
        .filter((f) => f.startsWith("config.json.") && f.endsWith(".tmp"));
      expect(strays).toEqual([]);
    } finally {
      fs.rmSync(mod.CONFIG_PATH, { recursive: true, force: true });
    }
  });

  it("reads an absent config as empty — that is a first run, not damage", () => {
    fs.rmSync(mod.CONFIG_PATH, { force: true });
    expect(mod.loadFullConfig()).toEqual({});
  });

  it("refuses to read a damaged config rather than calling it empty", () => {
    // Returning {} here is what turns "your config is damaged" into "you
    // have no identity" — and the next save then overwrites the only copy
    // of the key with a fresh file.
    fs.writeFileSync(mod.CONFIG_PATH, '{ "motebit_id": "m-1", ', "utf-8");
    expect(() => mod.loadFullConfig()).toThrow(/damaged|could not be read/i);
  });

  it("names the file and preserves its bytes when it refuses", () => {
    const damaged = '{ "cli_encrypted_key": { "ciphertext": "abc"';
    fs.writeFileSync(mod.CONFIG_PATH, damaged, "utf-8");
    try {
      mod.loadFullConfig();
      throw new Error("expected a refusal");
    } catch (err) {
      expect(String((err as Error).message)).toContain("config.json");
    }
    expect(fs.readFileSync(mod.CONFIG_PATH, "utf-8")).toBe(damaged);
  });
});
