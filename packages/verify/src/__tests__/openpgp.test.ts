/**
 * The OpenPGP shape the offline mode accepts (`git/openpgp.ts`), unit by
 * unit: the pinned-keys file (armored v4 RSA primary keys, fingerprints
 * computed, never labelled), packet framing, armor, and the commit payload
 * rule. The end-to-end refusals over real commits live in
 * `repo-change-landed.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { parsePinnedSigningKeys, splitSignedCommit, verifyCommitSignature } from "../git/index.js";
import {
  armor,
  commitPayload,
  packet,
  signPayload,
  testSigningKey,
  withSignature,
} from "./helpers/github-signer.js";

const KEY = "PGP PUBLIC KEY BLOCK";
const A = testSigningKey();
const B = testSigningKey();
const T = 1_900_000_000;
const TREE = "a".repeat(40);

function signed(key = A, header = "gpgsig"): Buffer {
  const payload = commitPayload({ tree: TREE, parents: ["b".repeat(40)], seconds: T });
  return withSignature(payload, signPayload(payload, key, T), header);
}

/** Old-format packet with a two-octet length (RFC 4880 §4.2.1). */
function oldPacket(tag: number, body: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([0x80 | (tag << 2) | 1, body.length >> 8, body.length & 0xff]),
    body,
  ]);
}

describe("the pinned signing keys file", () => {
  it("one or more armored blocks; every primary key a candidate, its fingerprint computed", () => {
    const keys = parsePinnedSigningKeys(`\n${A.armored}\n${B.armored}`);
    expect(keys.map((k) => k.fingerprint)).toEqual([A.fingerprint, B.fingerprint]);
    expect(keys[0]!.keyId).toBe(A.keyId);
    expect(verifyCommitSignature(signed(B), "sha1", keys)).toMatchObject({
      ok: true,
      fingerprint: B.fingerprint,
    });
  });

  it("armor headers, an old-format packet, a five-octet length and subkeys are read", () => {
    const bigUid = packet(13, Buffer.alloc(9000, 0x41));
    const sub = packet(14, B.keyBody);
    const data = Buffer.concat([
      oldPacket(6, A.keyBody),
      bigUid,
      sub,
      packet(2, Buffer.from([4])),
      packet(12, Buffer.alloc(2)),
    ]);
    const keys = parsePinnedSigningKeys(armor(KEY, data, ["Comment: GitHub", "Version: x"]));
    // The subkey is never a candidate.
    expect(keys.map((k) => k.fingerprint)).toEqual([A.fingerprint]);
    expect(verifyCommitSignature(signed(B), "sha1", keys)).toMatchObject({ ok: false });
  });

  it.each([
    ["", /no key/],
    ["not a key\n", /not a PGP PUBLIC KEY BLOCK/],
    [`-----BEGIN ${KEY}-----\n\nAAAA\n`, /not a PGP PUBLIC KEY BLOCK/],
    [`junk\n-----END ${KEY}-----\n`, /not a PGP PUBLIC KEY BLOCK/],
  ])("refuses text that is not key blocks %#", (text, reason) => {
    expect(() => parsePinnedSigningKeys(text)).toThrow(reason);
  });

  it("refuses a key pinned twice", () => {
    expect(() => parsePinnedSigningKeys(`${A.armored}${A.armored}`)).toThrow(/pinned twice/);
  });

  it.each([
    [
      "a v3 key",
      () => packet(6, Buffer.concat([Buffer.from([3]), A.keyBody.subarray(1)])),
      /version 3, not 4/,
    ],
    [
      "a non-RSA primary key",
      () => {
        const b = Buffer.from(A.keyBody);
        b[5] = 22;
        return packet(6, b);
      },
      /algorithm 22, not RSA/,
    ],
    ["a cut-short key", () => packet(6, A.keyBody.subarray(0, 4)), /cut short/],
    [
      "a key with trailing bytes",
      () => packet(6, Buffer.concat([A.keyBody, Buffer.from([0])])),
      /trailing bytes/,
    ],
    [
      "a key with a truncated exponent",
      () => packet(6, A.keyBody.subarray(0, A.keyBody.length - 1)),
      /exponent is malformed|exponent is cut short/,
    ],
    [
      "a key with no exponent",
      () => packet(6, A.keyBody.subarray(0, A.keyBody.length - 5)),
      /exponent is cut short/,
    ],
    [
      "a modulus whose bit count is not exact",
      () => {
        const b = Buffer.from(A.keyBody);
        b.writeUInt16BE(b.readUInt16BE(6) - 1, 6);
        return packet(6, b);
      },
      /bit count is not exact/,
    ],
    [
      "a disallowed packet",
      () => Buffer.concat([packet(6, A.keyBody), packet(11, Buffer.from("x"))]),
      /a packet of tag 11/,
    ],
    [
      "a block that does not start with a primary key",
      () => packet(13, Buffer.from("uid")),
      /does not start with a primary key/,
    ],
    ["a packet without its high bit", () => Buffer.from([0x06, 0x00]), /lacks its high bit/],
    ["a partial-length packet", () => Buffer.from([0xc6, 0xe0, 0x00]), /partial-length/],
    [
      "an indeterminate-length packet",
      () => Buffer.from([0x80 | (6 << 2) | 3, 0x00]),
      /indeterminate-length/,
    ],
    [
      "a packet that runs past its block",
      () => Buffer.from([0xc6, 0x05, 0x04]),
      /runs past the end/,
    ],
    ["a cut-short new-format length", () => Buffer.from([0xc6]), /length is cut short/],
    ["a cut-short two-octet length", () => Buffer.from([0xc6, 0xc0]), /length is cut short/],
    ["a cut-short five-octet length", () => Buffer.from([0xc6, 0xff, 0x00]), /length is cut short/],
    ["a cut-short old-format length", () => Buffer.from([0x99, 0x00]), /length is cut short/],
  ])("refuses %s", (_name, data, reason) => {
    expect(() => parsePinnedSigningKeys(armor(KEY, data()))).toThrow(reason);
  });

  it.each([
    [
      "a malformed armor header",
      (a: string) => a.replace(`${KEY}-----\n`, `${KEY}-----\nnot a header\n`),
      /malformed armor header/,
    ],
    [
      "no blank line",
      (a: string) => a.replace(`${KEY}-----\n\n`, `${KEY}-----\n`),
      /no blank line|malformed armor header/,
    ],
    [
      "padding before the last line",
      (a: string) => a.replace(/\n\n(.{60})(.{4})/, "\n\n$1QQ=="),
      /body is not base64 lines/,
    ],
    [
      "a line of a length not a multiple of 4 before the last line",
      (a: string) => a.replace(/\n\n(.{61})(.{3})/, "\n\n$1\n$2"),
      /body is not base64 lines/,
    ],
    [
      "non-canonical base64",
      () => armor(KEY, Buffer.from("A")).replace("\nQQ==\n", "\nQR==\n"),
      /not canonical base64/,
    ],
    [
      "an unterminated block",
      (a: string) => a.replace(`-----END ${KEY}-----`, ""),
      /not a PGP PUBLIC KEY BLOCK/,
    ],
  ])("refuses armor with %s", (_name, mutate, reason) => {
    expect(() => parsePinnedSigningKeys(mutate(A.armored))).toThrow(reason);
  });

  it("refuses a body that is the CRC line only", () => {
    expect(() =>
      parsePinnedSigningKeys(`-----BEGIN ${KEY}-----\n\n=AAAA\n-----END ${KEY}-----\n`),
    ).toThrow(/no CRC-24 line/);
  });
});

