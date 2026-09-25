/**
 * The write-ahead a rotation leaves before its request goes out
 * (`docs/proposals/key-rotation-client-v1.md` I2).
 */
import { chmodSync, mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  clearPendingRotation,
  hasPendingRotation,
  loadAnyPendingRotation,
  loadPendingRotation,
  pendingRotationPath,
  savePendingRotation,
  setAsidePendingRotation,
  type PendingRotation,
} from "../pending-rotation.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "motebit-pending-rotation-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const held: PendingRotation = {
  motebit_id: "mid-1",
  old_public_key: "aa".repeat(32),
  new_public_key: "bb".repeat(32),
  record: {
    old_public_key: "aa".repeat(32),
    new_public_key: "bb".repeat(32),
    timestamp: 1,
    suite: "motebit-jcs-ed25519-hex-v1",
    new_key_signature: "00",
  },
  encrypted_new_key: { ciphertext: "c", nonce: "n", tag: "t", salt: "s" },
  written_at: 1,
};

describe("a held rotation", () => {
  it("is returned to the identity and key it departs from", () => {
    savePendingRotation(held, dir);
    expect(loadPendingRotation("mid-1", "aa".repeat(32), dir)).toEqual(held);
    expect(hasPendingRotation(dir)).toBe(true);
  });

  it("is not offered to another identity, nor once the local key has moved past it", () => {
    savePendingRotation(held, dir);
    expect(loadPendingRotation("mid-2", "aa".repeat(32), dir)).toBeNull();
    expect(loadPendingRotation("mid-1", "bb".repeat(32), dir)).toBeNull();
    // Still on disk — the caller decides what a stale one means, and can
    // read it unscoped to say WHOSE it was before clearing it.
    expect(hasPendingRotation(dir)).toBe(true);
    expect(loadAnyPendingRotation(dir)).toEqual(held);
  });

  it("is absent (null) ONLY when nothing is there", () => {
    expect(loadPendingRotation("mid-1", "aa".repeat(32), dir)).toBeNull();
    expect(loadAnyPendingRotation(dir)).toBeNull();
  });

  // Damage is not absence: a torn write-ahead may be the only copy of a key
  // the relay already accepted, and "null" is what licenses clearing it.
  it.each([
    ["corrupt JSON", "{not json"],
    ["a partial record", JSON.stringify({ motebit_id: "mid-1", old_public_key: "aa".repeat(32) })],
    ["JSON null", "null"],
    ["an array", "[]"],
    ["an empty file", ""],
  ])("reads %s as unreadable, never as absent — and leaves it on disk", (_label, body) => {
    writeFileSync(pendingRotationPath(dir), body);
    expect(loadAnyPendingRotation(dir)).toBe("unreadable");
    expect(loadPendingRotation("mid-1", "aa".repeat(32), dir)).toBe("unreadable");
    expect(readFileSync(pendingRotationPath(dir), "utf-8")).toBe(body);
  });

  it("reads a write-ahead it has no permission to read as unreadable", () => {
    if (process.getuid?.() === 0) return; // root reads through mode 000
    savePendingRotation(held, dir);
    chmodSync(pendingRotationPath(dir), 0o000);
    try {
      expect(loadAnyPendingRotation(dir)).toBe("unreadable");
    } finally {
      chmodSync(pendingRotationPath(dir), 0o600);
    }
  });

  it("a world-readable write-ahead (it holds an encrypted key) is narrowed to 0600 on load", () => {
    writeFileSync(pendingRotationPath(dir), JSON.stringify(held));
    chmodSync(pendingRotationPath(dir), 0o644);
    expect(loadAnyPendingRotation(dir)).toEqual(held);
    expect(statSync(pendingRotationPath(dir)).mode & 0o777).toBe(0o600);
    // …and so is a damaged one: its bytes may still be key material.
    writeFileSync(pendingRotationPath(dir), "{torn");
    chmodSync(pendingRotationPath(dir), 0o644);
    expect(loadAnyPendingRotation(dir)).toBe("unreadable");
    expect(statSync(pendingRotationPath(dir)).mode & 0o777).toBe(0o600);
  });

  it("an unreadable write-ahead is set aside with its bytes kept, never deleted", () => {
    writeFileSync(pendingRotationPath(dir), "{torn");
    const kept = setAsidePendingRotation(dir);
    expect(kept).toMatch(/pending-rotation\.json\.clobbered-/);
    expect(readFileSync(kept, "utf-8")).toBe("{torn");
    expect(statSync(kept).mode & 0o777).toBe(0o600);
    expect(hasPendingRotation(dir)).toBe(false);
  });

  it("is written owner-only and atomically — it holds an encrypted private key", () => {
    savePendingRotation(held, dir);
    const mode = statSync(pendingRotationPath(dir)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(JSON.parse(readFileSync(pendingRotationPath(dir), "utf-8"))).toEqual(held);
    expect(() => statSync(`${pendingRotationPath(dir)}.tmp`)).toThrow();
  });

  it("is gone once cleared, and clearing nothing is not an error", () => {
    savePendingRotation(held, dir);
    clearPendingRotation(dir);
    expect(hasPendingRotation(dir)).toBe(false);
    expect(() => clearPendingRotation(dir)).not.toThrow();
  });
});
