/**
 * The OpenPGP shape the offline mode accepts (`openpgp.ts`), unit by
 * unit: the pinned-keys file (armored v4 RSA primary keys, fingerprints
 * computed, never labelled), packet framing, armor, and the commit payload
 * rule. The end-to-end refusals over real commits live in
 * `@motebit/verify`'s `repo-change-landed.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { parsePinnedSigningKeys, splitSignedCommit, verifyCommitSignature } from "../index.js";
import {
  armor,
  commitPayload,
  packet,
  signPayload,
  subpacket,
  testSigningKey,
  withSignature,
} from "./helpers/github-signer.js";
import type { SignOptions } from "./helpers/github-signer.js";

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

describe("the signature packet, refusal by refusal", () => {
  const keys = parsePinnedSigningKeys(A.armored);
  const payload = commitPayload({ tree: TREE, parents: ["b".repeat(40)], seconds: T });
  const time = (s: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(s);
    return b;
  };
  const check = (o: SignOptions, key = A) =>
    verifyCommitSignature(withSignature(payload, signPayload(payload, key, T, o)), "sha1", keys);
  /** The offset of the left 16 bits: after the hashed area and the unhashed area. */
  const left16At = (b: Buffer): number => {
    const hashedEnd = 6 + b.readUInt16BE(4);
    return hashedEnd + 2 + b.readUInt16BE(hashedEnd);
  };
  const patch = (at: (b: Buffer) => number, f: (b: Buffer, i: number) => void) => (b: Buffer) => {
    const c = Buffer.from(b);
    f(c, at(c));
    return c;
  };

  const refused: Array<[string, SignOptions, string]> = [
    ["a v3 signature", { version: 3 }, "a version 3 signature, not 4"],
    ["a text signature", { sigType: 0x01 }, "signature type 0x1, not binary (0x00)"],
    ["a DSA signature", { pkAlgo: 17 }, "public-key algorithm 17, not RSA (1)"],
    ["a SHA-512 signature", { hashAlgo: 10 }, "hash algorithm 10, not SHA-256 (8)"],
    ["no creation time", { created: null }, "no signature creation time"],
    [
      "two creation times",
      { extraHashed: [subpacket(2, time(T + 1))] },
      "more than one creation time",
    ],
    [
      "a malformed creation time",
      { created: null, extraHashed: [subpacket(2, Buffer.alloc(3))] },
      "a malformed creation time",
    ],
    [
      "a creation time in the unhashed area",
      {
        created: null,
        unhashed: [subpacket(2, time(T)), subpacket(16, Buffer.from(A.keyId, "hex"))],
      },
      "a creation time outside the hashed area",
    ],
    [
      "a signature expiration",
      { extraHashed: [subpacket(3, time(60))] },
      "a signature-expiration subpacket",
    ],
    [
      "a malformed issuer key id",
      { unhashed: [subpacket(16, Buffer.alloc(4))] },
      "a malformed issuer key id",
    ],
    [
      "two different issuer key ids",
      {
        unhashed: [
          subpacket(16, Buffer.from(A.keyId, "hex")),
          subpacket(16, Buffer.from(B.keyId, "hex")),
        ],
      },
      "two different issuer key ids",
    ],
    [
      "a malformed issuer fingerprint",
      { extraHashed: [subpacket(33, Buffer.concat([Buffer.from([5]), Buffer.alloc(20)]))] },
      "a malformed issuer fingerprint",
    ],
    [
      "an issuer fingerprint of the wrong length",
      { extraHashed: [subpacket(33, Buffer.concat([Buffer.from([4]), Buffer.alloc(19)]))] },
      "a malformed issuer fingerprint",
    ],
    [
      "an MPI that declares fewer bytes than it carries",
      {
        body: patch(
          (b) => left16At(b) + 2,
          (b, i) => b.writeUInt16BE(b.readUInt16BE(i) - 8, i),
        ),
      },
      "the signature packet has trailing bytes",
    ],
    [
      "two different issuer fingerprints",
      {
        extraHashed: [
          subpacket(33, Buffer.concat([Buffer.from([4]), Buffer.from(B.fingerprint, "hex")])),
        ],
      },
      "two different issuer fingerprints",
    ],
    [
      "an unknown critical subpacket",
      { extraHashed: [subpacket(0x80 | 20, Buffer.from([0]))] },
      "a critical subpacket of type 20",
    ],
    ["no issuer", { noFingerprint: true, unhashed: [] }, "no issuer"],
    [
      "a key id that is not the fingerprint's",
      { unhashed: [subpacket(16, Buffer.from(B.keyId, "hex"))] },
      "the issuer key id is not the issuer fingerprint's",
    ],
    [
      "a subpacket that runs past its area",
      { extraHashed: [Buffer.from([10, 20])] },
      "a subpacket runs past its area",
    ],
    [
      "a zero-length subpacket",
      { extraHashed: [Buffer.from([0])] },
      "a subpacket runs past its area",
    ],
    [
      "a two-octet subpacket length cut short",
      { extraHashed: [Buffer.from([200])] },
      "a subpacket length is cut short",
    ],
    [
      "a five-octet subpacket length cut short",
      { extraHashed: [Buffer.from([255, 0])] },
      "a subpacket length is cut short",
    ],
    [
      "a second packet after the signature",
      { trailing: packet(13, Buffer.from("x")) },
      "the signature holds 2 packets, not one",
    ],
    [
      "trailing bytes inside the signature packet",
      { body: (b) => Buffer.concat([b, Buffer.from([0])]) },
      "the signature packet has trailing bytes",
    ],
    ["a packet cut short", { body: (b) => b.subarray(0, 4) }, "the signature is cut short"],
    [
      "a hashed area longer than the packet",
      {
        body: patch(
          () => 4,
          (b, i) => b.writeUInt16BE(0xffff, i),
        ),
      },
      "the hashed area runs past the packet",
    ],
    [
      "an unhashed area longer than the packet",
      {
        body: patch(
          (b) => 6 + b.readUInt16BE(4),
          (b, i) => b.writeUInt16BE(0xffff, i),
        ),
      },
      "the unhashed area runs past the packet",
    ],
  ];
  it.each(refused)("refuses %s", (_name, o, reason) => {
    expect(check(o)).toEqual({ ok: false, reason: `the signature: ${reason}` });
  });

  it("refuses wrong left 16 bits, then a signature that does not verify", () => {
    expect(check({ body: patch(left16At, (b, i) => (b[i] ^= 1)) })).toEqual({
      ok: false,
      reason: "the signature's left 16 bits do not match the digest",
    });
    expect(
      check({
        body: patch(
          (b) => b.length - 1,
          (b, i) => (b[i] ^= 1),
        ),
      }),
    ).toEqual({
      ok: false,
      reason: "the RSA signature does not verify under the pinned key",
    });
  });

  it("refuses a signature made before its key was created", () => {
    const young = testSigningKey(2048, T + 10);
    const raw = withSignature(payload, signPayload(payload, young, T));
    expect(verifyCommitSignature(raw, "sha1", parsePinnedSigningKeys(young.armored))).toEqual({
      ok: false,
      reason: "the signature was made before its key was created",
    });
    const atCreation = withSignature(payload, signPayload(payload, young, T + 10));
    expect(
      verifyCommitSignature(atCreation, "sha1", parsePinnedSigningKeys(young.armored)),
    ).toMatchObject({ ok: true });
  });

  it("refuses a signer that is not pinned, by fingerprint or by key id", () => {
    expect(check({}, B)).toEqual({
      ok: false,
      reason: `the signer ${B.fingerprint} is not a pinned key`,
    });
    expect(check({ noFingerprint: true }, B)).toEqual({
      ok: false,
      reason: `the signer ${B.keyId} is not a pinned key`,
    });
  });

  it("accepts the issuer by key id alone, and skips a non-critical unknown subpacket of any length form", () => {
    expect(check({ noFingerprint: true })).toMatchObject({ ok: true });
    expect(check({ extraHashed: [subpacket(20, Buffer.from([0]))] })).toMatchObject({ ok: true });
    const long = Buffer.alloc(200);
    const twoOctet = Buffer.concat([
      Buffer.from([((long.length + 1 - 192) >> 8) + 192, (long.length + 1 - 192) & 0xff, 20]),
      long,
    ]);
    const fiveOctet = Buffer.from([255, 0, 0, 0, 2, 20, 0]);
    expect(check({ extraHashed: [twoOctet, fiveOctet] })).toMatchObject({ ok: true });
  });
});

