/**
 * #800 — the one rule for what a local identity file may contribute:
 * records (and a guardian) only from a file that verifies, names this
 * motebit, and whose current key IS the held key. The verifier is the
 * injected `@motebit/identity-file` `verify`; here it is a table of
 * verdicts, so each condition is severed on its own. The real verifier
 * (signatures, tampering) is exercised end to end by the CLI, mobile and
 * desktop suites, which pass the real one.
 */
import { describe, expect, it } from "vitest";
import type { KeySuccessionRecord } from "@motebit/sdk";
import {
  boundIdentityFile,
  identityFileRecords,
  type IdentityFileVerdict,
  type IdentityFileVerifier,
} from "../index.js";

const MID = "mid-800";
const HELD = "a".repeat(64);
const OTHER = "b".repeat(64);
const GUARDIAN = "c".repeat(64);
const RECORD = {
  old_public_key: OTHER,
  new_public_key: HELD,
  timestamp: 1,
  reason: "rotation",
  old_key_signature: "x",
  new_key_signature: "y",
} as unknown as KeySuccessionRecord;

function verdict(over: {
  valid?: boolean;
  type?: string;
  motebitId?: string;
  publicKey?: string;
  guardian?: string;
  identity?: null;
}): IdentityFileVerdict {
  return {
    type: over.type ?? "identity",
    valid: over.valid ?? true,
    identity:
      over.identity === null
        ? null
        : {
            motebit_id: over.motebitId ?? MID,
            identity: { public_key: over.publicKey ?? HELD },
            succession: [RECORD],
            guardian: { public_key: over.guardian ?? GUARDIAN },
          },
  };
}

const returning =
  (v: IdentityFileVerdict): IdentityFileVerifier =>
  () =>
    Promise.resolve(v);

describe("identityFileRecords / boundIdentityFile (#800)", () => {
  it("a file that verifies, names this motebit and is signed by the held key contributes its records and guardian", async () => {
    const verify = returning(verdict({}));
    expect(await identityFileRecords(MID, "file", HELD, verify)).toEqual([RECORD]);
    expect(await boundIdentityFile(MID, "file", HELD, verify)).toEqual({
      publicKeyHex: HELD,
      records: [RECORD],
      guardian: GUARDIAN,
    });
    // Case of the held key does not matter; it is compared as hex.
    expect(await identityFileRecords(MID, "file", HELD.toUpperCase(), verify)).toEqual([RECORD]);
  });

  it("a signature that does not verify (tampered) contributes nothing", async () => {
    const verify = returning(verdict({ valid: false }));
    expect(await identityFileRecords(MID, "file", HELD, verify)).toEqual([]);
    expect(await boundIdentityFile(MID, "file", HELD, verify)).toBeNull();
  });

  it("a file naming another motebit contributes nothing", async () => {
    const verify = returning(verdict({ motebitId: "someone-else" }));
    expect(await identityFileRecords(MID, "file", HELD, verify)).toEqual([]);
    expect(await boundIdentityFile(MID, "file", HELD, verify)).toBeNull();
  });

  it("a file whose current key is not the held key contributes nothing — no records, no guardian", async () => {
    const verify = returning(verdict({ publicKey: OTHER }));
    expect(await identityFileRecords(MID, "file", HELD, verify)).toEqual([]);
    expect(await boundIdentityFile(MID, "file", HELD, verify)).toBeNull();
  });

  it("no held key, no content, not an identity verdict, or a verifier that throws ⇒ nothing", async () => {
    const ok = returning(verdict({}));
    expect(await identityFileRecords(MID, "file", null, ok)).toEqual([]);
    expect(await identityFileRecords(MID, "file", "not-hex", ok)).toEqual([]);
    expect(await identityFileRecords(MID, null, HELD, ok)).toEqual([]);
    expect(await identityFileRecords(MID, "", HELD, ok)).toEqual([]);
    expect(
      await identityFileRecords(MID, "f", HELD, returning(verdict({ type: "receipt" }))),
    ).toEqual([]);
    expect(
      await identityFileRecords(MID, "f", HELD, returning(verdict({ identity: null }))),
    ).toEqual([]);
    const throws: IdentityFileVerifier = () => Promise.reject(new Error("boom"));
    expect(await identityFileRecords(MID, "file", HELD, throws)).toEqual([]);
  });

  it("a malformed guardian is not a guardian; the records still count", async () => {
    const verify = returning(verdict({ guardian: "not-a-key" }));
    expect(await boundIdentityFile(MID, "file", HELD, verify)).toEqual({
      publicKeyHex: HELD,
      records: [RECORD],
      guardian: null,
    });
  });
});
