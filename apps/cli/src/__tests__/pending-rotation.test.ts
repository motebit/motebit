/**
 * The write-ahead a rotation leaves before its request goes out
 * (`docs/proposals/key-rotation-client-v1.md` I2).
 */
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  clearPendingRotation,
  hasPendingRotation,
  loadPendingRotation,
  pendingRotationPath,
  savePendingRotation,
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
    // Still on disk — the caller decides what a stale one means.
    expect(hasPendingRotation(dir)).toBe(true);
  });

  it("is absent when nothing is held, and survives a corrupt or partial file", () => {
    expect(loadPendingRotation("mid-1", "aa".repeat(32), dir)).toBeNull();
    writeFileSync(pendingRotationPath(dir), "{not json");
    expect(loadPendingRotation("mid-1", "aa".repeat(32), dir)).toBeNull();
    writeFileSync(
      pendingRotationPath(dir),
      JSON.stringify({ motebit_id: "mid-1", old_public_key: "aa".repeat(32) }),
    );
    expect(loadPendingRotation("mid-1", "aa".repeat(32), dir)).toBeNull();
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