describe("the commit's signature header", () => {
  const keys = parsePinnedSigningKeys(A.armored);
  const payload = commitPayload({ tree: TREE, parents: [], seconds: T });
  const sig = signPayload(payload, A, T);

  it("reads GitHub's form (full-width MPI, one blank last header line) and gpg's (minimal, none)", () => {
    const github = withSignature(payload, sig);
    expect(github.toString("latin1")).toContain("-----END PGP SIGNATURE-----\n \n\n");
    expect(verifyCommitSignature(github, "sha1", keys)).toMatchObject({ ok: true });
    // Full width differs from minimal only when the signature's top bit is
    // zero (about half of all signatures): find a commit whose signature has one.
    for (let i = 0; ; i++) {
      const p = commitPayload({ tree: TREE, parents: [], seconds: T, message: `m${i}\n` });
      let top = 0xff;
      const armored = signPayload(p, A, T, {
        body: (b) => {
          const hashedEnd = 6 + b.readUInt16BE(4);
          top = b[hashedEnd + 2 + b.readUInt16BE(hashedEnd) + 4]!;
          return b;
        },
      });
      if (top >= 0x80) continue;
      expect(verifyCommitSignature(withSignature(p, armored), "sha1", keys)).toMatchObject({
        ok: true,
      });
      break;
    }
    const gpg = withSignature(
      payload,
      signPayload(payload, A, T, { minimalMpi: true }),
      "gpgsig",
      false,
    );
    expect(verifyCommitSignature(gpg, "sha1", keys)).toMatchObject({ ok: true });
    // The blank line is dropped once, and only at the end.
    const twice = withSignature(payload, `${sig}\n`);
    expect(verifyCommitSignature(twice, "sha1", keys)).toEqual({
      ok: false,
      reason: "the signature: the PGP SIGNATURE is not terminated",
    });
  });

  it("refuses an unsigned commit, two signatures, and a mergetag or encoding header", () => {
    expect(verifyCommitSignature(payload, "sha1", keys)).toEqual({
      ok: false,
      reason: "the commit has no gpgsig signature",
    });
    expect(
      verifyCommitSignature(withSignature(withSignature(payload, sig), sig), "sha1", keys),
    ).toEqual({
      ok: false,
      reason: "the commit has more than one gpgsig signature",
    });
    for (const h of ["mergetag", "encoding"]) {
      const raw = Buffer.from(payload.toString("latin1").replace("\n\n", `\n${h} x\n\n`), "latin1");
      expect(verifyCommitSignature(withSignature(raw, sig), "sha1", keys)).toEqual({
        ok: false,
        reason: `the commit carries a ${h} header`,
      });
    }
  });

  it("refuses broken armor: no END line, a malformed armor header, a wrong CRC-24", () => {
    const at = (armored: string) =>
      verifyCommitSignature(withSignature(payload, armored), "sha1", keys);
    expect(at(sig.replace("-----END PGP SIGNATURE-----", "-----END X-----"))).toEqual({
      ok: false,
      reason: "the signature: the PGP SIGNATURE is not terminated",
    });
    expect(
      at(
        sig.replace(
          "-----BEGIN PGP SIGNATURE-----\n",
          "-----BEGIN PGP SIGNATURE-----\nbad header\n",
        ),
      ),
    ).toEqual({
      ok: false,
      reason: "the signature: the PGP SIGNATURE has a malformed armor header",
    });
    const body = sig.replace(/\n$/, "").split("\n");
    const blank = body.indexOf("");
    // Two 64-character base64 lines joined: a 128-character line, longer than armor's 76.
    const long = [
      ...body.slice(0, blank + 1),
      body[blank + 1]! + body[blank + 2]!,
      ...body.slice(blank + 3),
    ];
    expect(body[blank + 1]!.length + body[blank + 2]!.length).toBeGreaterThan(76);
    expect(at(`${long.join("\n")}\n`)).toEqual({
      ok: false,
      reason: "the signature: the PGP SIGNATURE body is not base64 lines",
    });
    const lines = sig.replace(/\n$/, "").split("\n");
    const crc = lines[lines.length - 2]!;
    lines[lines.length - 2] = `=${crc.slice(1, 4)}${crc[4] === "A" ? "B" : "A"}`;
    expect(at(`${lines.join("\n")}\n`)).toEqual({
      ok: false,
      reason: "the signature: the PGP SIGNATURE CRC-24 does not match",
    });
  });
});