describe("the commit's signature", () => {
  it("verifies, and the payload is the commit without its gpgsig lines", () => {
    const raw = signed();
    const split = splitSignedCommit(raw, "sha1");
    expect(
      "payload" in split &&
        split.payload.equals(commitPayload({ tree: TREE, parents: ["b".repeat(40)], seconds: T })),
    ).toBe(true);
    expect(verifyCommitSignature(raw, "sha1", parsePinnedSigningKeys(A.armored))).toEqual({
      ok: true,
      fingerprint: A.fingerprint,
      createdAt: T,
    });
  });

  it("a sha256 repository reads gpgsig-sha256, and refuses a plain gpgsig there", () => {
    const keys = parsePinnedSigningKeys(A.armored);
    expect(verifyCommitSignature(signed(A, "gpgsig-sha256"), "sha256", keys)).toMatchObject({
      ok: true,
    });
    expect(verifyCommitSignature(signed(A), "sha256", keys)).toEqual({
      ok: false,
      reason: "the commit carries a gpgsig header",
    });
  });

  it("a commit with no message separator", () => {
    expect(splitSignedCommit(Buffer.from(`tree ${TREE}\n`), "sha1")).toEqual({
      reason: "the commit has no message separator",
    });
  });

  it("a signature longer than the pinned key's modulus", () => {
    // A's 2048-bit signature against A's entry claiming a 1024-bit modulus.
    const keys = parsePinnedSigningKeys(A.armored).map((k) => ({ ...k, modulusBytes: 128 }));
    expect(verifyCommitSignature(signed(), "sha1", keys)).toEqual({
      ok: false,
      reason: "the signature is longer than the key's modulus",
    });
  });

  it("an issuer key id that is not the matched key's", () => {
    const keys = parsePinnedSigningKeys(A.armored).map((k) => ({ ...k, keyId: "0".repeat(16) }));
    expect(verifyCommitSignature(signed(), "sha1", keys)).toEqual({
      ok: false,
      reason: "the issuer key id is not the pinned key's",
    });
  });

  it("a signature packet of another tag", () => {
    const payload = commitPayload({ tree: TREE, parents: [], seconds: T });
    const raw = withSignature(payload, armor("PGP SIGNATURE", packet(13, Buffer.from("x"))));
    expect(verifyCommitSignature(raw, "sha1", parsePinnedSigningKeys(A.armored))).toEqual({
      ok: false,
      reason: "the signature: the packet is of tag 13, not a signature (2)",
    });
  });
});
