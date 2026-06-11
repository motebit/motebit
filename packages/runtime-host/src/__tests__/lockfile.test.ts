import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLockfile, removeLockfile, writeLockfile } from "../lockfile.js";
import { nodePlatform } from "../node-platform.js";

const platform = nodePlatform();

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rh-lock-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("lockfile round-trip", () => {
  it("writes and reads a record (creating the parent dir)", async () => {
    const path = join(dir, "nested", "runtime.lock");
    await writeLockfile(platform, path, { pid: 1234, bound_at: 99, protocol_version: 1 });
    expect(await readLockfile(platform, path)).toEqual({
      pid: 1234,
      bound_at: 99,
      protocol_version: 1,
    });
    expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
  });

  it("returns null for a missing file", async () => {
    expect(await readLockfile(platform, join(dir, "absent.lock"))).toBeNull();
  });

  it("returns null for malformed or wrong-shaped contents", async () => {
    const path = join(dir, "runtime.lock");
    writeFileSync(path, "not json");
    expect(await readLockfile(platform, path)).toBeNull();
    writeFileSync(path, JSON.stringify({ pid: "1234" }));
    expect(await readLockfile(platform, path)).toBeNull();
    writeFileSync(path, JSON.stringify(null));
    expect(await readLockfile(platform, path)).toBeNull();
  });
});

describe("removeLockfile", () => {
  it("removes only its own record", async () => {
    const path = join(dir, "runtime.lock");
    await writeLockfile(platform, path, { pid: 42, bound_at: 0, protocol_version: 1 });
    await removeLockfile(platform, path, 43); // a successor's lock — must survive
    expect((await readLockfile(platform, path))?.pid).toBe(42);
    await removeLockfile(platform, path, 42);
    expect(await readLockfile(platform, path)).toBeNull();
  });

  it("is a no-op on a missing file", async () => {
    await expect(removeLockfile(platform, join(dir, "absent.lock"), 1)).resolves.toBeUndefined();
  });
});

describe("platform.isPidAlive", () => {
  it("sees the current process as alive", async () => {
    expect(await platform.isPidAlive(process.pid)).toBe(true);
  });

  it("rejects non-positive and non-integer pids without probing", async () => {
    expect(await platform.isPidAlive(0)).toBe(false);
    expect(await platform.isPidAlive(-5)).toBe(false);
    expect(await platform.isPidAlive(1.5)).toBe(false);
  });

  it("reports an (almost certainly) unused pid as dead", async () => {
    expect(await platform.isPidAlive(2_147_400_000)).toBe(false);
  });
});

describe("platform.mkdirExclusive", () => {
  it("is exclusive and recoverable", async () => {
    const mutex = join(dir, "deep", "lock.takeover");
    expect(await platform.mkdirExclusive(mutex)).toBe("created");
    expect(await platform.mkdirExclusive(mutex)).toBe("exists");
    await platform.removeDir(mutex);
    expect(await platform.mkdirExclusive(mutex)).toBe("created");
  });
});
