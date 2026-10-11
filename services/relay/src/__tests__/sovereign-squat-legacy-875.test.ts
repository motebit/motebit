/**
 * #875 review F1/F2 — ported for identity-authority Inc 2
 * (docs/design/identity-authority-writers.md §7).
 *
 * Ported from `fix/875-key-pop-v2` @ 373221619.
 *
 * F2 (an accepted proof of possession is accepted ONCE) is ported at the
 * replay store it rests on, `key-proof-replay.ts` + migration v59, as-is: the
 * proof's identifying triple, its idempotent record, its window, its prune.
 * Inc 2's `writeAuthority` consumes the same store for the
 * `X-Motebit-Authority` request (identity-authority.ts).
 *
 * Not ported: the F1 door cells (X's keyed register refused, V's signed
 * bootstrap parks the squat, the served key) and the F2 door cells (a replayed
 * bootstrap body answered and writing nothing). Each needs a door that refuses
 * or parks where this tree admits; Inc 2 refuses nothing new, so they return
 * with Inc 3 (`sovereignLineage`, `servedIdentityKey`, `parkSovereignSquat`).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import {
  KEY_PROOF_RETENTION_MS,
  keyProofAccepted,
  keyProofOf,
  recordKeyProofAccepted,
} from "../key-proof-replay.js";
import { createTestRelay } from "./test-helpers.js";

let relay: SyncRelay;
beforeEach(async () => {
  relay = await createTestRelay();
});
afterEach(async () => {
  await relay.close();
});

const db = () => relay.moteDb.db;
const rows = () =>
  (db().prepare("SELECT COUNT(*) AS n FROM relay_key_proofs_accepted").get() as { n: number }).n;

describe("F2 — an exact replay of an accepted proof is recognised (the replay store, v59)", () => {
  it("keyProofOf reads the triple only from a body carrying a string signature", () => {
    expect(keyProofOf(null, "m", "k")).toBeNull();
    expect(keyProofOf({ signature: "" }, "m", "k")).toBeNull();
    expect(keyProofOf({ signature: 7 }, "m", "k")).toBeNull();
    expect(keyProofOf({ signature: "s" }, "m", "k")).toEqual({
      motebitId: "m",
      publicKey: "k",
      signature: "s",
    });
  });

  it("the same body twice is one record — the second is a replay", () => {
    const proof = { motebitId: crypto.randomUUID(), publicKey: "aa", signature: "sig-1" };
    expect(keyProofAccepted(db(), proof)).toBe(false);
    recordKeyProofAccepted(db(), proof, "bootstrap", Date.now());
    expect(keyProofAccepted(db(), proof)).toBe(true);
    recordKeyProofAccepted(db(), proof, "bootstrap", Date.now());
    expect(rows()).toBe(1);
  });

  it("a register-self body replayed at bootstrap is the same proof (doors share one record)", () => {
    const proof = { motebitId: crypto.randomUUID(), publicKey: "bb", signature: "sig-2" };
    recordKeyProofAccepted(db(), proof, "register-self", Date.now());
    expect(keyProofAccepted(db(), proof)).toBe(true);
    recordKeyProofAccepted(db(), proof, "bootstrap", Date.now());
    expect(rows()).toBe(1);
  });

  it("a different signature (another body) is a different proof", () => {
    const id = crypto.randomUUID();
    recordKeyProofAccepted(db(), { motebitId: id, publicKey: "cc", signature: "a" }, "register", 1);
    expect(keyProofAccepted(db(), { motebitId: id, publicKey: "cc", signature: "b" })).toBe(false);
  });

  it("rows outlive the window they guard and no longer: pruned on the next record", () => {
    const old = { motebitId: crypto.randomUUID(), publicKey: "dd", signature: "old" };
    const now = Date.now();
    recordKeyProofAccepted(db(), old, "bootstrap", now - KEY_PROOF_RETENTION_MS - 1);
    expect(keyProofAccepted(db(), old)).toBe(true);
    recordKeyProofAccepted(
      db(),
      { motebitId: crypto.randomUUID(), publicKey: "ee", signature: "new" },
      "bootstrap",
      now,
    );
    expect(keyProofAccepted(db(), old)).toBe(false);
    expect(rows()).toBe(1);
  });
});
