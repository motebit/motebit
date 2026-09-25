/**
 * Key-file durability item 28 (`docs/proposals/key-file-durability-v1.md`):
 * `write_file` / `undo_write` never write into motebit's own state, keep
 * what they overwrite owner-only, and never overwrite what they could not
 * keep.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createWriteFileHandler } from "../builtins/write-file.js";
import { createUndoWriteHandler } from "../builtins/undo-write.js";
import { isProtectedStatePath } from "../builtins/path-sandbox.js";

let dir: string;
let backupDir: string;
const savedHome = process.env["HOME"];
const savedCfg = process.env["MOTEBIT_CONFIG_DIR"];

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "motebit-tools-kf-")));
  backupDir = path.join(dir, "backups");
  process.env["HOME"] = path.join(dir, "home");
  fs.mkdirSync(path.join(dir, "home", ".motebit"), { recursive: true });
  delete process.env["MOTEBIT_CONFIG_DIR"];
});
afterEach(() => {
  if (savedHome !== undefined) process.env["HOME"] = savedHome;
  if (savedCfg !== undefined) process.env["MOTEBIT_CONFIG_DIR"] = savedCfg;
  else delete process.env["MOTEBIT_CONFIG_DIR"];
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the file tools never write motebit's own state", () => {
  it("~/.motebit/config.json is denied, even inside allowedPaths", async () => {
    const target = path.join(dir, "home", ".motebit", "config.json");
    fs.writeFileSync(target, "KEY");
    const write = createWriteFileHandler({ allowedPaths: [dir], backupDir });
    const r = await write({ path: target, content: "x" });
    expect(r.ok).toBe(false);
    expect(fs.readFileSync(target, "utf-8")).toBe("KEY");
  });

  it("a scaffolded agent's `<agent>/.motebit/config.json` under the cwd is denied", async () => {
    const agent = path.join(dir, "my-agent", ".motebit");
    fs.mkdirSync(agent, { recursive: true });
    fs.writeFileSync(path.join(agent, "config.json"), "AGENT KEY");
    const write = createWriteFileHandler({ allowedPaths: [dir], backupDir });
    expect((await write({ path: path.join(agent, "config.json"), content: "x" })).ok).toBe(false);
    expect(fs.readFileSync(path.join(agent, "config.json"), "utf-8")).toBe("AGENT KEY");
  });

  it("a symlink from an allowed directory into ~/.motebit is denied", () => {
    const link = path.join(dir, "innocent");
    fs.symlinkSync(path.join(dir, "home", ".motebit"), link);
    expect(isProtectedStatePath(path.join(link, "config.json"))).toBe(true);
  });

  it("$MOTEBIT_CONFIG_DIR is protected wherever it points", () => {
    process.env["MOTEBIT_CONFIG_DIR"] = path.join(dir, "elsewhere");
    expect(isProtectedStatePath(path.join(dir, "elsewhere", "config.json"))).toBe(true);
    expect(isProtectedStatePath(path.join(dir, "project", "notes.md"))).toBe(false);
  });

  it("undo_write is denied there too", async () => {
    const target = path.join(dir, "home", ".motebit", "config.json");
    fs.writeFileSync(target, "ROTATED KEY");
    const undo = createUndoWriteHandler({ allowedPaths: [dir], backupDir });
    expect((await undo({ path: target })).ok).toBe(false);
    expect(fs.readFileSync(target, "utf-8")).toBe("ROTATED KEY");
  });
});

describe("what write_file overwrites is kept owner-only — or the write does not happen", () => {
  it("the backup directory is 0700 and the backup 0600", async () => {
    const target = path.join(dir, "notes.txt");
    fs.writeFileSync(target, "OLD", { mode: 0o644 });
    const prev = process.umask(0o022);
    try {
      const write = createWriteFileHandler({ allowedPaths: [dir], backupDir });
      expect((await write({ path: target, content: "NEW" })).ok).toBe(true);
    } finally {
      process.umask(prev);
    }
    expect(fs.statSync(backupDir).mode & 0o777).toBe(0o700);
    const copies = fs.readdirSync(backupDir).filter((f) => !f.endsWith(".meta.json"));
    expect(copies).toHaveLength(1);
    expect(fs.readFileSync(path.join(backupDir, copies[0]!), "utf-8")).toBe("OLD");
    expect(fs.statSync(path.join(backupDir, copies[0]!)).mode & 0o777).toBe(0o600);
  });

  it("an existing file that cannot be READ is not overwritten (it was once treated as 'new')", async () => {
    if (process.getuid?.() === 0) return;
    const target = path.join(dir, "locked.txt");
    fs.writeFileSync(target, "UNREADABLE");
    fs.chmodSync(target, 0o200); // writable, not readable
    try {
      const write = createWriteFileHandler({ allowedPaths: [dir], backupDir });
      const r = await write({ path: target, content: "NEW" });
      expect(r.ok).toBe(false);
    } finally {
      fs.chmodSync(target, 0o600);
    }
    expect(fs.readFileSync(target, "utf-8")).toBe("UNREADABLE");
  });

  it("a backup that cannot be written refuses the write (it once proceeded)", async () => {
    const target = path.join(dir, "notes.txt");
    fs.writeFileSync(target, "OLD");
    const blocked = path.join(dir, "not-a-dir");
    fs.writeFileSync(blocked, "file in the way");
    const write = createWriteFileHandler({ allowedPaths: [dir], backupDir: blocked });
    expect((await write({ path: target, content: "NEW" })).ok).toBe(false);
    expect(fs.readFileSync(target, "utf-8")).toBe("OLD");
  });

  it("undo_write keeps the CURRENT bytes before restoring", async () => {
    const target = path.join(dir, "notes.txt");
    fs.writeFileSync(target, "V1");
    const write = createWriteFileHandler({ allowedPaths: [dir], backupDir });
    await write({ path: target, content: "V2" });
    const undo = createUndoWriteHandler({ allowedPaths: [dir], backupDir });
    expect((await undo({ path: target })).ok).toBe(true);
    expect(fs.readFileSync(target, "utf-8")).toBe("V1");
    const copies = fs
      .readdirSync(backupDir)
      .filter((f) => !f.endsWith(".meta.json"))
      .map((f) => fs.readFileSync(path.join(backupDir, f), "utf-8"));
    expect(copies.sort()).toEqual(["V1", "V2"]);
  });
});
