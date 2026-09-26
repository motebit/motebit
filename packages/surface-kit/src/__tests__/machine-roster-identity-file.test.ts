/**
 * #800 — the one rule for what a local identity file may contribute:
 * records (and a guardian) only from a file that verifies, names this
 * motebit, and whose current key IS the held key. The kit verifies with
 * `@motebit/identity-file` itself; every case here is a genuinely signed
 * file, so each condition is severed on its own against real signatures.
 */
import { describe, expect, it } from "vitest";
import { bytesToHex, generateKeypair, signKeySuccession, type KeyPair } from "@motebit/encryption";
import { generate, rotate as rotateIdentityFile } from "@motebit/identity-file";
import { boundIdentityFile, identityFileRecords } from "../index.js";

const MID = "0190f1a2-0000-7000-8000-00000000abcd";
const OTHER_MID = "0190f1a2-0000-7000-8000-00000000ef01";
const hex = (kp: KeyPair) => bytesToHex(kp.publicKey);

/** A file for MID, first signed by `a` naming guardian `g`, rotated a → b (current key b). */
async function rotatedFile(guardian?: string) {
  const a = await generateKeypair();
  const b = await generateKeypair();
  const g = await generateKeypair();
  const file = await generate(
    {
      motebitId: MID,
      ownerId: "owner",
      publicKeyHex: hex(a),
      guardian: {
        public_key: guardian ?? hex(g),
        established_at: "2026-01-01T00:00:00.000Z",
      },
    },
    a.privateKey,
  );
  const record = await signKeySuccession(a.privateKey, b.privateKey, b.publicKey, a.publicKey);
  const rotated = await rotateIdentityFile({
    existingContent: file,
    newPublicKey: b.publicKey,
    newPrivateKey: b.privateKey,
    successionRecord: record,
  });
  return { a, b, g, rotated };
}

/** Flip one hex digit of the signature in the file's trailing signature comment. */
function flipSignatureByte(file: string): string {
  const m = /<!-- motebit:sig:[^:]+:([0-9a-f]+) -->/.exec(file);
  if (m == null) throw new Error("no signature line in the fixture");
  const sig = m[1]!;
  const flipped = (sig[0] === "0" ? "1" : "0") + sig.slice(1);
  return file.replace(sig, flipped);
}

describe("identityFileRecords / boundIdentityFile (#800)", () => {
  it("a file that verifies, names this motebit and is signed by the held key contributes its records and guardian", async () => {
    const { b, g, rotated } = await rotatedFile();
    const recs = await identityFileRecords(MID, rotated, hex(b));
    expect(recs).toHaveLength(1);
    expect(recs[0]!.new_public_key).toBe(hex(b));
    expect(await boundIdentityFile(MID, rotated, hex(b))).toEqual({
      publicKeyHex: hex(b),
      records: recs,
      guardian: hex(g),
    });
    // The held key is compared as hex, whatever its case.
    expect(await identityFileRecords(MID, rotated, hex(b).toUpperCase())).toHaveLength(1);
  });

  it("a tampered signature (one byte flipped in a genuinely signed file) contributes nothing", async () => {
    const { b, rotated } = await rotatedFile();
    const tampered = flipSignatureByte(rotated);
    expect(tampered).not.toBe(rotated);
    expect(await identityFileRecords(MID, tampered, hex(b))).toEqual([]);
    expect(await boundIdentityFile(MID, tampered, hex(b))).toBeNull();
  });

  it("a tampered body (the guardian swapped after signing) contributes nothing", async () => {
    const { a, b, g, rotated } = await rotatedFile();
    const tampered = rotated.replace(hex(g), hex(a));
    expect(tampered).not.toBe(rotated);
    expect(await boundIdentityFile(MID, tampered, hex(b))).toBeNull();
  });

  it("a file naming another motebit contributes nothing", async () => {
    const { b, rotated } = await rotatedFile();
    expect(await identityFileRecords(OTHER_MID, rotated, hex(b))).toEqual([]);
    expect(await boundIdentityFile(OTHER_MID, rotated, hex(b))).toBeNull();
  });

  it("a file whose current key is not the held key contributes nothing — no records, no guardian", async () => {
    const { a, rotated } = await rotatedFile();
    const stranger = await generateKeypair();
    expect(await identityFileRecords(MID, rotated, hex(a))).toEqual([]);
    expect(await boundIdentityFile(MID, rotated, hex(a))).toBeNull();
    expect(await boundIdentityFile(MID, rotated, hex(stranger))).toBeNull();
  });

  it("no held key, a malformed held key, no content, or not an identity file ⇒ nothing", async () => {
    const { b, rotated } = await rotatedFile();
    expect(await identityFileRecords(MID, rotated, null)).toEqual([]);
    expect(await identityFileRecords(MID, rotated, "not-hex")).toEqual([]);
    expect(await identityFileRecords(MID, null, hex(b))).toEqual([]);
    expect(await identityFileRecords(MID, "", hex(b))).toEqual([]);
    expect(await identityFileRecords(MID, "# just markdown\n", hex(b))).toEqual([]);
  });

  it("a malformed guardian is not a guardian; the records still count", async () => {
    const { b, rotated } = await rotatedFile("NOT-A-KEY");
    const bound = await boundIdentityFile(MID, rotated, hex(b));
    expect(bound?.records).toHaveLength(1);
    expect(bound?.guardian).toBeNull();
  });
});
