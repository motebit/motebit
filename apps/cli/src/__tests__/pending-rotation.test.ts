/**
 * The held rotation is what makes a lost response survivable.
 *
 * Rotation is all-or-nothing, so there is a moment where the relay may
 * have recorded the succession and this machine does not know it. Without
 * the record, the next run mints a FRESH keypair and presents a record
 * departing from a key the relay has already retired — refused, for good,
 * with only the guardian left. Holding it is what lets the next run
 * re-present the SAME record and meet the relay's "already recorded".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "motebit-pending-"));
vi.mock("../config.js", () => ({ CONFIG_DIR: tmp }));

const { savePendingRotation, loadPendingRotation, clearPendingRotation } =
  await import("../pending-rotation.js");

const PENDING = {
  motebit_id: "m-1",
  old_public_key: "aa".repeat(32),
  new_public_key: "bb".repeat(32),
  record: { old_public_key: "aa".repeat(32) } as never,
  encrypted_new_key: { ciphertext: "c", nonce: "n", tag: "t", salt: "s" },
};

beforeEach(() => clearPendingRotation());
afterEach(() => clearPendingRotation());

describe("a held rotation", () => {
  it("is returned to the identity and key it departs from", () => {
    savePendingRotation(PENDING);
    expect(loadPendingRotation("m-1", "aa".repeat(32))).toEqual(PENDING);
  });

  it("is not offered to another identity", () => {
    savePendingRotation(PENDING);
    expect(loadPendingRotation("m-2", "aa".repeat(32))).toBeNull();
  });

  it("is not offered once the local key has moved past it", () => {
    // A record departing from a key this machine no longer holds cannot be
    // finished from here. It is evidence of a different problem, not an
    // instruction — resuming it would present a record the relay refuses.
    savePendingRotation(PENDING);
    expect(loadPendingRotation("m-1", "cc".repeat(32))).toBeNull();
  });

  it("is absent when nothing is held, and survives a corrupt file", () => {
    expect(loadPendingRotation("m-1", "aa".repeat(32))).toBeNull();
    fs.writeFileSync(path.join(tmp, "pending-rotation.json"), "{ not json");
    expect(loadPendingRotation("m-1", "aa".repeat(32))).toBeNull();
  });

  it("is written owner-only — it holds an encrypted private key", () => {
    savePendingRotation(PENDING);
    const mode = fs.statSync(path.join(tmp, "pending-rotation.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("is gone once cleared, and clearing nothing is not an error", () => {
    savePendingRotation(PENDING);
    clearPendingRotation();
    expect(loadPendingRotation("m-1", "aa".repeat(32))).toBeNull();
    expect(() => clearPendingRotation()).not.toThrow();
  });
});
