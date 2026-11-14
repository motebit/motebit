// create-motebit's "Overwrite?" path replaces the identity in the shared
// ~/.motebit/config.json. A seed-backup acknowledgment recorded for the
// replaced identity must never be carried as the new identity's backup — the
// new seed was never shown — and must never be deleted either: the writer
// moves it ASIDE into `seed_backup_prior` (twin of the CLI's
// `setAsideReplacedSeedBackup`).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { readConfigFile, writeConfigFile } from "../config-file.js";

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "create-motebit-seed-"));
  file = path.join(dir, "config.json");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const KEY_A = { ciphertext: "aa", nonce: "01", tag: "02", salt: "03" };
const KEY_B = { ciphertext: "bb", nonce: "04", tag: "05", salt: "06" };

function seed(config: Record<string, unknown>): void {
  fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
}

describe("create-motebit replace — the old seed-backup acknowledgment is set aside, never carried", () => {
  it("a new identity over an acknowledged one: no current acknowledgment, the old one kept", () => {
    seed({
      motebit_id: "m-old",
      device_public_key: "A",
      cli_encrypted_key: KEY_A,
      seed_backed_up_at: 1_000,
      seed_backed_up_key: "A",
    });
    // The replace path: load, overwrite the binding, carry everything else.
    const config = readConfigFile<Record<string, unknown>>(file);
    config["motebit_id"] = "m-new";
    config["device_public_key"] = "B";
    config["cli_encrypted_key"] = KEY_B;
    writeConfigFile(file, config, { identityChange: "preserve-replaced" });

    const after = readConfigFile<Record<string, unknown>>(file);
    expect(after["seed_backed_up_at"]).toBeUndefined();
    expect(after["seed_backed_up_key"]).toBeUndefined();
    expect(after["seed_backup_prior"]).toEqual([{ at: 1_000, key: "A", motebit_id: "m-old" }]);
  });

  it("a legacy (unbound) acknowledgment is set aside the same way", () => {
    seed({
      motebit_id: "m-old",
      device_public_key: "A",
      cli_encrypted_key: KEY_A,
      seed_backed_up_at: 7,
    });
    const config = readConfigFile<Record<string, unknown>>(file);
    config["motebit_id"] = "m-new";
    config["device_public_key"] = "B";
    config["cli_encrypted_key"] = KEY_B;
    writeConfigFile(file, config, { identityChange: "preserve-replaced" });
    const after = readConfigFile<Record<string, unknown>>(file);
    expect(after["seed_backed_up_at"]).toBeUndefined();
    expect(after["seed_backup_prior"]).toEqual([{ at: 7, key: null, motebit_id: "m-old" }]);
  });

  it("a save that keeps the identity keeps the acknowledgment current", () => {
    seed({
      motebit_id: "m-old",
      device_public_key: "A",
      cli_encrypted_key: KEY_A,
      seed_backed_up_at: 1_000,
      seed_backed_up_key: "A",
    });
    const config = readConfigFile<Record<string, unknown>>(file);
    config["name"] = "project";
    writeConfigFile(file, config);
    const after = readConfigFile<Record<string, unknown>>(file);
    expect(after["seed_backed_up_at"]).toBe(1_000);
    expect(after["seed_backup_prior"]).toBeUndefined();
  });
});
