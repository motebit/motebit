// --- config.json: absence vs damage, damage preserved, atomic owner-only ---
//
// `~/.motebit/config.json` holds `cli_encrypted_key` — for a CLI identity,
// the only copy of the private key — and, un-migrated, the deprecated
// `cli_private_key` in PLAINTEXT. Three rules, one test group each:
//
//  1. Absence ≠ damage: ENOENT reads as {}; anything else refuses.
//  2. Damage is never overwritten: preserved as `config.json.clobbered-*`
//     before a write, or the write refuses.
//  3. Replacement is staged + fsync'd + renamed, owner-only (0600) from
//     creation, scratch removed on failure; a pre-existing 0644 file ends 0600.
//
// CONFIG_DIR is captured at module load, so the env is set before import.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "motebit-cli-durability-"));
const savedDir = process.env["MOTEBIT_CONFIG_DIR"];
process.env["MOTEBIT_CONFIG_DIR"] = tmpDir;

type ConfigModule = typeof import("../config.js");
type DurableModule = typeof import("../durable-file.js");
let mod: ConfigModule;
let durable: DurableModule;

beforeAll(async () => {
  mod = await import("../config.js");
  durable = await import("../durable-file.js");
  expect(mod.CONFIG_DIR).toBe(tmpDir);
});

beforeEach(() => {
  for (const f of fs.readdirSync(tmpDir)) fs.rmSync(path.join(tmpDir, f), { recursive: true });
});

