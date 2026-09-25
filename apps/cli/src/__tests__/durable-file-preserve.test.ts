// preserveAside must keep the REAL file's bytes, never a second name for a
// symlink. On Linux link(2) does not follow symlinks, so linking a symlinked
// config's NAME made the "backup" read the NEW bytes once the write landed
// (#757 round 2, C1). macOS link(2) follows symlinks, so the invariant test
// alone stays green there even without the fix — the linkSync spy below pins
// the mechanism on every platform, and Linux CI enforces the invariant.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, linkSync: vi.fn(actual.linkSync) };
});

const { preserveAside, writeFileAtomic } = await import("../durable-file.js");

let dir: string;
let realDir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "motebit-preserve-"));
  realDir = fs.mkdtempSync(path.join(os.tmpdir(), "motebit-preserve-real-"));
  vi.mocked(fs.linkSync).mockClear();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(realDir, { recursive: true, force: true });
});

function symlinkedConfig(bytes: string): { link: string; real: string } {
  const real = path.join(realDir, "real-config.json");
  const link = path.join(dir, "config.json");
  fs.writeFileSync(real, bytes);
  fs.symlinkSync(real, link);
  return { link, real };
}

describe("preserveAside through a symlink", () => {
  it("INVARIANT: after the write, the backup still reads the OLD bytes and is not a link", () => {
    const { link, real } = symlinkedConfig("{OLD damaged");
    const kept = preserveAside(link, ".clobbered-");
    writeFileAtomic(link, '{"NEW":1}', 0o600);
    expect(fs.readFileSync(kept, "utf-8")).toBe("{OLD damaged");
    expect(fs.lstatSync(kept).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(real, "utf-8")).toBe('{"NEW":1}');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("MECHANISM: a readable file is kept as a BYTE COPY, never a hard link (a second name for the same inode)", () => {
    const { link, real } = symlinkedConfig("{OLD");
    const kept = preserveAside(link, ".clobbered-");
    expect(vi.mocked(fs.linkSync)).not.toHaveBeenCalled();
    expect(fs.statSync(kept).ino).not.toBe(fs.statSync(real).ino);
  });

  it("X5: an IN-PLACE writer (an older CLI, the write_file tool) rewriting the live file cannot change the kept bytes", () => {
    // A hard-link "backup" shares the live file's inode: when the live name
    // survives (create-motebit's pre-rotation copy after a failed step, a
    // restore that preserved and then exited), any O_TRUNC write through the
    // live name rewrote the "kept" old key too.
    const live = path.join(dir, "config.json");
    fs.writeFileSync(live, "{OLD KEY");
    const kept = preserveAside(live, ".pre-rotation-");
    fs.writeFileSync(live, "{SOMETHING ELSE"); // in place, same inode
    expect(fs.readFileSync(kept, "utf-8")).toBe("{OLD KEY");
  });

  it("a file this process cannot READ is kept by hard link (it cannot be copied), owner-only", () => {
    if (process.getuid?.() === 0) return; // root reads everything
    const live = path.join(dir, "config.json");
    fs.writeFileSync(live, "{UNREADABLE");
    fs.chmodSync(live, 0o000);
    try {
      const kept = preserveAside(live, ".clobbered-");
      expect(vi.mocked(fs.linkSync)).toHaveBeenCalledTimes(1);
      expect(fs.statSync(kept).ino).toBe(fs.statSync(live).ino);
    } finally {
      fs.chmodSync(live, 0o600);
    }
  });

  it("the copy is 0600 from creation, even under a permissive umask", () => {
    const { link } = symlinkedConfig("{OLD");
    const prev = process.umask(0o000); // a copy-then-chmod would be 0666 until the chmod
    let kept: string;
    try {
      kept = preserveAside(link, ".clobbered-");
    } finally {
      process.umask(prev);
    }
    expect(fs.statSync(kept).mode & 0o777).toBe(0o600);
    writeFileAtomic(link, '{"NEW":1}', 0o600);
    expect(fs.readFileSync(kept, "utf-8")).toBe("{OLD");
    expect(fs.lstatSync(kept).isSymbolicLink()).toBe(false);
  });

  it("refuses when a symlink cannot be resolved (dangling), rather than keeping the link", () => {
    const link = path.join(dir, "config.json");
    fs.symlinkSync(path.join(realDir, "gone.json"), link);
    expect(() => preserveAside(link, ".clobbered-")).toThrow(/could not resolve/);
  });
});
