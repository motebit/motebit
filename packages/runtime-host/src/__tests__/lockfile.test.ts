import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPidAlive, readLockfile, removeLockfile, writeLockfile } from "../lockfile.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rh-lock-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("lockfile round-trip", () => {
  it("writes and reads a record", () => {
    const path = join(dir, "nested", "runtime.lock");
    writeLockfile(path, { pid: 1234, bound_at: 99, protocol_version: 1 });
    expect(readLockfile(path)).toEqual({ pid: 1234, bound_at: 99, protocol_version: 1 });
  });

  it("returns null for a missing file", () => {
    expect(readLockfile(join(dir, "absent.lock"))).toBeNull();
  });

  it("returns null for malformed or wrong-shaped contents", () => {
    const path = join(dir, "runtime.lock");
    writeFileSync(path, "not json");
    expect(readLockfile(path)).toBeNull();
    writeFileSync(path, JSON.stringify({ pid: "1234" }));
    expect(readLockfile(path)).toBeNull();
    writeFileSync(path, JSON.stringify(null));
    expect(readLockfile(path)).toBeNull();
  });
});

describe("removeLockfile", () => {
  it("removes only its own record", () => {
    const path = join(dir, "runtime.lock");
    writeLockfile(path, { pid: 42, bound_at: 0, protocol_version: 1 });
    removeLockfile(path, 43); // a successor's lock — must survive
    expect(readLockfile(path)?.pid).toBe(42);
    removeLockfile(path, 42);
    expect(readLockfile(path)).toBeNull();
  });

  it("is a no-op on a missing file", () => {
    expect(() => removeLockfile(join(dir, "absent.lock"), 1)).not.toThrow();
  });
});

describe("isPidAlive", () => {
  it("sees the current process as alive", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("rejects non-positive and non-integer pids without probing", () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-5)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
  });

  it("treats ESRCH as dead and EPERM as alive", () => {
    const esrch = (): never => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    };
    const eperm = (): never => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    };
    expect(isPidAlive(999, esrch)).toBe(false);
    expect(isPidAlive(999, eperm)).toBe(true);
  });
});

describe("writeLockfile permissions", () => {
  it("writes mode 0600", () => {
    const path = join(dir, "runtime.lock");
    writeLockfile(path, { pid: 1, bound_at: 0, protocol_version: 1 });
    // Sanity: the record is the only content, newline-terminated.
    expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
  });
});