afterAll(() => {
  if (savedDir !== undefined) process.env["MOTEBIT_CONFIG_DIR"] = savedDir;
  else delete process.env["MOTEBIT_CONFIG_DIR"];
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const mode = (p: string) => fs.statSync(p).mode & 0o777;
const others = () => fs.readdirSync(tmpDir).filter((f) => f !== "config.json");

const DAMAGED_BODIES = [
  '{ "cli_encrypted_key": { "ciphertext": "ab', // truncated mid-write
  "", // truncated to nothing
  "null",
  "[]",
  "3",
  '"x"',
];

describe("rule 1 — absence is not damage", () => {
  it("an absent config reads as empty (a first run)", () => {
    expect(mod.loadFullConfig()).toEqual({});
  });

  it.each(DAMAGED_BODIES)("refuses %j and leaves the bytes untouched", (body) => {
    fs.writeFileSync(mod.CONFIG_PATH, body, "utf-8");
    expect(() => mod.loadFullConfig()).toThrow(mod.ConfigDamagedError);
    expect(fs.readFileSync(mod.CONFIG_PATH, "utf-8")).toBe(body);
  });

  it("refuses an unreadable path (a directory where the file should be)", () => {
    fs.mkdirSync(mod.CONFIG_PATH);
    expect(() => mod.loadFullConfig()).toThrow(/could not be read/);
  });

  it("names the file in the refusal", () => {
    fs.writeFileSync(mod.CONFIG_PATH, "{", "utf-8");
    expect(() => mod.loadFullConfig()).toThrow(mod.CONFIG_PATH);
  });
});

describe("rule 2 — damage is never overwritten", () => {
  it.each(DAMAGED_BODIES)("a save over %j preserves it as config.json.clobbered-*", (body) => {
    fs.writeFileSync(mod.CONFIG_PATH, body, { encoding: "utf-8", mode: 0o644 });
    const kept = mod.saveFullConfig({ motebit_id: "m-new" });
    expect(kept).not.toBeNull();
    expect(path.basename(kept!)).toMatch(/^config\.json\.clobbered-/);
    expect(fs.readFileSync(kept!, "utf-8")).toBe(body);
    expect(mode(kept!)).toBe(0o600); // a damaged key file is still a key file
    expect(mod.loadFullConfig().motebit_id).toBe("m-new");
    // Every reader that points a user at a backup finds this one.
    expect(mod.listConfigBackups()).toEqual([path.basename(kept!)]);
  });

  it("a save over a healthy config makes no backup", () => {
    mod.saveFullConfig({ motebit_id: "m-1" });
    expect(mod.saveFullConfig({ motebit_id: "m-2" })).toBeNull();
    expect(others()).toEqual([]);
  });

  it("refuses to write when the damage cannot be preserved", () => {
    // A directory cannot be hard-linked or copied: nothing may be written
    // over it, and nothing is.
    fs.mkdirSync(mod.CONFIG_PATH);
    fs.writeFileSync(path.join(mod.CONFIG_PATH, "inside"), "x");
    expect(() => mod.saveFullConfig({ motebit_id: "m-1" })).toThrow(/could not preserve/);
    expect(fs.readFileSync(path.join(mod.CONFIG_PATH, "inside"), "utf-8")).toBe("x");
    expect(others()).toEqual([]);
  });

  it("two damaged saves in the same millisecond keep both copies", () => {
    const now = new Date("2026-09-24T12:00:00.000Z");
    fs.writeFileSync(mod.CONFIG_PATH, "{a", "utf-8");
    const a = durable.preserveAside(mod.CONFIG_PATH, ".clobbered-", now);
    fs.rmSync(mod.CONFIG_PATH); // a hard link shares the inode; replace, don't rewrite
    fs.writeFileSync(mod.CONFIG_PATH, "{b", "utf-8");
    const b = durable.preserveAside(mod.CONFIG_PATH, ".clobbered-", now);
    expect(a).not.toBe(b);
    expect(fs.readFileSync(a, "utf-8")).toBe("{a");
    expect(fs.readFileSync(b, "utf-8")).toBe("{b");
  });
});

describe("rule 3 — atomic, owner-only replacement", () => {
  it("a new config is written 0600", () => {
    mod.saveFullConfig({ motebit_id: "m-1" });
    expect(mode(mod.CONFIG_PATH)).toBe(0o600);
  });

  it("a pre-existing 0644 config is tightened on LOAD — most commands only read", () => {
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({ motebit_id: "m-old" }), { mode: 0o644 });
    fs.chmodSync(mod.CONFIG_PATH, 0o644);
    expect(mod.loadFullConfig().motebit_id).toBe("m-old");
    expect(mode(mod.CONFIG_PATH)).toBe(0o600);
  });

  it("a pre-existing 0644 config ends 0600 after a save", () => {
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({ motebit_id: "m-old" }));
    fs.chmodSync(mod.CONFIG_PATH, 0o644);
    mod.saveFullConfig({ motebit_id: "m-old" });
    expect(mode(mod.CONFIG_PATH)).toBe(0o600);
  });

  it("replaces rather than writes through — a read-only config is still replaceable", () => {
    // Rename needs permission on the DIRECTORY; writing through needs it on
    // the FILE. A write-in-place implementation fails here.
    mod.saveFullConfig({ motebit_id: "m-1" });
    fs.chmodSync(mod.CONFIG_PATH, 0o400);
    mod.saveFullConfig({ motebit_id: "m-2" });
    expect(mod.loadFullConfig().motebit_id).toBe("m-2");
    expect(mode(mod.CONFIG_PATH)).toBe(0o600);
  });

  it("the file is 0600 even under a permissive umask", () => {
    const prev = process.umask(0o000);
    try {
      mod.saveFullConfig({ motebit_id: "m-1" });
    } finally {
      process.umask(prev);
    }
    expect(mode(mod.CONFIG_PATH)).toBe(0o600);
  });

  it("leaves no scratch file behind on success", () => {
    mod.saveFullConfig({ motebit_id: "m-1" });
    mod.saveFullConfig({ motebit_id: "m-2" });
    expect(others()).toEqual([]);
  });

  it("removes the scratch file when the replacement fails after staging", () => {
    // A non-empty directory at the target: staging succeeds, rename fails.
    const target = path.join(tmpDir, "occupied.json");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "x"), "x");
    expect(() => durable.writeFileAtomic(target, '{"secret":1}', 0o600)).toThrow();
    expect(fs.readdirSync(tmpDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("a symlinked config is replaced at its target — the link survives", () => {
    const real = path.join(tmpDir, "dotfiles-config.json");
    fs.writeFileSync(real, JSON.stringify({ motebit_id: "m-1" }));
    fs.symlinkSync(real, mod.CONFIG_PATH);
    mod.saveFullConfig({ motebit_id: "m-2" });
    expect(fs.lstatSync(mod.CONFIG_PATH).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(real, "utf-8")).motebit_id).toBe("m-2");
    expect(mode(real)).toBe(0o600);
  });

  it("a DAMAGED symlinked config: the kept copy still reads the old bytes after the save", () => {
    // Linux link(2) does not follow symlinks; a backup linked by NAME would
    // read the new config. Linux CI enforces this; see durable-file-preserve.
    const real = path.join(tmpDir, "dotfiles-config.json");
    fs.writeFileSync(real, "{ damaged");
    fs.symlinkSync(real, mod.CONFIG_PATH);
    const kept = mod.saveFullConfig({ motebit_id: "m-new" });
    expect(fs.readFileSync(kept!, "utf-8")).toBe("{ damaged");
    expect(fs.lstatSync(kept!).isSymbolicLink()).toBe(false);
    expect(mod.loadFullConfig().motebit_id).toBe("m-new");
  });

  it("a public file keeps a mode its owner narrowed", () => {
    const md = path.join(tmpDir, "motebit.md");
    fs.writeFileSync(md, "old");
    fs.chmodSync(md, 0o600);
    durable.writeFileAtomic(md, "new", durable.currentModeOr(md, 0o644));
    expect(fs.readFileSync(md, "utf-8")).toBe("new");
    expect(mode(md)).toBe(0o600);
    expect(durable.currentModeOr(path.join(tmpDir, "absent.md"), 0o644)).toBe(0o644);
  });
});
