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

  it("MECHANISM: it links the resolved real file, never the name as given", () => {
    const { link, real } = symlinkedConfig("{OLD");
    preserveAside(link, ".clobbered-");
    expect(vi.mocked(fs.linkSync)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fs.linkSync).mock.calls[0]![0]).toBe(fs.realpathSync(real));
  });

  it("the copy fallback (no hard links, e.g. across filesystems) keeps old bytes, 0600 from creation", () => {
    const { link } = symlinkedConfig("{OLD");
    vi.mocked(fs.linkSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("EXDEV"), { code: "EXDEV" });
    });
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
