// Key-file durability build 3 (docs/proposals/key-file-durability-v1.md) —
// the create-motebit twin of the CLI's config rules: no lost update, a
// damaged file narrowed before it is refused, a dangling symlink is damage,
// the lock shared with the CLI, a write-ahead moved aside never deleted.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ConfigDamagedError,
  ConfigIdentityChangedError,
  moveAside,
  readConfigFile,
  withFileLock,
  writeConfigFile,
} from "../config-file.js";

let dir: string;
let cfg: string;
const mode = (p: string) => statSync(p).mode & 0o777;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "create-motebit-kf3-"));
  cfg = join(dir, "config.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("no lost update", () => {
  it("a stale read saved after another process committed a new key keeps the NEW key", () => {
    writeFileSync(cfg, JSON.stringify({ motebit_id: "m", cli_encrypted_key: { c: "A" } }));
    const stale = readConfigFile<Record<string, unknown>>(cfg); // create-motebit reuse path
    const other = readConfigFile<Record<string, unknown>>(cfg); // `motebit rotate`
    other["cli_encrypted_key"] = { c: "B" };
    writeConfigFile(cfg, other, { identityChange: "retired-kept-elsewhere" });
    stale["name"] = "my-project";
    writeConfigFile(cfg, stale);
    const after = JSON.parse(readFileSync(cfg, "utf-8"));
    expect(after.cli_encrypted_key).toEqual({ c: "B" });
    expect(after.name).toBe("my-project");
  });

  it("an identity change decided on a state that no longer exists is refused", () => {
    writeFileSync(cfg, JSON.stringify({ motebit_id: "m", cli_encrypted_key: { c: "A" } }));
    const decided = readConfigFile<Record<string, unknown>>(cfg);
    const other = readConfigFile<Record<string, unknown>>(cfg);
    other["cli_encrypted_key"] = { c: "B" };
    writeConfigFile(cfg, other, { identityChange: "retired-kept-elsewhere" });
    decided["cli_encrypted_key"] = { c: "C" };
    expect(() => writeConfigFile(cfg, decided, { identityChange: "preserve-replaced" })).toThrow(
      ConfigIdentityChangedError,
    );
    expect(JSON.parse(readFileSync(cfg, "utf-8")).cli_encrypted_key).toEqual({ c: "B" });
  });

  it("a replaced key is kept as a byte copy (preserve-replaced)", () => {
    const body = JSON.stringify({ motebit_id: "m", cli_encrypted_key: { c: "A" } });
    writeFileSync(cfg, body);
    const c = readConfigFile<Record<string, unknown>>(cfg);
    c["motebit_id"] = "m2";
    c["cli_encrypted_key"] = { c: "B" };
    const kept = writeConfigFile(cfg, c, { identityChange: "preserve-replaced" });
    expect(readFileSync(kept!, "utf-8")).toBe(body);
    expect(mode(kept!)).toBe(0o600);
  });
});

describe("damage", () => {
  it("a damaged 0644 config is narrowed to 0600 by the read that refuses it", () => {
    writeFileSync(cfg, "{ torn");
    chmodSync(cfg, 0o644);
    expect(() => readConfigFile(cfg)).toThrow(ConfigDamagedError);
    expect(mode(cfg)).toBe(0o600);
  });

  it("a dangling symlink is damage: read refuses, write refuses, the link survives", () => {
    symlinkSync(join(dir, "unmounted", "config.json"), cfg);
    expect(() => readConfigFile(cfg)).toThrow(/symlink whose target is missing/);
    expect(() => writeConfigFile(cfg, { a: 1 })).toThrow();
    expect(lstatSync(cfg).isSymbolicLink()).toBe(true);
  });
});

describe("the lock shared with the motebit CLI (`<config>.lock`)", () => {
  it("a live holder blocks a write, which refuses on timeout with nothing changed", () => {
    writeFileSync(cfg, JSON.stringify({ a: 1 }));
    writeFileSync(`${cfg}.lock`, String(process.ppid));
    expect(() =>
      withFileLock(cfg, () => writeConfigFile(cfg, { a: 2 }), { timeoutMs: 100 }),
    ).toThrow(/locked by another motebit process/);
    expect(JSON.parse(readFileSync(cfg, "utf-8"))).toEqual({ a: 1 });
  });

  it("is re-entrant within one process (a rotation holds it across its commit)", () => {
    const r = withFileLock(cfg, () => {
      writeConfigFile(cfg, { a: 3 });
      return "done";
    });
    expect(r).toBe("done");
    expect(existsSync(`${cfg}.lock`)).toBe(false);
  });
});

describe("moveAside (the write-ahead's preserve verb)", () => {
  it("renames: same bytes, same inode, owner-only; the name is free; nothing there ⇒ null", () => {
    const p = join(dir, "pending-rotation.json");
    writeFileSync(p, "HELD", { mode: 0o644 });
    const ino = statSync(p).ino;
    const kept = moveAside(p, ".clobbered-")!;
    expect(readFileSync(kept, "utf-8")).toBe("HELD");
    expect(statSync(kept).ino).toBe(ino);
    expect(mode(kept)).toBe(0o600);
    expect(existsSync(p)).toBe(false);
    expect(moveAside(p, ".clobbered-")).toBeNull();
    expect(readdirSync(dir)).toHaveLength(1);
  });
});
