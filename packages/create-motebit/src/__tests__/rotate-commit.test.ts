// `create-motebit rotate`'s commit: at EVERY failure point, both keys stay
// recoverable, and the key motebit.md names is always one held on disk.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  commitRotation,
  defaultRotationCommitOps,
  finishRotationCommand,
  RotationCommitError,
  type RotationCommitOps,
  type RotationCommitStep,
} from "../rotate-commit.js";

let dir: string;
let configPath: string;
let identityPath: string;
const OLD_CONFIG = { motebit_id: "m", device_public_key: "OLD_PUB", cli_encrypted_key: "OLD_KEY" };
const NEXT_CONFIG = { motebit_id: "m", device_public_key: "NEW_PUB", cli_encrypted_key: "NEW_KEY" };
const OLD_ID = "identity naming OLD_PUB";
const NEW_ID = "identity naming NEW_PUB";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "create-motebit-rotate-commit-"));
  configPath = join(dir, "config.json");
  identityPath = join(dir, "motebit.md");
  writeFileSync(configPath, JSON.stringify(OLD_CONFIG), { mode: 0o600 });
  writeFileSync(identityPath, OLD_ID);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const plan = () => ({
  configPath,
  identityPath,
  previousIdentity: OLD_ID,
  nextIdentity: NEW_ID,
  nextConfig: NEXT_CONFIG,
});

/** Every file in the dir that holds `key` (config.json and any sibling). */
function holders(key: string): string[] {
  return readdirSync(dir).filter((f) => {
    try {
      return readFileSync(join(dir, f), "utf-8").includes(key);
    } catch {
      return false;
    }
  });
}

function failingAt(step: "backup" | "identity" | "config"): RotationCommitOps {
  const boom = () => {
    throw new Error(`injected ${step} failure`);
  };
  return {
    ...defaultRotationCommitOps,
    ...(step === "backup" ? { writeBackup: boom } : {}),
    ...(step === "identity" ? { writeIdentity: boom } : {}),
    ...(step === "config" ? { writeConfig: boom } : {}),
  };
}

describe("commitRotation", () => {
  it("succeeds: config holds the new key, the file names it, and the RETIRED key is kept (owner-only), never erased", () => {
    // The founder's ruling: a retired key is erased only after a relay has
    // accepted the succession — this command never talks to one.
    const { backupPath, oldKeyKeptAt } = commitRotation(plan());
    expect(JSON.parse(readFileSync(configPath, "utf-8")).cli_encrypted_key).toBe("NEW_KEY");
    expect(readFileSync(identityPath, "utf-8")).toBe(NEW_ID);
    expect(readFileSync(backupPath, "utf-8")).toBe(OLD_ID);
    expect(readFileSync(oldKeyKeptAt, "utf-8")).toContain("OLD_KEY");
    expect(statSync(oldKeyKeptAt).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter((f) => f.includes("rotation-next-"))).toEqual([]);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it.each(["backup", "identity", "config"] as const)(
    "a failure at %s loses neither key, and the key motebit.md names is held",
    (step) => {
      let caught: unknown;
      try {
        commitRotation(plan(), failingAt(step));
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(RotationCommitError);
      const e = caught as RotationCommitError;
      expect(e.step).toBe<RotationCommitStep>(step);

      // Both keys are on disk, owner-only.
      expect(holders("OLD_KEY").length).toBeGreaterThan(0);
      expect(holders("NEW_KEY").length).toBeGreaterThan(0);
      expect(readFileSync(e.oldKeyAt, "utf-8")).toContain("OLD_KEY");
      expect(readFileSync(e.newKeyAt!, "utf-8")).toContain("NEW_KEY");
      expect(statSync(e.oldKeyAt).mode & 0o777).toBe(0o600);
      expect(statSync(e.newKeyAt!).mode & 0o777).toBe(0o600);

      // Whatever motebit.md names, its private half is held.
      const names = readFileSync(identityPath, "utf-8") === NEW_ID ? "new" : "old";
      expect(e.identityNames).toBe(names);
      expect(holders(names === "new" ? "NEW_KEY" : "OLD_KEY").length).toBeGreaterThan(0);
    },
  );

  it("the finishing command for a config-step failure names the REAL config, so following it keeps a symlink", () => {
    const real = join(dir, "dotfiles-config.json");
    writeFileSync(real, JSON.stringify(OLD_CONFIG));
    rmSync(configPath);
    symlinkSync(real, configPath);
    let caught: RotationCommitError | undefined;
    try {
      commitRotation(plan(), failingAt("config"));
    } catch (err) {
      caught = err as RotationCommitError;
    }
    const cmd = finishRotationCommand(caught!.newKeyAt!, configPath);
    expect(cmd).toBe(`mv "${caught!.newKeyAt}" "${realpathSync(real)}"`);
    // Follow it, as a user would: the link survives and now reads the new key.
    renameSync(caught!.newKeyAt!, realpathSync(real));
    expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(configPath, "utf-8")).cli_encrypted_key).toBe("NEW_KEY");
  });

  it("the reviewer's probe: a directory at motebit.md.backup changes nothing that names a key", () => {
    // EISDIR on the backup write once left config.json on the NEW key with
    // motebit.md on the OLD one and the old key overwritten.
    const backupDir = join(dir, "motebit.md.backup");
    mkdirSync(join(backupDir, "occupied"), { recursive: true });
    expect(() => commitRotation(plan())).toThrow(RotationCommitError);
    expect(JSON.parse(readFileSync(configPath, "utf-8")).cli_encrypted_key).toBe("OLD_KEY");
    expect(readFileSync(identityPath, "utf-8")).toBe(OLD_ID);
    expect(holders("NEW_KEY").length).toBeGreaterThan(0);
  });
});
