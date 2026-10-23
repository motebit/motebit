/**
 * The key-binding primitives never throw on a malformed `succession`.
 *
 * `verifyKeyBindingAtTime` read `identity.succession ?? []` and then called
 * array methods on it (`chain.some`) and indexed its first record
 * (`chain[0].old_public_key`). A string, an object, or an array holding a
 * non-object made it throw, and every wrapper inherited the throw:
 * `verifyMigratingKeyBinding` (documented "returns false, never throws"),
 * `verifyIdentityBindingAnchored`, and @motebit/state-export-client's
 * `verifyReceiptDocument` (documented "never throws on bad input").
 *
 * A malformed chain is UNBOUND — fail-closed — whatever the caller trusts.
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  generateKeypair,
  bytesToHex,
  deriveSovereignMotebitId,
  identityLogLeaf,
  verifyKeyBindingAtTime,
  verifyMigratingKeyBinding,
  verifyIdentityBindingAnchored,
  type KeyPair,
  type MotebitIdentityFile,
} from "../index.js";

const T0 = Date.parse("2026-01-01T00:00:00Z");
const T1 = Date.parse("2026-02-01T00:00:00Z");

const MALFORMED: ReadonlyArray<readonly [string, unknown]> = [
  ["a string", "not-an-array"],
  ["an object", {}],
  ["an array-like object", { length: 1, 0: {} }],
  ["a number", 7],
  ["true", true],
  ["[null]", [null]],
  ["[1]", [1]],
  ['["x"]', ["x"]],
  ["[[]]", [[]]],
];

function identityWith(motebitId: string, currentKeyHex: string, succession: unknown) {
  return {
    spec: "motebit/identity@1.0",
    motebit_id: motebitId,
    created_at: new Date(T0).toISOString(),
    owner_id: "owner",
    identity: { algorithm: "Ed25519", public_key: currentKeyHex },
    devices: [],
    succession,
  } as unknown as MotebitIdentityFile;
}

describe("key binding — a malformed succession never throws and never binds", () => {
  let genesis: KeyPair;
  let id: string;
  let signer: KeyPair;
  let guardianHex: string;

  beforeAll(async () => {
    genesis = await generateKeypair();
    id = await deriveSovereignMotebitId(bytesToHex(genesis.publicKey));
    signer = await generateKeypair();
    guardianHex = bytesToHex((await generateKeypair()).publicKey);
  });

  for (const [label, succession] of MALFORMED) {
    it(`succession is ${label}: verifyKeyBindingAtTime resolves unbound (with and without a trusted guardian)`, async () => {
      const file = identityWith(id, bytesToHex(signer.publicKey), succession);
      for (const trusted of [undefined, guardianHex]) {
        const r = await verifyKeyBindingAtTime(file, bytesToHex(signer.publicKey), T1, trusted);
        expect(r.bound).toBe(false);
        expect(r.reason).toMatch(/succession/i);
      }
    });

    it(`succession is ${label}: the genesis key the id commits to does not bind through it either`, async () => {
      // A malformed chain cannot be read as "no rotations": that would bind the
      // genesis key on a file whose history is unreadable.
      const file = identityWith(id, bytesToHex(genesis.publicKey), succession);
      const r = await verifyKeyBindingAtTime(file, bytesToHex(genesis.publicKey), T1);
      expect(r.bound).toBe(false);
    });

    it(`succession is ${label}: verifyMigratingKeyBinding returns false`, async () => {
      const file = identityWith(id, bytesToHex(signer.publicKey), succession);
      await expect(
        verifyMigratingKeyBinding(id, bytesToHex(signer.publicKey), file, guardianHex),
      ).resolves.toBe(false);
    });

    it(`succession is ${label}: verifyIdentityBindingAnchored resolves unbound`, async () => {
      const file = identityWith(id, bytesToHex(signer.publicKey), succession);
      const root = await identityLogLeaf(id, bytesToHex(signer.publicKey));
      const r = await verifyIdentityBindingAnchored(
        file,
        bytesToHex(signer.publicKey),
        T1,
        { index: 0, siblings: [], layerSizes: [1], anchoredRoot: root },
        guardianHex,
      );
      expect(r.bound).toBe(false);
    });
  }
});
